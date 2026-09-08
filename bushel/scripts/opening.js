#!/usr/bin/env node
'use strict';
/**
 * opening.js — what does the same launch actually open at, priced in each pairing asset?
 *
 * A launchpad's one-click launch is supposed to mean the same thing whichever asset you pair
 * against. On the incumbent it does not, and this is the arithmetic that shows why: the opening
 * valuation is set by a per-asset number (`pairTokenEconomics.phantomQuote`) that an operator typed
 * by hand and has not revisited, so what the same button gives you depends on when somebody last
 * thought about that asset rather than on what the asset is worth today.
 *
 * The curve is constant product against a virtual quote reserve, so at t=0:
 *
 *     price(pair units per token) = phantomQuote / tokensOnCurve
 *     opening valuation           = price x supply x (dollar price of one pair token)
 *
 * `tokensOnCurve` is the supply the curve can actually sell — the launch config's supply less what
 * the factory holds back for the graduation pool. That fraction is read from a real launch rather
 * than assumed; see RESERVED_BPS below.
 *
 *   node scripts/opening.js            # every pairing asset that has a dollar price, worst spread first
 *   node scripts/opening.js --json
 *
 * Read-only. Dollar prices are DexScreener's, from each asset's deepest pool on this chain.
 */
const path = require('path');
const chain = require(path.join(__dirname, 'chain.js'));
const cfg = require(path.join(__dirname, '..', 'config', 'addresses.json'));

const DEX = 'https://api.dexscreener.com/latest/dex/tokens/';
const JSON_OUT = process.argv.includes('--json');

// Of a 1e27 launch, the factory reserves 285,714,285,714,285,714,285,714,285 for graduation and
// seeds the pool with 204,081,632,653,061,224,489,795,918 of it — the difference, 8.16% of the whole
// supply, is locked forever. Both numbers are the same on every graduation; the curve therefore
// sells the remaining 71.43%.
const RESERVED_BPS = 2857n;      // 28.57% of supply, in basis points
const BPS = 10000n;

const endpoints = cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc];
let turn = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callMany(to, datas) {
  const url = endpoints[turn++ % endpoints.length];
  const body = datas.map((data, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to, data }, 'latest'] }));
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error((j.error && j.error.message) || 'batch refused');
  return j.sort((a, b) => a.id - b.id).map((x) => x.result);
}

async function registry() {
  const res = await fetch(cfg.registry, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  const j = await res.json();
  const items = Array.isArray(j) ? j : (j.results || j.assets || j.data || Object.values(j).find(Array.isArray));
  return (items || []).map((a) => {
    const d = (a.deployments || []).find((x) => String(x.chainId) === String(cfg.chainId)) || (a.deployments || [])[0];
    return d && (d.contractAddress || d.address)
      ? { symbol: a.tokenSymbol, name: (a.tokenName || '').replace(' • Robinhood Token', '').trim(), address: d.contractAddress || d.address }
      : null;
  }).filter(Boolean);
}

async function usdPrices(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 25) {
    const slice = addresses.slice(i, i + 25);
    const res = await fetch(DEX + slice.join(','), { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => ({}));
    for (const p of j.pairs || []) {
      const base = ((p.baseToken && p.baseToken.address) || '').toLowerCase();
      const usd = Number(p.priceUsd), liq = Number((p.liquidity || {}).usd) || 0;
      if (!(usd > 0) || !slice.some((a) => a.toLowerCase() === base)) continue;
      const prev = out.get(base);
      if (!prev || liq > prev.liquidity) out.set(base, { usd, liquidity: liq });
    }
    await sleep(300);
  }
  return out;
}

const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

async function main() {
  const assets = await registry();
  assets.push({ symbol: 'USDG', name: 'Robinhood USD', address: cfg.usdg });

  const cfgRaw = (await callMany(cfg.pons.factory, [chain.encodeCall('getLaunchConfig(uint256)', [0])]))[0];
  const supply = word(cfgRaw, 0);
  const curveFeeBps = word(cfgRaw, 1);
  const tokensOnCurve = supply * (BPS - RESERVED_BPS) / BPS;

  const menu = [];
  for (let i = 0; i < assets.length; i += 25) {
    const slice = assets.slice(i, i + 25);
    const flags = await callMany(cfg.pons.factory, slice.map((a) => chain.encodeCall('approvedPairTokens(address)', [a.address])));
    const live = slice.filter((_, k) => flags[k] && BigInt(flags[k]));
    if (live.length) {
      const econ = await callMany(cfg.pons.factory, live.map((a) => chain.encodeCall('pairTokenEconomics(address)', [a.address])));
      live.forEach((a, k) => {
        const e = econ[k];
        if (!e || e.length < 194) return;
        menu.push(Object.assign({}, a, {
          phantomQuote: word(e, 0), graduationThreshold: word(e, 1), decimals: Number(word(e, 2)) || 18,
        }));
      });
    }
    await sleep(300);
  }

  const prices = await usdPrices(menu.map((a) => a.address));
  const rows = [];
  for (const a of menu) {
    const p = prices.get(a.address.toLowerCase());
    if (!p) continue;                                   // no dollar price, nothing to compare
    const unit = 10 ** a.decimals;
    const pairPerToken = Number(a.phantomQuote) / unit / (Number(tokensOnCurve) / 1e18);
    const openingUsd = pairPerToken * (Number(supply) / 1e18) * p.usd;
    const graduationUsd = Number(a.graduationThreshold) / unit * p.usd;
    rows.push({ symbol: a.symbol, name: a.name, decimals: a.decimals, usd: p.usd, liquidity: p.liquidity,
      phantomQuote: (Number(a.phantomQuote) / unit), openingUsd, graduationUsd });
  }
  rows.sort((x, y) => y.openingUsd - x.openingUsd);

  if (JSON_OUT) { console.log(JSON.stringify({ supply: supply.toString(), curveFeeBps: Number(curveFeeBps), tokensOnCurve: tokensOnCurve.toString(), rows }, null, 1)); return; }

  const lo = rows[rows.length - 1], hi = rows[0];
  console.log('The same one-click launch, priced in each pairing asset\n');
  console.log(`Launch config 0: ${(Number(supply) / 1e18).toLocaleString()} supply, ${Number(curveFeeBps) / 100}% curve fee,`);
  console.log(`${(Number(tokensOnCurve) / 1e18).toLocaleString()} tokens sold on the curve (the rest is held back for graduation).\n`);
  console.log('SYMBOL   PAIR $        PHANTOM QUOTE      OPENS AT (USD)   GRADUATES AT (USD)');
  console.log('-------  ------------  -----------------  ---------------  ------------------');
  for (const r of rows) {
    console.log(`${r.symbol.padEnd(7)}  ${('$' + r.usd.toLocaleString('en-US', { maximumFractionDigits: r.usd < 10 ? 4 : 2 })).padStart(12)}`
      + `  ${r.phantomQuote.toFixed(6).padStart(17)}  ${('$' + Math.round(r.openingUsd).toLocaleString()).padStart(15)}`
      + `  ${('$' + Math.round(r.graduationUsd).toLocaleString()).padStart(18)}`);
  }
  console.log(`\nSame button, same supply, same curve — and an opening valuation that runs from`);
  console.log(`$${Math.round(lo.openingUsd).toLocaleString()} (${lo.symbol}) to $${Math.round(hi.openingUsd).toLocaleString()} (${hi.symbol}), a ${(hi.openingUsd / lo.openingUsd).toFixed(2)}x spread.`);
  console.log(`Nothing about the assets explains that. The per-asset number was typed by hand and not revisited.`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
