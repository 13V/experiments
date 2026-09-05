// Vercel serverless function (Node runtime). Candles for a Robinhood Chain pool, from
// GeckoTerminal, so that every visitor shares one edge-cached answer instead of each browser
// spending its own share of GeckoTerminal's per-IP allowance.
//
//   GET /api/ohlcv?pool=0x...&tf=15m|1h|1d[&limit=96]
//   -> { candles: [[t, o, h, l, c, v], ...] oldest first, tf, pool, ts }
//   GET /api/ohlcv?pools=0x...,0x...&tf=1h&limit=24        (up to 24 pools, for sparklines)
//   -> { series: { "0x...": [[t,o,h,l,c,v], ...] | null }, tf, ts }
//
// Pool ids are the same 32-byte Uniswap v4 ids DexScreener reports as pairAddress.

const NETWORK = 'robinhood';
const UA = 'Mozilla/5.0 (compatible; Locate/1.0; +https://robinhoodchain.blockscout.com)';
const TF = {
  '15m': { path: 'minute?aggregate=15', ttl: 30, max: 300 },
  '1h':  { path: 'hour?aggregate=1',    ttl: 60, max: 300 },
  '1d':  { path: 'day?aggregate=1',     ttl: 300, max: 300 },
};
const CONCURRENCY = 4;
const memo = new Map(); // `${pool}|${tf}|${limit}` -> { ts, data }

async function fetchCandles(pool, tf, limit, attempt = 0) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool}/ohlcv/${TF[tf].path}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    return fetchCandles(pool, tf, limit, attempt + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
  const body = await res.json();
  const list = (((body || {}).data || {}).attributes || {}).ohlcv_list || [];
  // GeckoTerminal is newest-first; the chart wants oldest-first
  return list.map((k) => k.map(Number)).sort((a, b) => a[0] - b[0]);
}

async function lookup(pool, tf, limit) {
  const key = `${pool}|${tf}|${limit}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.ts < TF[tf].ttl * 1000) return hit.data;
  const data = await fetchCandles(pool, tf, limit);
  memo.set(key, { ts: Date.now(), data });
  return data;
}

const isPool = (p) => /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(p);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const q = req.query || {};
  const tf = String(q.tf || '1h');
  if (!TF[tf]) { res.setHeader('Cache-Control', 'no-store'); res.status(400).json({ error: 'tf must be 15m, 1h or 1d' }); return; }
  const limit = Math.max(2, Math.min(TF[tf].max, parseInt(q.limit, 10) || (q.pools ? 24 : 96)));
  const ttl = TF[tf].ttl;

  if (q.pools) {
    const pools = [...new Set(String(q.pools).split(',').map((p) => p.trim().toLowerCase()).filter(isPool))].slice(0, 24);
    if (!pools.length) { res.setHeader('Cache-Control', 'no-store'); res.status(400).json({ error: 'pass ?pools=0x...,0x...' }); return; }
    const series = {};
    let failures = 0;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pools.length) }, async () => {
      while (i < pools.length) {
        const p = pools[i++];
        try { series[p] = await lookup(p, tf, limit); } catch { failures++; }
      }
    }));
    res.setHeader('Cache-Control', failures === 0 ? `s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}` : 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json({ series, tf, failures, ts: Math.floor(Date.now() / 1000) });
    return;
  }

  const pool = String(q.pool || '').trim().toLowerCase();
  if (!isPool(pool)) { res.setHeader('Cache-Control', 'no-store'); res.status(400).json({ error: 'pass ?pool=0x...' }); return; }
  try {
    const candles = await lookup(pool, tf, limit);
    res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}`);
    res.status(200).json({ candles, tf, pool, ts: Math.floor(Date.now() / 1000) });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
