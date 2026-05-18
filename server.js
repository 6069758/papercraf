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
// HELPER — call Groq with auto-retry on 429
// ─────────────────────────────────────────────────────────────
async function callGroq(systemMsg, userMsg, maxTokens = 4000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
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

    // Success
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }

    // Rate limited — wait and retry
    if (res.status === 429 && attempt < retries) {
      const errData = await res.json().catch(() => ({}));
      const msg     = errData?.error?.message || '';
      // Extract wait seconds from Groq message e.g. "try again in 22.4s"
      const match   = msg.match(/try again in ([\d.]+)s/i);
      const wait    = match ? Math.ceil(parseFloat(match[1])) * 1000 : 15000;
      console.log(`[groq] Rate limited, waiting ${wait}ms then retry ${attempt}/${retries}`);
      await new Promise(r => setTimeout(r, wait + 1000));
      continue;
    }

    // Other error
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${errText.substring(0, 200)}`);
  }
  throw new Error('Rate limit hit after retries. Please wait 1 minute and try again.');
}

// ─────────────────────────────────────────────────────────────
// 1. EXTRACT TEXT FROM UPLOADED FILE
// ─────────────────────────────────────────────────────────────
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', success: false });

    const { buffer, originalname, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let html  = '';

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
          if (/^section\s+[a-d]/i.test(t) || /^(instructions?|general\s+instructions?)/i.test(t))
            return `<p><strong>${t}</strong></p>`;
          return `<p>${t}</p>`;
        })
        .join('\n');

    } else if (ext === '.txt') {
      html = buffer.toString('utf8')
        .split('\n')
        .map(l => l.trim() ? `<p>${l}</p>` : '<p>&nbsp;</p>')
        .join('\n');

    } else {
      return res.status(400).json({ error: 'Unsupported file. Upload .docx or .pdf', success: false });
    }

    res.json({ html, success: true });
  } catch (err) {
    console.error('[extract]', err.message);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─────────────────────────────────────────────────────────────
// 2. GENERATE — single smart call with retry
// ─────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { formatHtml, questions } = req.body;

    if (!formatHtml) return res.status(400).json({ error: 'No format provided', success: false });
    if (!questions)  return res.status(400).json({ error: 'No questions provided', success: false });
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY not set', success: false });

    // Trim format to save tokens — take first 4000 chars which has header + sections
    const trimmedFormat = formatHtml.substring(0, 4000);

    const system = `You are an expert question paper formatter for schools and universities.
You produce perfectly formatted, print-ready HTML question papers.
You copy all headers, section names, instructions, and marks EXACTLY as given.
You ONLY change the question text — nothing else.
Output ONLY raw HTML with inline CSS. Zero markdown. Zero explanation.`;

    const user = `TASK: Create a new question paper. Copy the original format 100% exactly. Only replace the questions.

━━━ ORIGINAL PAPER FORMAT ━━━
${trimmedFormat}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ NEW QUESTIONS FROM TEACHER ━━━
${questions}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULES — follow every single one:
1. HEADER: Copy school name, exam title, subject, class, date, time, max marks — WORD FOR WORD. Same layout.
2. INSTRUCTIONS: Copy all general instructions WORD FOR WORD. Same numbering.
3. SECTIONS: Copy section names and all section instructions WORD FOR WORD.
4. QUESTION COUNT: Each section must have the EXACT same number of questions as the original.
5. MARKS: Each question must carry the EXACT same marks as the original.
6. NUMBERING: Questions continue across sections (Section A: 1-10, Section B: 11-15, etc.)
7. MISSING QUESTIONS: If teacher provided fewer questions than needed, write "[To be added]".
8. CHANGE ONLY: The question text itself — nothing else changes.

HTML OUTPUT RULES:
- Outer wrapper: <div style="max-width:800px;margin:0 auto;padding:50px;font-family:Arial,sans-serif;font-size:13pt;line-height:1.9;color:#111;background:#fff;">
- School name: <p style="text-align:center;font-size:20pt;font-weight:bold;margin:0;">SCHOOL NAME</p>
- Exam details (title, subject, class, date, time, marks): centered, each on its own line
- Divider after header: <hr style="border:2px solid #000;margin:16px 0;">
- General instructions heading: <p style="font-weight:bold;margin-top:16px;">General Instructions:</p>
- Instructions list: <ol> with <li> items, font-size:11pt
- Section heading: <p style="font-weight:bold;font-size:14pt;text-decoration:underline;margin-top:28px;">SECTION A</p>
- Section instructions: <p style="font-style:italic;font-size:11pt;color:#444;margin:4px 0 12px;">instructions here</p>
- Each question: <p style="margin:10px 0;"><strong>Q1.</strong> Question text here <span style="float:right;">[2 marks]</span></p>
- Clear float after each section: <div style="clear:both;"></div>
- End of paper: <p style="text-align:center;margin-top:48px;font-weight:bold;">*** End of Question Paper ***</p>
- Print CSS: <style>@media print{body{margin:0;}div{page-break-inside:avoid;}}</style> at top`;

    let output = await callGroq(system, user, 4000);

    // Clean markdown fences if any
    output = output
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .trim();

    if (!output) throw new Error('Empty response from AI. Please try again.');

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
<html><head><style>
  body    { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; }
  p       { margin: 6px 0; }
  strong  { font-weight: bold; }
  em      { font-style: italic; }
  hr      { border: 1px solid #000; margin: 10px 0; }
  ol, ul  { margin: 4px 0 4px 24px; }
</style></head>
<body>${html}</body></html>`;

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
