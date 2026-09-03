#!/usr/bin/env node
'use strict';

/**
 * Stonk Packs integration tests: the compiled contract inside a real EVM.
 *
 *   npm install --no-save solc@0.8.28 @ethereumjs/vm@8.1.1 @ethereumjs/common@4.4.0 @ethereumjs/util@9.1.0 @ethereumjs/block@5.3.0
 *   node scripts/packs/test.js
 *
 * What is proven here, in order of how much it matters:
 *   1. The on-chain pulls are exactly what scripts/packs/odds.js recomputes from public
 *      inputs, so anyone can verify any pack.
 *   2. Opens are strictly ordered on the seed chain, a wrong seed is rejected, and a
 *      stalled pack becomes refundable by anyone, then is settled late with the same
 *      prizes a timely open would have paid, and the game continues.
 *   3. Every pull pays either the stock at the feed price or the same USD in cash;
 *      empty inventory, stale feeds and a downed sequencer all degrade to cash or an IOU.
 *   4. Escrow and IOUs can never be withdrawn by the owner.
 *   5. Over a few hundred packs the realised payout tracks the published odds.
 */

let solc, VM, Common, Hardfork, Address, Account, hexToBytes, bytesToHex, Block;
try {
  solc = require('solc');
  ({ VM } = require('@ethereumjs/vm'));
  ({ Common, Hardfork } = require('@ethereumjs/common'));
  ({ Address, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util'));
  ({ Block } = require('@ethereumjs/block'));
} catch (e) {
  console.log('SKIPPED — dev dependencies not installed. See the header of this file.');
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const { keccak256 } = require('../keccak');
const odds = require('./odds');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? '  — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// ABI helpers (hand-rolled; the shapes here are few)
// ---------------------------------------------------------------------------

const strip = (h) => String(h).replace(/^0x/i, '');
const word = (v) => {
  if (typeof v === 'bigint' || typeof v === 'number') {
    let b = BigInt(v);
    if (b < 0n) b = (1n << 256n) + b;
    return Buffer.from(b.toString(16).padStart(64, '0'), 'hex');
  }
  if (typeof v === 'boolean') return word(v ? 1 : 0);
  const b = Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(strip(v), 'hex');
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
};
const selector = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4);

function encodeArgs(types, values) {
  const heads = [];
  let tail = Buffer.alloc(0);
  const headLen = 32 * types.length;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const v = values[i];
    if (t.endsWith('[]')) {
      const enc = Buffer.concat([word(v.length), ...v.map((x) => word(x))]);
      heads.push(word(headLen + tail.length));
      tail = Buffer.concat([tail, enc]);
    } else if (t === 'string' || t === 'bytes') {
      const raw = Buffer.from(v, t === 'string' ? 'utf8' : 'hex');
      const padded = Buffer.concat([raw, Buffer.alloc((32 - (raw.length % 32)) % 32)]);
      heads.push(word(headLen + tail.length));
      tail = Buffer.concat([tail, word(raw.length), padded]);
    } else {
      heads.push(word(v));
    }
  }
  return Buffer.concat([...heads, tail]);
}

function encode(sig, ...values) {
  const types = sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean);
  return Buffer.concat([selector(sig), encodeArgs(types, values)]);
}

const words = (buf) => {
  const out = [];
  for (let i = 0; i + 32 <= buf.length; i += 32) out.push(Buffer.from(buf.subarray(i, i + 32)));
  return out;
};
const toBig = (w) => BigInt('0x' + Buffer.from(w).toString('hex'));
const toAddr = (w) => '0x' + Buffer.from(w).subarray(12).toString('hex');
const errorIs = (ret, sig) => ret.length >= 4 && Buffer.from(ret.subarray(0, 4)).equals(selector(sig));

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

