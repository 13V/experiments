#!/usr/bin/env node
'use strict';

/**
 * dividend-leak.js — reproduce how Robinhood stock tokens hand out dividends, from chain data alone.
 *
 * A stock token never pays cash. When the underlying pays a dividend, Robinhood Assets (Jersey)
 * reinvests the cash and raises the token's ERC-8056 `uiMultiplier()`. This script shows two things
 * about that process, both readable from the public RPC with no dependencies:
 *
 *   1. The multiplier moves on or after the PAY date, not the ex-date. The token's price already
 *      dropped by the full dividend on the ex-date (the Chainlink feed is underlying × multiplier).
 *   2. The raise is spread over every token in existence at the moment of the update, but the cash
 *      only came from the tokens that existed on the record date. So
 *
 *          bump = dividend × (1 − withholding) / price × supplyAtRecord / supplyAtUpdate
 *
 *      Tokens minted after the record date are paid a dividend they never earned; tokens burned
 *      before the update forfeit theirs; and on a chain whose float grows weekly, whoever held on
 *      the record date gets a fraction. Ford, Sept 2026: 2%. UPS: 20%.
 *
 * Usage:
 *   node scripts/dividend-leak.js F                                    # multiplier history + live scheduled change
 *   node scripts/dividend-leak.js F --ex 2026-08-11 --dividend 0.15 --price 14.3
 *   node scripts/dividend-leak.js SPY --forecast                       # supply growth into the next ex-date
 *
 * Env: RPC_URL (default: the public Robinhood Chain RPC, which wants a browser-like user agent).
 * Historical state needs no archive node: supply is rebuilt from mint and burn events.
 */

const path = require('path');
const { keccak256Hex } = require(path.join(__dirname, 'keccak.js'));

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const REGISTRY = 'https://api.robinhood.com/rhj/assets';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const sig = (s) => strip(keccak256Hex(Buffer.from(s, 'utf8')));
const SEL = {
  totalSupply: '0x' + sig('totalSupply()').slice(0, 8),
  uiMultiplier: '0x' + sig('uiMultiplier()').slice(0, 8),
  newUIMultiplier: '0x' + sig('newUIMultiplier()').slice(0, 8),
  effectiveAt: '0x' + sig('effectiveAt()').slice(0, 8),
};
const TOPIC_MULTIPLIER = '0x' + sig('UIMultiplierUpdated(uint256,uint256,uint256)');
const TOPIC_TRANSFER = '0x' + sig('Transfer(address,address,uint256)');
const ZERO32 = '0x' + '0'.repeat(64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => '0x' + n.toString(16);
const f18 = (b) => Number(b) / 1e18;
const iso = (t) => new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

async function rpc(method, params) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    try {
      const r = await fetch(RPC, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      const j = await r.json();
      if (j.error) {
        if (/too many/i.test(j.error.message)) { await sleep(2000 * (attempt + 1)); continue; }
        throw new Error(j.error.message);
      }
      await sleep(250); // stay under the public RPC's rate limit
      return j.result;
    } catch (e) {
      if (e.name === 'AbortError') { await sleep(1000); continue; }
      throw e;
    } finally { clearTimeout(timer); }
  }
  throw new Error(`rate limited: ${method}`);
}
const call = (to, data, block = 'latest') => rpc('eth_call', [{ to, data }, block]);

async function getLogs(address, topics, latest) {
  try {
    return await rpc('eth_getLogs', [{ address, topics, fromBlock: '0x0', toBlock: 'latest' }]);
  } catch (e) {
    process.stderr.write(`  full-range eth_getLogs refused (${e.message}); chunking\n`);
  }
  const out = [];
  for (let from = 0; from <= latest; from += 10_000_000) {
    const to = Math.min(latest, from + 9_999_999);
    out.push(...(await rpc('eth_getLogs', [{ address, topics, fromBlock: hx(from), toBlock: hx(to) }])));
  }
  return out;
}

