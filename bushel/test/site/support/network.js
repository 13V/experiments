'use strict';
/**
 * The sandbox this runs in cannot reach api.dexscreener.com or a Robinhood Chain RPC, and a test
 * that depends on either would be testing the network rather than the page. So both are answered
 * locally: `stubNetwork` returns fixed prices and fixed chain reads, which also means a price the
 * page renders is a number this file chose and the assertion can name it.
 *
 * Anything not matched here is aborted rather than allowed through, so a request this file forgot
 * about shows up as a visible failure instead of a thirty-second hang.
 */
const RPC_HOSTS = /(robinhood|ordofi|publicnode|127\.0\.0\.1:854)/i;

// eth_call returns are 32-byte words; these are the three the page asks the factory for.
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const TRUE = '0x' + word(1);

// An ABI-encoded `string` return: offset, length, then the bytes right-padded to a word.
function abiString(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const body = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return '0x' + word(32) + word(bytes.length) + body.padEnd(Math.ceil(body.length / 64) * 64 || 64, '0');
}

/** `count` synthetic TokenLaunched logs: topic, token in topics[1], pair token in data word 0. */
function makeLaunchLogs(count, pairAddresses, fromBlock) {
  const TOPIC = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
  return Array.from({ length: count }, (_, i) => ({
    address: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
    topics: [TOPIC, '0x' + word(0xC0FFEE00 + i), '0x' + word(0xCC0000 + i), '0x' + word(0xDD0000 + i)],
    data: '0x' + pairAddresses[i % pairAddresses.length].replace(/^0x/, '').padStart(64, '0') + word(0) + word(42n * 10n ** 17n),
    blockNumber: '0x' + (fromBlock + i).toString(16),
    transactionHash: '0x' + word(0xABCD00 + i),
  }));
}

function stubNetwork(page, opts = {}) {
  const priceUsd = opts.priceUsd || 100;
  const seen = { dex: 0, rpc: 0, blocked: [] };

  // Playwright resolves routes last-registered-first, so the catch-all goes down FIRST and the
  // two handlers that answer something specific are registered after it, on top of it.
  // Everything else off-origin is a request nothing in this suite arranged for.
  page.route('**://**', async (route) => {
    const url = route.request().url();
    // fallback(), not continue(): a same-origin request may have a more specific handler that was
    // registered EARLIER than this catch-all (stubMenu, say), and continue() would send it to the
    // server instead. With no handler left, fallback() performs the request anyway.
    if (url.startsWith('http://127.0.0.1')) { await route.fallback(); return; }
    seen.blocked.push(url);
    await route.abort();
  });

  // An address with no pool on this chain is absent from DexScreener's answer, not present with a
  // price of zero — so `noMarket` drops it from the response entirely, the way the real API does.
  const dark = new Set((opts.noMarket || []).map((a) => String(a).toLowerCase()));
  // `thin` is a claim about depth, so a test about it has to be able to say how deep. Addresses not
  // named in `liquidity` get a million dollars, which is comfortably above every threshold.
  const menuForStub = opts.menu || require('../fixtures/menu.json');
  // Recent launches reads eth_getLogs; without any, that route can only ever show its empty state.
  const launchLogs = opts.logs === undefined
    ? makeLaunchLogs(8, menuForStub.assets.map((a) => a.address), (opts.block || 0x1234567) - 8)
    : opts.logs;
  const depths = new Map(Object.entries(opts.liquidity || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const depth = (a) => (depths.has(a.toLowerCase()) ? depths.get(a.toLowerCase()) : 1_000_000);
  // asset address <-> pool id, taken from the same fixture the page is loading.
  const poolOfAsset = new Map(menuForStub.assets
    .filter((a) => a.pairAddress).map((a) => [a.address.toLowerCase(), a.pairAddress.toLowerCase()]));
  const assetOfPool = new Map([...poolOfAsset].map(([asset, pool]) => [pool, asset]));
  const assetOf = (id) => assetOfPool.get(String(id).toLowerCase());
  const darkPools = new Set([...dark].map((a) => poolOfAsset.get(a)).filter(Boolean));

  // The site refreshes by pool id (/pairs/<chain>/<ids>), so this answers ids, not token addresses,
  // and echoes each id back as its own pairAddress — which is how the page matches an answer to a
  // row. `noMarket` and `liquidity` are still keyed by the ASSET address the test names; the map
  // below turns those into the pool ids the fixture gives each asset.
  page.route('**/api.dexscreener.com/**', async (route) => {
    seen.dex++;
    const url = route.request().url();
    const ids = (url.split('/pairs/robinhood/')[1] || url.split('/tokens/')[1] || '').split(',').filter(Boolean);
    const pairs = ids
      .filter((id) => !darkPools.has(id.toLowerCase()))
      .map((id, i) => ({
        chainId: 'robinhood', dexId: 'uniswap', pairAddress: id,
        baseToken: { address: assetOf(id) || id, symbol: 'T' + i }, priceUsd: String(priceUsd + i),
        liquidity: { usd: depth(assetOf(id) || id) }, volume: { h24: 50_000 }, priceChange: { h24: 1.5 },
      }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pairs }) });
  });

  page.route((url) => RPC_HOSTS.test(url.host + ':' + url.port), async (route) => {
    seen.rpc++;
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { /* not JSON: fall through */ }
    const answer = (req) => {
      const m = req.method;
      if (m === 'eth_blockNumber') return '0x' + (opts.block || 0x1234567).toString(16);
      if (m === 'eth_chainId') return '0x1237';                 // 4663
      if (m === 'eth_getLogs') return launchLogs;
      if (m === 'eth_call') {
        const data = ((req.params && req.params[0]) || {}).data || '';
        if (data.slice(0, 10) === '0x95d89b41') return abiString('T' + String((req.params[0].to || '').slice(-2)));
        return TRUE;
      }
      if (m === 'eth_gasPrice') return '0x' + (290000000).toString(16);
      return '0x';
    };
    const one = (req) => ({ jsonrpc: '2.0', id: req.id, result: answer(req) });
    const out = Array.isArray(body) ? body.map(one) : one(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  return seen;
}

/**
 * Serves `test/site/fixtures/menu.json` in place of the generated `site/data/menu.json`, so the
 * suite asserts against numbers this repo chose rather than against whatever the chain said the
 * morning the menu was last built. Pass `null` to leave the file missing and exercise the
 * not-built-yet path instead.
 */
function stubMenu(page, menu) {
  const fixture = menu === undefined ? require('../fixtures/menu.json') : menu;
  return page.route('**/data/menu.json', async (route) => {
    if (!fixture) { await route.fulfill({ status: 404, body: 'no menu' }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });
}

module.exports = { stubNetwork, stubMenu };
