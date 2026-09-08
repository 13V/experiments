#!/usr/bin/env node
'use strict';
/**
 * menu.js — one JSON file the site can render without doing any of pairs.js, prices.js or
 * opening.js's work itself.
 *
 * The site needs, for every pairing asset Pons will accept: what it is, what it is worth, what a
 * launch against it opens and graduates at in dollars, how much anyone actually uses it, and
 * whether any of that is fiction (no market, or a market too thin to trust). Those are three
 * separate reads against chain and DexScreener, and this is all three, merged into one row per
 * asset and one honest number for the spread across them — computed here, once, so the page never
 * has to re-derive arithmetic that already exists in opening.js, or guess at a block time the way
 * the README once did and got wrong by a factor of twenty.
 *
 *   node scripts/menu.js                                   # writes site/data/menu.json
 *   node scripts/menu.js --out site/data/menu.json          # same, explicit
 *   node scripts/menu.js --blocks 250000                    # a wider window (slower)
 *
 * Read-only, no key, no dependency beyond scripts/chain.js. Robinhood's registry and DexScreener
 * are HTTP calls; everything else is eth_call and eth_getLogs against config/addresses.json's
 * endpoints, rotated the same way pairs.js, prices.js and opening.js already do it.
 */
const fs = require('fs');
const path = require('path');
const chain = require(path.join(__dirname, 'chain.js'));
const cfg = require(path.join(__dirname, '..', 'config', 'addresses.json'));

const FACTORY = cfg.pons.factory;
// TokenLaunched(address token indexed, address curve indexed, address deployer indexed,
//               address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
const LAUNCHED = chain.topic('TokenLaunched(address,address,address,address,uint256,uint256)');
const NATIVE = '0x0000000000000000000000000000000000000000';
const DEX = 'https://api.dexscreener.com/latest/dex/tokens/';

// Of a 1e27 launch, the factory reserves 28.57% of supply for graduation and never puts it on the
// curve — see opening.js, which reads this from a real graduation rather than assuming it. Copied
// verbatim rather than re-derived so this file and opening.js can never quietly disagree.
const RESERVED_BPS = 2857n;
const BPS = 10000n;
const LAUNCH_CONFIG_ID = 0;   // the one config opening.js reads; there is only the one in use today

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const WINDOW = Number(arg('blocks', 100000));
const CHUNK = 25000;          // the official endpoint refuses much more than this in one getLogs
const PAUSE_MS = 500;
const outArg = arg('out', null);
const OUT = outArg ? path.resolve(process.cwd(), outArg) : path.join(__dirname, '..', 'site', 'data', 'menu.json');

const endpoints = cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc];
let turn = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON-RPC call, on the next endpoint in the rotation, retried once elsewhere on failure. */
async function rpc(method, params, attempt = 0) {
  const url = endpoints[turn++ % endpoints.length];
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) {
    if (attempt >= endpoints.length) throw e;
    await sleep(400 * (attempt + 1));
    return rpc(method, params, attempt + 1);
  }
}

/** eth_call in a batch, on the next endpoint, retried once elsewhere if the whole batch fails. */
async function callMany(to, datas, attempt = 0) {
  const url = endpoints[turn++ % endpoints.length];
  const body = datas.map((data, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to, data }, 'latest'] }));
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!Array.isArray(j)) throw new Error((j.error && j.error.message) || 'batch refused');
    return j.sort((a, b) => a.id - b.id).map((x) => x.result);
  } catch (e) {
    if (attempt >= endpoints.length) throw e;
    await sleep(500 * (attempt + 1));
    return callMany(to, datas, attempt + 1);
  }
}

// pairs.js found this the hard way: one entry in an eth_call batch coming back empty is the
// endpoint dropping that call, not the chain answering "no" — treating it as a negative answer
// made 53 real approvals look like 41. So every batch of calls that decides something in this
// file (approved or not, what the economics are, what a foreign token's symbol is) goes through
// this: ask again, on a different endpoint, up to `passes` times, and if an answer still never
// comes back, throw rather than let a silent gap read as a negative fact.
async function retryBatch(to, datas, passes = 4) {
  const out = new Array(datas.length).fill(undefined);
  let pending = datas.map((_, i) => i);
  for (let pass = 0; pass < passes && pending.length; pass++) {
    const res = await callMany(to, pending.map((i) => datas[i]));
    const missed = [];
    pending.forEach((idx, k) => { if (res[k] === undefined || res[k] === null) missed.push(idx); else out[idx] = res[k]; });
    pending = missed;
    if (pending.length) await sleep(700);
  }
  if (pending.length) {
    throw new Error(`${pending.length} of ${datas.length} calls to ${to} never answered after ${passes} passes; refusing to write a menu that guessed`);
  }
  return out;
}

