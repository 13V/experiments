#!/usr/bin/env node
'use strict';
/**
 * prices.js — what is each pairing asset worth, and is it deep enough to price a coin against?
 *
 * A coin paired with gold is quoted in ounces, which is the point; but a buyer still wants to know
 * what an ounce is, and a launch curve has to be sized in the pair asset's own units — a launch
 * against $405 gold and one against $1 USDG cannot use the same numbers. Both need the same thing:
 * a reliable dollar price for every asset on the menu, and a sense of whether its own market is
 * deep enough that the quote means anything.
 *
 * The price comes from the pair asset's own deepest pool on this chain, read through DexScreener.
 * That is a third party and it can be wrong or late — for anything that decides money, read the
 * pool directly. This is for sizing, display and sanity, not for settlement.
 *
 *   node scripts/prices.js                # every approved pairing asset, by depth
 *   node scripts/prices.js GLD SGOV USO   # just these
 *   node scripts/prices.js --json
 */
const path = require('path');
const chain = require(path.join(__dirname, 'chain.js'));
const cfg = require(path.join(__dirname, '..', 'config', 'addresses.json'));

const DEX = 'https://api.dexscreener.com/latest/dex/tokens/';
const JSON_OUT = process.argv.includes('--json');
const WANT = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

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
      ? { symbol: a.tokenSymbol, name: (a.tokenName || '').replace(' • Robinhood Token', '').trim(), decimals: a.tokenDecimals, address: d.contractAddress || d.address }
      : null;
  }).filter(Boolean);
}

/**
 * The deepest pool DexScreener knows for each token, and the price it implies.
 *
 * One address per call, deliberately. `/latest/dex/tokens/` accepts a comma-separated list but caps
 * its answer at thirty pairs however long the list is — ask about thirty addresses and thirteen of
 * them come back — and the ones it drops are indistinguishable from the ones that genuinely have no
 * pool. An earlier version of this file batched twenty-five at a time and concluded that thirty
 * assets on this chain had no market at all, silver and oil among them. They all have markets. A
 * truncated answer is not a negative answer, and this is the third time that distinction has cost
 * something in this repo.
 */
async function quote(addresses) {
  const out = new Map();
  for (const address of addresses) {
    const slice = [address];
    const res = await fetch(DEX + address, { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => ({}));
    for (const p of j.pairs || []) {
      const base = (p.baseToken && p.baseToken.address || '').toLowerCase();
      if (!slice.some((a) => a.toLowerCase() === base)) continue;      // only where our asset is the base
      const usd = Number(p.priceUsd), liq = Number((p.liquidity || {}).usd);
      if (!(usd > 0)) continue;
      const prev = out.get(base);
      if (!prev || liq > prev.liquidity) {
        out.set(base, {
          usd, liquidity: liq || 0, venue: p.dexId + (p.labels && p.labels.length ? ' ' + p.labels.join('/') : ''),
          quoteSymbol: p.quoteToken && p.quoteToken.symbol, pair: p.pairAddress,
          vol24: Number((p.volume || {}).h24) || 0,
        });
      }
    }
    await sleep(300);
  }
  return out;
}

async function main() {
  const assets = await registry();
  assets.push({ symbol: 'USDG', name: 'Robinhood USD', decimals: 6, address: cfg.usdg });
  assets.push({ symbol: 'WETH', name: 'wrapped ether', decimals: 18, address: cfg.weth });

  // Only the ones a coin can actually be paired against.
  const flags = [];
  for (let i = 0; i < assets.length; i += 25) {
    const slice = assets.slice(i, i + 25);
    flags.push(...await callMany(cfg.pons.factory, slice.map((a) => chain.encodeCall('approvedPairTokens(address)', [a.address]))));
    await sleep(300);
  }
  let menu = assets.filter((_, i) => flags[i] && BigInt(flags[i]));
  if (WANT.length) menu = menu.filter((a) => WANT.includes(a.symbol.toUpperCase()));

  const prices = await quote(menu.map((a) => a.address));
  const rows = menu.map((a) => Object.assign({}, a, prices.get(a.address.toLowerCase()) || { usd: null, liquidity: 0 }))
    .sort((x, y) => (y.liquidity || 0) - (x.liquidity || 0));

  if (JSON_OUT) { console.log(JSON.stringify({ readAt: new Date().toISOString().slice(0, 19) + 'Z', assets: rows }, null, 1)); return; }

  console.log('Pairing assets, by the depth of their own market\n');
  console.log('SYMBOL   DEC        PRICE USD      OWN LIQUIDITY      24H VOLUME   VENUE           NAME');
  console.log('-------  ---  ---------------  ----------------  --------------   --------------  ------------------------');
  for (const r of rows) {
    const usd = r.usd == null ? '—' : '$' + r.usd.toLocaleString('en-US', { maximumFractionDigits: r.usd < 10 ? 4 : 2 });
    const liq = r.liquidity ? '$' + Math.round(r.liquidity).toLocaleString('en-US') : '—';
    const vol = r.vol24 ? '$' + Math.round(r.vol24).toLocaleString('en-US') : '—';
    console.log(`${r.symbol.padEnd(7)}  ${String(r.decimals ?? '?').padStart(3)}  ${usd.padStart(15)}  ${liq.padStart(16)}  ${vol.padStart(14)}   ${(r.venue || '—').padEnd(14)}  ${(r.name || '').slice(0, 24)}`);
  }
  const thin = rows.filter((r) => !r.usd || r.liquidity < 100000);
  if (thin.length) {
    console.log(`\nToo thin to price a launch against, or not quoted at all (< $100k of own liquidity):`);
    console.log('  ' + thin.map((r) => r.symbol).join(', '));
  }
  console.log('\nPrices are DexScreener\'s, from each asset\'s deepest pool on this chain. Good enough to size a');
  console.log('launch and to show a dollar figure beside an ounce; not good enough to settle anything.');
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
