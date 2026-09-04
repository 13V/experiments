// Vercel serverless function (Node runtime). Proxies Robinhood's rhj/assets + rhj/prices,
// neither of which sends Access-Control-Allow-Origin (confirmed by curling both with an
// Origin header set — the header is simply absent), so the browser can't call them directly.
//
// Deviation from the brief worth flagging: Robinhood's API rejects an unrecognised query
// field outright — `?symbols=NVDA` on either endpoint returns HTTP 400,
// `Could not find field "symbols" in the type "crypto_tokenization.service.v1.Get...Request"`.
// There is no upstream filter to forward. So this function always fetches the full registry
// (194 assets / 194 quotes today) and, if the caller passed `?symbols=`, filters its OWN
// response to that set before replying — same external contract the brief asks for
// (`?symbols=` in, a trimmed `{assets, prices, ts}` out), implemented server-side instead.

const UPSTREAM_UA = 'Mozilla/5.0 (compatible; Locate/1.0; +https://robinhoodchain.blockscout.com)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UPSTREAM_UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const [assetsBody, pricesBody] = await Promise.all([
      getJson('https://api.robinhood.com/rhj/assets'),
      getJson('https://api.robinhood.com/rhj/prices'),
    ]);
    let assets = assetsBody.assets || [];
    let prices = pricesBody.quotes || [];

    const symbolsParam = req.query && req.query.symbols;
    if (symbolsParam) {
      const want = new Set(String(symbolsParam).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
      assets = assets.filter((a) => want.has(String(a.tokenSymbol).toUpperCase()));
      prices = prices.filter((p) => want.has(String(p.tokenSymbol).toUpperCase()));
    }

    // s-maxage: the Vercel edge cache serves this to everyone for 15s, so 194 assets +
    // 194 quotes cost one upstream round trip per 15s no matter how many people load the site.
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json({ assets, prices, ts: Math.floor(Date.now() / 1000) });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'upstream fetch failed', detail: String((err && err.message) || err) });
  }
}
