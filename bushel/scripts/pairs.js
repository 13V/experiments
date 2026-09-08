#!/usr/bin/env node
'use strict';
/**
 * pairs.js — what can a memecoin be priced in on this chain, and what is anybody actually using?
 *
 * The premise of this launchpad is that a coin's pairing asset can be a real-world thing rather than
 * a dollar: gold, oil, treasuries, an index, a company. Two facts decide whether that is a product
 * or a wish, and both are on chain: which assets Robinhood has tokenized, and which of those the
 * incumbent launchpad (Pons V2) will let you pair against. This reads both, then counts what people
 * chose in the recent past, so the gap between "allowed" and "used" is visible rather than assumed.
 *
 *   node scripts/pairs.js                    # the allowlist, and the last ~3 hours of launches
 *   node scripts/pairs.js --blocks 250000    # a wider window (slower; the RPC caps logs at 10k)
 *   node scripts/pairs.js --json             # machine-readable, for the site and for docs
 *
 * Read-only, no key, no dependencies. Robinhood's registry is an HTTP call; everything else is
 * eth_call and eth_getLogs against the endpoints in config/addresses.json, rotated because the
 * official one rate-limits hard.
 */
const path = require('path');
const chain = require(path.join(__dirname, 'chain.js'));
const cfg = require(path.join(__dirname, '..', 'config', 'addresses.json'));

const FACTORY = cfg.pons.factory;
// TokenLaunched(address token indexed, address curve indexed, address deployer indexed,
//               address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
const LAUNCHED = chain.topic('TokenLaunched(address,address,address,address,uint256,uint256)');
const NATIVE = '0x0000000000000000000000000000000000000000';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const JSON_OUT = process.argv.includes('--json');
const WINDOW = Number(arg('blocks', 100000));
const CHUNK = 25000;         // the official endpoint refuses much more than this in one getLogs
const PAUSE_MS = 500;

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

/** eth_call in a batch, which is the only way to ask about 194 tokens without being rate-limited. */
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

/** Robinhood's own list of what it has tokenized: symbol, name, ISIN, decimals, address on 4663. */
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
      isin: a.isin || '',
      decimals: a.tokenDecimals,
      address,
    });
  }
  return out;
}

const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

