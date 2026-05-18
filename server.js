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
// HELPER — preserve structure while removing HTML tags
// ─────────────────────────────────────────────────────────────
function htmlToText(html, maxChars = 2500) {
  return html
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '[$1]') // mark bold text
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, maxChars);
}

// ─────────────────────────────────────────────────────────────
// HELPER — call Groq with auto-retry
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
  throw new Error('Rate limited. Please wait 1 minute and try again.');
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
      html = data.text.split('\n').map(l => `<p>${l.trim()}</p>`).join('\n');
    } else if (ext === '.txt') {
      html = buffer.toString('utf8').split('\n').map(l => `<p>${l}</p>`).join('\n');
    } else {
      return res.status(400).json({ error: 'Upload .docx or .pdf only', success: false });
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

    const cleanFormat    = htmlToText(formatHtml, 2200);
    const cleanQuestions = questions.substring(0, 1500);

    const system = `You are an expert school question paper formatter.
You produce perfectly formatted, print-ready HTML question papers that look exactly like real school exams.
Output ONLY raw HTML. No markdown. No explanation. No code fences. Nothing else.`;

    const user = `Create a new question paper using the EXACT same format as the original. Only the questions change.

ORIGINAL PAPER FORMAT:
---
${cleanFormat}
---

NEW QUESTIONS FROM TEACHER:
---
${cleanQuestions}
---

STRICT RULES:
1. Copy school name, exam title, subject, class, date, time, max marks — EXACTLY word for word
2. Copy section names (Section A, Section B, etc.) — EXACTLY
3. Copy section instructions (e.g. "Fill in the blanks", "Attempt all") — EXACTLY word for word
4. Copy general instructions — EXACTLY word for word
5. Keep the SAME number of questions per section as the original
6. Keep the SAME marks per question as the original
7. Distribute ALL the teacher's new questions across sections. Use ALL of them.
8. Number questions continuously: Q1, Q2, Q3... across all sections
9. If teacher gave fewer questions than sections need — write [To be added]
10. ONLY the question text changes — everything else stays the same

HTML FORMAT RULES — follow exactly:

Use this structure for the paper:

<div style="max-width:780px;margin:0 auto;padding:40px;font-family:Arial,sans-serif;font-size:12pt;color:#000;background:#fff;line-height:1.7;">

<!-- HEADER -->
<p style="text-align:center;font-size:18pt;font-weight:bold;margin:0 0 4px 0;">SCHOOL NAME HERE</p>
<p style="text-align:center;font-size:13pt;font-weight:bold;margin:0 0 2px 0;">EXAM TITLE HERE</p>
<p style="text-align:center;margin:0 0 2px 0;">SUBJECT NAME &nbsp;&nbsp;|&nbsp;&nbsp; CLASS HERE</p>
<hr style="border:none;border-top:2px solid #000;margin:10px 0;">
<table style="width:100%;border-collapse:collapse;margin-bottom:6px;">
  <tr>
    <td style="text-align:left;font-size:11pt;">Time: TIME HERE</td>
    <td style="text-align:center;font-size:11pt;">Date: DATE HERE</td>
    <td style="text-align:right;font-size:11pt;">Max Marks: MARKS HERE</td>
  </tr>
</table>
<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
  <tr>
    <td style="font-size:11pt;">Name: ____________________________</td>
    <td style="font-size:11pt;">Roll No.: ____________</td>
    <td style="font-size:11pt;">Checked By: ____________</td>
  </tr>
</table>
<hr style="border:none;border-top:1px solid #000;margin:10px 0;">

<!-- GENERAL INSTRUCTIONS -->
<p style="font-weight:bold;margin:10px 0 4px 0;">General Instructions:</p>
<ol style="margin:0 0 12px 20px;font-size:11pt;">
  <li>Each instruction on its own line</li>
</ol>

<!-- SECTION -->
<p style="font-weight:bold;font-size:13pt;text-decoration:underline;margin:20px 0 4px 0;">Section A</p>
<p style="font-style:italic;font-size:11pt;margin:0 0 10px 0;">Section instruction here.</p>

<!-- QUESTIONS — use this table layout for EVERY question, no exceptions -->
<table style="width:100%;border-collapse:collapse;margin:6px 0;">
  <tr>
    <td style="width:38px;vertical-align:top;font-weight:bold;padding-right:6px;">Q1.</td>
    <td style="vertical-align:top;">Question text goes here</td>
    <td style="width:75px;vertical-align:top;text-align:right;white-space:nowrap;font-size:11pt;">[1 mark]</td>
  </tr>
</table>

<table style="width:100%;border-collapse:collapse;margin:6px 0;">
  <tr>
    <td style="width:38px;vertical-align:top;font-weight:bold;padding-right:6px;">Q2.</td>
    <td style="vertical-align:top;">Question text goes here</td>
    <td style="width:75px;vertical-align:top;text-align:right;white-space:nowrap;font-size:11pt;">[1 mark]</td>
  </tr>
</table>

<!-- repeat table for every question -->

<!-- END -->
<p style="text-align:center;margin-top:40px;font-weight:bold;border-top:1px solid #000;padding-top:10px;">*** End of Question Paper ***</p>

</div>

CRITICAL: Use the TABLE layout for EVERY single question. Never use float:right. Never use span for marks.
CRITICAL: Place marks on the RIGHT side of each question row, in the third table column.
CRITICAL: Use ALL the teacher's questions — distribute them across sections proportionally.`;

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
  body   { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #000; }
  p      { margin: 4px 0; }
  strong { font-weight: bold; }
  em     { font-style: italic; }
  hr     { border: 1px solid #000; margin: 8px 0; }
  table  { width: 100%; border-collapse: collapse; }
  ol,ul  { margin: 4px 0 4px 20px; }
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
