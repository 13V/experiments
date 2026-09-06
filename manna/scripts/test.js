#!/usr/bin/env node
'use strict';

/**
 * Manna integration tests: the oracle, the adapters and the Manna contract compiled together with Locate's
 * vault/router and the vendored Morpho Blue, and run inside an in-process EVM (ethereumjs, Cancun), so
 * every number below is Morpho's own accounting plus LocateVault's, not a stand-in.
 *
 *   NODE_PATH=/home/user/experiments/node_modules node manna/scripts/test.js
 *
 * Sections:
 *   0. Compile manna/contracts/** + manna/test/Mocks.sol + locate/contracts/** + locate/test/** in one run.
 *   1. TickMath against an independent floating-point computation; the Prophet: both pool orientations,
 *      the window fallback, the floor, spot vs mean.
 *   2. World: Morpho, tokens, mock pools, oracles, markets, Storehouses (LocateVaults with Manna as fee
 *      recipient), the v3 seller, the curve buyer, the escrow.
 *   3. Lenders enter through Manna; shorts open through LocateRouter; interest accrues; the tithe appears.
 *   4. dawn(): claim, sell, split, buy, fall; the caller's tip; weights by borrowed value; the cap and carry.
 *   5. The calendar: once a day, from noon, never on Sunday, Monday carries.
 *   6. Gathering and spoilage; autoStake; the staking pool.
 *   7. The v4 adapter against a mock PoolManager; a failing buyer carries the budget.
 *   8. Bad debt, Joseph's Reserve and restore(); Jubilee; the Sunday rule on dials; invariants throughout.
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
const { keccak256 } = require('../../scripts/keccak');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? '  — ' + detail : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// ABI helpers (hand-rolled; static types, dynamic arrays of words, bytes/string, one static tuple level)
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

function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const tail = inner.slice(start);
  if (tail !== '' || parts.length > 0) parts.push(tail);
  return parts.filter((p) => p.length > 0);
}

function encodeArgs(types, values) {
  const heads = [];
  let tail = Buffer.alloc(0);
  const headLen = 32 * types.reduce((n, t) => n + (t.startsWith('(') ? splitTopLevel(t.slice(1, -1)).length : 1), 0);
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
    } else if (t.startsWith('(') && t.endsWith(')')) {
      const subTypes = splitTopLevel(t.slice(1, -1));
      for (let j = 0; j < subTypes.length; j++) heads.push(word(v[j]));
    } else {
      heads.push(word(v));
    }
  }
  return Buffer.concat([...heads, tail]);
}

function encode(sig, ...values) {
  const types = splitTopLevel(sig.slice(sig.indexOf('(') + 1, -1));
  return Buffer.concat([selector(sig), encodeArgs(types, values)]);
}

const words = (buf) => {
  const out = [];
  for (let i = 0; i + 32 <= buf.length; i += 32) out.push(Buffer.from(buf.subarray(i, i + 32)));
  return out;
};
const toBig = (w) => BigInt('0x' + Buffer.from(w).toString('hex'));
const toInt = (w) => {
  const u = toBig(w);
  return u >= 1n << 255n ? u - (1n << 256n) : u;
};
const toAddr = (w) => '0x' + Buffer.from(w).subarray(12).toString('hex');
const errorIs = (ret, sig) => ret.length >= 4 && Buffer.from(ret.subarray(0, 4)).equals(selector(sig));
const topicOf = (sig) => bytesToHex(keccak256(Buffer.from(sig, 'utf8')));

const MP_T = '(address,address,address,address,uint256)';
const mpTuple = (mp) => [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv];
const marketId = (mp) =>
  '0x' +
  keccak256(Buffer.concat([word(mp.loanToken), word(mp.collateralToken), word(mp.oracle), word(mp.irm), word(mp.lltv)])).toString('hex');

const WAD = 10n ** 18n;
const mulDivDown = (x, y, d) => (x * y) / d;
const abs = (x) => (x < 0n ? -x : x);
const BPS = 10000n;

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

const REPO = path.join(__dirname, '..', '..');
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.sol')) out.push(p);
  }
  return out;
}
const files = [
  ...walk(path.join(REPO, 'manna/contracts')),
  ...walk(path.join(REPO, 'manna/test')),
  ...walk(path.join(REPO, 'locate/contracts')),
  ...walk(path.join(REPO, 'locate/test')),
];
const sources = {};
for (const f of files) sources[path.relative(REPO, f).split(path.sep).join('/')] = { content: fs.readFileSync(f, 'utf8') };

const solcOut = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources,
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: 'cancun',
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    }),
    { import: (p) => ({ error: 'not found ' + p }) }
  )
);
const diags = solcOut.errors || [];
const solcErrors = diags.filter((d) => d.severity === 'error');
if (solcErrors.length) {
  for (const e of solcErrors) console.error(e.formattedMessage);
  process.exit(1);
}
const ourWarnings = diags.filter((d) => d.severity === 'warning' && d.sourceLocation && d.sourceLocation.file.startsWith('manna/contracts/'));

const A = (file, name) => solcOut.contracts[file][name];
const ART = {
  Manna: A('manna/contracts/Manna.sol', 'Manna'),
  Oracle: A('manna/contracts/MemeTwapOracle.sol', 'MemeTwapOracle'),
  V3Swapper: A('manna/contracts/adapters/UniswapV3Swapper.sol', 'UniswapV3Swapper'),
  V4Swapper: A('manna/contracts/adapters/UniswapV4Swapper.sol', 'UniswapV4Swapper'),
  CurveSwapper: A('manna/contracts/adapters/PonsCurveSwapper.sol', 'PonsCurveSwapper'),
  MockV3Pool: A('manna/test/Mocks.sol', 'MockV3Pool'),
  MockPoolManager: A('manna/test/Mocks.sol', 'MockPoolManager'),
  MockEscrow: A('manna/test/Mocks.sol', 'MockEscrow'),
  MockCurve: A('manna/test/Mocks.sol', 'MockCurve'),
  MockFailingBuyer: A('manna/test/Mocks.sol', 'MockFailingBuyer'),
  LocateVault: A('locate/contracts/LocateVault.sol', 'LocateVault'),
  LocateRouter: A('locate/contracts/LocateRouter.sol', 'LocateRouter'),
  Morpho: A('locate/test/morpho/Morpho.sol', 'Morpho'),
  MockERC20: A('locate/test/Mocks.sol', 'MockERC20'),
  MockIrm: A('locate/test/Mocks.sol', 'MockIrm'),
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OWNER = '0x' + 'a0'.repeat(20);
const TREASURY = '0x' + 'a1'.repeat(20);
const CHARITY = '0x' + 'a2'.repeat(20);
const HOOK = '0x' + 'a3'.repeat(20); // stands in for the Pons hook crediting the escrow
const L1 = '0x' + 'b1'.repeat(20);
const L2 = '0x' + 'b2'.repeat(20);
const L3 = '0x' + 'b3'.repeat(20);
const B1 = '0x' + 'c1'.repeat(20);
const B2 = '0x' + 'c2'.repeat(20);
const CALLER = '0x' + 'd0'.repeat(20);
const STRANGER = '0x' + 'd1'.repeat(20);
const STAKER = '0x' + 'd2'.repeat(20);
const LIQUIDATOR = '0x' + 'd3'.repeat(20);
const ACCOUNTS = [OWNER, TREASURY, CHARITY, HOOK, L1, L2, L3, B1, B2, CALLER, STRANGER, STAKER, LIQUIDATOR];

const ETH = 10n ** 18n;
const USDG_UNIT = 10n ** 6n;
const TOKEN_UNIT = 10n ** 18n;
const DAY = 86400n;
const NOON = 43200n;
const addr = (h) => new Address(hexToBytes(h));
const MAX = (1n << 256n) - 1n;

const dayOf = (ts) => ts / DAY;
const isSunday = (day) => (day + 4n) % 7n === 0n;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dow = (day) => DOW[Number((day + 4n) % 7n)];

// Independent float computation of sqrt(1.0001^tick) * 2^96, for the TickMath check.
const sqrtPriceFloat = (tick) => Math.sqrt(Math.pow(1.0001, tick)) * Math.pow(2, 96);
const tickFor = (ratio) => Math.round(Math.log(ratio) / Math.log(1.0001));
const isqrt = (n) => {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
};

async function main() {
  const common = new Common({ chain: 1, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const fakeHash = (n) => keccak256(Buffer.concat([Buffer.from('blockhash', 'utf8'), word(BigInt(n))]));
  const bc = vm.evm.blockchain || vm.blockchain;
  bc.getBlock = async (n) => ({ hash: () => new Uint8Array(fakeHash(typeof n === 'bigint' ? n : BigInt(n))) });

  let blockNo = 1000n;
  // Start on a Monday at 12:00 UTC.
  let ts = 1_800_000_000n;
  {
    let d = dayOf(ts);
    while ((d + 4n) % 7n !== 1n) d += 1n;
    ts = d * DAY + NOON;
  }
  const advance = (seconds) => {
    ts += BigInt(seconds);
    blockNo += 1n;
  };
  const setTime = (t) => {
    if (t < ts) throw new Error('time goes forward only');
    ts = t;
    blockNo += 1n;
  };
  const curBlock = () => Block.fromBlockData({ header: { number: blockNo, timestamp: ts, gasLimit: 30_000_000n } }, { common });

  for (const a of ACCOUNTS) await vm.stateManager.putAccount(addr(a), new Account(0n, 1000n * ETH));

  const call = async ({ from = OWNER, to, data, value = 0n }) => {
    const res = await vm.evm.runCall({
      caller: addr(from),
      origin: addr(from),
      to: to ? addr(to) : undefined,
      data,
      value,
      gasLimit: 20_000_000n,
      block: curBlock(),
    });
    return {
      reverted: !!res.execResult.exceptionError,
      error: res.execResult.exceptionError?.error,
      ret: Buffer.from(res.execResult.returnValue),
      logs: (res.execResult.logs || []).map(([a, topics, d]) => ({
        address: bytesToHex(a),
        topics: topics.map((t) => bytesToHex(t)),
        data: Buffer.from(d),
      })),
      created: res.createdAddress ? bytesToHex(res.createdAddress.bytes) : null,
      gas: res.execResult.executionGasUsed,
    };
  };
  const deploy = async (art, types = [], args = [], from = OWNER) => {
    const r = await call({ from, data: Buffer.concat([Buffer.from(art.evm.bytecode.object, 'hex'), encodeArgs(types, args)]) });
    if (r.reverted) throw new Error('deploy failed: ' + (r.error || r.ret.toString('hex')));
    return r.created;
  };
  const tryDeploy = async (art, types, args) => {
    const r = await call({ data: Buffer.concat([Buffer.from(art.evm.bytecode.object, 'hex'), encodeArgs(types, args)]) });
    return r;
  };
  const view = async (to, sig, ...args) => {
    const r = await call({ from: STRANGER, to, data: encode(sig, ...args) });
    if (r.reverted) return null;
    return words(r.ret);
  };
  const viewBig = async (to, sig, ...args) => {
    const w = await view(to, sig, ...args);
    return w ? toBig(w[0]) : null;
  };
  const viewRaw = async (to, sig, ...args) => call({ from: STRANGER, to, data: encode(sig, ...args) });
  const bal = (token, who) => viewBig(token, 'balanceOf(address)', who);
  const send = async (from, to, sig, ...args) => call({ from, to, data: encode(sig, ...args) });
  const mint = (token, to, amount) => send(OWNER, token, 'mint(address,uint256)', to, amount);
  const approve = (from, token, spender, amount = MAX) => send(from, token, 'approve(address,uint256)', spender, amount);
  const logsOf = (r, sig) => r.logs.filter((l) => l.topics[0] === topicOf(sig));
  const revertName = (r) => {
    const names = [
      'Sabbath()', 'NotYetDawn()', 'AlreadyFell()', 'TokenNotSet()', 'TokenAlreadySet()', 'UnknownStorehouse()',
      'StorehouseExists()', 'StorehouseInactive()', 'NotFeeRecipient()', 'BadDial()', 'InsufficientShares()',
      'InsufficientStake()', 'NothingToRestore()', 'NotJubileeYet()', 'NoCharity()', 'NotOwner()', 'ZeroAmount()',
      'ZeroAddress()', 'TransferFailed()', 'Reentrancy()', 'OracleUnavailable()', 'InvalidWindow()', 'TokenNotInPool()',
      'Slippage()', 'NoRoute()', 'BadCallback()', 'InsufficientLiquidity()', 'NoSeller()',
    ];
    for (const n of names) if (errorIs(r.ret, n)) return n;
    return r.error || r.ret.toString('hex').slice(0, 10);
  };

  section('0. Compilation');
  check('manna + locate + mocks + vendored Morpho compile with no errors', true);
  check('no solc warnings for manna/contracts/* (hard gate)', ourWarnings.length === 0, ourWarnings.map((w) => w.formattedMessage.split('\n')[0]).join(' | '));
  check(`clock starts on a Monday at noon UTC (day ${dayOf(ts)} is ${dow(dayOf(ts))})`, dow(dayOf(ts)) === 'Monday' && ts % DAY === NOON);

  // =========================================================================
  section('1. TickMath and the Prophet');
  // =========================================================================

  const usdg = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Global Dollar', 'USDG', 6]);
  const weth = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Wrapped Ether', 'WETH', 18]);
  const pons = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Pons', 'PONS', 18]);
  const cat = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Cash Cat', 'CASHCAT', 18]);
  const manna = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Manna', 'MANNA', 18]);

  // Pool A1: WETH/PONS, PONS is token1. 1 WETH = 2,000,000 PONS.
  // Pool A2: CASHCAT/WETH, CASHCAT is token0. 1 WETH = 500,000 CASHCAT.
  // Pool B:  WETH/USDG, WETH is token0. 1 WETH = 4,000 USDG (raw ratio 4e-9).
  const PONS_PER_WETH = 2_000_000;
  const CAT_PER_WETH = 500_000;
  const USDG_PER_WETH = 4_000;
  const tickA1 = tickFor(PONS_PER_WETH); // token1/token0 = PONS per WETH
  const tickA2 = tickFor(1 / CAT_PER_WETH); // token1/token0 = WETH per CAT
  const tickB = tickFor(USDG_PER_WETH * 1e6 / 1e18); // token1/token0 raw = USDG raw per WETH raw

  const poolA1 = await deploy(ART.MockV3Pool, ['address', 'address', 'uint24'], [weth, pons, 10000]);
  const poolA2 = await deploy(ART.MockV3Pool, ['address', 'address', 'uint24'], [cat, weth, 10000]);
  const poolB = await deploy(ART.MockV3Pool, ['address', 'address', 'uint24'], [weth, usdg, 100]);
  await send(OWNER, poolA1, 'setMeanTick(int24)', tickA1);
  await send(OWNER, poolA1, 'setSpotTick(int24)', tickA1);
  await send(OWNER, poolA1, 'setRate(uint256,uint256)', BigInt(PONS_PER_WETH), 1n);
  await send(OWNER, poolA2, 'setMeanTick(int24)', tickA2);
  await send(OWNER, poolA2, 'setSpotTick(int24)', tickA2);
  await send(OWNER, poolA2, 'setRate(uint256,uint256)', 1n, BigInt(CAT_PER_WETH));
  await send(OWNER, poolB, 'setMeanTick(int24)', tickB);
  await send(OWNER, poolB, 'setSpotTick(int24)', tickB);
  await send(OWNER, poolB, 'setRate(uint256,uint256)', BigInt(USDG_PER_WETH), 10n ** 12n); // 4000e6 / 1e18

  const WINDOW = 1800n;
  const FALLBACK = 600n;
  const oraclePons = await deploy(ART.Oracle, ['address', 'address', 'address', 'address', 'address', 'uint32', 'uint32'], [poolA1, poolB, pons, weth, usdg, WINDOW, FALLBACK]);
  const oracleCat = await deploy(ART.Oracle, ['address', 'address', 'address', 'address', 'address', 'uint32', 'uint32'], [poolA2, poolB, cat, weth, usdg, WINDOW, FALLBACK]);
  check('PONS oracle deployed; memeIsToken1 == true', (await viewBig(oraclePons, 'memeIsToken1()')) === 1n);
  check('CASHCAT oracle deployed; memeIsToken1 == false', (await viewBig(oracleCat, 'memeIsToken1()')) === 0n);
  check('quote pool orientation: wethIsToken1 == false', (await viewBig(oraclePons, 'wethIsToken1()')) === 0n);

  // TickMath check: priceFromTicks(a, 0) with wethIsToken1 false and memeIsToken1 true => t = a.
  for (const t of [0, 1, -1, 1000, -1000, 145094, -193378, 400000, -400000, 887271, -600000]) {
    const got = await viewBig(oraclePons, 'priceFromTicks(int24,int24)', t, 0);
    const want = Math.pow(1.0001, t) * 1e36;
    const rel = Math.abs(Number(got) - want) / want;
    check(`TickMath: 1.0001^${t} * 1e36 within 1e-9 (rel ${rel.toExponential(2)})`, rel < 1e-9);
  }
  {
    const r = await viewRaw(oraclePons, 'priceFromTicks(int24,int24)', 887272, 887272);
    check('combined tick beyond MAX_TICK is clamped, not reverted', !r.reverted && toBig(words(r.ret)[0]) > 0n);
  }

  // Expected prices: PONS raw per USDG raw = 2e6 / 4e-9 => 5e14; * 1e36 = 5e50. CASHCAT: 125 per USDG => 1.25e50.
  const PONS_PRICE = 500n * 10n ** 12n * 10n ** 36n;
  const CAT_PRICE = 125n * 10n ** 12n * 10n ** 36n;
  const pPons = await viewBig(oraclePons, 'price()');
  const pCat = await viewBig(oracleCat, 'price()');
  const relErr = (a, b) => Number(abs(a - b)) / Number(b);
  check(`PONS Prophet price ≈ 5e50 (got ${pPons.toExponential ? pPons : pPons.toString().slice(0, 6)}e…, rel ${relErr(pPons, PONS_PRICE).toExponential(2)})`, relErr(pPons, PONS_PRICE) < 3e-4);
  check(`CASHCAT Prophet price ≈ 1.25e50 (rel ${relErr(pCat, CAT_PRICE).toExponential(2)})`, relErr(pCat, CAT_PRICE) < 3e-4);
  {
    const mt = await view(oraclePons, 'meanTicks()');
    check('meanTicks() reports the full window when both buffers reach', toBig(mt[2]) === WINDOW && toInt(mt[0]) === BigInt(tickA1) && toInt(mt[1]) === BigInt(tickB));
    await send(OWNER, poolA1, 'setOldest(uint32)', 900n);
    const mt2 = await view(oraclePons, 'meanTicks()');
    check('a buffer shorter than the window falls back to fallbackWindow', toBig(mt2[2]) === FALLBACK);
    await send(OWNER, poolA1, 'setOldest(uint32)', 100n);
    const r = await viewRaw(oraclePons, 'price()');
    check('a buffer shorter than the fallback reverts OracleUnavailable()', r.reverted && errorIs(r.ret, 'OracleUnavailable()'));
    await send(OWNER, poolA1, 'setOldest(uint32)', MAX >> 224n);
    check('price() recovers once the buffer is back', (await viewBig(oraclePons, 'price()')) === pPons);
    await send(OWNER, poolA1, 'setSpotTick(int24)', tickA1 + 1000);
    const spot = await viewBig(oraclePons, 'spot()');
    check('spot() follows slot0 while price() follows the mean (spot +10.5%)', spot > pPons && relErr(spot, (pPons * 11052n) / 10000n) < 2e-3);
    await send(OWNER, poolA1, 'setSpotTick(int24)', tickA1);
  }
  {
    const r = await tryDeploy(ART.Oracle, ['address', 'address', 'address', 'address', 'address', 'uint32', 'uint32'], [poolA1, poolB, pons, weth, usdg, 1800n, 200n]);
    check('constructor rejects a fallback window below MIN_WINDOW (InvalidWindow)', r.reverted && errorIs(r.ret, 'InvalidWindow()'));
    const r2 = await tryDeploy(ART.Oracle, ['address', 'address', 'address', 'address', 'address', 'uint32', 'uint32'], [poolA1, poolB, cat, weth, usdg, 1800n, 600n]);
    check('constructor rejects a meme that is not in the pool (TokenNotInPool)', r2.reverted && errorIs(r2.ret, 'TokenNotInPool()'));
    const r3 = await tryDeploy(ART.Oracle, ['address', 'address', 'address', 'address', 'address', 'uint32', 'uint32'], [poolA1, poolB, pons, weth, usdg, 500n, 600n]);
    check('constructor rejects window < fallbackWindow', r3.reverted && errorIs(r3.ret, 'InvalidWindow()'));
  }

  // =========================================================================
  section('2. World: Morpho, markets, Storehouses, adapters, escrow');
  // =========================================================================

  const morpho = await deploy(ART.Morpho, ['address'], [OWNER]);
  const RATE = 63_419_584_000n; // ≈ 200% a year, WAD per second
  const irm = await deploy(ART.MockIrm, ['uint256'], [RATE]);
  const LLTV = (385n * WAD) / 1000n;
  await send(OWNER, morpho, 'enableIrm(address)', irm);
  await send(OWNER, morpho, 'enableLltv(uint256)', LLTV);
  const mpPons = { loanToken: pons, collateralToken: usdg, oracle: oraclePons, irm, lltv: LLTV };
  const mpCat = { loanToken: cat, collateralToken: usdg, oracle: oracleCat, irm, lltv: LLTV };
  const idPons = marketId(mpPons);
  const idCat = marketId(mpCat);
  let r = await send(OWNER, morpho, `createMarket(${MP_T})`, mpTuple(mpPons));
  check('PONS/USDG market created on Morpho (loan = PONS, collateral = USDG, LLTV 38.5%)', !r.reverted, r.error);
  r = await send(OWNER, morpho, `createMarket(${MP_T})`, mpTuple(mpCat));
  check('CASHCAT/USDG market created', !r.reverted, r.error);

  const mannaC = await deploy(ART.Manna, ['address', 'address', 'address'], [usdg, OWNER, TREASURY]);
  check('Manna deployed with default dial 20/10/5, target 10%, stakers 70%, tip 0.5%', (await view(mannaC, 'dial()')).length === 8 && toBig((await view(mannaC, 'dial()'))[0]) === 2000n);
  const vaultPons = await deploy(ART.LocateVault, ['address', 'address', 'string', 'string', 'address', 'address', 'uint96'], [morpho, pons, 'Storehouse PONS', 'shPONS', OWNER, mannaC, 1000n]);
  const vaultCat = await deploy(ART.LocateVault, ['address', 'address', 'string', 'string', 'address', 'address', 'uint96'], [morpho, cat, 'Storehouse CASHCAT', 'shCAT', OWNER, mannaC, 1000n]);
  const vaultBad = await deploy(ART.LocateVault, ['address', 'address', 'string', 'string', 'address', 'address', 'uint96'], [morpho, pons, 'Wrong recipient', 'bad', OWNER, OWNER, 1000n]);
  const router = await deploy(ART.LocateRouter, ['address'], [morpho]);
  const CAP = 5_000_000n * TOKEN_UNIT;
  r = await send(OWNER, vaultPons, `setMarket(${MP_T},uint256)`, mpTuple(mpPons), CAP);
  check('PONS Storehouse supplies its market up to a 5M PONS cap', !r.reverted, r.error);
  r = await send(OWNER, vaultCat, `setMarket(${MP_T},uint256)`, mpTuple(mpCat), CAP);
  check('CASHCAT Storehouse supplies its market', !r.reverted, r.error);

  r = await send(OWNER, mannaC, 'addStorehouse(address,address)', vaultBad, oraclePons);
  check('addStorehouse rejects a vault whose feeRecipient is not Manna (NotFeeRecipient)', r.reverted && errorIs(r.ret, 'NotFeeRecipient()'));
  r = await send(STRANGER, mannaC, 'addStorehouse(address,address)', vaultPons, oraclePons);
  check('addStorehouse from a stranger reverts NotOwner()', r.reverted && errorIs(r.ret, 'NotOwner()'));
  r = await send(OWNER, mannaC, 'addStorehouse(address,address)', vaultPons, oraclePons);
  check('PONS Storehouse registered', !r.reverted, revertName(r));
  r = await send(OWNER, mannaC, 'addStorehouse(address,address)', vaultCat, oracleCat);
  check('CASHCAT Storehouse registered', !r.reverted, revertName(r));
  r = await send(OWNER, mannaC, 'addStorehouse(address,address)', vaultPons, oraclePons);
  check('registering twice reverts StorehouseExists()', r.reverted && errorIs(r.ret, 'StorehouseExists()'));
  check('storehouseCount() == 2', (await viewBig(mannaC, 'storehouseCount()')) === 2n);

  // The v3 seller with routes for both Giants; the pools hold inventory on both sides.
  const v3 = await deploy(ART.V3Swapper, ['address', 'address', 'address', 'address'], [weth, usdg, poolB, OWNER]);
  await send(OWNER, v3, 'setRoute(address,address)', pons, poolA1);
  await send(OWNER, v3, 'setRoute(address,address)', cat, poolA2);
  r = await send(OWNER, v3, 'setRoute(address,address)', cat, poolA1);
  check('setRoute rejects a pool that does not contain the token (TokenNotInPool)', r.reverted && errorIs(r.ret, 'TokenNotInPool()'));
  for (const [t, p, amt] of [[weth, poolA1, 1_000n], [pons, poolA1, 2_000_000_000n], [cat, poolA2, 500_000_000n], [weth, poolA2, 1_000n], [weth, poolB, 10_000n]]) await mint(t, p, amt * TOKEN_UNIT);
  await mint(usdg, poolB, 40_000_000n * USDG_UNIT);

  // The Pons curve, the curve buyer, the escrow.
  const curve = await deploy(ART.MockCurve, ['address', 'address', 'uint256', 'uint256'], [usdg, manna, 100n, 100n]);
  await mint(manna, curve, 800_000_000n * TOKEN_UNIT);
  await send(OWNER, curve, 'setReserves(uint256,uint256)', 50_000n * USDG_UNIT, 800_000_000n * TOKEN_UNIT);
  const curveBuyer = await deploy(ART.CurveSwapper, ['address', 'address', 'address'], [curve, usdg, manna]);
  const escrow = await deploy(ART.MockEscrow, [], []);

  r = await send(OWNER, mannaC, 'setAddresses(address,address,address,address,address)', TREASURY, '0x' + '0'.repeat(40), curveBuyer, v3, escrow);
  check('setAddresses: treasury, no charity yet, curve buyer, v3 seller, escrow', !r.reverted, revertName(r));
  r = await send(OWNER, mannaC, 'dawn()');
  check('dawn() before the token is set reverts TokenNotSet()', r.reverted && errorIs(r.ret, 'TokenNotSet()'));
  r = await send(OWNER, mannaC, 'setToken(address)', manna);
  check('setToken names the coin', !r.reverted, revertName(r));
  r = await send(OWNER, mannaC, 'setToken(address)', manna);
  check('setToken twice reverts TokenAlreadySet()', r.reverted && errorIs(r.ret, 'TokenAlreadySet()'));
  const nextJ = await viewBig(mannaC, 'nextJubileeDay()');
  check(`nextJubileeDay is a Sunday at least 49 days out (day ${nextJ}, ${dow(nextJ)}, +${nextJ - dayOf(ts)} days)`, isSunday(nextJ) && nextJ - dayOf(ts) >= 49n && nextJ - dayOf(ts) < 56n);

  const invariants = async (label) => {
    const balM = await bal(manna, mannaC);
    const staked = await viewBig(mannaC, 'stakedPool()');
    const lp = await viewBig(mannaC, 'lenderPool()');
    check(`MANNA balance >= stakedPool + lenderPool, dust < 1e6 (${label})`, balM >= staked + lp && balM - staked - lp < 1_000_000n, `${balM} vs ${staked}+${lp}`);
    const balU = await bal(usdg, mannaC);
    const res = await viewBig(mannaC, 'reserve()');
    const ch = await viewBig(mannaC, 'charityAccrued()');
    const carry = await viewBig(mannaC, 'carry()');
    check(`USDG balance == reserve + charityAccrued + carry (${label})`, balU === res + ch + carry, `${balU} vs ${res}+${ch}+${carry}`);
  };
  await invariants('after setup');

  // =========================================================================
  section('3. Lenders enter, shorts open, interest accrues, the tithe appears');
  // =========================================================================

  await mint(pons, L1, 1_000_000n * TOKEN_UNIT);
  await mint(pons, L2, 500_000n * TOKEN_UNIT);
  await mint(cat, L3, 2_000_000n * TOKEN_UNIT);
  await approve(L1, pons, mannaC);
  await approve(L2, pons, mannaC);
  await approve(L3, cat, mannaC);
  r = await send(L1, mannaC, 'enter(address,uint256)', vaultPons, 1_000_000n * TOKEN_UNIT);
  check('L1 enters 1,000,000 PONS through Manna', !r.reverted, revertName(r));
  const sharesL1 = (await view(mannaC, 'lenderOf(address,address)', vaultPons, L1))[0];
  check('L1 has staked shares recorded', toBig(sharesL1) > 0n);
  check('Manna holds the vault shares, lender holds none directly', (await bal(vaultPons, mannaC)) === toBig(sharesL1) && (await bal(vaultPons, L1)) === 0n);
  check('the vault supplied the PONS to Morpho (idle 0)', (await viewBig(vaultPons, 'idle()')) === 0n);
  r = await send(L2, mannaC, 'enter(address,uint256)', vaultPons, 500_000n * TOKEN_UNIT);
  check('L2 enters 500,000 PONS', !r.reverted, revertName(r));
  r = await send(L3, mannaC, 'enter(address,uint256)', vaultCat, 2_000_000n * TOKEN_UNIT);
  check('L3 enters 2,000,000 CASHCAT', !r.reverted, revertName(r));
  r = await send(L3, mannaC, 'enter(address,uint256)', vaultBad, 1n);
  check('enter on an unregistered vault reverts UnknownStorehouse()', r.reverted && errorIs(r.ret, 'UnknownStorehouse()'));
  r = await send(L3, mannaC, 'enter(address,uint256)', vaultCat, 0n);
  check('enter(0) reverts ZeroAmount()', r.reverted && errorIs(r.ret, 'ZeroAmount()'));

  // Shorts. B1 posts 10,000 USDG and borrows 1,000,000 PONS ($2,000, 20% LTV); B2 posts 5,000 USDG, borrows 100,000 CAT.
  await mint(usdg, B1, 10_000n * USDG_UNIT);
  await mint(usdg, B2, 5_000n * USDG_UNIT);
  await approve(B1, usdg, router);
  await approve(B2, usdg, router);
  await send(B1, morpho, 'setAuthorization(address,bool)', router, true);
  await send(B2, morpho, 'setAuthorization(address,bool)', router, true);
  r = await send(B1, router, `openShort(${MP_T},uint256,uint256,address)`, mpTuple(mpPons), 10_000n * USDG_UNIT, 1_000_000n * TOKEN_UNIT, B1);
  check('B1 slings 1,000,000 PONS against 10,000 USDG', !r.reverted, revertName(r));
  check('B1 holds the borrowed PONS', (await bal(pons, B1)) === 1_000_000n * TOKEN_UNIT);
  r = await send(B2, router, `openShort(${MP_T},uint256,uint256,address)`, mpTuple(mpCat), 5_000n * USDG_UNIT, 100_000n * TOKEN_UNIT, B2);
  check('B2 slings 100,000 CASHCAT against 5,000 USDG', !r.reverted, revertName(r));
  r = await send(B1, router, `openShort(${MP_T},uint256,uint256,address)`, mpTuple(mpPons), 0n, 2_000_000n * TOKEN_UNIT, B1);
  check('a sling beyond 38.5% LLTV is refused by Morpho', r.reverted);

  const borrowedUsdPons0 = await viewBig(mannaC, 'borrowedUsd(uint256)', 0n);
  const borrowedUsdCat0 = await viewBig(mannaC, 'borrowedUsd(uint256)', 1n);
  check(`borrowedUsd(PONS) ≈ $2,000 (${borrowedUsdPons0})`, relErr(borrowedUsdPons0, 2_000n * USDG_UNIT) < 1e-3);
  check(`borrowedUsd(CASHCAT) ≈ $800 (${borrowedUsdCat0})`, relErr(borrowedUsdCat0, 800n * USDG_UNIT) < 1e-3);
  const value0 = await viewBig(mannaC, 'storehouseValueUsd()');
  check(`storehouseValueUsd ≈ $3,000 + $16,000 (${value0})`, relErr(value0, 19_000n * USDG_UNIT) < 1e-3);

  // Seven days pass; the Storehouses accrue; the tithe is minted to Manna as shares.
  advance(7n * DAY);
  await send(STRANGER, vaultPons, 'accrue()');
  await send(STRANGER, vaultCat, 'accrue()');
  const feePons = await viewBig(mannaC, 'feeShares(address)', vaultPons);
  const feeCat = await viewBig(mannaC, 'feeShares(address)', vaultCat);
  check(`fee shares minted to Manna in PONS Storehouse (${feePons})`, feePons > 0n);
  check(`fee shares minted to Manna in CASHCAT Storehouse (${feeCat})`, feeCat > 0n);
  const feeAssetsPons = await viewBig(vaultPons, 'convertToAssets(uint256)', feePons);
  // 1,000,000 PONS borrowed at ~200%/yr for 7 days ≈ 3.9% interest ≈ 39,000 PONS; the tithe is 10% ≈ 3,900 PONS.
  check(`the PONS tithe is about 3,900 PONS (${feeAssetsPons / TOKEN_UNIT})`, feeAssetsPons > 3_500n * TOKEN_UNIT && feeAssetsPons < 4_300n * TOKEN_UNIT);
  check('lender shares unchanged by the accrual', toBig((await view(mannaC, 'lenderOf(address,address)', vaultPons, L1))[0]) === toBig(sharesL1));

  // Pons fees arrive in the escrow: the hook credits Manna 10,000 USDG.
  await mint(usdg, HOOK, 100_000n * USDG_UNIT);
  await approve(HOOK, usdg, escrow);
  await send(HOOK, escrow, 'creditToken(address,address,uint256)', mannaC, usdg, 10_000n * USDG_UNIT);
  check('escrow holds 10,000 USDG for Manna', (await viewBig(escrow, 'balanceOfToken(address,address)', mannaC, usdg)) === 10_000n * USDG_UNIT);
  await invariants('before the first dawn');

  return { vm, deploy, call, send, view, viewBig, viewRaw, bal, mint, approve, logsOf, revertName, advance, setTime, getTs: () => ts, tokens: { usdg, weth, pons, cat, manna }, pools: { poolA1, poolA2, poolB }, oracles: { oraclePons, oracleCat }, morpho, irm, mps: { mpPons, mpCat, idPons, idCat }, mannaC, vaults: { vaultPons, vaultCat }, router, v3, curve, curveBuyer, escrow, invariants, relErr, ticks: { tickA1, tickA2, tickB }, prices: { PONS_PRICE, CAT_PRICE }, LLTV, RATE };
}

module.exports = { main, check, section, encode, encodeArgs, words, toBig, toInt, toAddr, errorIs, topicOf, MP_T, mpTuple, marketId, ART, WAD, BPS, DAY, NOON, USDG_UNIT, TOKEN_UNIT, MAX, dayOf, isSunday, dow, isqrt, mulDivDown, abs, ACCOUNTS: { OWNER, TREASURY, CHARITY, HOOK, L1, L2, L3, B1, B2, CALLER, STRANGER, STAKER, LIQUIDATOR }, deployArt: null, summary: () => ({ pass, fail }) };

if (require.main === module) {
  main()
    .then(async (w) => {
      const part2 = require('./test-dawn.js');
      await part2.run(w, module.exports);
      const { pass: p, fail: f } = module.exports.summary();
      console.log(`\n${p} passed, ${f} failed`);
      process.exit(f ? 1 : 0);
    })
    .catch((e) => {
      console.error('FATAL', e);
      process.exit(1);
    });
}
