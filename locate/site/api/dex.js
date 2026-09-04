// Vercel serverless function (Node runtime). Fetches DexScreener pool data for Robinhood Chain
// tokens on the server so that (a) every visitor shares one edge-cached answer instead of each
// browser making up to ~200 calls and tripping DexScreener's 300/min limit, and (b) the Premiums
// board loads in a second instead of forty.
//
//   GET /api/dex?addrs=0xabc,0xdef,...   (up to 250 addresses)
//   -> { pools: { "0xabc": {priceUsd, liqUsd, vol24, chg24, dexId, url, pairAddress, pairCount} | null }, ts }
//
// A null pool means "checked, no pool on Robinhood Chain". An address missing from `pools`
// means DexScreener could not be reached for it this time; the client shows a dash.

const CHAIN = 'robinhood';
const UA = 'Mozilla/5.0 (compatible; Locate/1.0; +https://robinhoodchain.blockscout.com)';
const TTL_MS = 45 * 1000;
const CONCURRENCY = 12;

// Per-instance memory cache: survives between invocations on a warm instance and shields
// DexScreener from edge-cache misses across regions.
const memo = new Map(); // lowerAddr -> { ts, data }

function summarize(addrLower, pairs) {
  const mine = pairs.filter((p) => p && p.chainId === CHAIN && p.baseToken && String(p.baseToken.address).toLowerCase() === addrLower);
  if (!mine.length) return null;
  const best = mine.reduce((a, b) => (((b.liquidity && b.liquidity.usd) || 0) > ((a.liquidity && a.liquidity.usd) || 0) ? b : a));
  const vol24 = mine.reduce((s, p) => s + ((p.volume && p.volume.h24) || 0), 0);
  const chg24 = best.priceChange && best.priceChange.h24 !== undefined && best.priceChange.h24 !== null ? Number(best.priceChange.h24) : null;
  return {
    priceUsd: Number(best.priceUsd),
    liqUsd: (best.liquidity && best.liquidity.usd) || 0,
    vol24,
    chg24,
    dexId: best.dexId,
    url: best.url,
    pairAddress: best.pairAddress,
    pairCount: mine.length,
  };
}

async function fetchPairs(addr, attempt = 0) {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${CHAIN}/${addr}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    return fetchPairs(addr, attempt + 1);
  }
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.pairs || []);
}

async function lookup(addrLower) {
  const hit = memo.get(addrLower);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  const data = summarize(addrLower, await fetchPairs(addrLower));
  memo.set(addrLower, { ts: Date.now(), data });
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const raw = String((req.query && req.query.addrs) || '');
  const addrs = [...new Set(raw.split(',').map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].slice(0, 250);
  if (!addrs.length) { res.setHeader('Cache-Control', 'no-store'); res.status(400).json({ error: 'pass ?addrs=0x...,0x...' }); return; }

  const pools = {};
  let failures = 0;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addrs.length) }, async () => {
    while (i < addrs.length) {
      const addr = addrs[i++];
      try { pools[addr] = await lookup(addr); } catch { failures++; }
    }
  }));

  // Edge cache per distinct address list: the Markets page (10 addresses) and the board (all
  // tokens) are two entries, each refreshed at most every 45s for everyone.
  res.setHeader('Cache-Control', failures === 0 ? 's-maxage=45, stale-while-revalidate=120' : 's-maxage=10, stale-while-revalidate=30');
  res.status(200).json({ pools, failures, ts: Math.floor(Date.now() / 1000) });
}