async function main() {
  const assets = await registry();
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  byAddress.set(cfg.usdg.toLowerCase(), { symbol: 'USDG', name: 'Robinhood USD', address: cfg.usdg, decimals: 6 });
  byAddress.set(NATIVE, { symbol: 'ETH', name: 'native ether', address: NATIVE, decimals: 18 });

  // Which of them will Pons let you pair against, and on what terms? A batch entry that comes back
  // empty is the endpoint failing, not a "no" — counting it as a "no" silently shrinks the answer,
  // which is how the first version of this script reported 41 approvals instead of 53. Ask again.
  async function approvals(addresses) {
    const out = new Array(addresses.length).fill(undefined);
    let pending = addresses.map((_, i) => i);
    for (let pass = 0; pass < 3 && pending.length; pass++) {
      const res = await callMany(FACTORY, pending.map((i) => chain.encodeCall('approvedPairTokens(address)', [addresses[i]])));
      const missed = [];
      pending.forEach((idx, k) => { if (res[k] === undefined || res[k] === null) missed.push(idx); else out[idx] = res[k]; });
      pending = missed;
      if (pending.length) await sleep(700);
    }
    if (pending.length) throw new Error(pending.length + ' approval reads never answered; the number would be wrong');
    return out;
  }

  const approved = [];
  for (let i = 0; i < assets.length; i += 25) {
    const slice = assets.slice(i, i + 25);
    const flags = await approvals(slice.map((a) => a.address));
    const wanted = slice.filter((_, k) => flags[k] && BigInt(flags[k]));
    if (wanted.length) {
      const econ = await callMany(FACTORY, wanted.map((a) => chain.encodeCall('pairTokenEconomics(address)', [a.address])));
      wanted.forEach((a, k) => {
        const e = econ[k];
        approved.push(Object.assign({}, a, e && e.length >= 194
          ? { phantomQuote: word(e, 0).toString(), graduationThreshold: word(e, 1).toString(), pairDecimals: Number(word(e, 2)) }
          : {}));
      });
    }
    await sleep(PAUSE_MS);
  }
  const usdg = await callMany(FACTORY, [chain.encodeCall('approvedPairTokens(address)', [cfg.usdg])]);
  const usdgApproved = usdg[0] && BigInt(usdg[0]) > 0n;

  // The allowlist is not confined to Robinhood's own tokens: cbBTC (8 decimals, from Coinbase) and
  // TAO are on it too. So the registry alone does not describe the menu, and anything found pairing
  // in the logs but missing from the registry gets identified here — that is also the evidence that
  // a token we issued ourselves could be approved, which is the whole question for wrapped exotics.
  async function identify(address) {
    const [sym, name, dec] = await callMany(address, [
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
    return { symbol: text(sym) || address.slice(0, 10), name: text(name) || 'not in Robinhood\'s registry',
      decimals: dec ? Number(BigInt(dec)) : null, address, foreign: true };
  }

  // And what did anyone actually choose? Count the pair token of every recent launch.
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  const counts = new Map();
  let launches = 0, scanned = 0;
  // Never state a window in days without reading the clock. This chain is Arbitrum Nitro at about
  // 0.1s a block, not the 2s an OP-stack assumption would give you, and the difference is a factor
  // of twenty in every rate derived from it.
  const spanSeconds = await (async () => {
    const [a, b] = await Promise.all([
      rpc('eth_getBlockByNumber', ['0x' + Math.max(0, head - WINDOW).toString(16), false]),
      rpc('eth_getBlockByNumber', ['0x' + head.toString(16), false]),
    ]);
    return a && b ? Number(BigInt(b.timestamp)) - Number(BigInt(a.timestamp)) : null;
  })();
  for (let to = head; to > head - WINDOW; to -= CHUNK) {
    const from = Math.max(0, to - CHUNK);
    let logs;
    try {
      logs = await rpc('eth_getLogs', [{ address: FACTORY, topics: [LAUNCHED], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    } catch (e) {
      process.stderr.write(`  (window ${from}-${to} skipped: ${String(e.message).slice(0, 60)})\n`);
      continue;
    }
    scanned += to - from;
    for (const log of logs) {
      const pair = '0x' + log.data.slice(26, 66);
      counts.set(pair, (counts.get(pair) || 0) + 1);
      launches++;
    }
    await sleep(PAUSE_MS);
  }

  for (const address of counts.keys()) {
    if (byAddress.has(address)) continue;
    const found = await identify(address);
    byAddress.set(address, found);
    const [flag, econ] = await callMany(FACTORY, [
      chain.encodeCall('approvedPairTokens(address)', [address]),
      chain.encodeCall('pairTokenEconomics(address)', [address]),
    ]);
    if (flag && BigInt(flag)) {
      approved.push(Object.assign({}, found, econ && econ.length >= 194
        ? { phantomQuote: word(econ, 0).toString(), graduationThreshold: word(econ, 1).toString(), pairDecimals: Number(word(econ, 2)) }
        : {}));
    }
    await sleep(PAUSE_MS);
  }

  const used = [...counts.entries()]
    .map(([address, count]) => {
      const a = byAddress.get(address) || { symbol: address.slice(0, 10), name: 'unknown token', address };
      return { symbol: a.symbol, name: a.name, address, count, share: launches ? count / launches : 0 };
    })
    .sort((a, b) => b.count - a.count);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      chainId: cfg.chainId, head, scannedBlocks: scanned, spanSeconds, launches,
      tokenizedAssets: assets.length,
      approvedPairTokens: approved.length + (usdgApproved ? 1 : 0) + 1, // + USDG + native ether
      approved, used,
    }, null, 1));
    return;
  }

  console.log(`Robinhood Chain ${cfg.chainId} — what a coin can be priced in\n`);
  const foreign = approved.filter((a) => a.foreign).length;
  console.log(`${assets.length} assets tokenized by Robinhood, ${approved.length - foreign} of them approved by Pons as pair`);
  console.log(`tokens${foreign ? `, plus ${foreign} token${foreign > 1 ? 's' : ''} from outside that registry` : ''}, plus ${usdgApproved ? 'USDG and ' : ''}native ether.\n`);
  console.log('SYMBOL   DECIMALS  PHANTOM QUOTE (pair units)  GRADUATES AT  NAME');
  console.log('-------  --------  --------------------------  ------------  ----------------------------------');
  for (const a of approved.sort((x, y) => x.symbol.localeCompare(y.symbol))) {
    const dec = a.pairDecimals != null && a.pairDecimals > 0 ? a.pairDecimals : (a.decimals || 18);
    const unit = 10 ** dec;
    const pq = a.phantomQuote ? (Number(a.phantomQuote) / unit).toFixed(4) : '?';
    const gt = a.graduationThreshold ? (Number(a.graduationThreshold) / unit).toFixed(4) : '?';
    console.log(`${a.symbol.padEnd(7)}  ${String(dec).padStart(8)}  ${pq.padStart(26)}  ${gt.padStart(12)}  ${a.name.slice(0, 34)}${a.foreign ? '  *' : ''}`);
  }

  if (approved.some((a) => a.foreign)) console.log('\n  * not one of Robinhood\'s tokenized assets — the allowlist takes outside tokens too.');
  const hours = spanSeconds ? spanSeconds / 3600 : null;
  const perDay = hours ? Math.round(launches / hours * 24) : null;
  console.log(`\nWhat launchers chose, over the last ${scanned.toLocaleString()} blocks`
    + (hours ? ` (${hours.toFixed(1)} hours, at ${(spanSeconds / scanned).toFixed(3)}s a block)` : '') + ':');
  console.log(`${launches.toLocaleString()} launches${perDay ? `, a rate of about ${perDay.toLocaleString()} a day` : ''}, across ${used.length} distinct pair assets\n`);
  console.log('  COUNT   SHARE   PAIR ASSET');
  for (const u of used.slice(0, 20)) {
    console.log(`  ${String(u.count).padStart(5)}  ${(u.share * 100).toFixed(1).padStart(5)}%   ${u.symbol}${u.name && u.symbol !== u.name ? '  (' + u.name.slice(0, 34) + ')' : ''}`);
  }
  const quiet = approved.filter((a) => !counts.get(a.address.toLowerCase()));
  if (quiet.length) {
    console.log(`\nApproved but unused in this window — the empty half of the menu:`);
    console.log('  ' + quiet.map((a) => a.symbol).join(', '));
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