/** Robinhood's own list of what it has tokenized: symbol, name, ISIN, decimals, address, logo. */
async function registry() {
  const res = await fetch(cfg.registry, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  const j = await res.json();
  const items = Array.isArray(j) ? j : (j.results || j.assets || j.data || Object.values(j).find(Array.isArray));
  const out = [];
  for (const a of items || []) {
    const deployments = a.deployments || [];
    const here = deployments.find((d) => String(d.chainId) === String(cfg.chainId)) || deployments[0];
    const address = here && (here.contractAddress || here.address);
    if (!address) continue;
    out.push({
      symbol: a.tokenSymbol,
      name: (a.tokenName || '').replace(' • Robinhood Token', '').trim(),
      isin: a.isin || null,
      decimals: a.tokenDecimals,
      address,
      logoUrl: a.logoUrl || null,
    });
  }
  return out;
}

const trimZeros = (s) => (s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, ''));
const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

/** pairTokenEconomics(address) -> {phantomQuote, graduationThreshold, pairDecimals}, or all-null
 *  if the row does not decode to the expected three words, or decodes to an all-zero row — which
 *  is what native ether's row reads as (see the comment where it is handled below): a real,
 *  successful answer that means "the factory never populated this asset's row," not "zero cost." */
function parseEconomics(hex) {
  if (!hex || hex.length < 194) return { phantomQuote: null, graduationThreshold: null, pairDecimals: null };
  const phantomQuote = word(hex, 0);
  const graduationThreshold = word(hex, 1);
  if (phantomQuote === 0n && graduationThreshold === 0n) return { phantomQuote: null, graduationThreshold: null, pairDecimals: null };
  return { phantomQuote, graduationThreshold, pairDecimals: Number(word(hex, 2)) };
}

/** Symbol/name/decimals for a pair token found on chain but not in Robinhood's registry — the
 *  same discovery pairs.js uses for cbBTC and TAO: the allowlist is not confined to Robinhood's
 *  own tokens, so anything paired in the logs and missing from the registry gets read directly. */
async function identify(address) {
  const [sym, name, dec] = await retryBatch(address, [
    chain.encodeCall('symbol()'), chain.encodeCall('name()'), chain.encodeCall('decimals()'),
  ]);
  const text = (hex) => {
    if (!hex || hex === '0x') return null;
    try {
      const off = Number(BigInt('0x' + hex.slice(2, 66)));
      const len = Number(BigInt('0x' + hex.slice(2 + off * 2, 2 + off * 2 + 64)));
      return Buffer.from(hex.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2), 'hex').toString();
    } catch (e) { return null; }
  };
  return {
    symbol: text(sym) || address.slice(0, 10),
    name: text(name) || 'not in Robinhood\'s registry',
    isin: null,
    decimals: dec ? Number(BigInt(dec)) : null,
    address,
    logoUrl: null,
    foreign: true,
  };
}

/** The deepest pool DexScreener knows for one address, and the price/volume/venue it implies.
 *  Unlike prices.js, a failed fetch here is retried and then thrown, not swallowed — this file's
 *  `tradeable` flag has to mean "DexScreener was asked and had nothing," never "DexScreener could
 *  not be reached," so an outage must not silently read as every asset having no market. */
async function fetchDex(address, attempt = 0) {
  try {
    const res = await fetch(DEX + address, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt >= 3) throw new Error(`DexScreener would not answer for ${address} after retries: ${e.message}`);
    await sleep(500 * (attempt + 1));
    return fetchDex(address, attempt + 1);
  }
}

