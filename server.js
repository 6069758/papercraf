require('dotenv').config();
const express    = require('express');
const multer     = require('multer');
const mammoth    = require('mammoth');
const pdfParse   = require('pdf-parse');
const HTMLtoDOCX = require('html-to-docx');
const fetch      = require('node-fetch');
const path       = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────────────────────
// HELPER — call Groq
// ─────────────────────────────────────────────────────────────
async function callGroq(systemMsg, userMsg, maxTokens = 4096) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg   }
      ],
      temperature: 0.0,
      max_tokens: maxTokens
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.substring(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────
// 1. EXTRACT TEXT FROM UPLOADED FILE
// ─────────────────────────────────────────────────────────────
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', success: false });

    const { buffer, originalname, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let html = '';

    if (ext === '.docx' || mimetype.includes('wordprocessingml')) {
      const result = await mammoth.convertToHtml({ buffer });
      html = result.value;

    } else if (ext === '.pdf' || mimetype === 'application/pdf') {
      const data = await pdfParse(buffer);
      html = data.text
        .split('\n')
        .map(line => {
          const t = line.trim();
          if (!t) return '<p>&nbsp;</p>';
          if (/^section\s+[a-d]/i.test(t) || /^(instructions?|general\s+instructions?)/i.test(t)) {
            return `<p><strong>${t}</strong></p>`;
          }
          return `<p>${t}</p>`;
        })
        .join('\n');

    } else if (ext === '.txt') {
      html = buffer.toString('utf8')
        .split('\n')
        .map(l => l.trim() ? `<p>${l}</p>` : '<p>&nbsp;</p>')
        .join('\n');

    } else {
      return res.status(400).json({ error: 'Unsupported file. Please upload .docx or .pdf', success: false });
    }

    res.json({ html, success: true });
  } catch (err) {
    console.error('[extract]', err.message);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─────────────────────────────────────────────────────────────
// 2. GENERATE — 2-step: analyze format → then generate
// ─────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { formatHtml, questions } = req.body;

    if (!formatHtml) return res.status(400).json({ error: 'No format provided', success: false });
    if (!questions)  return res.status(400).json({ error: 'No questions provided', success: false });
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY not set', success: false });

    // ── STEP 1: Extract the exact structure of the original paper ──
    const analyzeSystem = `You are an expert at reading and analyzing question paper formats.
Extract the EXACT structure of the paper provided. Be 100% precise — copy text word for word.
Return ONLY a JSON object, no other text.`;

    const analyzeUser = `Analyze this question paper and extract its EXACT structure:

${formatHtml.substring(0, 8000)}

Return this exact JSON format:
{
  "header": {
    "school_name": "exact school name from paper",
    "exam_title": "exact exam title",
    "subject": "exact subject",
    "class": "exact class/grade",
    "date": "exact date or [Date]",
    "time": "exact time allowed",
    "max_marks": "exact maximum marks",
    "extra_header_lines": ["any other header lines word for word"]
  },
  "general_instructions": ["instruction 1 word for word", "instruction 2 word for word"],
  "sections": [
    {
      "name": "Section A",
      "title": "full section title if any",
      "instructions": ["section instruction 1 word for word"],
      "total_questions": 10,
      "questions_to_attempt": 5,
      "marks_per_question": "1",
      "marks_range": "1-5",
      "total_marks": 20,
      "question_style": "MCQ/Short Answer/Long Answer/etc"
    }
  ]
}`;

    let structure;
    try {
      const analyzeRaw = await callGroq(analyzeSystem, analyzeUser, 2000);
      const jsonMatch  = analyzeRaw.match(/\{[\s\S]*\}/);
      structure = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (e) {
      console.warn('[analyze] Could not parse structure, using fallback', e.message);
      structure = null;
    }

    // ── STEP 2: Generate the new paper using extracted structure ──
    const generateSystem = `You are an expert question paper formatter for schools and universities.
You produce perfectly formatted, print-ready HTML question papers.
You follow instructions with 100% precision — never skip, never add, never change anything not asked.
Output ONLY raw HTML with inline CSS. Zero markdown. Zero explanations. Zero code fences.`;

    let generateUser;

    if (structure) {
      // Use the precisely extracted structure
      generateUser = `Create a new question paper using EXACTLY this structure:

PAPER STRUCTURE (extracted from teacher's original):
${JSON.stringify(structure, null, 2)}

NEW QUESTIONS TO USE:
${questions}

STRICT RULES — every single one must be followed:
1. HEADER: Copy every field from the structure EXACTLY word for word. Same layout, same order.
2. GENERAL INSTRUCTIONS: Copy every instruction EXACTLY word for word. Same numbering.
3. SECTIONS: For each section —
   - Section name: IDENTICAL
   - Section title: IDENTICAL  
   - Section instructions: IDENTICAL word for word
   - Number of questions: EXACTLY the same count
   - Marks per question: EXACTLY the same
   - Question numbering: continue from previous section
4. QUESTIONS: Place the teacher's new questions into the correct sections. Distribute them proportionally.
   If teacher gave fewer questions than needed → write "[To be added]" for missing ones.
   If teacher gave more questions than needed → use first N questions for that section.
5. FORMAT: Professional exam paper look with proper spacing between sections.

HTML REQUIREMENTS:
- Full A4 page style: max-width 800px, margin 40px auto, padding 40px, background white
- Header: centered, bold school name (font-size 18pt), then other details centered
- Horizontal line under header
- Section headings: bold, uppercase, underlined
- Instructions: italic, indented, smaller font
- Question numbers: bold
- Marks: shown in brackets at end of question, right-aligned
- Proper line spacing between questions (margin 10px)
- Professional font: Arial or Times New Roman
- Print-ready: @media print included`;

    } else {
      // Fallback: use raw HTML directly
      generateUser = `Create a new question paper.

ORIGINAL PAPER FORMAT (copy structure exactly):
${formatHtml.substring(0, 8000)}

NEW QUESTIONS:
${questions}

RULES:
1. Copy the header EXACTLY — school name, subject, class, date, time, marks — word for word
2. Copy ALL section headings and instructions EXACTLY word for word
3. Keep the SAME number of questions per section
4. Keep the SAME marks structure
5. Replace ONLY the question text with the new questions provided
6. Keep identical numbering style

HTML REQUIREMENTS:
- Full A4 style: max-width 800px, margin 40px auto, padding 40px, white background
- Header centered, bold school name
- Horizontal line under header
- Section headings bold and underlined
- Instructions in italics
- Marks in brackets
- Clean spacing, professional look
- @media print included`;
    }

    let output = await callGroq(generateSystem, generateUser, 4096);

    // Clean up any markdown fences
    output = output
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .trim();

    if (!output) throw new Error('AI returned empty response. Please try again.');

    res.json({ html: output, structure, success: true });
  } catch (err) {
    console.error('[generate]', err.message);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─────────────────────────────────────────────────────────────
// 3. EXPORT AS WORD (.docx)
// ─────────────────────────────────────────────────────────────
app.post('/api/export/docx', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided' });

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<style>
  body   { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; }
  h1, h2, h3 { font-family: Arial, sans-serif; }
  p      { margin: 6px 0; }
  strong { font-weight: bold; }
  em     { font-style: italic; }
  hr     { border: 1px solid #000; margin: 10px 0; }
</style>
</head>
<body>${html}</body>
</html>`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      table:      { row: { cantSplit: true } },
      footer:     false,
      pageNumber: false,
      margins:    { top: 720, right: 900, bottom: 720, left: 900 }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="question_paper.docx"');
    res.send(docxBuffer);
  } catch (err) {
    console.error('[docx]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅  PaperCraft running → http://localhost:${PORT}`);
    console.log(`    Groq Key : ${process.env.GROQ_API_KEY ? '✓ Set' : '✗ MISSING'}\n`);
  });
}

module.exports = app;
