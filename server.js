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
// HELPER — clean HTML to readable plain text
// ─────────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '$1')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '$1')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// HELPER — call OpenRouter with model fallback
// ─────────────────────────────────────────────────────────────

// Free models in order of preference — if one fails, next is tried
const FREE_MODELS = [
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'qwen/qwen-2.5-7b-instruct:free'
];

async function callAI(systemMsg, userMsg, maxTokens = 6000) {
  const errors = [];

  for (const model of FREE_MODELS) {
    try {
      console.log(`[ai] trying: ${model}`);

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.APP_URL || 'https://papercraft.vercel.app',
          'X-Title': 'PaperCraft'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user',   content: userMsg   }
          ],
          temperature: 0.0,
          max_tokens: maxTokens
        })
      });

      const raw = await res.text();

      if (!res.ok) {
        const msg = `${model} → ${res.status}: ${raw.substring(0, 120)}`;
        console.warn(`[ai] FAIL: ${msg}`);
        errors.push(msg);
        continue;
      }

      let data;
      try { data = JSON.parse(raw); } catch(e) {
        errors.push(`${model} → JSON parse failed`);
        continue;
      }

      const text = data.choices?.[0]?.message?.content || '';
      if (!text) {
        errors.push(`${model} → empty response`);
        continue;
      }

      console.log(`[ai] SUCCESS: ${model}`);
      return text;

    } catch (err) {
      const msg = `${model} → ${err.message}`;
      console.warn(`[ai] ERROR: ${msg}`);
      errors.push(msg);
    }
  }

  throw new Error('All models failed:\n' + errors.join('\n'));
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
    if (!process.env.OPENROUTER_API_KEY)
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in environment variables', success: false });

    const originalText = htmlToText(formatHtml);

    const system = `You are an expert Indian school question paper formatter.
You produce perfectly formatted, professional, print-ready HTML question papers.
You read the original paper carefully and copy ALL details — school name, exam title, subject, class, time, marks, instructions, section names, section instructions — WORD FOR WORD.
You NEVER invent, guess, or use placeholder text.
Output ONLY raw HTML with inline CSS. No markdown. No explanation. No code fences.`;

    const user = `Create a new question paper. The format must be IDENTICAL to the original. Only the question text changes.

══════════════════════════════════════
ORIGINAL PAPER — copy everything from here WORD FOR WORD except questions:
══════════════════════════════════════
${originalText}

══════════════════════════════════════
NEW QUESTIONS — use ALL of these:
══════════════════════════════════════
${questions}

══════════════════════════════════════
STRICT RULES:
══════════════════════════════════════
1. School name → EXACT copy from original
2. Exam title → EXACT copy from original
3. Subject, Class → EXACT copy from original
4. Time, Date, Max Marks → EXACT copy from original
5. Student fields (Name, Roll No, Checked By, Rechecked By) → EXACT copy from original
6. General Instructions → EXACT copy from original, every word
7. Each Section name → EXACT copy from original
8. Each Section instruction → EXACT copy from original, every word
9. Marks per question → EXACT same as original
10. Number of questions per section → EXACT same count as original
11. Use ALL teacher's questions. Distribute proportionally across sections.
12. Questions numbered continuously: Q1, Q2, Q3... across all sections
13. NEVER write placeholder text. NEVER invent instructions.
14. Only the question text itself changes.

══════════════════════════════════════
HTML OUTPUT — build it exactly like this:
══════════════════════════════════════

The paper must look like a real Indian school printed exam paper with:

OUTER WRAPPER:
<div style="max-width:780px;margin:0 auto;padding:30px;border:3px double #000;font-family:Arial,sans-serif;font-size:12pt;color:#000;line-height:1.8;background:#fff;">

SCHOOL HEADER (centered):
- School name: bold, 20pt, ALL CAPS, centered
- Exam title: bold, 14pt, centered
- Subject and Class: 12pt, centered
- Thin HR line: <hr style="border:none;border-top:1.5px solid #000;margin:8px 0;">

TIME / DATE / MARKS ROW (use a table):
<table style="width:100%;border-collapse:collapse;margin:6px 0;font-size:11pt;">
  <tr>
    <td style="text-align:left;">Time: [value from original]</td>
    <td style="text-align:center;">M.M.: [value from original]</td>
    <td style="text-align:right;">Date: [value from original]</td>
  </tr>
</table>

STUDENT INFO (use a bordered table):
<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:11pt;">
  <tr>
    <td style="border:1px solid #000;padding:4px 8px;width:40%;">Name: _______________________</td>
    <td style="border:1px solid #000;padding:4px 8px;width:30%;">Roll No.: ____________</td>
    <td style="border:1px solid #000;padding:4px 8px;width:30%;">Checked By: __________</td>
  </tr>
</table>

Thick HR: <hr style="border:none;border-top:2px solid #000;margin:10px 0;">

GENERAL INSTRUCTIONS:
<p style="font-weight:bold;margin:8px 0 4px;">General Instructions:</p>
<ol style="margin:0 0 10px 22px;font-size:11pt;line-height:1.7;">
  [copy each instruction from original as a separate <li>]
</ol>

EACH SECTION:
<p style="font-weight:bold;font-size:13pt;text-decoration:underline;margin:18px 0 4px;">Section A</p>
<p style="font-style:italic;font-size:11pt;margin:0 0 10px;">[section instruction from original]</p>

EACH QUESTION (use this table — no outer border):
<table style="width:100%;border-collapse:collapse;margin:5px 0;">
  <tr>
    <td style="width:42px;vertical-align:top;font-weight:bold;white-space:nowrap;">Q1.</td>
    <td style="vertical-align:top;">[question text]</td>
    <td style="width:72px;vertical-align:top;text-align:right;white-space:nowrap;font-size:11pt;">[1 mark]</td>
  </tr>
</table>

For fill-in-the-blank questions use: _______________ inside the sentence.

CLOSING:
<hr style="border:none;border-top:1px solid #000;margin:30px 0 8px;">
<p style="text-align:center;font-weight:bold;font-size:11pt;">*** End of Question Paper ***</p>

</div>

Now generate the complete paper:`;

    let output = await callAI(system, user, 6000);

    // Strip markdown fences if any
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
  body  { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #000; }
  p     { margin: 4px 0; }
  strong{ font-weight: bold; }
  em    { font-style: italic; }
  hr    { border: 1px solid #000; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; }
  td    { padding: 3px 6px; }
  ol,ul { margin: 4px 0 4px 20px; }
</style></head>
<body>${html}</body></html>`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      table:      { row: { cantSplit: true } },
      footer:     false,
      pageNumber: false,
      margins:    { top: 600, right: 800, bottom: 600, left: 800 }
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
    console.log(`    OpenRouter Key: ${process.env.OPENROUTER_API_KEY ? '✓ Set' : '✗ MISSING'}\n`);
  });
}

module.exports = app;