// DexScreener's multi-token endpoint (.../tokens/addr1,addr2,...) caps the whole response at
// around 30 pairs shared across every address in the request — not 30 per token. pairs.js and
// prices.js both ask about 25 tokens at a time, which means whichever tokens in a batch do not
// happen to own the most active pools come back with zero pairs: checked directly, SLV and GLD
// alone each return real pools (SLV's deepest is $375k), but asked about together the response
// still tops out at 30 pairs total and one of them gets starved. That reads as "no market" and
// is not one, so it would have quietly corrupted this file's tradeable/thin flags for whichever
// assets lost the coin flip. One address per request is slower — 57 requests instead of 3 — but
// it is the only way this cap does not decide which assets this file calls tradeable.
async function quote(addresses) {
  const out = new Map();
  for (const address of addresses) {
    const j = await fetchDex(address);
    for (const p of j.pairs || []) {
      const base = (p.baseToken && p.baseToken.address || '').toLowerCase();
      if (base !== address.toLowerCase()) continue;      // only where our asset is the base
      const usd = Number(p.priceUsd), liq = Number((p.liquidity || {}).usd);
      if (!(usd > 0)) continue;
      const prev = out.get(base);
      if (!prev || liq > prev.liquidity) {
        out.set(base, {
          usd, liquidity: liq || 0, venue: p.dexId + (p.labels && p.labels.length ? ' ' + p.labels.join('/') : ''),
          vol24: Number((p.volume || {}).h24) || 0,
          // The deepest pool's own address. The site refreshes prices through
          // /latest/dex/pairs/<chain>/<ids>, which honours every id it is given — unlike
          // /latest/dex/tokens/<addresses>, which caps its answer at 30 pairs however many
          // addresses are asked for and so silently drops most of a 57-asset menu.
          pairAddress: p.pairAddress || null,
        });
      }
    }
    await sleep(300);
  }
  return out;
}

// Robinhood's own names and ISINs get most assets right on their own (see classifyKind below): a
// registry entry with no ISIN is not one of Robinhood's securities at all, and the address gives
// away native ether and USDG outright. What a name-based rule cannot do is tell a commodity trust
// from an index fund, or a single-country fund from a sector fund, without knowing what the fund
// actually holds — "SPDR Gold Trust" and "SPDR S&P 500 ETF Trust" look identical to that rule. So
// this list is hand-kept for exactly the handful where that distinction matters, taken from what
// is on Robinhood's menu today (docs/pair-assets.md): gold, silver, oil and wrapped bitcoin are
// commodities; the treasury and bond funds are bonds; the broad and sector index funds are an
// index; the single-country funds are regional. Nothing here is a price, a count, or an address —
// it only needs revisiting if Robinhood tokenizes a new fund of one of these kinds that isn't on
// this list yet, which classifyKind's fallback would otherwise call "equity" or "index" by mistake.
const KIND_OVERRIDES = {
  GLD: 'commodity', SLV: 'commodity', USO: 'commodity', CBBTC: 'commodity',
  SGOV: 'bond', SHY: 'bond', BND: 'bond',
  SPY: 'index', QQQ: 'index', VTI: 'index', SMH: 'index', SOXX: 'index', XLK: 'index',
  INDA: 'regional', EWT: 'regional', EWY: 'regional',
};

function classifyKind(asset) {
  const override = KIND_OVERRIDES[String(asset.symbol).toUpperCase()];
  if (override) return override;
  if (asset.address === NATIVE) return 'crypto';
  if (asset.address.toLowerCase() === cfg.usdg.toLowerCase()) return 'stable';
  if (!asset.isin) return 'crypto';    // approved but not one of Robinhood's own tokens, e.g. TAO
  if (/\b(trust|fund|etf)\b/i.test(asset.name || '')) return 'index';  // a basket, by default
  return 'equity';
}

// Asking a rotated endpoint for a block by exact number races against that endpoint's own sync
// lag: the block genuinely exists (another endpoint just reported its number as the chain head),
// but the one this call happens to land on may not have replicated it yet and answers with a
// plain `null` result rather than an error. That is the same "empty is not a negative answer"
// failure pairs.js warns about, just for a block instead of an eth_call — so it gets the same
// treatment: retry on the next endpoint in the rotation rather than accept a null as "no block".
async function getBlockRetry(hex, attempt = 0) {
  const result = await rpc('eth_getBlockByNumber', [hex, false]);
  if (result) return result;
  if (attempt >= endpoints.length + 1) throw new Error(`block ${hex} never came back from any endpoint; refusing to guess the window's span`);
  await sleep(400 * (attempt + 1));
  return getBlockRetry(hex, attempt + 1);
}

