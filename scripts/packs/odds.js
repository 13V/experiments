#!/usr/bin/env node
'use strict';

/**
 * Stonk Packs toolkit. Zero dependencies.
 *
 *   node scripts/packs/odds.js rtp                 print the odds table and expected payout
 *   node scripts/packs/odds.js chain [N]           generate an operator seed chain (secret stays local)
 *   node scripts/packs/odds.js seed <secret> <k>   derive seed_k for opening pack k
 *   node scripts/packs/odds.js tiers               fetch canonical Robinhood stock token addresses
 *                                                  and print the setTier calls for the default table
 *   node scripts/packs/odds.js verify <seed_k> <buyerSeed> <packId> <blockhash>
 *                                                  recompute a pack's pulls from public inputs
 *                                                  (seed_k from the open or openLate calldata,
 *                                                  buyerSeed from the Bought event, blockhash
 *                                                  of purchaseBlock + 1)
 *
 * The contract's randomness and tier selection are mirrored here byte for byte, so
 * anyone can re-derive every pull of every pack from on-chain data.
 */

const crypto = require('node:crypto');
const { keccak256 } = require('../keccak');

// ---------------------------------------------------------------------------
// Default odds table. Weights sum to 10,000. Values in whole USD.
// ---------------------------------------------------------------------------

const TIERS = [
  { name: 'Common',    weight: 7200, usd: 1,    tokens: ['F', 'AMC', 'BB', 'SOFI', 'RIVN', 'SNAP', 'CCL', 'HIMS', 'SOUN', 'RCAT'] },
  { name: 'Uncommon',  weight: 2000, usd: 3,    tokens: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'COIN', 'INTC', 'AMD', 'NFLX', 'RBLX'] },
  { name: 'Rare',      weight: 600,  usd: 12,   tokens: ['NVDA', 'TSLA', 'PLTR', 'MSTR', 'SPCX', 'GME', 'GLD', 'TTWO'] },
  { name: 'Epic',      weight: 180,  usd: 50,   tokens: ['COST', 'ASML', 'NET', 'AVGO', 'UNH'] },
  { name: 'Legendary', weight: 19,   usd: 200,  tokens: ['CELH', 'LULU', 'IREN', 'WULF', 'GLXY', 'RKLB'] },
  { name: 'Mythic',    weight: 1,    usd: 1163, tokens: ['LLY'] }, // one whole share of Eli Lilly
];

const PACK_PRICE_USD = 20;
const PULLS_PER_PACK = 5;

function rtp(tiers = TIERS, price = PACK_PRICE_USD, pulls = PULLS_PER_PACK) {
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  const evPull = tiers.reduce((s, t) => s + (t.weight / total) * t.usd, 0);
  return { total, evPull, evPack: evPull * pulls, rtp: (evPull * pulls) / price };
}

// ---------------------------------------------------------------------------
// Seed chain. s_N = secret, s_k = keccak(s_{k+1}), root = keccak(s_1).
// Pack k is opened with s_k; the contract checks keccak(s_k) == current head.
// ---------------------------------------------------------------------------

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const buf = (h) => Buffer.from(String(h).replace(/^0x/i, ''), 'hex');

function deriveChain(secretHex, n) {
  const seeds = new Array(n + 1);
  seeds[n] = buf(secretHex);
  for (let k = n - 1; k >= 1; k--) seeds[k] = keccak256(seeds[k + 1]);
  const root = keccak256(seeds[1]);
  return { root: hex(root), seeds: seeds.map((s, i) => (i === 0 ? null : hex(s))) };
}

/** seed_k without materialising the whole chain: hash the secret (N - k) times. */
function seedAt(secretHex, n, k) {
  let s = buf(secretHex);
  for (let i = 0; i < n - k; i++) s = keccak256(s);
  return hex(s);
}

// ---------------------------------------------------------------------------
// Mirror of the contract's randomness and selection
// ---------------------------------------------------------------------------

const word = (v) => {
  if (typeof v === 'bigint' || typeof v === 'number') return Buffer.from(BigInt(v).toString(16).padStart(64, '0'), 'hex');
  const b = Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v) : buf(v);
  if (b.length > 32) throw new Error('word overflow');
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
};

/** keccak256(abi.encode(seed, buyerSeed, packId, blockhash)). No address is an input: the
 *  holder can change after everything else is fixed, so it must not steer the outcome. */
function packRandomness(seed, buyerSeed, packId, blockhash) {
  return keccak256(Buffer.concat([word(seed), word(buyerSeed), word(packId), word(blockhash)]));
}

