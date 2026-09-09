#!/usr/bin/env node
'use strict';

/**
 * meme-pools.js — can this memecoin feed a Morpho oracle?
 *
 * "Borrow the meme" is Locate's contracts pointed at memecoins: Morpho markets with the meme as
 * loan token and USDG as collateral. Memes have no Chainlink feed, so the oracle has to be a
 * Uniswap v3 time-weighted price, and a v3 pool only serves one if its observation buffer has
 * been grown (`observationCardinality`); v4 pools carry no oracle at all. This script answers,
 * per symbol: which pool, how deep, is a 30-minute and a 5-minute TWAP available right now, which
 * side the meme sits on, and roughly what it would cost to double the spot price in that pool.
 *
 *   node scripts/meme-pools.js PONS CASHCAT AI Index BONER
 *
 * Reads DexScreener for pool discovery and the public RPC for everything else. No dependencies.
 * The "WETH to 2x" column assumes the in-range liquidity stays constant out to twice the price,
 * which real books do not, so it bounds the cost of a spot spike from above; a 30-minute TWAP
 * additionally needs that spike held for the window against arbitrage.
 */

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SEL = { slot0: '0x3850c7bd', liquidity: '0x1a686502', fee: '0xddca3f43', token0: '0x0dfe1681', token1: '0xd21220a7', decimals: '0x313ce567', observe: '0x883bdbfd' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 40000);
    try {
      const r = await fetch(RPC, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      const j = await r.json();
      if (j.error) { if (/too many/i.test(j.error.message)) { await sleep(1500 * (attempt + 1)); continue; } return { error: j.error.message }; }
      await sleep(250); return j.result;
    } catch (e) { if (e.name === 'AbortError') { await sleep(1000); continue; } throw e; } finally { clearTimeout(t); }
  }
  return { error: 'rate limited' };
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const ok = (r) => r && !r.error && r !== '0x';
const word = (h, i) => BigInt('0x' + h.slice(2).slice(i * 64, i * 64 + 64));
const addrOf = (h) => '0x' + h.slice(2).slice(24, 64);
const observeCalldata = (secs) => SEL.observe + '20'.padStart(64, '0') + '2'.padStart(64, '0') + secs.toString(16).padStart(64, '0') + '0'.repeat(64);
async function dex(url) { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } }); return r.json(); }
const usd = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

async function twap(pool, secs) {
  const r = await call(pool, observeCalldata(secs));
  if (ok(r)) return 'ok';
  return r && r.error && /OLD/i.test(r.error) ? 'OLD' : 'fail';
}

async function poolReport(pool) {
  const [t0, t1, slot0, liq, fee] = await Promise.all([call(pool, SEL.token0), call(pool, SEL.token1), call(pool, SEL.slot0), call(pool, SEL.liquidity), call(pool, SEL.fee)]);
  if (!ok(slot0) || slot0.length < 2 + 7 * 64) return null;
  return { token0: addrOf(t0), token1: addrOf(t1), sqrtP: word(slot0, 0), cardinality: Number(word(slot0, 3)), next: Number(word(slot0, 4)), L: BigInt(liq), fee: ok(fee) ? Number(BigInt(fee)) : NaN, t30: await twap(pool, 1800), t5: await twap(pool, 300) };
}

// WETH needed to double the price of the meme under constant in-range liquidity.
function wethToDouble(rep, memeIsToken0) {
  const Q96 = 2 ** 96, sqrtP = Number(rep.sqrtP), L = Number(rep.L);
  if (memeIsToken0) return L * sqrtP * (Math.SQRT2 - 1) / Q96 / 1e18;          // buy token0 with token1: token1 in = L * (sqrtP' - sqrtP)
  return L * (Q96 / (sqrtP / Math.SQRT2) - Q96 / sqrtP) / 1e18;                 // buy token1 with token0: token0 in = L * (1/sqrtP' - 1/sqrtP)
}

