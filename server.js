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
      model: 'llama-3.1-8b-instant',
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

    // ── STEP 1: Extract exact structure as JSON ──────────────
    const analyzeSystem = `You are an expert at reading and analyzing question paper formats.
Extract the EXACT structure of the paper. Copy all text word for word.
Return ONLY a valid JSON object. No extra text. No markdown.`;

    const analyzeUser = `Analyze this question paper and return its exact structure as JSON:

${formatHtml.substring(0, 6000)}

Return exactly this JSON format:
{
  "header": {
    "school_name": "exact school name",
    "exam_title": "exact exam title",
    "subject": "exact subject name",
    "class": "exact class or grade",
    "date": "exact date or [Date]",
    "time": "exact time allowed",
    "max_marks": "exact maximum marks",
    "extra_lines": ["any other header lines word for word"]
  },
  "general_instructions": ["instruction 1 word for word", "instruction 2 word for word"],
  "sections": [
    {
      "name": "Section A",
      "title": "full section title if any",
      "instructions": ["exact instruction word for word"],
      "total_questions": 10,
      "questions_to_attempt": 5,
      "marks_per_question": "1",
      "total_marks": 10,
      "question_type": "MCQ or Short Answer or Long Answer or Project"
    }
  ]
}`;

    let structure = null;
    try {
      const raw      = await callGroq(analyzeSystem, analyzeUser, 1500);
      const match    = raw.match(/\{[\s\S]*\}/);
      if (match) structure = JSON.parse(match[0]);
    } catch (e) {
      console.warn('[analyze] fallback to raw format:', e.message);
    }

    // ── STEP 2: Generate the paper ───────────────────────────
    const generateSystem = `You are an expert question paper formatter for schools.
You produce perfectly formatted print-ready HTML question papers.
You follow every instruction with 100% precision.
Output ONLY raw HTML with inline CSS. No markdown. No explanation. No code fences.`;

    const generateUser = structure ? `
Create a new question paper using this EXACT structure:

${JSON.stringify(structure, null, 2)}

NEW QUESTIONS FROM TEACHER:
${questions}

STRICT RULES:
1. Header — copy every field EXACTLY word for word, same layout, centered
2. General instructions — copy EXACTLY word for word, same numbering
3. For each section:
   - Section name: IDENTICAL
   - Section instructions: IDENTICAL word for word
   - Question count: EXACTLY the same number as total_questions
   - Marks: EXACTLY the same per question
   - Question numbering: continue from previous section (e.g. Section A ends at 10, Section B starts at 11)
4. Distribute teacher's new questions across sections proportionally
5. If teacher gave fewer questions → write "[To be added]" for missing ones
6. ONLY the question text changes — everything else stays identical

HTML RULES:
- Wrapper: <div style="max-width:800px;margin:40px auto;padding:40px;background:#fff;font-family:Arial,sans-serif;font-size:13pt;line-height:1.8;color:#111;">
- School name: centered, bold, font-size:20pt
- Exam title + details: centered, font-size:13pt
- Horizontal line <hr> after header
- General instructions: font-size:11pt, italic, margin-bottom:20px
- Section heading: bold, uppercase, underlined, margin-top:24px
- Section instructions: italic, font-size:11pt, color:#333
- Each question: margin:10px 0, with question number bold
- Marks: shown as [X marks] at end of question, float right or in brackets
- @media print { body { margin: 0; } }
- End with <p style="text-align:center;margin-top:40px;font-weight:bold;">--- End of Paper ---</p>
` : `
Create a new question paper based on this original format:

${formatHtml.substring(0, 6000)}

NEW QUESTIONS FROM TEACHER:
${questions}

RULES:
1. Copy header EXACTLY — school name, subject, class, date, time, marks — word for word
2. Copy ALL section headings and instructions EXACTLY word for word
3. Keep SAME number of questions per section
4. Keep SAME marks structure
5. Replace ONLY the question text
6. Keep identical numbering

HTML RULES:
- Wrapper: <div style="max-width:800px;margin:40px auto;padding:40px;background:#fff;font-family:Arial,sans-serif;font-size:13pt;line-height:1.8;color:#111;">
- School name centered and bold
- Horizontal line after header
- Section headings bold and underlined
- Instructions italic
- Marks in brackets at end
- End with <p style="text-align:center;margin-top:40px;font-weight:bold;">--- End of Paper ---</p>
`;

    let output = await callGroq(generateSystem, generateUser, 4096);

    // Strip any markdown fences
    output = output
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .trim();

    if (!output) throw new Error('AI returned empty response. Please try again.');

    res.json({ html: output, success: true });
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
  body       { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; }
  h1,h2,h3   { font-family: Arial, sans-serif; }
  p          { margin: 6px 0; }
  strong     { font-weight: bold; }
  em         { font-style: italic; }
  hr         { border: 1px solid #000; margin: 10px 0; }
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
