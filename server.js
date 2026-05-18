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
          if (!t) return '<p style="margin:4px 0">&nbsp;</p>';
          if (/^section\s+[a-d]/i.test(t) || /^(instructions?|general\s+instructions?)/i.test(t)) {
            return `<p style="margin:8px 0"><strong>${t}</strong></p>`;
          }
          return `<p style="margin:4px 0">${t}</p>`;
        })
        .join('\n');

    } else if (ext === '.txt') {
      html = buffer.toString('utf8')
        .split('\n')
        .map(l => l.trim() ? `<p style="margin:4px 0">${l}</p>` : '<p>&nbsp;</p>')
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
// 2. GENERATE FORMATTED PAPER VIA GROQ
// ─────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { formatHtml, questions } = req.body;

    if (!formatHtml) return res.status(400).json({ error: 'No format provided', success: false });
    if (!questions)  return res.status(400).json({ error: 'No questions provided', success: false });
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY not set in environment variables', success: false });

    const prompt = `You are a precise, expert question paper formatter.

ORIGINAL PAPER (extracted from teacher's uploaded file):
===
${formatHtml.substring(0, 9000)}
===

NEW QUESTIONS FROM TEACHER:
===
${questions}
===

YOUR JOB:
Produce a new question paper that is IDENTICAL to the original in every way EXCEPT the question text.

STRICT RULES:
1. Copy the header EXACTLY: school name, subject, class, time, marks, date — word for word
2. Copy ALL section headings EXACTLY
3. Copy ALL instructions EXACTLY
4. Keep the SAME marks per question and section totals
5. Keep the SAME number of questions per section
6. Only replace the question content with the new questions
7. Distribute new questions across sections matching the original structure
8. If teacher gave fewer questions than needed, write "[Question to be filled]"
9. Maintain identical question numbering style

OUTPUT FORMAT:
- Output ONLY valid HTML with inline CSS
- No markdown, no explanation, no code fences
- White background, Arial or Times New Roman font, 12-13pt
- Proper A4 margins and spacing
- Must look like a real printed exam paper
- No html head body tags — just the content`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.05,
        max_tokens: 4096
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error(`Groq ${groqRes.status}: ${errText.substring(0, 300)}`);
    }

    const data = await groqRes.json();
    let output = data.choices?.[0]?.message?.content || '';

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
  body   { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; }
  h1, h2 { font-family: Arial, sans-serif; }
  p      { margin: 4px 0; }
  strong { font-weight: bold; }
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
    console.error('[docx export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START — local only, Vercel uses module.exports
// ─────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅  PaperCraft running → http://localhost:${PORT}`);
    console.log(`    Groq Key : ${process.env.GROQ_API_KEY ? '✓ Set' : '✗ MISSING'}\n`);
  });
}

module.exports = app;
