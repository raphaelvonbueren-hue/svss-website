// Vercel Serverless Function: KI-Übersetzung via Vercel AI Gateway (+ Supabase-Cache)
// POST { target: 'fr'|'it'|'rm'|'en', texts: [string] } -> { translations: [string] }
// Env (im Vercel-Projekt setzen):
//   AI_GATEWAY_API_KEY   (Pflicht)  – Vercel AI Gateway Key
//   AI_MODEL             (optional) – Default 'anthropic/claude-sonnet-4'
//   AI_GATEWAY_URL       (optional) – Default 'https://ai-gateway.vercel.sh/v1/chat/completions'
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (optional) – fürs Cachen der Übersetzungen
const crypto = require('crypto');
const LANGNAME = { de:'Deutsch', fr:'Französisch', it:'Italienisch', rm:'Rätoromanisch (Rumantsch Grischun)', en:'Englisch' };
const sha = (s)=>crypto.createHash('sha256').update(s,'utf8').digest('hex');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
    const target = body.target;
    let texts = Array.isArray(body.texts) ? body.texts.filter(t=>typeof t==='string' && t.trim()) : [];
    if (!LANGNAME[target]) return res.status(400).json({ error: 'bad target' });
    if (target === 'de' || !texts.length) return res.status(200).json({ translations: texts });
    texts = texts.slice(0, 60);
    if (texts.some(t=>t.length > 5000)) return res.status(400).json({ error: 'text too long' });

    const KEY = process.env.AI_GATEWAY_API_KEY;
    const MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4';
    const URL = process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1/chat/completions';
    if (!KEY) return res.status(500).json({ error: 'AI_GATEWAY_API_KEY missing' });

    const prompt = `Übersetze die folgenden Texte einer Schweizer Vereinswebsite (Thema Spielplatzsicherheit) von Deutsch nach ${LANGNAME[target]}. Behalte HTML-Tags, Platzhalter (z.B. {x}, %s), Zahlen sowie Eigen-/Firmennamen unverändert. Gib AUSSCHLIESSLICH ein JSON-Array mit den Übersetzungen in exakt derselben Reihenfolge zurück, ohne Erklärungen.\n\n${JSON.stringify(texts)}`;
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) return res.status(502).json({ error: 'AI error: ' + (await r.text()).slice(0, 300) });
    const data = await r.json();
    let txt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    const a = txt.indexOf('['), b = txt.lastIndexOf(']');
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
    let arr; try { arr = JSON.parse(txt); } catch (e) { return res.status(502).json({ error: 'parse fail' }); }
    const out = texts.map((s,i)=> (typeof arr[i] === 'string' ? arr[i] : s));

    // Cache nach Supabase (best effort)
    const SU = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (SU && SK) {
      const rows = texts.map((s,i)=>({ src_hash: sha(s), lang: target, src: s.slice(0,500), text: out[i] }));
      try {
        await fetch(`${SU}/rest/v1/translations`, {
          method: 'POST',
          headers: { 'apikey': SK, 'Authorization': `Bearer ${SK}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows)
        });
      } catch (e) { /* Cache-Fehler ignorieren */ }
    }
    return res.status(200).json({ translations: out });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