(async () => {
  const symbols = process.argv.slice(2);
  if (!symbols.length) { console.log('usage: node scripts/meme-pools.js SYMBOL [SYMBOL...]'); process.exit(1); }

  // The second hop of the oracle: the deepest WETH/USDG v3 pool.
  let ethUsd = 0;
  try {
    const j = await dex('https://api.dexscreener.com/latest/dex/search?q=WETH%20USDG');
    const both = [WETH, USDG].sort().join();
    const ps = (j.pairs || []).filter((p) => p.chainId === 'robinhood' && (p.labels || []).includes('v3') && [p.baseToken.address, p.quoteToken.address].map((a) => a.toLowerCase()).sort().join() === both)
      .sort((a, b) => Number((b.liquidity || {}).usd || 0) - Number((a.liquidity || {}).usd || 0));
    if (ps[0]) {
      ethUsd = ps[0].baseToken.address.toLowerCase() === WETH ? Number(ps[0].priceUsd) : 1 / Number(ps[0].priceNative);
      const rep = await poolReport(ps[0].pairAddress);
      console.log(`WETH/USDG v3 ${ps[0].pairAddress}: liquidity $${usd(Number(ps[0].liquidity.usd))}, observations ${rep ? rep.cardinality : '?'}, 30m TWAP ${rep ? rep.t30 : '?'}, WETH ≈ $${ethUsd.toFixed(0)}\n`);
    }
  } catch (e) { console.log('WETH/USDG lookup failed:', e.message); }

  console.log(`${'meme'.padEnd(12)} ${'pool'.padEnd(5)} ${'quote'.padEnd(6)} ${'liquidity $'.padStart(12)} ${'vol 24h $'.padStart(12)} ${'fee'.padStart(6)} ${'obs'.padStart(6)} ${'30m'.padEnd(5)} ${'5m'.padEnd(5)} ${'side'.padEnd(7)} ${'dec'.padStart(3)} ${'$ to 2x spot'.padStart(13)}  pool / meme`);
  for (const sym of symbols) {
    let pairs;
    try { const j = await dex(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`); pairs = (j.pairs || []).filter((p) => p.chainId === 'robinhood' && p.baseToken.symbol === sym); } catch (e) { console.log(`${sym.padEnd(12)} search failed`); continue; }
    if (!pairs.length) { console.log(`${sym.padEnd(12)} no pair found (symbols are case-sensitive)`); continue; }
    pairs.sort((a, b) => Number((b.liquidity || {}).usd || 0) - Number((a.liquidity || {}).usd || 0));
    const v3 = pairs.filter((p) => (p.labels || []).includes('v3') && /^0x[0-9a-fA-F]{40}$/.test(p.pairAddress));
    const deepest = pairs[0];
    if (!v3.length) { console.log(`${sym.padEnd(12)} ${String((deepest.labels || [])[0] || deepest.dexId).padEnd(5)} ${deepest.quoteToken.symbol.padEnd(6)} ${usd(Number((deepest.liquidity || {}).usd || 0)).padStart(12)} ${usd(Number((deepest.volume || {}).h24 || 0)).padStart(12)}   no v3 pool: no oracle`); continue; }
    const p = v3[0]; const rep = await poolReport(p.pairAddress);
    if (!rep) { console.log(`${sym.padEnd(12)} v3    ${p.quoteToken.symbol.padEnd(6)} pool did not answer slot0: ${p.pairAddress}`); continue; }
    const memeIsToken0 = rep.token1 === WETH || rep.token1 === USDG;
    const meme = memeIsToken0 ? rep.token0 : rep.token1;
    const decHex = await call(meme, SEL.decimals); const dec = ok(decHex) ? Number(BigInt(decHex)) : NaN;
    const quoteIsWeth = (memeIsToken0 ? rep.token1 : rep.token0) === WETH;
    const cost = wethToDouble(rep, memeIsToken0) * (quoteIsWeth ? ethUsd : 1);
    console.log(`${sym.padEnd(12)} v3    ${p.quoteToken.symbol.padEnd(6)} ${usd(Number((p.liquidity || {}).usd || 0)).padStart(12)} ${usd(Number((p.volume || {}).h24 || 0)).padStart(12)} ${String((rep.fee / 10000) + '%').padStart(6)} ${String(rep.cardinality).padStart(6)} ${rep.t30.padEnd(5)} ${rep.t5.padEnd(5)} ${(memeIsToken0 ? 'token0' : 'token1').padEnd(7)} ${String(dec).padStart(3)} ${usd(cost).padStart(13)}  ${p.pairAddress} / ${meme}`);
    if (deepest !== p) console.log(`${''.padEnd(12)} deepest pool is ${(deepest.labels || [])[0] || deepest.dexId} ${deepest.quoteToken.symbol} at $${usd(Number((deepest.liquidity || {}).usd || 0))}, which carries no oracle`);
  }
  console.log('\n"obs" is observationCardinality: a v3 pool serves a 30-minute TWAP only when its buffer covers the window; "OLD" means it does not yet, and anyone can grow it with increaseObservationCardinalityNext.');
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
