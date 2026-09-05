// Vercel serverless function (Node runtime). Candles for a Robinhood Chain pool, from
// GeckoTerminal, so that every visitor shares one edge-cached answer instead of each browser
// spending its own share of GeckoTerminal's per-IP allowance.
//
//   GET /api/ohlcv?pool=0x...&tf=15m|1h|1d[&limit=96][&cg=<coingecko coin id>]
//   -> { candles: [[t, o, h, l, c, v], ...] oldest first, source, tf, pool, ts }
//      When GeckoTerminal is refusing us and `cg` is given, the answer comes from CoinGecko's
//      price history instead: the last day's five-minute prices bucketed into candles for 15m
//      and 1h (source "coingecko"), and ninety days of daily prices as { line: [[t, p], ...] } for
//      1d. A different API with its own allowance, so one bad minute on one does not blank the chart.
//   GET /api/ohlcv?pools=0x...,0x...&tf=1h&limit=24        (up to 24 pools, for sparklines)
//   -> { series: { "0x...": [[t,o,h,l,c,v], ...] | null }, tf, ts }
//
// Pool ids are the same 32-byte Uniswap v4 ids DexScreener reports as pairAddress.

const NETWORK = 'robinhood';
const UA = 'Mozilla/5.0 (compatible; Locate/1.0; +https://robinhoodchain.blockscout.com)';
// ttl is how long an answer is fresh; a stale one is still served when GeckoTerminal is
// unreachable or rate-limiting, because an hour-old chart beats an error
const TF = {
  '15m': { path: 'minute?aggregate=15', ttl: 90, max: 300 },
  '1h':  { path: 'hour?aggregate=1',    ttl: 120, max: 300 },
  '1d':  { path: 'day?aggregate=1',     ttl: 600, max: 300 },
};
const STALE_MS = 6 * 3600 * 1000;
const CG_TTL_MS = 120 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCoingecko(cgId, tf, attempt = 0) {
  const days = tf === '1d' ? 90 : 1;
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=usd&days=${days}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); return fetchCoingecko(cgId, tf, attempt + 1); }
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const prices = (((await res.json()) || {}).prices || []).map(([t, p]) => [Math.floor(t / 1000), Number(p)]).filter((x) => x[1] > 0).sort((a, b) => a[0] - b[0]);
  if (!prices.length) return null;
  if (tf === '1d') return { line: prices };
  const bucket = tf === '15m' ? 900 : 3600;
  const map = new Map();
  for (const [t, p] of prices) {
    const k = Math.floor(t / bucket) * bucket; const c = map.get(k);
    if (!c) map.set(k, [k, p, p, p, p, 0]); else { if (p > c[2]) c[2] = p; if (p < c[3]) c[3] = p; c[4] = p; }
  }
  return { candles: [...map.values()] };
}
const CONCURRENCY = 4;
const memo = new Map(); // `${pool}|${tf}|${limit}` -> { ts, data }

async function fetchCandles(pool, tf, limit, attempt = 0) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool}/ohlcv/${TF[tf].path}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    // GeckoTerminal meters bursts; wait what it asks for, else a growing pause (1.2s, 2.4s, 3.6s)
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, Math.min(4000, ra > 0 ? ra * 1000 : 1200 * (attempt + 1))));
    return fetchCandles(pool, tf, limit, attempt + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
  const body = await res.json();
  const list = (((body || {}).data || {}).attributes || {}).ohlcv_list || [];
  // GeckoTerminal is newest-first; the chart wants oldest-first
  return list.map((k) => k.map(Number)).sort((a, b) => a[0] - b[0]);
}

/** GeckoTerminal candles, or a stale copy, or CoinGecko's prices: { candles | line, source }. */
async function lookup(pool, tf, limit, cg) {
  const key = `${pool}|${tf}|${limit}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.ts < TF[tf].ttl * 1000) return { candles: hit.data, source: 'geckoterminal' };
  try {
    const data = await fetchCandles(pool, tf, limit);
    memo.set(key, { ts: Date.now(), data });
    return { candles: data, source: 'geckoterminal' };
  } catch (e) {
    if (hit && Date.now() - hit.ts < STALE_MS) { lookup.stale = true; return { candles: hit.data, source: 'geckoterminal' }; }
    if (!cg) throw e;
    const ckey = `cg:${cg}|${tf}`; const chit = memo.get(ckey);
    if (chit && Date.now() - chit.ts < CG_TTL_MS) return Object.assign({ source: 'coingecko' }, chit.data);
    try {
      const data = await fetchCoingecko(cg, tf);
      if (!data) throw e;
      memo.set(ckey, { ts: Date.now(), data });
      return Object.assign({ source: 'coingecko' }, data);
    } catch (e2) {
      if (chit && Date.now() - chit.ts < STALE_MS) { lookup.stale = true; return Object.assign({ source: 'coingecko' }, chit.data); }
      throw e;
    }
  }
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
        try { series[p] = (await lookup(p, tf, limit)).candles; } catch { failures++; }
      }
    }));
    const stale = lookup.stale; lookup.stale = false;
    res.setHeader('Cache-Control', failures === 0 && !stale ? `s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}` : 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json({ series, tf, failures, stale, ts: Math.floor(Date.now() / 1000) });
    return;
  }

  const pool = String(q.pool || '').trim().toLowerCase();
  if (!isPool(pool)) { res.setHeader('Cache-Control', 'no-store'); res.status(400).json({ error: 'pass ?pool=0x...' }); return; }
  const cg = /^[a-z0-9-]{1,80}$/.test(String(q.cg || '')) ? String(q.cg) : null;
  try {
    lookup.stale = false;
    const got = await lookup(pool, tf, limit, cg);
    const stale = lookup.stale; lookup.stale = false;
    const fresh = !stale && got.source === 'geckoterminal';
    res.setHeader('Cache-Control', fresh ? `s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}` : 's-maxage=20, stale-while-revalidate=60');
    res.status(200).json({ candles: got.candles || null, line: got.line || null, source: got.source, tf, pool, stale, ts: Math.floor(Date.now() / 1000) });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
