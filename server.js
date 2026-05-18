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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── strip HTML to clean short plain text ──────────────────────
function compress(html, limit) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/\s+/g,' ').trim()
    .substring(0, limit);
}

// ── Groq call with smart retry ────────────────────────────────
async function groq(prompt, tokens) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model:      'llama-3.1-8b-instant',
        messages:   [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens:  tokens
      })
    });

    if (r.ok) {
      const d = await r.json();
      return d.choices?.[0]?.message?.content || '';
    }

    const e = await r.json().catch(() => ({}));

    if (r.status === 429 && attempt < 4) {
      const sec   = (e?.error?.message || '').match(/try again in ([\d.]+)s/i);
      const wait  = sec ? Math.ceil(parseFloat(sec[1])) * 1000 + 1000 : 20000;
      console.log(`[groq] 429 — waiting ${wait}ms then retry ${attempt}/4`);
      await new Promise(ok => setTimeout(ok, wait));
      continue;
    }

    throw new Error(e?.error?.message || `Groq ${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// STEP 1 — extract format: send ONLY the structure (no questions)
// Returns a tiny JSON blueprint of the paper
// ═══════════════════════════════════════════════════════════════
async function extractFormat(rawText) {
  // Keep only first 1200 chars — enough for header + section names
  const snippet = rawText.substring(0, 1200);

  const p = `Read this question paper snippet and return ONLY a JSON object. No other text.
Paper:
${snippet}

JSON format:
{"school":"...","exam":"...","subject":"...","class":"...","time":"...","marks":"...","date":"...","fields":["Name: ___","Roll No: ___"],"instructions":["inst1","inst2"],"sections":[{"name":"Section A","instruction":"Attempt all","qcount":5,"qmarks":"1","type":"MCQ"}]}`;

  const out = await groq(p, 600);
  const m   = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Could not read paper format. Please try again.');
  return JSON.parse(m[0]);
}

// ═══════════════════════════════════════════════════════════════
// STEP 2 — generate HTML using blueprint + questions
// Two separate small calls instead of one huge call
// ═══════════════════════════════════════════════════════════════
async function buildPaper(fmt, questions) {
  const qs = questions.substring(0, 1200);

  const p = `You are a school question paper formatter. Output ONLY raw HTML, no markdown.

PAPER DETAILS (use these EXACTLY):
School: ${fmt.school}
Exam: ${fmt.exam}
Subject: ${fmt.subject}
Class: ${fmt.class}
Time: ${fmt.time} | Marks: ${fmt.marks} | Date: ${fmt.date || '________'}
Student fields: ${(fmt.fields||[]).join(' | ')}
General Instructions: ${(fmt.instructions||[]).join(' / ')}
Sections: ${JSON.stringify(fmt.sections)}

NEW QUESTIONS (distribute across sections in order):
${qs}

BUILD this HTML paper:

<div style="max-width:780px;margin:0 auto;padding:30px 35px;border:3px double #000;font-family:Arial,sans-serif;font-size:12pt;color:#000;line-height:1.8;background:#fff;">

1. SCHOOL HEADER — centered:
   School name: bold 20pt
   Exam title: bold 13pt
   Subject | Class: 12pt
   <hr style="border:2px solid #000;margin:8px 0">
   Time / Marks / Date in one table row (left | center | right)
   Student info in bordered table cells (Name ___ | Roll No ___ | Checked By ___)
   <hr style="border:1px solid #000;margin:8px 0">

2. GENERAL INSTRUCTIONS — bold heading + numbered list 11pt

3. FOR EACH SECTION:
   Section name: bold underlined 13pt
   Section instruction: italic 11pt
   Each question as:
   <table style="width:100%;margin:4px 0"><tr>
     <td style="width:40px;font-weight:bold;vertical-align:top">Q1.</td>
     <td style="vertical-align:top">question text here</td>
     <td style="width:70px;text-align:right;vertical-align:top;white-space:nowrap">[1 mark]</td>
   </tr></table>

4. END: <hr><p style="text-align:center;font-weight:bold">*** End of Question Paper ***</p>

RULES:
- Copy school/exam/subject/class/time/marks/instructions from PAPER DETAILS above — EXACTLY
- Distribute ALL questions across sections proportionally
- Number questions Q1,Q2,Q3... continuously across all sections
- For fill-in-blank: use ___________ in the sentence
- Output complete HTML only`;

  let out = await groq(p, 2500);
  return out.replace(/^```html\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', success: false });
    const { buffer, originalname, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let html = '';

    if (ext === '.docx' || mimetype.includes('wordprocessingml')) {
      html = (await mammoth.convertToHtml({ buffer })).value;
    } else if (ext === '.pdf' || mimetype === 'application/pdf') {
      const d = await pdfParse(buffer);
      html = d.text.split('\n').map(l => `<p>${l.trim()}</p>`).join('');
    } else if (ext === '.txt') {
      html = buffer.toString('utf8').split('\n').map(l => `<p>${l}</p>`).join('');
    } else {
      return res.status(400).json({ error: 'Please upload .docx or .pdf', success: false });
    }

    res.json({ html, success: true });
  } catch (err) {
    console.error('[extract]', err.message);
    res.status(500).json({ error: err.message, success: false });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { formatHtml, questions } = req.body;
    if (!formatHtml) return res.status(400).json({ error: 'No format provided', success: false });
    if (!questions)  return res.status(400).json({ error: 'No questions provided', success: false });
    if (!process.env.GROQ_API_KEY)
      return res.status(500).json({ error: 'GROQ_API_KEY not set', success: false });

    // Two small calls instead of one giant call — stays under token limit
    const rawText = compress(formatHtml, 2000);
    const fmt     = await extractFormat(rawText);
    const html    = await buildPaper(fmt, questions);

    if (!html) throw new Error('Empty response. Please try again.');
    res.json({ html, success: true });

  } catch (err) {
    console.error('[generate]', err.message);
    res.status(500).json({ error: err.message, success: false });
  }
});

app.post('/api/export/docx', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided' });

    const full = `<!DOCTYPE html><html><head><style>
      body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.8;color:#000;}
      p{margin:4px 0;} strong{font-weight:bold;} hr{border:1px solid #000;margin:8px 0;}
      table{width:100%;border-collapse:collapse;} td{padding:2px 4px;}
    </style></head><body>${html}</body></html>`;

    const buf = await HTMLtoDOCX(full, null, {
      table: { row: { cantSplit: true } },
      margins: { top: 600, right: 800, bottom: 600, left: 800 }
    });

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition','attachment; filename="question_paper.docx"');
    res.send(buf);
  } catch (err) {
    console.error('[docx]', err.message);
    res.status(500).json({ error: err.message });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✅  PaperCraft → http://localhost:${PORT}`);
    console.log(`    Groq: ${process.env.GROQ_API_KEY ? '✓' : '✗ MISSING'}\n`);
  });
}

module.exports = app;