const root = path.join(__dirname, '..', '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'StonkPacks.sol': { content: src('contracts/StonkPacks.sol') },
    'test/PackMocks.sol': { content: src('contracts/test/PackMocks.sol') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
})));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }
const warnings = (out.errors || []).filter((e) => e.severity === 'warning');
const ART = {
  StonkPacks: out.contracts['StonkPacks.sol'].StonkPacks,
  MockERC20: out.contracts['test/PackMocks.sol'].MockERC20,
  MockAggregator: out.contracts['test/PackMocks.sol'].MockAggregator,
  PackHolder: out.contracts['test/PackMocks.sol'].PackHolder,
  FreezingERC20: out.contracts['test/PackMocks.sol'].FreezingERC20,
  RevertingERC20: out.contracts['test/PackMocks.sol'].RevertingERC20,
  BombERC20: out.contracts['test/PackMocks.sol'].BombERC20,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OWNER = '0x' + 'a0'.repeat(20);
const BUYER = '0x' + 'b1'.repeat(20);
const BUYER2 = '0x' + 'b2'.repeat(20);
const STRANGER = '0x' + 'c3'.repeat(20);
const FEE_TO = '0x' + 'f0'.repeat(20);
const ETH = 10n ** 18n;
const addr = (h) => new Address(hexToBytes(h));

const PRICE = 20_000_000n; // 20 USDG (6 decimals)
const FEE_BPS = 1000n;
const PULLS = 5;

// Mock feed prices (USD, 8 decimals) for every symbol in the odds table.
const PRICES = {
  F: 60.86, AMC: 2.59, BB: 7.95, SOFI: 17.73, RIVN: 19.99, SNAP: 22.72, CCL: 36.70, HIMS: 29.27, SOUN: 6.94, RCAT: 14.69,
  AAPL: 325.81, MSFT: 502.29, GOOGL: 336.22, AMZN: 256.41, META: 580.79, COIN: 177.09, INTC: 89.62, AMD: 454.45, NFLX: 80.42, RBLX: 40.95,
  NVDA: 218.07, TSLA: 355.99, PLTR: 180.62, MSTR: 126.95, SPCX: 142.09, GME: 18.78, GLD: 398.61, TTWO: 218.21,
  COST: 944.33, ASML: 1658.72, NET: 284.07, AVGO: 373.39, UNH: 399.80,
  CELH: 42.58, LULU: 143.63, IREN: 37.26, WULF: 14.93, GLXY: 23.35, RKLB: 62.94,
  LLY: 1162.57,
};
const price8 = (usd) => BigInt(Math.round(usd * 1e8));
/** Contract formula: cents * 10^tokenDec * 10^feedDec / (100 * price) */
const quoteAmount = (cents, priceUsd) => (BigInt(cents) * 10n ** 18n * 10n ** 8n) / (100n * price8(priceUsd));

async function main() {
  const common = new Common({ chain: 1, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });

  // Deterministic fake block hashes so BLOCKHASH resolves for any recent block.
  const fakeHash = (n) => keccak256(Buffer.concat([Buffer.from('blockhash', 'utf8'), word(BigInt(n))]));
  const bc = vm.evm.blockchain || vm.blockchain;
  bc.getBlock = async (n) => ({ hash: () => new Uint8Array(fakeHash(typeof n === 'bigint' ? n : BigInt(n))) });

  let blockNo = 1000n;
  let ts = 1_800_000_000n;
  const advance = (n) => { blockNo += BigInt(n); ts += BigInt(n); };
  const curBlock = () => Block.fromBlockData({ header: { number: blockNo, timestamp: ts, gasLimit: 30_000_000n } }, { common });

  for (const a of [OWNER, BUYER, BUYER2, STRANGER, FEE_TO]) {
    await vm.stateManager.putAccount(addr(a), new Account(0n, 1000n * ETH));
  }

  const call = async ({ from = OWNER, to, data, value = 0n }) => {
    const res = await vm.evm.runCall({
      caller: addr(from), origin: addr(from), to: to ? addr(to) : undefined,
      data, value, gasLimit: 12_000_000n, block: curBlock(),
    });
    return {
      reverted: !!res.execResult.exceptionError,
      error: res.execResult.exceptionError?.error,
      ret: Buffer.from(res.execResult.returnValue),
      logs: (res.execResult.logs || []).map(([a, topics, d]) => ({
        address: bytesToHex(a), topics: topics.map((t) => bytesToHex(t)), data: Buffer.from(d),
      })),
      created: res.createdAddress ? bytesToHex(res.createdAddress.bytes) : null,
      gas: res.execResult.executionGasUsed,
    };
  };

  const deploy = async (art, types = [], args = [], from = OWNER) => {
    const r = await call({ from, data: Buffer.concat([Buffer.from(art.evm.bytecode.object, 'hex'), encodeArgs(types, args)]) });
    if (r.reverted) throw new Error('deploy failed: ' + r.error);
    return r.created;
  };

  const view = async (to, sig, ...args) => {
    const r = await call({ from: STRANGER, to, data: encode(sig, ...args) });
    if (r.reverted) return null;
    return words(r.ret);
  };
  const viewBig = async (to, sig, ...args) => { const w = await view(to, sig, ...args); return w ? toBig(w[0]) : null; };

  const EV = {
    Bought: bytesToHex(keccak256(Buffer.from('Bought(uint256,address,bytes32,uint256)'))),
    Opened: bytesToHex(keccak256(Buffer.from('Opened(uint256,address,bytes32,bytes32,bool)'))),
    Pull: bytesToHex(keccak256(Buffer.from('Pull(uint256,uint8,uint8,address,uint256,uint64,bool)'))),
    Refunded: bytesToHex(keccak256(Buffer.from('Refunded(uint256,address,uint256)'))),
  };
  const pullsOf = (logs) => logs.filter((l) => l.topics[0] === EV.Pull).map((l) => {
    const w = words(l.data);
    return { packId: toBig(Buffer.from(strip(l.topics[1]), 'hex')), index: Number(toBig(w[0])), tier: Number(toBig(w[1])),
      token: toAddr(w[2]), amount: toBig(w[3]), usdCents: toBig(w[4]), cash: toBig(w[5]) === 1n };
  });
  const openedOf = (logs) => logs.filter((l) => l.topics[0] === EV.Opened).map((l) => ({
    packId: toBig(Buffer.from(strip(l.topics[1]), 'hex')), holder: '0x' + strip(l.topics[2]).slice(24),
    randomness: '0x' + l.data.subarray(0, 32).toString('hex'), blockHash: '0x' + l.data.subarray(32, 64).toString('hex'), late: toBig(l.data.subarray(64, 96)) === 1n }));
  const hashOf = async (packsAddr, id) => bytesToHex((await view(packsAddr, 'packs(uint256)', id))[5]);
  const expectRand = (k, buyerSeed, purchaseBlock) =>
    '0x' + odds.packRandomness(seed(k), buyerSeed, BigInt(k), '0x' + fakeHash(purchaseBlock + 1n).toString('hex')).toString('hex');

  // -------------------------------------------------------------------------
  // World builder
  // -------------------------------------------------------------------------

  const SECRET = '0x' + '5e'.repeat(32);
  const N = 400;
  const chain = odds.deriveChain(SECRET, N);
  const seed = (k) => chain.seeds[k];

  async function buildWorld({ tiers = odds.TIERS, inventory = true, pulls = PULLS, chainRoot = chain.root, chainLen = N, freezingPayment = false, reverting = [], bomb = [] } = {}) {
    const usdg = freezingPayment
      ? await deploy(ART.FreezingERC20, ['uint8'], [6])
      : await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Global Dollar', 'USDG', 6]);
    const tokens = {};
    const feeds = {};
    const symbols = [...new Set(tiers.flatMap((t) => t.tokens))];
    for (const s of symbols) {
      tokens[s] = reverting.includes(s)
        ? await deploy(ART.RevertingERC20)
        : bomb.includes(s)
          ? await deploy(ART.BombERC20)
          : await deploy(ART.MockERC20, ['string', 'string', 'uint8'], [s, s, 18]);
      feeds[s] = await deploy(ART.MockAggregator, ['int256', 'uint8'], [price8(PRICES[s]), 8]);
    }
    const packs = await deploy(ART.StonkPacks, ['address', 'uint256', 'uint8', 'uint16', 'address', 'bytes32', 'uint256'],
      [usdg, PRICE, pulls, FEE_BPS, FEE_TO, chainRoot, chainLen]);
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      const r = await call({ to: packs, data: encode('setTier(uint8,uint32,uint64,address[])', i, t.weight, t.usd * 100, t.tokens.map((s) => tokens[s])) });
      if (r.reverted) throw new Error('setTier failed ' + r.error + ' ' + r.ret.toString('hex'));
    }
    for (const s of symbols) {
      await call({ to: packs, data: encode('setFeed(address,address,uint32)', tokens[s], feeds[s], 3600) });
      if (inventory && !reverting.includes(s)) await call({ to: tokens[s], data: encode('mint(address,uint256)', packs, 1_000_000n * ETH) });
    }
    await call({ to: usdg, data: encode('mint(address,uint256)', BUYER, 1_000_000_000_000n) });
    await call({ to: usdg, data: encode('mint(address,uint256)', BUYER2, 1_000_000_000_000n) });
    for (const b of [BUYER, BUYER2]) await call({ from: b, to: usdg, data: encode('approve(address,uint256)', packs, (1n << 256n) - 1n) });
    return { usdg, tokens, feeds, packs, symbols, tiers };
  }

  // -------------------------------------------------------------------------
  section('Compilation');
  check('contracts compile with no errors', true);
  check('no warnings', warnings.length === 0, warnings.map((w) => w.formattedMessage.split('\n')[0]).join(' | '));

  section('World');
  const W = await buildWorld();
  const { usdg, tokens, feeds, packs } = W;
  const bal = async (token, who) => viewBig(token, 'balanceOf(address)', who);
  check('six tiers configured', (await viewBig(packs, 'tierCount()')) === 6n);
  check('expectedValueCents matches the odds table (1718 = $17.18 per $20 pack)', (await viewBig(packs, 'expectedValueCents()')) === 1718n);
  const early = await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '01'.repeat(32)) });
  check('nothing sells before the odds are locked', early.reverted && errorIs(early.ret, 'NotLocked()'));
  const lockR = await call({ to: packs, data: encode('lockOdds()') });
  check('owner locks the odds', !lockR.reverted, lockR.error);
  const refeed = await call({ to: packs, data: encode('setFeed(address,address,uint32)', tokens.F, feeds.AMC, 3600) });
  check('feeds cannot be repointed after lock', refeed.reverted && errorIs(refeed.ret, 'OddsAreLocked()'));
  const reseq = await call({ to: packs, data: encode('setSequencerFeed(address)', feeds.AMC) });
  check('sequencer feed cannot be set after lock', reseq.reverted && errorIs(reseq.ret, 'OddsAreLocked()'));
  const relock = await call({ to: packs, data: encode('setTier(uint8,uint32,uint64,address[])', 0, 1, 100, [tokens.F]) });
  check('odds cannot change after lock', relock.reverted && errorIs(relock.ret, 'OddsAreLocked()'));
  const pullsChange = await call({ to: packs, data: encode('setPullsPerPack(uint8)', 9) });
  check('pulls per pack cannot change after lock', pullsChange.reverted && errorIs(pullsChange.ret, 'OddsAreLocked()'));
  const strangerTier = await call({ from: STRANGER, to: packs, data: encode('setPrice(uint256)', 1n) });
  check('a stranger cannot change config', strangerTier.reverted && errorIs(strangerTier.ret, 'NotOwner()'));

  section('Buying');
  const buyerSeed1 = '0x' + '11'.repeat(32);
  const buy1 = await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', buyerSeed1) });
  check('buyer gets pack 1', !buy1.reverted && toBig(words(buy1.ret)[0]) === 1n, buy1.error);
  const purchaseBlock1 = blockNo;
  check('pack 1 is an NFT owned by the buyer', toAddr((await view(packs, 'ownerOf(uint256)', 1))[0]) === BUYER);
  check('price is escrowed', (await viewBig(packs, 'escrowed()')) === PRICE);
  check('USDG moved into the contract', (await bal(usdg, packs)) === PRICE);
  check('Bought event emitted', buy1.logs.some((l) => l.topics[0] === EV.Bought));

  section('Opening: guards');
  let r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('cannot open in the purchase block', r.reverted && errorIs(r.ret, 'TooEarly()'));
  advance(1);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('cannot open before the next block exists', r.reverted && errorIs(r.ret, 'TooEarly()'));
  advance(1);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 1, seed(2)) });
  check('wrong seed is rejected', r.reverted && errorIs(r.ret, 'BadSeed()'));
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 2, seed(1)) });
  check('a pack that does not exist cannot be opened', r.reverted && errorIs(r.ret, 'NotSealed()'));

  section('Opening: pack 1');
  const open1 = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('anyone can open with the right seed', !open1.reverted, open1.error || open1.ret.toString('hex'));
  const pulls1 = pullsOf(open1.logs);
  const opened1 = openedOf(open1.logs)[0];
  check(`exactly ${PULLS} pulls`, pulls1.length === PULLS, pulls1.length);
  check('prize went to the pack holder', opened1 && opened1.holder === BUYER);
  check('NFT burned', (await view(packs, 'ownerOf(uint256)', 1)) === null);
  check('escrow released', (await viewBig(packs, 'escrowed()')) === 0n);
  check('fee paid to feeRecipient', (await bal(usdg, FEE_TO)) === PRICE * FEE_BPS / 10_000n);
  check('chain advanced', (await viewBig(packs, 'revealed()')) === 1n && bytesToHex((await view(packs, 'chainHead()'))[0]) === seed(1));
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('cannot open twice', r.reverted && errorIs(r.ret, 'NotSealed()'));

  section('Pulls are priced by the feed and paid in stock');
  const symOf = Object.fromEntries(Object.entries(tokens).map(([s, a]) => [a.toLowerCase(), s]));
  let allStock = true;
  let amountsOk = true;
  const expectedBal = {};
  for (const p of pulls1) {
    if (p.cash) allStock = false;
    const s = symOf[p.token.toLowerCase()];
    const want = quoteAmount(Number(p.usdCents), PRICES[s]);
    if (p.amount !== want) amountsOk = false;
    expectedBal[s] = (expectedBal[s] || 0n) + p.amount;
  }
  check('every pull paid in stock (inventory is full)', allStock);
  check('every amount equals usd / feed price at 18 decimals', amountsOk);
  let balsOk = true;
  for (const [s, amt] of Object.entries(expectedBal)) if ((await bal(tokens[s], BUYER)) !== amt) balsOk = false;
  check('buyer token balances match the pulls', balsOk);
  console.log('       pulls: ' + pulls1.map((p) => `${odds.TIERS[p.tier].name}:$${Number(p.usdCents) / 100} ${symOf[p.token.toLowerCase()]}`).join(' | '));

  section('THE CRITICAL CHECK: odds.js recomputes the pack from public inputs');
  const jsRand = expectRand(1, buyerSeed1, purchaseBlock1);
  check('randomness matches keccak(seed, buyerSeed, packId, blockhash)', jsRand === opened1.randomness, `${jsRand} vs ${opened1.randomness}`);
  const jsPulls = odds.pulls(Buffer.from(strip(jsRand), 'hex'));
  const same = jsPulls.every((jp, i) => jp.tier === odds.TIERS[pulls1[i].tier].name && tokens[jp.token].toLowerCase() === pulls1[i].token.toLowerCase());
  check('tiers and tokens match the on-chain pulls, pull for pull', same);

  section('Ordering');
  const b2 = await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '22'.repeat(32)) });
  const b3 = await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '33'.repeat(32)) });
  check('packs 2 and 3 bought', !b2.reverted && !b3.reverted && (await viewBig(packs, 'packCount()')) === 3n);
  advance(2);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 3, seed(3)) });
  check('pack 3 cannot open before pack 2', r.reverted && errorIs(r.ret, 'OutOfOrder()'));
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 2, seed(2)) });
  check('pack 2 opens', !r.reverted, r.error);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 3, seed(3)) });
  check('then pack 3 opens', !r.reverted, r.error);

  section('Sealed packs are transferable; the prize follows the pack, the outcome does not');
  await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '44'.repeat(32)) });
  const purchaseBlock4 = blockNo;
  const tx = await call({ from: BUYER, to: packs, data: encode('transferFrom(address,address,uint256)', BUYER, BUYER2, 4) });
  check('buyer transfers sealed pack 4 to buyer2', !tx.reverted && toAddr((await view(packs, 'ownerOf(uint256)', 4))[0]) === BUYER2);
  const stranger = await call({ from: STRANGER, to: packs, data: encode('transferFrom(address,address,uint256)', BUYER2, STRANGER, 4) });
  check('a stranger cannot move it', stranger.reverted && errorIs(stranger.ret, 'NotAuthorized()'));
  advance(2);
  const open4 = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 4, seed(4)) });
  check('pack 4 opens', !open4.reverted, open4.error);
  check('prize went to buyer2, the holder at open time', openedOf(open4.logs)[0].holder === BUYER2);
  check('the outcome was fixed at purchase; changing hands did not change it', openedOf(open4.logs)[0].randomness === expectRand(4, '0x' + '44'.repeat(32), purchaseBlock4));

  section('Liveness: window, refund by anyone, late settlement still pays the prizes');
  await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '55'.repeat(32)) });
  const purchaseBlock5 = blockNo;
  r = await call({ from: STRANGER, to: packs, data: encode('refundExpired(uint256)', 5) });
  check('cannot refund inside the window', r.reverted && errorIs(r.ret, 'WindowOpen()'));
  advance(201);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 5, seed(5)) });
  check('cannot open after the window', r.reverted && errorIs(r.ret, 'WindowClosed()'));
  const buyerBefore = await bal(usdg, BUYER);
  r = await call({ from: STRANGER, to: packs, data: encode('refundExpired(uint256)', 5) });
  check('a stranger can trigger the refund', !r.reverted, r.error);
  check('the full price went back to the holder, no fee taken', (await bal(usdg, BUYER)) === buyerBefore + PRICE);
  check('refunded pack is burned', (await view(packs, 'ownerOf(uint256)', 5)) === null);
  check('the refund recorded blockhash(purchaseBlock + 1)', (await hashOf(packs, 5)) === '0x' + fakeHash(purchaseBlock5 + 1n).toString('hex'));
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 6, seed(5)) });
  check('chain is stuck until the refunded pack is settled', r.reverted);
  const feeBefore5 = await bal(usdg, FEE_TO);
  const late5 = await call({ from: STRANGER, to: packs, data: encode('openLate(uint256,bytes32)', 5, seed(5)) });
  check('openLate consumes seed 5', !late5.reverted && (await viewBig(packs, 'revealed()')) === 5n, late5.error);
  const lateEv = openedOf(late5.logs)[0];
  check('the refunded holder is still paid all 5 pulls', lateEv && lateEv.late && lateEv.holder === BUYER && pullsOf(late5.logs).length === PULLS);
  check('the late outcome is exactly what a timely open would have rolled', lateEv && lateEv.randomness === expectRand(5, '0x' + '55'.repeat(32), purchaseBlock5));
  check('the event carries the block hash it used', lateEv && lateEv.blockHash === '0x' + fakeHash(purchaseBlock5 + 1n).toString('hex'));
  check('no fee on a late pack', (await bal(usdg, FEE_TO)) === feeBefore5);
  r = await call({ from: STRANGER, to: packs, data: encode('openLate(uint256,bytes32)', 5, seed(6)) });
  check('cannot settle twice', r.reverted && errorIs(r.ret, 'NotRefunded()'));
  await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '66'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 6, seed(6)) });
  check('the game continues with pack 6', !r.reverted, r.error);

  section('Price changes never touch sealed packs');
  await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + 'e1'.repeat(32)) }); // pack 7 at 20
  const escBefore = await viewBig(packs, 'escrowed()');
  await call({ to: packs, data: encode('setPrice(uint256)', 30_000_000n) });
  await call({ from: BUYER2, to: packs, data: encode('buy(bytes32)', '0x' + 'e2'.repeat(32)) }); // pack 8 at 30
  check('escrow is the sum of what was actually paid', (await viewBig(packs, 'escrowed()')) === escBefore + 30_000_000n);
  advance(2);
  const feeBefore = await bal(usdg, FEE_TO);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 7, seed(7)) });
  check('pack bought at 20 opens after the price rose', !r.reverted, r.error);
  check('its fee is 10% of 20, not of 30', (await bal(usdg, FEE_TO)) === feeBefore + 2_000_000n);
  check('escrow released exactly 20', (await viewBig(packs, 'escrowed()')) === 30_000_000n);
  advance(201);
  const b2Before = await bal(usdg, BUYER2);
  await call({ from: STRANGER, to: packs, data: encode('refundExpired(uint256)', 8) });
  check('refund pays what was paid, 30', (await bal(usdg, BUYER2)) === b2Before + 30_000_000n);
  check('escrow back to zero', (await viewBig(packs, 'escrowed()')) === 0n);
  await call({ from: STRANGER, to: packs, data: encode('openLate(uint256,bytes32)', 8, seed(8)) });
  await call({ to: packs, data: encode('setPrice(uint256)', PRICE) });

  section('Contract buyers cannot interfere');
  const holder = await deploy(ART.PackHolder);
  await call({ to: usdg, data: encode('mint(address,uint256)', holder, PRICE) });
  r = await call({ from: STRANGER, to: holder, data: encode('approveAndBuy(address,address,uint256,bytes32)', packs, usdg, PRICE, '0x' + '77'.repeat(32)) });
  check('a contract can buy a pack', !r.reverted && toAddr((await view(packs, 'ownerOf(uint256)', 9))[0]) === holder.toLowerCase(), r.error);
  advance(2);
  r = await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 9, seed(9)) });
  check('someone else opens it; the contract just receives', !r.reverted && openedOf(r.logs)[0].holder === holder.toLowerCase(), r.error);

  section('Withdraw guard');
  await call({ from: BUYER, to: packs, data: encode('buy(bytes32)', '0x' + '88'.repeat(32)) }); // pack 10 sealed -> escrow 20
  const contractUsdg = await bal(usdg, packs);
  const esc = await viewBig(packs, 'escrowed()');
  r = await call({ to: packs, data: encode('withdraw(address,address,uint256)', usdg, OWNER, contractUsdg - esc + 1n) });
  check('owner cannot withdraw into escrow', r.reverted && errorIs(r.ret, 'InsufficientFree()'));
  r = await call({ to: packs, data: encode('withdraw(address,address,uint256)', usdg, OWNER, contractUsdg - esc) });
  check('owner can withdraw free revenue', !r.reverted, r.error);
  r = await call({ to: packs, data: encode('withdraw(address,address,uint256)', tokens.NVDA, OWNER, 1n * ETH) });
  check('owner can withdraw inventory', !r.reverted, r.error);
  r = await call({ from: STRANGER, to: packs, data: encode('withdraw(address,address,uint256)', tokens.NVDA, STRANGER, 1n) });
  check('a stranger cannot withdraw', r.reverted && errorIs(r.ret, 'NotOwner()'));
  advance(2);
  await call({ from: STRANGER, to: packs, data: encode('open(uint256,bytes32)', 10, seed(10)) });

  // -------------------------------------------------------------------------
  section('Degraded modes: empty inventory, stale feed, sequencer down');
  const oneTier = [{ name: 'Only', weight: 1, usd: 50, tokens: ['NVDA'] }];
  const D = await buildWorld({ tiers: oneTier, inventory: false, pulls: 5 });
  const seq = await deploy(ART.MockAggregator, ['int256', 'uint8'], [0n, 0]); // sequencer feed: 0 == up
  await call({ to: seq, data: encode('set(int256,uint256)', 0n, ts - 7200n) }); // up for two hours
  await call({ to: D.packs, data: encode('setSequencerFeed(address)', seq) }); // feeds must be set before lock
  await call({ to: D.packs, data: encode('lockOdds()') });
  await call({ from: BUYER, to: D.packs, data: encode('buy(bytes32)', '0x' + '99'.repeat(32)) });
  advance(2);
  let o = await call({ from: STRANGER, to: D.packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  let ps = pullsOf(o.logs);
  check('open succeeds with zero stock inventory', !o.reverted && ps.length === 5, o.error);
  check('every pull fell back to cash', ps.every((p) => p.cash));
  check('cash pull is the same USD in the payment token (6 decimals)', ps.every((p) => p.amount === 50_000_000n));
  // A $50 pull is all-or-nothing: with only 18 USDG free (price minus fee) every pull became an IOU.
  let owed = await viewBig(D.packs, 'owed(address)', BUYER);
  check('what the treasury could not pay became an IOU, pull by pull', owed === 250_000_000n, owed);
  check('totalOwed tracks it', (await viewBig(D.packs, 'totalOwed()')) === owed);
  let before = await bal(D.usdg, BUYER);
  r = await call({ from: BUYER, to: D.packs, data: encode('claimOwed()') });
  check('the 18 USDG that was free is claimable immediately, as a partial payment', !r.reverted && (await bal(D.usdg, BUYER)) === before + 18_000_000n, r.error);
  owed = await viewBig(D.packs, 'owed(address)', BUYER);
  check('remaining IOU is 232 USDG', owed === 232_000_000n, owed);
  r = await call({ from: BUYER, to: D.packs, data: encode('claimOwed()') });
  check('nothing more can be claimed from an empty treasury', r.reverted && errorIs(r.ret, 'InsufficientFree()'));
  await call({ to: D.usdg, data: encode('mint(address,uint256)', D.packs, 1_000_000_000n) });
  r = await call({ to: D.packs, data: encode('withdraw(address,address,uint256)', D.usdg, OWNER, 1_000_000_000n) });
  check('owner cannot withdraw funds that are owed', r.reverted && errorIs(r.ret, 'InsufficientFree()'));
  r = await call({ to: D.packs, data: encode('withdraw(address,address,uint256)', D.usdg, OWNER, 1_000_000_000n - 232_000_000n) });
  check('owner can withdraw everything above what is owed', !r.reverted, r.error);
  before = await bal(D.usdg, BUYER);
  r = await call({ from: BUYER, to: D.packs, data: encode('claimOwed()') });
  check('IOU paid in full once funded', !r.reverted && (await bal(D.usdg, BUYER)) === before + 232_000_000n && (await viewBig(D.packs, 'owed(address)', BUYER)) === 0n, r.error);

  // Stale feed: restock NVDA, then push the feed's updatedAt into the past.
  await call({ to: D.tokens.NVDA, data: encode('mint(address,uint256)', D.packs, 1_000_000n * ETH) });
  await call({ to: D.feeds.NVDA, data: encode('set(int256,uint256)', price8(PRICES.NVDA), ts - 10_000n) });
  const q = await view(D.packs, 'quote(address,uint64)', D.tokens.NVDA, 5000);
  check('stale feed: quote reports not ok', q && toBig(q[1]) === 0n);
  await call({ from: BUYER, to: D.packs, data: encode('buy(bytes32)', '0x' + 'aa'.repeat(32)) });
  advance(2);
  o = await call({ from: STRANGER, to: D.packs, data: encode('open(uint256,bytes32)', 2, seed(2)) });
  check('stale feed: pulls fall back to cash rather than a stale price', !o.reverted && pullsOf(o.logs).every((p) => p.cash), o.error);
  await call({ to: D.feeds.NVDA, data: encode('set(int256,uint256)', price8(PRICES.NVDA), ts) });
  await call({ from: BUYER, to: D.packs, data: encode('buy(bytes32)', '0x' + 'ab'.repeat(32)) });
  advance(2);
  o = await call({ from: STRANGER, to: D.packs, data: encode('open(uint256,bytes32)', 3, seed(3)) });
  check('fresh feed and inventory: pulls pay in stock again', !o.reverted && pullsOf(o.logs).every((p) => !p.cash), o.error);

  // Sequencer down.
  await call({ to: seq, data: encode('set(int256,uint256)', 1n, ts) }); // 1 == down
  check('sequencer down: quote not ok', toBig((await view(D.packs, 'quote(address,uint64)', D.tokens.NVDA, 5000))[1]) === 0n);
  await call({ to: seq, data: encode('set(int256,uint256)', 0n, ts) }); // just came back up
  check('sequencer just restarted: still not ok during grace', toBig((await view(D.packs, 'quote(address,uint64)', D.tokens.NVDA, 5000))[1]) === 0n);
  await call({ to: seq, data: encode('set(int256,uint256)', 0n, ts - 7200n) });
  check('sequencer up past grace: ok', toBig((await view(D.packs, 'quote(address,uint64)', D.tokens.NVDA, 5000))[1]) === 1n);

  // -------------------------------------------------------------------------
  section('Fee is capped and frozen with the odds');
  r = await call({ to: packs, data: encode('setFee(uint16,address)', 3000, FEE_TO) });
  check('fee above the cap is rejected', r.reverted && errorIs(r.ret, 'BadTier()'));
  r = await call({ to: packs, data: encode('setFee(uint16,address)', 500, FEE_TO) });
  check('fee cut cannot change after lockOdds', r.reverted && errorIs(r.ret, 'OddsAreLocked()'));
  r = await call({ to: packs, data: encode('setFee(uint16,address)', 1000, BUYER2) });
  check('fee recipient can still change', !r.reverted, r.error);
  await call({ to: packs, data: encode('setFee(uint16,address)', 1000, FEE_TO) });

  section('Hostile recipients cannot freeze the game');
  const FROZEN = '0x' + 'fe'.repeat(20);
  const H = await buildWorld({ tiers: oneTier, inventory: false, freezingPayment: true });
  await call({ to: H.packs, data: encode('lockOdds()') });
  await call({ to: H.usdg, data: encode('freeze(address,bool)', FROZEN, true) });
  await call({ from: BUYER, to: H.packs, data: encode('buy(bytes32)', '0x' + 'f1'.repeat(32)) });
  await call({ from: BUYER, to: H.packs, data: encode('transferFrom(address,address,uint256)', BUYER, FROZEN, 1) });
  advance(201);
  r = await call({ from: STRANGER, to: H.packs, data: encode('refundExpired(uint256)', 1) });
  check('refund to an address the stablecoin refuses still succeeds', !r.reverted, r.error);
  check('the frozen holder is credited an IOU instead', (await viewBig(H.packs, 'owed(address)', FROZEN)) === PRICE);
  check('escrow released', (await viewBig(H.packs, 'escrowed()')) === 0n);
  r = await call({ from: STRANGER, to: H.packs, data: encode('openLate(uint256,bytes32)', 1, seed(1)) });
  check('chain moves on', !r.reverted && (await viewBig(H.packs, 'revealed()')) === 1n, r.error);
  check('the late prizes of the frozen holder became IOUs too', (await viewBig(H.packs, 'owed(address)', FROZEN)) === PRICE + 250_000_000n);
  await call({ from: BUYER, to: H.packs, data: encode('buy(bytes32)', '0x' + 'f2'.repeat(32)) });
  await call({ from: BUYER, to: H.packs, data: encode('transferFrom(address,address,uint256)', BUYER, FROZEN, 2) });
  advance(2);
  r = await call({ from: STRANGER, to: H.packs, data: encode('open(uint256,bytes32)', 2, seed(2)) });
  check('a pack held by a frozen address still opens', !r.reverted && pullsOf(r.logs).length === 5, r.error);
  check('every pull became an IOU for the frozen holder', (await viewBig(H.packs, 'owed(address)', FROZEN)) === PRICE + 500_000_000n);
  check('the game continues past it', (await viewBig(H.packs, 'revealed()')) === 2n);

  section('A paused or hostile stock token degrades to cash');
  const R = await buildWorld({ tiers: [{ name: 'Only', weight: 1, usd: 2, tokens: ['NVDA'] }], reverting: ['NVDA'] });
  await call({ to: R.packs, data: encode('lockOdds()') });
  await call({ from: BUYER, to: R.packs, data: encode('buy(bytes32)', '0x' + 'f3'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: R.packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('open succeeds when the stock token reverts on transfer', !r.reverted, r.error);
  check('pulls paid in cash', pullsOf(r.logs).every((p) => p.cash && p.amount === 2_000_000n));

  section('Sales gate, pause and chain extension');
  const chain2 = odds.deriveChain('0x' + '7a'.repeat(32), 3);
  const G = await buildWorld({ tiers: oneTier, chainLen: 2 });
  r = await call({ to: G.packs, data: encode('setFeed(address,address,uint32)', G.tokens.NVDA, STRANGER, 3600) });
  check('a feed address without code is rejected', r.reverted && errorIs(r.ret, 'BadFeed()'));
  await call({ to: G.packs, data: encode('lockOdds()') });
  await call({ to: G.packs, data: encode('setPaused(bool)', true) });
  r = await call({ from: BUYER, to: G.packs, data: encode('buy(bytes32)', '0x' + 'd1'.repeat(32)) });
  check('paused: nothing sells', r.reverted && errorIs(r.ret, 'Paused()'));
  await call({ to: G.packs, data: encode('setPaused(bool)', false) });
  await call({ from: BUYER, to: G.packs, data: encode('buy(bytes32)', '0x' + 'd1'.repeat(32)) });
  await call({ from: BUYER, to: G.packs, data: encode('buy(bytes32)', '0x' + 'd2'.repeat(32)) });
  r = await call({ from: BUYER, to: G.packs, data: encode('buy(bytes32)', '0x' + 'd3'.repeat(32)) });
  check('a chain of 2 seeds sells exactly 2 packs', r.reverted && errorIs(r.ret, 'ChainExhausted()'));
  r = await call({ to: G.packs, data: encode('extendChain(bytes32,uint256)', chain2.root, 3) });
  check('the chain cannot be replaced while packs are pending', r.reverted && errorIs(r.ret, 'PacksPending()'));
  advance(2);
  await call({ from: STRANGER, to: G.packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  await call({ from: STRANGER, to: G.packs, data: encode('open(uint256,bytes32)', 2, seed(2)) });
  r = await call({ to: G.packs, data: encode('extendChain(bytes32,uint256)', chain2.root, 3) });
  check('owner commits a new chain once everything is settled', !r.reverted && (await viewBig(G.packs, 'chainEnd()')) === 5n, r.error);
  await call({ from: BUYER, to: G.packs, data: encode('buy(bytes32)', '0x' + 'd3'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: G.packs, data: encode('open(uint256,bytes32)', 3, seed(3)) });
  check('seeds of the old chain no longer open anything', r.reverted && errorIs(r.ret, 'BadSeed()'));
  r = await call({ from: STRANGER, to: G.packs, data: encode('open(uint256,bytes32)', 3, chain2.seeds[1]) });
  check('pack 3 opens with seed 1 of the new chain', !r.reverted, r.error);

  section('Checkpoints keep the hash alive past the 256-block horizon');
  const C = await buildWorld({ tiers: oneTier });
  await call({ to: C.packs, data: encode('lockOdds()') });
  await call({ from: BUYER, to: C.packs, data: encode('buy(bytes32)', '0x' + 'c1'.repeat(32)) });
  const pbC1 = blockNo;
  advance(2);
  check('hash is not recorded at purchase', toBig((await view(C.packs, 'packs(uint256)', 1))[5]) === 0n);
  await call({ from: BUYER2, to: C.packs, data: encode('buy(bytes32)', '0x' + 'c2'.repeat(32) ) });
  check('the next purchase records the pending pack\'s hash', (await hashOf(C.packs, 1)) === '0x' + fakeHash(pbC1 + 1n).toString('hex'));
  advance(300);
  await call({ from: STRANGER, to: C.packs, data: encode('refundExpired(uint256)', 1) });
  r = await call({ from: STRANGER, to: C.packs, data: encode('openLate(uint256,bytes32)', 1, seed(1)) });
  check('settled 300 blocks later with the real hash', !r.reverted && openedOf(r.logs)[0].randomness === expectRand(1, '0x' + 'c1'.repeat(32), pbC1), r.error);
  r = await call({ from: STRANGER, to: C.packs, data: encode('checkpoint(uint256)', 2) });
  check('a checkpoint after 256 blocks records nothing', !r.reverted && toBig((await view(C.packs, 'packs(uint256)', 2))[5]) === 0n);
  await call({ from: STRANGER, to: C.packs, data: encode('refundExpired(uint256)', 2) });
  r = await call({ from: STRANGER, to: C.packs, data: encode('openLate(uint256,bytes32)', 2, seed(2)) });
  check('a pack nobody touched still settles, with a zero hash, instead of blocking the chain', !r.reverted && (await viewBig(C.packs, 'revealed()')) === 2n, r.error);

  section('Broken feeds and cleared feeds degrade to cash');
  const F = await buildWorld({ tiers: [{ name: 'Only', weight: 1, usd: 2, tokens: ['NVDA'] }] });
  const seq2 = await deploy(ART.MockAggregator, ['int256', 'uint8'], [0n, 0]);
  await call({ to: seq2, data: encode('set(int256,uint256)', 0n, ts - 7200n) });
  r = await call({ to: F.packs, data: encode('setSequencerFeed(address)', seq2) });
  check('a live sequencer feed is accepted before lock', !r.reverted, r.error);
  await call({ to: F.packs, data: encode('lockOdds()') });
  check('quote ok with everything healthy', toBig((await view(F.packs, 'quote(address,uint64)', F.tokens.NVDA, 200))[1]) === 1n);
  await call({ to: F.feeds.NVDA, data: encode('setBroken(bool)', true) });
  check('quote reports not ok on a feed that reverts', toBig((await view(F.packs, 'quote(address,uint64)', F.tokens.NVDA, 200))[1]) === 0n);
  await call({ from: BUYER, to: F.packs, data: encode('buy(bytes32)', '0x' + 'e7'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: F.packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('open succeeds and pays cash', !r.reverted && pullsOf(r.logs).every((p) => p.cash && p.amount === 2_000_000n), r.error);
  await call({ to: F.feeds.NVDA, data: encode('setBroken(bool)', false) });
  await call({ to: seq2, data: encode('setBroken(bool)', true) });
  check('a reverting sequencer feed counts as down', toBig((await view(F.packs, 'quote(address,uint64)', F.tokens.NVDA, 200))[1]) === 0n);
  r = await call({ to: F.packs, data: encode('setSequencerFeed(address)', '0x' + '00'.repeat(20)) });
  check('owner may clear the sequencer feed after lock', !r.reverted, r.error);
  check('quote ok again', toBig((await view(F.packs, 'quote(address,uint64)', F.tokens.NVDA, 200))[1]) === 1n);
  r = await call({ to: F.packs, data: encode('setFeed(address,address,uint32)', F.tokens.NVDA, '0x' + '00'.repeat(20), 0) });
  check('owner may clear a price feed after lock', !r.reverted, r.error);
  await call({ from: BUYER, to: F.packs, data: encode('buy(bytes32)', '0x' + 'e8'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: F.packs, data: encode('open(uint256,bytes32)', 2, seed(2)) });
  check('a cleared feed pays the full USD value in cash', !r.reverted && pullsOf(r.logs).every((p) => p.cash && p.amount === 2_000_000n), r.error);

  section('Return-bombing and odd-status tokens cannot stall an open');
  const B = await buildWorld({ tiers: [{ name: 'Only', weight: 1, usd: 2, tokens: ['NVDA'] }], bomb: ['NVDA'] });
  await call({ to: B.packs, data: encode('lockOdds()') });
  await call({ from: BUYER, to: B.packs, data: encode('buy(bytes32)', '0x' + 'e5'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: B.packs, data: encode('open(uint256,bytes32)', 1, seed(1)) });
  check('open succeeds against a token that answers with 8 KB', !r.reverted, r.error);
  check('its true first word counts as delivered, so the pulls are stock', pullsOf(r.logs).every((p) => !p.cash));
  await call({ to: B.tokens.NVDA, data: encode('setMode(uint8)', 1) });
  await call({ from: BUYER, to: B.packs, data: encode('buy(bytes32)', '0x' + 'e6'.repeat(32)) });
  advance(2);
  r = await call({ from: STRANGER, to: B.packs, data: encode('open(uint256,bytes32)', 2, seed(2)) });
  check('a token answering 2 instead of true counts as not delivered: cash', !r.reverted && pullsOf(r.logs).every((p) => p.cash), r.error);

  // -------------------------------------------------------------------------
  section('Statistics: realised payout tracks the published odds');
  const S = await buildWorld();
  await call({ to: S.packs, data: encode('lockOdds()') });
  const symOfS = Object.fromEntries(Object.entries(S.tokens).map(([s, a]) => [a.toLowerCase(), s]));
  const NPACKS = 250;
  const tierCount = new Array(odds.TIERS.length).fill(0);
  let payoutCents = 0n;
  let cashPulls = 0;
  const seenTokens = new Set();
  let gasMax = 0n;
  for (let k = 1; k <= NPACKS; k++) {
    const bs = '0x' + keccak256(Buffer.from('buyer' + k)).toString('hex');
    const b = await call({ from: BUYER, to: S.packs, data: encode('buy(bytes32)', bs) });
    if (b.reverted) { check(`buy ${k}`, false, b.error); break; }
    advance(2);
    const oo = await call({ from: STRANGER, to: S.packs, data: encode('open(uint256,bytes32)', k, seed(k)) });
    if (oo.reverted) { check(`open ${k}`, false, oo.error || oo.ret.toString('hex')); break; }
    if (oo.gas > gasMax) gasMax = oo.gas;
    for (const p of pullsOf(oo.logs)) {
      tierCount[p.tier]++;
      payoutCents += p.usdCents;
      if (p.cash) cashPulls++;
      seenTokens.add(symOfS[p.token.toLowerCase()]);
    }
  }
  const totalPulls = tierCount.reduce((a, b) => a + b, 0);
  const evCents = 1718n * BigInt(NPACKS);
  const ratio = Number(payoutCents) / Number(evCents);
  check(`${NPACKS} packs opened in order`, (await viewBig(S.packs, 'revealed()')) === BigInt(NPACKS) && totalPulls === NPACKS * PULLS);
  check('no pull needed the cash fallback', cashPulls === 0, cashPulls);
  const commonShare = tierCount[0] / totalPulls;
  check(`Common share near 72% (got ${(commonShare * 100).toFixed(1)}%)`, commonShare > 0.66 && commonShare < 0.78);
  check(`realised payout within 55% to 150% of expected (got ${(ratio * 100).toFixed(0)}%)`, ratio > 0.55 && ratio < 1.5);
  check(`prizes spread across the table (${seenTokens.size} distinct stocks)`, seenTokens.size >= 20);
  console.log(`       tiers hit: ${odds.TIERS.map((t, i) => `${t.name} ${tierCount[i]}`).join(', ')}`);
  console.log(`       paid $${(Number(payoutCents) / 100).toFixed(2)} on $${NPACKS * 20} of packs; max open gas ${gasMax}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