function pickTier(rand, tiers = TIERS) {
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  const roll = Number(BigInt('0x' + rand.toString('hex')) % BigInt(total));
  let acc = 0;
  for (let i = 0; i < tiers.length; i++) {
    acc += tiers[i].weight;
    if (roll < acc) return i;
  }
  return tiers.length - 1;
}

function pickToken(rand, tier) {
  // The contract uses abi.encode(rand, "token"), which is NOT encodePacked:
  // head(rand) | offset 0x40 | length 5 | "token" right-padded to 32 bytes.
  const enc = Buffer.concat([
    word(rand),
    word(0x40),
    word(5),
    Buffer.concat([Buffer.from('token', 'utf8'), Buffer.alloc(27)]),
  ]);
  const h = keccak256(enc);
  return Number(BigInt('0x' + h.toString('hex')) % BigInt(tier.tokens.length));
}

function pulls(randomness, pullsPerPack = PULLS_PER_PACK, tiers = TIERS) {
  const out = [];
  for (let i = 0; i < pullsPerPack; i++) {
    const r = keccak256(Buffer.concat([word(randomness), word(i)]));
    const t = pickTier(r, tiers);
    out.push({ index: i, tier: tiers[t].name, usd: tiers[t].usd, token: tiers[t].tokens[pickToken(r, tiers[t])] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical token addresses (Robinhood publishes the registry)
// ---------------------------------------------------------------------------

async function fetchCanonical() {
  const res = await fetch('https://api.robinhood.com/rhj/assets', { headers: { 'User-Agent': 'stonkpacks' } });
  const data = await res.json();
  const items = Array.isArray(data) ? data : data.results || data.assets || [];
  const map = {};
  for (const a of items) {
    for (const d of a.deployments || []) if (d.chainId === 4663) map[a.tokenSymbol] = d.contractAddress;
  }
  return map;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  (async () => {
    if (cmd === 'rtp') {
      const r = rtp();
      console.log(`pack $${PACK_PRICE_USD}, ${PULLS_PER_PACK} pulls, weights sum ${r.total}\n`);
      for (const t of TIERS) {
        console.log(`  ${t.name.padEnd(10)} ${(100 * t.weight / r.total).toFixed(2).padStart(6)}%  $${String(t.usd).padStart(5)}  ${t.tokens.join(' ')}`);
      }
      console.log(`\n  EV per pull $${r.evPull.toFixed(3)}  EV per pack $${r.evPack.toFixed(2)}  return to player ${(100 * r.rtp).toFixed(1)}%`);
      console.log(`  odds of a Mythic in one pack: 1 in ${Math.round(1 / (1 - Math.pow(1 - 1 / r.total, PULLS_PER_PACK)))}`);
    } else if (cmd === 'chain') {
      const n = Number(rest[0] || 10000);
      const secret = hex(crypto.randomBytes(32));
      const t0 = Date.now();
      const { root } = deriveChain(secret, n);
      console.log(`secret (KEEP OFFLINE): ${secret}`);
      console.log(`chain length        : ${n}`);
      console.log(`root (publish, pass to constructor): ${root}`);
      console.log(`derived in ${Date.now() - t0} ms`);
    } else if (cmd === 'seed') {
      const [secret, k, n] = rest;
      console.log(seedAt(secret, Number(n || 10000), Number(k)));
    } else if (cmd === 'tiers') {
      const map = await fetchCanonical();
      const missing = [];
      TIERS.forEach((t, i) => {
        const addrs = t.tokens.map((s) => { if (!map[s]) missing.push(s); return map[s] || null; }).filter(Boolean);
        console.log(`setTier(${i}, ${t.weight}, ${t.usd * 100}, [${addrs.join(', ')}])  // ${t.name}`);
      });
      if (missing.length) console.log('\nnot in the canonical registry:', missing.join(' '));
    } else if (cmd === 'verify') {
      const [seed, buyerSeed, packId, bh] = rest;
      const r = packRandomness(seed, buyerSeed, BigInt(packId), bh || '0x' + '00'.repeat(32));
      console.log('randomness', hex(r));
      for (const p of pulls(r)) console.log(`  pull ${p.index}: ${p.tier.padEnd(9)} $${String(p.usd).padStart(4)} of ${p.token}`);
    } else {
      console.log('usage: odds.js <rtp|chain [N]|seed <secret> <k> [N]|tiers|verify ...>');
      process.exit(1);
    }
  })();
}

module.exports = { TIERS, PACK_PRICE_USD, PULLS_PER_PACK, rtp, deriveChain, seedAt, packRandomness, pickTier, pickToken, pulls, fetchCanonical };