async function tokenAddress(symbol) {
  if (/^0x[0-9a-fA-F]{40}$/.test(symbol)) return symbol;
  const r = await fetch(REGISTRY, { headers: { 'user-agent': UA, accept: 'application/json' } });
  const j = await r.json();
  const items = Array.isArray(j) ? j : (j.results || j.assets || j.data || Object.values(j).find(Array.isArray));
  const a = items.find((x) => x.tokenSymbol === symbol.toUpperCase());
  if (!a) throw new Error(`${symbol} is not in the registry`);
  const d = (a.deployments || []).find((x) => String(x.chainId) === '4663') || a.deployments[0];
  return d.contractAddress || d.address;
}

// Block clock from two real block headers. Nitro makes ~10 blocks/s; never trust block.number for this.
async function blockClock(latest) {
  const [a, b] = await Promise.all([rpc('eth_getBlockByNumber', [hx(latest), false]), rpc('eth_getBlockByNumber', [hx(latest - 3_000_000), false])]);
  const ta = Number(BigInt(a.timestamp)), tb = Number(BigInt(b.timestamp));
  const rate = 3_000_000 / (ta - tb);
  return { rate, blockAt: (t) => Math.round(latest - (ta - t) * rate), timeOf: (bn) => ta - (latest - bn) / rate };
}

function args() {
  const a = process.argv.slice(2);
  const opt = { symbol: a[0] };
  for (let i = 1; i < a.length; i++) {
    const k = a[i];
    if (k === '--forecast') opt.forecast = true;
    else if (k.startsWith('--')) opt[k.slice(2)] = a[++i];
  }
  return opt;
}