async function main() {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));

  // Never state a window in days, or a rate per day, without reading the clock. This chain is
  // Arbitrum Nitro at about 0.1s a block, not the 2s an OP-stack assumption would give you, and
  // the difference is a factor of twenty in every rate derived from it.
  const [fromBlock, toBlock] = await Promise.all([
    getBlockRetry('0x' + Math.max(0, head - WINDOW).toString(16)),
    getBlockRetry('0x' + head.toString(16)),
  ]);
  const spanSeconds = Number(BigInt(toBlock.timestamp)) - Number(BigInt(fromBlock.timestamp));

  const registryAssets = await registry();
  const byAddress = new Map(registryAssets.map((a) => [a.address.toLowerCase(), a]));
  const usdgAsset = { symbol: 'USDG', name: 'Robinhood USD', isin: null, decimals: cfg.usdgDecimals || 6, address: cfg.usdg, logoUrl: null };
  const ethAsset = { symbol: 'ETH', name: 'native ether', isin: null, decimals: 18, address: NATIVE, logoUrl: null };
  byAddress.set(cfg.usdg.toLowerCase(), usdgAsset);
  byAddress.set(NATIVE, ethAsset);

  // Which registry assets, plus USDG, will Pons let you pair against? Native ether is handled
  // separately below: address(0) is not an ERC20, so it is never a key in this mapping at all —
  // asking approvedPairTokens(address(0)) reads false regardless of whether native-ETH launches
  // work, which they demonstrably do (see the launch scan further down).
  const checkList = registryAssets.concat([usdgAsset]);
  const approvedFlags = [];
  for (let i = 0; i < checkList.length; i += 25) {
    const slice = checkList.slice(i, i + 25);
    approvedFlags.push(...await retryBatch(FACTORY, slice.map((a) => chain.encodeCall('approvedPairTokens(address)', [a.address]))));
    await sleep(PAUSE_MS);
  }
  const approvedRegistry = checkList.filter((_, i) => approvedFlags[i] && BigInt(approvedFlags[i]) > 0n);

  const approved = [];
  for (let i = 0; i < approvedRegistry.length; i += 25) {
    const slice = approvedRegistry.slice(i, i + 25);
    const econ = await retryBatch(FACTORY, slice.map((a) => chain.encodeCall('pairTokenEconomics(address)', [a.address])));
    slice.forEach((a, k) => approved.push(Object.assign({}, a, parseEconomics(econ[k]))));
    await sleep(PAUSE_MS);
  }

  // What did anyone actually choose? Count the pair token of every launch in the window, and
  // along the way discover any pair token that is not Robinhood's and not USDG or native ether —
  // exactly how pairs.js found cbBTC and TAO. A failed getLogs range is not retried into a zero
  // here: it is allowed to throw, because a launch count silently missing a chunk would make this
  // file's demand numbers wrong in a way nothing downstream could detect.
  const counts = new Map();
  // TokenLaunched's third unindexed field is the graduation threshold the factory priced that
  // launch against — the same number pairTokenEconomics returns, confirmed to the last digit for
  // every asset that has a row. Recording it here is what lets native ether, which has no row, be
  // read from what the factory actually did rather than left blank. See deriveNative() below.
  const observedThreshold = new Map();
  let totalLaunches = 0, scannedBlocks = 0;
  for (let to = head; to > head - WINDOW; to -= CHUNK) {
    const from = Math.max(0, to - CHUNK);
    const logs = await rpc('eth_getLogs', [{ address: FACTORY, topics: [LAUNCHED], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    scannedBlocks += to - from;
    for (const log of logs) {
      const pair = '0x' + log.data.slice(26, 66);
      counts.set(pair, (counts.get(pair) || 0) + 1);
      if (!observedThreshold.has(pair) && log.data.length >= 2 + 3 * 64) observedThreshold.set(pair, word(log.data, 2));
      totalLaunches++;
    }
    await sleep(PAUSE_MS);
  }

  for (const address of counts.keys()) {
    if (byAddress.has(address)) continue;
    const found = await identify(address);
    byAddress.set(address, found);
    const [flag] = await retryBatch(FACTORY, [chain.encodeCall('approvedPairTokens(address)', [address])]);
    if (flag && BigInt(flag) > 0n) {
      const [econRaw] = await retryBatch(FACTORY, [chain.encodeCall('pairTokenEconomics(address)', [address])]);
      approved.push(Object.assign({}, found, parseEconomics(econRaw)));
    }
    await sleep(PAUSE_MS);
  }

  // Native ether is always a valid pairing choice — it is the single largest one, at roughly two
  // in five launches — but it reaches the curve through a different code path than an ERC-20 pair
  // token, and pairTokenEconomics(address(0)) reads back all zeros (parseEconomics turns that into
  // nulls above): the factory never populated a row for it, so this file's opening/graduation
  // arithmetic, which depends on that row, cannot be computed for ETH and is left null rather than
  // guessed. Its market data still comes from chain: DexScreener has no pool for address(0), so
  // wrapped ether's pool — the same asset, 1:1, the only form of it that is an ERC-20 — stands in.
  //
  // It can be read anyway, and honestly. Every asset that DOES have a row satisfies
  // graduationThreshold = 2.5 x phantomQuote exactly, and a launch's own log carries the threshold
  // it was priced against — so native ether's threshold comes from its own launches and its phantom
  // quote from that one ratio. The ratio is measured here rather than assumed: if the assets with
  // rows ever stop agreeing on it, nothing is derived and ETH goes back to null.
  const withRows = approved.filter((a) => a.phantomQuote && a.graduationThreshold);
  const ratios = withRows.map((a) => Number(a.graduationThreshold) / Number(a.phantomQuote));
  const ratio = ratios.length ? ratios.reduce((x, y) => x + y, 0) / ratios.length : null;
  const agrees = ratio && ratios.every((r) => Math.abs(r - ratio) / ratio < 1e-5);
  const ethThreshold = observedThreshold.get(NATIVE);
  const derivable = agrees && ethThreshold != null && ethThreshold > 0n;
  if (!derivable && ratio) {
    process.stderr.write(`  (native ether left unpriced: ${agrees ? 'no launch log carried a threshold' : `the ${ratios.length} assets with rows disagree on the threshold ratio`})\n`);
  }
  // Integer arithmetic, because these are wei: scale the measured ratio to six figures rather than
  // going through a float and back.
  const SCALE = 1000000n;
  approved.push(Object.assign({}, ethAsset, derivable ? {
    phantomQuote: ethThreshold * SCALE / BigInt(Math.round(ratio * Number(SCALE))),
    graduationThreshold: ethThreshold, pairDecimals: 18,
    derived: `threshold from its own launch logs, quote as threshold / ${ratio.toFixed(2)} (the ratio every asset with a row shows)`,
  } : { phantomQuote: null, graduationThreshold: null, pairDecimals: null }));

  // The launch config all of this arithmetic shares: total supply, curve fee, and the fraction of
  // supply the curve actually sells once graduation's reserve is set aside. Read once, shared by
  // every asset below — see RESERVED_BPS above for where that fraction comes from.
  const [launchCfgRaw, launchFeeRaw] = await retryBatch(FACTORY, [
    chain.encodeCall('getLaunchConfig(uint256)', [LAUNCH_CONFIG_ID]),
    chain.encodeCall('launchFee()'),
  ]);
  const supply = word(launchCfgRaw, 0);
  const curveFeeBps = word(launchCfgRaw, 1);
  const tokensOnCurve = supply * (BPS - RESERVED_BPS) / BPS;
  // The fee the factory charges to launch, in wei. The site quotes it because it is the one cost a
  // launcher pays up front, and because it is Pons's, not ours — so it has to be read, not typed.
  const launchFeeWei = launchFeeRaw ? word(launchFeeRaw, 0) : null;

  // Dollar prices, depth and volume for every asset with a real ERC-20 address, plus WETH as the
  // proxy for native ether (see the comment above).
  const priceAddresses = approved.filter((a) => a.address !== NATIVE).map((a) => a.address);
  priceAddresses.push(cfg.weth);
  const prices = await quote(priceAddresses);

  const assets = approved.map((a) => {
    const priceKey = (a.address === NATIVE ? cfg.weth : a.address).toLowerCase();
    const p = prices.get(priceKey) || null;

    // `derived` is set only for native ether, whose terms are read from what the factory did rather
    // than from a row it never wrote. The site shows the figure and says where it came from.
    let launchEcon = { phantomQuote: null, graduationThreshold: null, openingUsd: null, graduationUsd: null, derived: a.derived || null };
    if (a.phantomQuote != null && a.graduationThreshold != null) {
      const decUsed = a.pairDecimals != null && a.pairDecimals > 0 ? a.pairDecimals : (a.decimals || 18);
      const unit = 10 ** decUsed;
      const phantomQuoteHuman = Number(a.phantomQuote) / unit;
      const graduationThresholdHuman = Number(a.graduationThreshold) / unit;
      launchEcon.phantomQuote = phantomQuoteHuman;
      launchEcon.graduationThreshold = graduationThresholdHuman;
      if (p) {
        // Exactly opening.js's arithmetic: price(pair units per token) = phantomQuote / tokensOnCurve,
        // opening valuation = price x supply x (dollar price of one pair token).
        const pairPerToken = Number(a.phantomQuote) / unit / (Number(tokensOnCurve) / 1e18);
        launchEcon.openingUsd = pairPerToken * (Number(supply) / 1e18) * p.usd;
        launchEcon.graduationUsd = graduationThresholdHuman * p.usd;
      }
    }

    const count = counts.get(a.address.toLowerCase()) || 0;
    const perDay = spanSeconds ? (count / spanSeconds) * 86400 : null;
    const liquidity = p ? p.liquidity : 0;

    return {
      symbol: a.symbol,
      name: a.name,
      address: a.address,
      decimals: a.decimals != null ? a.decimals : null,
      logoUrl: a.logoUrl || null,
      kind: classifyKind(a),
      market: {
        usd: p ? p.usd : null,
        liquidity,
        vol24: p ? p.vol24 : 0,
        venue: p ? p.venue : null,
        pairAddress: p ? p.pairAddress : null,
      },
      launch: launchEcon,
      demand: { launches: count, perDay },
      tradeable: !!p,
      thin: !!p && liquidity < 100000,
    };
  });

  assets.sort((x, y) => (y.market.liquidity || 0) - (x.market.liquidity || 0) || x.symbol.localeCompare(y.symbol));

  const withOpening = assets.filter((a) => a.launch.openingUsd != null);
  withOpening.sort((x, y) => y.launch.openingUsd - x.launch.openingUsd);
  const hi = withOpening[0], lo = withOpening[withOpening.length - 1];

  const out = {
    readAt: new Date().toISOString().slice(0, 19) + 'Z',
    chainId: cfg.chainId,
    factory: FACTORY,
    head,
    window: {
      requestedBlocks: WINDOW,
      scannedBlocks,
      spanSeconds,
      spanHours: spanSeconds ? spanSeconds / 3600 : null,
    },
    launchConfig: {
      id: LAUNCH_CONFIG_ID,
      supply: supply.toString(),
      curveFeeBps: Number(curveFeeBps),
      tokensOnCurve: tokensOnCurve.toString(),
    },
    launchFeeWei: launchFeeWei != null ? launchFeeWei.toString() : null,
    launchFeeEth: launchFeeWei != null ? trimZeros((Number(launchFeeWei) / 1e18).toFixed(18)) : null,
    totalLaunches,
    launchesPerDay: spanSeconds ? totalLaunches * 86400 / spanSeconds : null,
    openingSpread: hi && lo ? {
      minSymbol: lo.symbol, min: lo.launch.openingUsd,
      maxSymbol: hi.symbol, max: hi.launch.openingUsd,
      ratio: lo.launch.openingUsd ? hi.launch.openingUsd / lo.launch.openingUsd : null,
    } : { minSymbol: null, min: null, maxSymbol: null, max: null, ratio: null },
    assets,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');

  const bytes = fs.statSync(OUT).size;
  console.log(`Wrote ${assets.length} pairing assets (${totalLaunches.toLocaleString()} launches over ${scannedBlocks.toLocaleString()} blocks) to ${path.relative(process.cwd(), OUT)} (${bytes.toLocaleString()} bytes).`);
  if (hi && lo) {
    console.log(`Opening valuation spread: $${lo.launch.openingUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${lo.symbol}) to `
      + `$${hi.launch.openingUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${hi.symbol}), a ${out.openingSpread.ratio.toFixed(2)}x spread.`);
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
