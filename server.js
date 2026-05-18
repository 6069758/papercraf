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
// HELPER — strip HTML tags, collapse whitespace, trim to limit
// ─────────────────────────────────────────────────────────────
function cleanAndTrim(html, maxChars = 2000) {
  return html
    .replace(/<[^>]+>/g, ' ')   // remove all HTML tags
    .replace(/&nbsp;/g, ' ')    // remove &nbsp;
    .replace(/\s+/g, ' ')       // collapse whitespace
    .trim()
    .substring(0, maxChars);    // hard limit
}

// ─────────────────────────────────────────────────────────────
// HELPER — call Groq with auto-retry on 429
// ─────────────────────────────────────────────────────────────
async function callGroq(systemMsg, userMsg, maxTokens = 3000, retries = 3) {
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

    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }

    if ((res.status === 429 || res.status === 413) && attempt < retries) {
      const errData = await res.json().catch(() => ({}));
      const msg     = errData?.error?.message || '';
      const match   = msg.match(/try again in ([\d.]+)s/i);
      const wait    = match ? Math.ceil(parseFloat(match[1])) * 1000 : 20000;
      console.log(`[groq] ${res.status} — waiting ${wait}ms, retry ${attempt}/${retries}`);
      await new Promise(r => setTimeout(r, wait + 1000));
      continue;
    }

    const errText = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${errText.substring(0, 200)}`);
  }
  throw new Error('Still rate limited after retries. Please wait 1 minute and try again.');
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
// 2. GENERATE
// ─────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { formatHtml, questions } = req.body;

    if (!formatHtml) return res.status(400).json({ error: 'No format provided', success: false });
    if (!questions)  return res.status(400).json({ error: 'No questions provided', success: false });
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY not set', success: false });

    // Strip HTML and hard-trim to stay under token limit
    const cleanFormat    = cleanAndTrim(formatHtml, 2000);
    const cleanQuestions = questions.substring(0, 1500);

    const system = `You are an expert question paper formatter.
Output ONLY raw HTML with inline CSS. No markdown. No explanation. No code fences.`;

    const user = `Create a new question paper. Copy the original format EXACTLY. Only replace the questions.

ORIGINAL FORMAT:
${cleanFormat}

NEW QUESTIONS:
${cleanQuestions}

RULES:
1. Copy school name, subject, class, date, time, marks WORD FOR WORD
2. Copy all section names and instructions WORD FOR WORD
3. Keep SAME number of questions per section and SAME marks
4. Continue question numbering across sections
5. If not enough questions given, write [To be added]
6. Change ONLY the question text

HTML OUTPUT:
<style>@media print{body{margin:0;}}</style>
<div style="max-width:800px;margin:0 auto;padding:50px;font-family:Arial,sans-serif;font-size:13pt;line-height:1.9;color:#111;">
  School name: centered, bold, 20pt
  Exam details: centered
  <hr style="border:2px solid #000;margin:16px 0;">
  General instructions: bold heading then numbered list, 11pt
  Section heading: bold, underlined, 14pt, margin-top:28px
  Section instructions: italic, 11pt
  Each question: <p><strong>Q1.</strong> text <span style="float:right;">[2 marks]</span></p>
  <div style="clear:both;"></div> after each section
  End: <p style="text-align:center;margin-top:40px;font-weight:bold;">*** End of Question Paper ***</p>
</div>`;

    let output = await callGroq(system, user, 3000);

    output = output
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .trim();

    if (!output) throw new Error('Empty response. Please try again.');

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
  body   { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; }
  p      { margin: 6px 0; }
  strong { font-weight: bold; }
  em     { font-style: italic; }
  hr     { border: 1px solid #000; margin: 10px 0; }
  ol,ul  { margin: 4px 0 4px 24px; }
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