(async () => {
  const opt = args();
  if (!opt.symbol) { console.log('usage: node scripts/dividend-leak.js <SYMBOL|address> [--ex YYYY-MM-DD] [--dividend D] [--price P] [--withholding 0.30] [--forecast]'); process.exit(1); }
  const address = await tokenAddress(opt.symbol);
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const clock = await blockClock(latest);
  console.log(`${opt.symbol.toUpperCase()} ${address}  (L2 block ${latest}, ${clock.rate.toFixed(2)} blocks/s)`);

  const [cur, nxt, eff, supply] = await Promise.all([call(address, SEL.uiMultiplier), call(address, SEL.newUIMultiplier), call(address, SEL.effectiveAt), call(address, SEL.totalSupply)]);
  console.log(`live: uiMultiplier ${f18(BigInt(cur)).toFixed(9)}  newUIMultiplier ${f18(BigInt(nxt)).toFixed(9)}  effectiveAt ${BigInt(eff) === 0n ? 'none' : iso(BigInt(eff))}  totalSupply ${f18(BigInt(supply)).toFixed(2)} tokens`);

  const updates = (await getLogs(address, [TOPIC_MULTIPLIER], latest)).map((l) => {
    const [oldM, newM, effT] = l.data.replace(/^0x/, '').match(/.{64}/g).map((w) => BigInt('0x' + w));
    return { block: parseInt(l.blockNumber, 16), oldM, newM, effT, tx: l.transactionHash };
  });
  console.log(`\nUIMultiplierUpdated: ${updates.length} event(s)`);
  for (const u of updates) {
    const t = clock.timeOf(u.block);
    console.log(`  block ${u.block} (~${iso(t)}): ${f18(u.oldM).toFixed(9)} -> ${f18(u.newM).toFixed(9)}  (+${((f18(u.newM) / f18(u.oldM) - 1) * 100).toFixed(4)}%)  effective ${iso(u.effT)}  ${u.tx}`);
  }

  if (!opt.ex && !opt.forecast) return;

  process.stderr.write('reconstructing supply from mint and burn events...\n');
  const mints = await getLogs(address, [TOPIC_TRANSFER, ZERO32], latest);
  const burns = await getLogs(address, [TOPIC_TRANSFER, null, ZERO32], latest);
  const events = [
    ...mints.map((l) => ({ block: parseInt(l.blockNumber, 16), amt: BigInt(l.data) })),
    ...burns.map((l) => ({ block: parseInt(l.blockNumber, 16), amt: -BigInt(l.data) })),
  ].sort((a, b) => a.block - b.block);
  const supplyAt = (bn) => events.filter((e) => e.block <= bn).reduce((s, e) => s + e.amt, 0n);
  const rebuilt = supplyAt(latest);
  console.log(`\nsupply rebuilt from ${mints.length} mints and ${burns.length} burns: ${f18(rebuilt).toFixed(2)} (totalSupply says ${f18(BigInt(supply)).toFixed(2)})`);

  const week = Math.round(7 * 86400 * clock.rate);
  const path8 = [];
  for (let bn = latest - 8 * week; bn <= latest; bn += week) path8.push(`${iso(clock.timeOf(bn)).slice(0, 10)} ${f18(supplyAt(bn)).toFixed(0)}`);
  console.log('weekly supply: ' + path8.join(' | '));

  if (opt.ex) {
    // Under T+1 the record date is the ex-date, and a trade settles on it only if it was made the
    // business day before. So the shares that earn the dividend are the ones backing the tokens at
    // the close before the ex-date; redemptions on the ex-date itself still get paid to the issuer.
    const ex = new Date(opt.ex + 'T00:00:00Z');
    const prev = new Date(ex); prev.setUTCDate(prev.getUTCDate() - 1);
    while (prev.getUTCDay() === 0 || prev.getUTCDay() === 6) prev.setUTCDate(prev.getUTCDate() - 1);
    const recordBlock = clock.blockAt(prev.getTime() / 1000 + 86399);
    const update = updates.find((u) => u.block > recordBlock);
    const sRecord = supplyAt(recordBlock);
    console.log(`\nentitled supply at the close before the ${opt.ex} ex-date (${prev.toISOString().slice(0, 10)} 23:59Z, block ${recordBlock}): ${f18(sRecord).toFixed(2)} tokens`);
    if (!update) { console.log('no multiplier update after the record date yet'); return; }
    const sUpdate = supplyAt(update.block - 1);
    const dilution = f18(sRecord) / f18(sUpdate);
    const observed = f18(update.newM) / f18(update.oldM) - 1;
    console.log(`update ${iso(clock.timeOf(update.block))}: supply ${f18(sUpdate).toFixed(2)} tokens, so the holders who earned the dividend were paid on ${(dilution * 100).toFixed(2)}% of it`);
    console.log(`observed multiplier bump: ${(observed * 100).toFixed(5)}%`);
    if (opt.dividend && opt.price) {
      const w = opt.withholding !== undefined ? Number(opt.withholding) : 0.30;
      const gross = Number(opt.dividend) / Number(opt.price);
      const expected = gross * (1 - w) * dilution;
      console.log(`gross dividend / price: ${(gross * 100).toFixed(4)}%   expected with ${(w * 100).toFixed(0)}% withholding and this dilution: ${(expected * 100).toFixed(5)}%   observed / expected = ${(observed / expected).toFixed(3)}`);
      console.log(`implied withholding at this dilution: ${((1 - observed / (gross * dilution)) * 100).toFixed(1)}%`);
      console.log(`a holder through the ex-date lost ${(gross * 100).toFixed(3)}% on the ex-date and got ${(observed * 100).toFixed(4)}% back at the update`);
    }
    const before = events.filter((e) => e.block > recordBlock && e.block < update.block && e.amt > 0n).reduce((s, e) => s + e.amt, 0n);
    console.log(`tokens minted between that close and the update: ${f18(before).toFixed(2)} (paid a dividend they did not earn)`);
  }

  if (opt.forecast) {
    const s1 = supplyAt(latest - week), s6 = supplyAt(latest - 6 * week);
    console.log(`\nforecast: supply ${f18(rebuilt).toFixed(0)} now, ${f18(s1).toFixed(0)} a week ago (x${(f18(rebuilt) / f18(s1)).toFixed(2)}), ${f18(s6).toFixed(0)} six weeks ago (x${(f18(rebuilt) / f18(s6)).toFixed(2)})`);
    console.log('if growth continues at even a fraction of this into the next pay date, record-date holders will be paid on a fraction of their dividend cash');
  }
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
