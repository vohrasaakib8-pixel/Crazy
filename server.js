const express = require('express');
const app = express();
const KEY = process.env.TWELVEDATA_KEY;
const NTFY = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const TOPIC = process.env.NTFY_TOPIC;
const TTL = { '1min': 55e3, '5min': 120e3, '15min': 180e3, '30min': 600e3, '1h': 600e3, '4h': 900e3 };
const cache = {};

async function getCandles(iv) {
  if (!KEY) throw new Error('TWELVEDATA_KEY is not set on the server');
  const hit = cache[iv];
  if (hit && Date.now() - hit.t < TTL[iv]) return hit.d;
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${iv}&outputsize=300&order=ASC&timezone=UTC&apikey=${KEY}`);
  const j = await r.json();
  if (j.status === 'error') throw new Error(j.message);
  const d = j.values.map(v => ({
    time: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000),
    open: +v.open, high: +v.high, low: +v.low, close: +v.close
  }));
  cache[iv] = { t: Date.now(), d };
  return d;
}

app.get('/api/candles', async (req, res) => {
  const iv = req.query.interval || '15min';
  if (!TTL[iv]) return res.status(400).json({ error: 'bad interval' });
  try { res.json(await getCandles(iv)); } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- signal engine (same rules as the page) ---------- */
const ema = (v, n) => { const k = 2 / (n + 1); let p = v[0]; return v.map((x, i) => i ? (p = x * k + p * (1 - k)) : p); };
function rsi(c, n = 14) { let g = 0, l = 0; const o = Array(c.length).fill(50); for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0); if (i <= n) { g += u / n; l += w / n; } else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + w) / n; } if (i >= n) o[i] = l ? 100 - 100 / (1 + g / l) : 100; } return o; }
function bands(c, n = 20) { return c.map((_, i) => { if (i < n - 1) return null; const s = c.slice(i - n + 1, i + 1), m = s.reduce((a, b) => a + b) / n, sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n); return { u: m + 2 * sd, l: m - 2 * sd }; }); }
const toCall = s => s >= 2 ? 'BUY' : s <= -2 ? 'SELL' : 'WAIT';
function atr(d, n = 14) { const t = d.slice(-n).map((x, i, a) => { const pc = i ? a[i - 1].close : d[d.length - n - 1].close; return Math.max(x.high - x.low, Math.abs(x.high - pc), Math.abs(x.low - pc)); }); return t.reduce((a, b) => a + b) / n; }
function analyse(d) {
  const c = d.map(x => x.close), e9 = ema(c, 9), e21 = ema(c, 21), e12 = ema(c, 12), e26 = ema(c, 26);
  const mc = e12.map((x, i) => x - e26[i]), h = mc.map((x, i) => x - ema(mc, 9)[i]), r = rsi(c), b = bands(c), i = c.length - 1;
  const s = (e9[i] > e21[i] ? 1 : -1) + (h[i] > 0 && h[i] > h[i - 1] ? 1 : h[i] < 0 && h[i] < h[i - 1] ? -1 : 0) + (r[i] < 35 ? 1 : r[i] > 65 ? -1 : 0) + (c[i] < b[i].l ? 1 : c[i] > b[i].u ? -1 : 0);
  return toCall(s);
}

/* ---------- ntfy alerts ---------- */
const GROUPS = {
  scalp: { tfs: ['1min', '5min'], entryTf: '1min', atrTf: '5min', cooldown: 15 * 60e3, every: (+process.env.SCALP_MIN || 10) * 60e3 },
  mid: { tfs: ['15min', '30min'], entryTf: '15min', atrTf: '30min', cooldown: 30 * 60e3, every: (+process.env.MID_MIN || 15) * 60e3 }
};
const last = { scalp: { sig: 'WAIT', at: 0 }, mid: { sig: 'WAIT', at: 0 } };
async function ntfy(title, body, priority = 'high', tags = 'chart_with_upwards_trend') {
  if (!TOPIC) throw new Error('NTFY_TOPIC is not set on the server');
  const r = await fetch(`${NTFY}/${encodeURIComponent(TOPIC)}`, { method: 'POST', body, headers: { Title: title, Priority: priority, Tags: tags } });
  if (!r.ok) throw new Error('ntfy returned ' + r.status);
}
async function levels(g) {
  const G = GROUPS[g], all = {};
  await Promise.all([...new Set([...G.tfs, G.entryTf, G.atrTf])].map(async t => { all[t] = await getCandles(t); }));
  const calls = G.tfs.map(t => analyse(all[t]));
  const e = all[G.entryTf];
  return { calls, entry: e[e.length - 1].close, a: atr(all[G.atrTf]) };
}
function message(g, sig, entry, a) {
  const dir = sig === 'BUY' ? 1 : -1, f = x => x.toFixed(2);
  const sl = entry - dir * 1.5 * a, tp1 = entry + dir * 1.5 * a, tp2 = entry + dir * 3 * a;
  return `Entry: ${f(entry)}\nStop loss: ${f(sl)}\nTake profit 1: ${f(tp1)} (1:1)\nTake profit 2: ${f(tp2)} (1:2)\nAll of ${GROUPS[g].tfs.join(', ')} agree.`;
}
async function check(g) {
  try {
    const { calls, entry, a } = await levels(g);
    const sig = calls.every(x => x === 'BUY') ? 'BUY' : calls.every(x => x === 'SELL') ? 'SELL' : 'WAIT';
    const L = last[g];
    if (sig === 'WAIT') { L.sig = 'WAIT'; return; }
    if (sig === L.sig) return;                           // already alerted this move
    if (Date.now() - L.at < GROUPS[g].cooldown) return;
    await ntfy(`${sig} XAUUSD (${g})`, message(g, sig, entry, a), 'high', sig === 'BUY' ? 'green_circle' : 'red_circle');
    last[g] = { sig, at: Date.now() };
  } catch (e) { console.error(g + ' check failed:', e.message); }
}
if (TOPIC && KEY) {
  setInterval(() => check('scalp'), GROUPS.scalp.every); setTimeout(() => check('scalp'), 15e3);
  setInterval(() => check('mid'), GROUPS.mid.every); setTimeout(() => check('mid'), 45e3);
}

app.get('/api/test', async (req, res) => {
  try {
    const { entry, a } = await levels('mid');
    await ntfy('TEST XAUUSD', 'Test alert (example levels)\n' + message('mid', 'BUY', entry, a), 'default', 'test_tube');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/health', (_, res) => res.send('ok'));

app.use(express.static('public'));
app.listen(process.env.PORT || 3000);
