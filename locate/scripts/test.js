#!/usr/bin/env node
'use strict';

/**
 * Locate integration tests: LocateVault + LocateRouter compiled and run against a real, vendored Morpho
 * Blue (locate/test/morpho/**) inside an in-process EVM (ethereumjs), so the accounting under test is
 * Morpho's actual accounting, not a stand-in.
 *
 *   NODE_PATH=/home/user/experiments/node_modules node locate/scripts/test.js
 *
 * Structure (see SPEC.md sections 3 and 5):
 *   0. Compile locate/contracts/** + locate/test/Mocks.sol + locate/test/morpho/** in one solc run.
 *   1. Vault ERC-20 / ERC-4626 surface, with no Morpho market configured yet (everything stays idle).
 *   2. Market allocation: setMarket/removeMarket/reallocate, caps, queues.
 *   3. LocateRouter borrow flow: openShort/addCollateral/repay/closeShort, positionOf, authorization.
 *   4. Interest accrual and the vault's performance fee.
 *   5. Liquidity under 100% utilisation, and recovery once the borrower repays.
 *   throughout: router never holds funds after a call; vault totalAssets == idle + Σ supplied.
 *
 * This file is self-contained: it does not import anything from scripts/packs/. It reuses only
 * scripts/keccak.js from the repo root (as SPEC.md section 6 earmarks for every script in this project).
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
// ABI helpers (hand-rolled). Extended from the usual flat-word encoder with support for one fully-static
// tuple parameter (MarketParams: 4 addresses + 1 uint256) — per the ABI spec a tuple of only static members
// is itself static and is encoded inline (no offset/tail indirection), so this is a small, safe addition.
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

/** Splits a signature's inner type-list on top-level commas only (parenthesis-depth aware). */
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
  if (start < inner.length || inner.length === 0) {
    const tail = inner.slice(start);
    if (tail !== '' || parts.length > 0) parts.push(tail);
  }
  return parts.filter((p) => p.length > 0);
}

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
    } else if (t.startsWith('(') && t.endsWith(')')) {
      // Fully-static tuple (our only case: MarketParams = 4 addresses + 1 uint256): inline, no indirection.
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
const toAddr = (w) => '0x' + Buffer.from(w).subarray(12).toString('hex');
const errorIs = (ret, sig) => ret.length >= 4 && Buffer.from(ret.subarray(0, 4)).equals(selector(sig));
const decodeString = (ret, wordOffset = 0) => {
  const w = words(ret);
  const len = Number(toBig(w[wordOffset + 1]));
  const start = (wordOffset + 2) * 32;
  return ret.subarray(start, start + len).toString('utf8');
};
const decodeBytes32Array = (ret) => {
  const w = words(ret);
  const len = Number(toBig(w[1]));
  const out = [];
  for (let i = 0; i < len; i++) out.push('0x' + Buffer.from(w[2 + i]).toString('hex'));
  return out;
};
/** Standard Solidity `require(cond, "reason")` revert: selector 0x08c379a0, Error(string). */
const decodeStringRevert = (ret) => {
  if (ret.length < 4 || !Buffer.from(ret.subarray(0, 4)).equals(Buffer.from('08c379a0', 'hex'))) return null;
  return decodeString(ret.subarray(4));
};

// A MarketParams value as the 5-element array the tuple encoder above expects.
const MP_T = '(address,address,address,address,uint256)';
const mpTuple = (mp) => [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv];
const marketId = (mp) =>
  '0x' + keccak256(Buffer.concat([word(mp.loanToken), word(mp.collateralToken), word(mp.oracle), word(mp.irm), word(mp.lltv)])).toString('hex');

// ---------------------------------------------------------------------------
// JS mirrors of the exact on-chain fixed-point formulas, used to hand-check every result.
// ---------------------------------------------------------------------------

const WAD = 10n ** 18n;
const MORPHO_VIRTUAL_SHARES = 10n ** 6n;
const MORPHO_VIRTUAL_ASSETS = 1n;
const VAULT_OFFSET_SHARES = 10n ** 6n;
const VAULT_OFFSET_ASSETS = 1n;

const mulDivDown = (x, y, d) => (x * y) / d;
const mulDivUp = (x, y, d) => (x * y + (d - 1n)) / d;

const toAssetsDown = (shares, totalAssets, totalShares) =>
  mulDivDown(shares, totalAssets + MORPHO_VIRTUAL_ASSETS, totalShares + MORPHO_VIRTUAL_SHARES);
const toAssetsUp = (shares, totalAssets, totalShares) =>
  mulDivUp(shares, totalAssets + MORPHO_VIRTUAL_ASSETS, totalShares + MORPHO_VIRTUAL_SHARES);
const toSharesDown = (assets, totalAssets, totalShares) =>
  mulDivDown(assets, totalShares + MORPHO_VIRTUAL_SHARES, totalAssets + MORPHO_VIRTUAL_ASSETS);
const toSharesUp = (assets, totalAssets, totalShares) =>
  mulDivUp(assets, totalShares + MORPHO_VIRTUAL_SHARES, totalAssets + MORPHO_VIRTUAL_ASSETS);

/** Morpho's MathLib.wTaylorCompounded: e^(rate*t) - 1, approximated by its first three Taylor terms. */
const wTaylorCompounded = (x, n) => {
  const firstTerm = x * n;
  const secondTerm = mulDivDown(firstTerm, firstTerm, 2n * WAD);
  const thirdTerm = mulDivDown(secondTerm, firstTerm, 3n * WAD);
  return firstTerm + secondTerm + thirdTerm;
};

const vConvertToShares = (assets, totalSupply, totalAssets, roundUp) => {
  const s = totalSupply + VAULT_OFFSET_SHARES;
  const a = totalAssets + VAULT_OFFSET_ASSETS;
  return roundUp ? mulDivUp(assets, s, a) : mulDivDown(assets, s, a);
};
const vConvertToAssets = (shares, totalSupply, totalAssets, roundUp) => {
  const s = totalSupply + VAULT_OFFSET_SHARES;
  const a = totalAssets + VAULT_OFFSET_ASSETS;
  return roundUp ? mulDivUp(shares, a, s) : mulDivDown(shares, a, s);
};

/** LocateRouter.positionOf's liquidationPrice: USDG per 1 stock, 1e18 fixed point. See its NatSpec. */
const liquidationPriceCalc = (collateral, lltv, borrowAssets) =>
  borrowAssets === 0n ? 0n : (collateral * lltv * 10n ** 12n) / borrowAssets;
const maxBorrowCalc = (collateral, price, lltv) => mulDivDown(mulDivDown(collateral, price, 10n ** 36n), lltv, WAD);

// ---------------------------------------------------------------------------
// Compile: locate/contracts/** + locate/test/Mocks.sol + locate/test/morpho/** in one solc run.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..'); // locate/
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SOURCE_FILES = [
  'contracts/LocateVault.sol',
  'contracts/LocateRouter.sol',
  'contracts/interfaces/IMorpho.sol',
  'contracts/interfaces/IOracle.sol',
  'test/Mocks.sol',
  'test/morpho/Morpho.sol',
  'test/morpho/interfaces/IMorpho.sol',
  'test/morpho/interfaces/IIrm.sol',
  'test/morpho/interfaces/IOracle.sol',
  'test/morpho/interfaces/IERC20.sol',
  'test/morpho/interfaces/IMorphoCallbacks.sol',
  'test/morpho/libraries/ConstantsLib.sol',
  'test/morpho/libraries/ErrorsLib.sol',
  'test/morpho/libraries/EventsLib.sol',
  'test/morpho/libraries/MathLib.sol',
  'test/morpho/libraries/MarketParamsLib.sol',
  'test/morpho/libraries/SafeTransferLib.sol',
  'test/morpho/libraries/SharesMathLib.sol',
  'test/morpho/libraries/UtilsLib.sol',
];
const sources = {};
for (const f of SOURCE_FILES) sources[f] = { content: src(f) };

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
    })
  )
);
const diags = solcOut.errors || [];
const solcErrors = diags.filter((d) => d.severity === 'error');
if (solcErrors.length) {
  for (const e of solcErrors) console.error(e.formattedMessage);
  process.exit(1);
}
const solcWarnings = diags.filter((d) => d.severity === 'warning');
const ourWarnings = solcWarnings.filter((w) => w.sourceLocation && w.sourceLocation.file.startsWith('contracts/'));
const otherWarnings = solcWarnings.filter((w) => !(w.sourceLocation && w.sourceLocation.file.startsWith('contracts/')));
if (otherWarnings.length) {
  console.log(`\n(${otherWarnings.length} solc warning(s) outside locate/contracts/*, tolerated:)`);
  for (const w of otherWarnings) console.log('  ' + w.formattedMessage.split('\n')[0]);
}

const ART = {
  LocateVault: solcOut.contracts['contracts/LocateVault.sol'].LocateVault,
  LocateRouter: solcOut.contracts['contracts/LocateRouter.sol'].LocateRouter,
  Morpho: solcOut.contracts['test/morpho/Morpho.sol'].Morpho,
  MockERC20: solcOut.contracts['test/Mocks.sol'].MockERC20,
  MockOracle: solcOut.contracts['test/Mocks.sol'].MockOracle,
  MockIrm: solcOut.contracts['test/Mocks.sol'].MockIrm,
  MockFeed: solcOut.contracts['test/Mocks.sol'].MockFeed,
};

// ---------------------------------------------------------------------------
// EVM harness (ethereumjs, Cancun)
// ---------------------------------------------------------------------------

const OWNER = '0x' + 'a0'.repeat(20);
const LENDER1 = '0x' + 'b1'.repeat(20);
const LENDER2 = '0x' + 'b2'.repeat(20);
const BORROWER = '0x' + 'c1'.repeat(20);
const BORROWER2 = '0x' + 'c2'.repeat(20);
const BORROWER3 = '0x' + 'c3'.repeat(20);
const STRANGER = '0x' + 'd0'.repeat(20);
const STRANGER2 = '0x' + 'd1'.repeat(20);
const FEE_RECIPIENT = '0x' + 'e0'.repeat(20);
const FEE_RECIPIENT2 = '0x' + 'e1'.repeat(20);
const RECEIVER = '0x' + 'f1'.repeat(20);
const RECEIVER2 = '0x' + 'f2'.repeat(20);
const FAIL_USER = '0x' + 'f3'.repeat(20);

const ETH = 10n ** 18n;
const addr = (h) => new Address(hexToBytes(h));

const USDG_UNIT = 10n ** 6n;
const STOCK_UNIT = 10n ** 18n;
const LLTV = (77n * WAD) / 100n; // 0.77e18
const STOCK_PRICE_USD = 200n; // 1 stock == 200 USDG, for the mock oracle
const ORACLE_PRICE = (10n ** 48n) / STOCK_PRICE_USD; // 1e36 convention, stock-per-USDG (see IOracle.sol)
const FEE_BPS = 1000n; // 10%

async function main() {
  const common = new Common({ chain: 1, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });

  const fakeHash = (n) => keccak256(Buffer.concat([Buffer.from('blockhash', 'utf8'), word(BigInt(n))]));
  const bc = vm.evm.blockchain || vm.blockchain;
  bc.getBlock = async (n) => ({ hash: () => new Uint8Array(fakeHash(typeof n === 'bigint' ? n : BigInt(n))) });

  let blockNo = 1000n;
  let ts = 1_800_000_000n;
  const advance = (seconds) => {
    ts += BigInt(seconds);
    blockNo += 1n;
  };
  const curBlock = () => Block.fromBlockData({ header: { number: blockNo, timestamp: ts, gasLimit: 30_000_000n } }, { common });

  for (const a of [
    OWNER, LENDER1, LENDER2, BORROWER, BORROWER2, BORROWER3, STRANGER, STRANGER2,
    FEE_RECIPIENT, FEE_RECIPIENT2, RECEIVER, RECEIVER2, FAIL_USER,
  ]) {
    await vm.stateManager.putAccount(addr(a), new Account(0n, 1000n * ETH));
  }

  const call = async ({ from = OWNER, to, data, value = 0n }) => {
    const res = await vm.evm.runCall({
      caller: addr(from),
      origin: addr(from),
      to: to ? addr(to) : undefined,
      data,
      value,
      gasLimit: 12_000_000n,
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

  const view = async (to, sig, ...args) => {
    const r = await call({ from: STRANGER, to, data: encode(sig, ...args) });
    if (r.reverted) return null;
    return words(r.ret);
  };
  const viewBig = async (to, sig, ...args) => {
    const w = await view(to, sig, ...args);
    return w ? toBig(w[0]) : null;
  };
  const viewRaw = async (to, sig, ...args) => {
    const r = await call({ from: STRANGER, to, data: encode(sig, ...args) });
    return r;
  };

  // -------------------------------------------------------------------------
  section('Compilation');
  check('contracts + mocks + vendored Morpho compile with no errors', true);
  check(
    'no solc warnings for locate/contracts/* (hard gate)',
    ourWarnings.length === 0,
    ourWarnings.map((w) => w.formattedMessage.split('\n')[0]).join(' | ')
  );

  // -------------------------------------------------------------------------
  section('World: Morpho + tokens + oracle/irm + market1 + vault + router');

  const morpho = await deploy(ART.Morpho, ['address'], [OWNER]);
  const oracle1 = await deploy(ART.MockOracle, ['uint256'], [ORACLE_PRICE]);
  const irm1 = await deploy(ART.MockIrm, ['uint256'], [0n]);
  const usdg = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Global Dollar', 'USDG', 6]);
  const stock = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Locate NVDA', 'lNVDA', 18]);

  let r = await call({ to: morpho, data: encode('enableIrm(address)', irm1) });
  check('owner enables the IRM', !r.reverted, r.error);
  r = await call({ to: morpho, data: encode('enableLltv(uint256)', LLTV) });
  check('owner enables LLTV 0.77e18', !r.reverted, r.error);

  const mp1 = { loanToken: stock, collateralToken: usdg, oracle: oracle1, irm: irm1, lltv: LLTV };
  const id1 = marketId(mp1);
  r = await call({ to: morpho, data: encode(`createMarket(${MP_T})`, mpTuple(mp1)) });
  check('market1 created on Morpho (loan=stock, collateral=USDG)', !r.reverted, r.error);
  check('market1 exists (lastUpdate != 0)', (await view(morpho, 'market(bytes32)', id1))[4] !== undefined && toBig((await view(morpho, 'market(bytes32)', id1))[4]) !== 0n);

  const vault = await deploy(
    ART.LocateVault,
    ['address', 'address', 'string', 'string', 'address', 'address', 'uint96'],
    [morpho, stock, 'Locate lNVDA Vault', 'locNVDA', OWNER, FEE_RECIPIENT, FEE_BPS]
  );
  const router = await deploy(ART.LocateRouter, ['address'], [morpho]);
  check('vault deployed', vault !== null);
  check('router deployed', router !== null);

  async function morphoMarket(id) {
    const w = await view(morpho, 'market(bytes32)', id);
    return {
      totalSupplyAssets: toBig(w[0]),
      totalSupplyShares: toBig(w[1]),
      totalBorrowAssets: toBig(w[2]),
      totalBorrowShares: toBig(w[3]),
      lastUpdate: toBig(w[4]),
      fee: toBig(w[5]),
    };
  }
  async function morphoPosition(id, who) {
    const w = await view(morpho, 'position(bytes32,address)', id, who);
    return { supplyShares: toBig(w[0]), borrowShares: toBig(w[1]), collateral: toBig(w[2]) };
  }
  async function bal(token, who) {
    return viewBig(token, 'balanceOf(address)', who);
  }
  async function routerEmpty(label) {
    const u = await bal(usdg, router);
    const s = await bal(stock, router);
    check(`router holds no USDG (${label})`, u === 0n, u);
    check(`router holds no stock (${label})`, s === 0n, s);
  }
  async function vaultInvariant(label) {
    const idleV = await viewBig(vault, 'idle()');
    const totalV = await viewBig(vault, 'totalAssets()');
    const q = decodeBytes32Array((await viewRaw(vault, 'supplyQueue()')).ret);
    let sum = 0n;
    for (const id of q) sum += await viewBig(vault, 'supplied(bytes32)', id);
    check(`vault totalAssets == idle + Σsupplied (${label})`, totalV === idleV + sum, `${totalV} vs ${idleV}+${sum}`);
  }

  section('MockFeed (Chainlink-style, for completeness — not consumed by Morpho directly)');
  const feed = await deploy(ART.MockFeed, ['int256', 'uint8'], [20_000_000_000n, 8]); // $200.00 at 8 decimals
  check('MockFeed decimals()', (await viewBig(feed, 'decimals()')) === 8n);
  let rd = await view(feed, 'latestRoundData()');
  check('MockFeed latestRoundData() answer', toBig(rd[1]) === 20_000_000_000n);
  check('MockFeed latestRoundData() roundId starts at 1', toBig(rd[0]) === 1n);
  await call({ to: feed, data: encode('setAnswer(int256)', 21_000_000_000n) });
  rd = await view(feed, 'latestRoundData()');
  check('MockFeed setAnswer updates the answer', toBig(rd[1]) === 21_000_000_000n);
  check('MockFeed setAnswer bumps roundId', toBig(rd[0]) === 2n);

  // ===========================================================================================
  section('1. Vault ERC-20 / ERC-4626 surface (no market configured yet — everything stays idle)');
  // ===========================================================================================

  check('name()', decodeString((await viewRaw(vault, 'name()')).ret) === 'Locate lNVDA Vault');
  check('symbol()', decodeString((await viewRaw(vault, 'symbol()')).ret) === 'locNVDA');
  check('decimals() == asset decimals (18) + 6 == 24', (await viewBig(vault, 'decimals()')) === 24n);
  check('asset() == stock', (await view(vault, 'asset()'))[0].subarray(12).toString('hex') === strip(stock).toLowerCase());
  check('totalSupply() starts at 0', (await viewBig(vault, 'totalSupply()')) === 0n);
  check('totalAssets() starts at 0', (await viewBig(vault, 'totalAssets()')) === 0n);
  check('owner() == OWNER', toAddr((await view(vault, 'owner()'))[0]) === OWNER);
  check('feeRecipient() == FEE_RECIPIENT', toAddr((await view(vault, 'feeRecipient()'))[0]) === FEE_RECIPIENT);
  check('feeBps() == 1000', (await viewBig(vault, 'feeBps()')) === FEE_BPS);

  await call({ to: stock, data: encode('mint(address,uint256)', LENDER1, 1_000_000n * STOCK_UNIT) });
  await call({ to: stock, data: encode('mint(address,uint256)', LENDER2, 500_000n * STOCK_UNIT) });
  await call({ from: LENDER1, to: stock, data: encode('approve(address,uint256)', vault, (1n << 256n) - 1n) });
  await call({ from: LENDER2, to: stock, data: encode('approve(address,uint256)', vault, (1n << 256n) - 1n) });

  // Zero-amount paths revert with the right custom error.
  r = await call({ from: LENDER1, to: vault, data: encode('deposit(uint256,address)', 0n, LENDER1) });
  check('deposit(0) reverts ZeroAssets()', r.reverted && errorIs(r.ret, 'ZeroAssets()'));
  r = await call({ from: LENDER1, to: vault, data: encode('mint(uint256,address)', 0n, LENDER1) });
  check('mint(0) reverts ZeroShares()', r.reverted && errorIs(r.ret, 'ZeroShares()'));
  r = await call({ from: LENDER1, to: vault, data: encode('withdraw(uint256,address,address)', 0n, LENDER1, LENDER1) });
  check('withdraw(0) reverts ZeroAssets()', r.reverted && errorIs(r.ret, 'ZeroAssets()'));
  r = await call({ from: LENDER1, to: vault, data: encode('redeem(uint256,address,address)', 0n, LENDER1, LENDER1) });
  check('redeem(0) reverts ZeroShares()', r.reverted && errorIs(r.ret, 'ZeroShares()'));

  const deposit1 = 10_000n * STOCK_UNIT;
  let totalSupplyNow = 0n;
  let totalAssetsNow = 0n;
  const expectedShares1 = vConvertToShares(deposit1, totalSupplyNow, totalAssetsNow, false);
  const previewShares1 = await viewBig(vault, 'previewDeposit(uint256)', deposit1);
  check('previewDeposit matches the pre-deposit-rate hand computation', previewShares1 === expectedShares1, `${previewShares1} vs ${expectedShares1}`);

  r = await call({ from: LENDER1, to: vault, data: encode('deposit(uint256,address)', deposit1, LENDER1) });
  check('LENDER1 deposits 10,000 stock', !r.reverted, r.error);
  const shares1 = toBig(words(r.ret)[0]);
  check('deposit() returns the previewed share amount', shares1 === expectedShares1, `${shares1} vs ${expectedShares1}`);
  check('LENDER1 balanceOf == minted shares', (await bal(vault, LENDER1)) === shares1);
  check('totalSupply() == minted shares', (await viewBig(vault, 'totalSupply()')) === shares1);
  check('totalAssets() == deposit1 (no market yet, all idle)', (await viewBig(vault, 'totalAssets()')) === deposit1);
  check('idle() == deposit1', (await viewBig(vault, 'idle()')) === deposit1);
  check('Deposit event emitted', r.logs.some((l) => l.topics[0] === bytesToHex(keccak256(Buffer.from('Deposit(address,address,uint256,uint256)')))));
  check('Transfer(0,LENDER1,shares) emitted', r.logs.some((l) => l.topics[0] === bytesToHex(keccak256(Buffer.from('Transfer(address,address,uint256)')))));

  // mint()
  totalSupplyNow = await viewBig(vault, 'totalSupply()');
  totalAssetsNow = await viewBig(vault, 'totalAssets()');
  const mintShares = shares1 / 10n; // mint 10% more shares
  const expectedAssetsForMint = vConvertToAssets(mintShares, totalSupplyNow, totalAssetsNow, true);
  const previewMintAssets = await viewBig(vault, 'previewMint(uint256)', mintShares);
  check('previewMint matches ceil hand computation', previewMintAssets === expectedAssetsForMint, `${previewMintAssets} vs ${expectedAssetsForMint}`);
  r = await call({ from: LENDER1, to: vault, data: encode('mint(uint256,address)', mintShares, LENDER1) });
  check('LENDER1 mints shares directly', !r.reverted, r.error);
  const mintedAssets = toBig(words(r.ret)[0]);
  check('mint() pulls exactly previewMint()', mintedAssets === expectedAssetsForMint);
  check('LENDER1 balance increased by mintShares', (await bal(vault, LENDER1)) === shares1 + mintShares);

  // Transfers, approvals, allowance.
  const lender1Shares = await bal(vault, LENDER1);
  const xferAmt = lender1Shares / 100n;
  r = await call({ from: LENDER1, to: vault, data: encode('approve(address,uint256)', STRANGER, xferAmt) });
  check('approve() succeeds', !r.reverted);
  check('allowance reflects the approval', (await viewBig(vault, 'allowance(address,address)', LENDER1, STRANGER)) === xferAmt);
  r = await call({ from: STRANGER, to: vault, data: encode('transferFrom(address,address,uint256)', LENDER1, LENDER2, xferAmt) });
  check('transferFrom() within allowance succeeds', !r.reverted, r.error);
  check('allowance decremented to 0', (await viewBig(vault, 'allowance(address,address)', LENDER1, STRANGER)) === 0n);
  check('LENDER2 received the shares', (await bal(vault, LENDER2)) >= xferAmt);
  r = await call({ from: STRANGER, to: vault, data: encode('transferFrom(address,address,uint256)', LENDER1, LENDER2, 1n) });
  check('transferFrom() beyond allowance reverts InsufficientAllowance()', r.reverted && errorIs(r.ret, 'InsufficientAllowance()'));
  r = await call({ from: LENDER1, to: vault, data: encode('transfer(address,uint256)', LENDER2, (1n << 200n)) });
  check('transfer() beyond balance reverts InsufficientBalance()', r.reverted && errorIs(r.ret, 'InsufficientBalance()'));
  const directXfer = 12345n;
  const l2Before = await bal(vault, LENDER2);
  r = await call({ from: LENDER1, to: vault, data: encode('transfer(address,uint256)', LENDER2, directXfer) });
  check('direct transfer() succeeds', !r.reverted);
  check('direct transfer() moved exactly the amount', (await bal(vault, LENDER2)) === l2Before + directXfer);

  // Unauthorized withdraw/redeem (owner param != caller, no allowance).
  r = await call({ from: STRANGER, to: vault, data: encode('withdraw(uint256,address,address)', 1n, STRANGER, LENDER1) });
  check('withdraw() on someone else without allowance reverts InsufficientAllowance()', r.reverted && errorIs(r.ret, 'InsufficientAllowance()'));
  // A large-enough share amount that it cannot round down to 0 assets (which would revert ZeroAssets()
  // before the allowance check even runs) yet is still a small slice of LENDER1's actual balance.
  r = await call({ from: STRANGER, to: vault, data: encode('redeem(uint256,address,address)', 10n ** 15n, STRANGER, LENDER1) });
  check('redeem() on someone else without allowance reverts InsufficientAllowance()', r.reverted && errorIs(r.ret, 'InsufficientAllowance()'));

  // previewWithdraw / previewRedeem / redeem, all idle so no liquidity constraint yet.
  totalSupplyNow = await viewBig(vault, 'totalSupply()');
  totalAssetsNow = await viewBig(vault, 'totalAssets()');
  const redeemShares = (await bal(vault, LENDER2)) / 2n;
  const expectedRedeemAssets = vConvertToAssets(redeemShares, totalSupplyNow, totalAssetsNow, false);
  const previewRedeemAssets = await viewBig(vault, 'previewRedeem(uint256)', redeemShares);
  check('previewRedeem matches hand computation', previewRedeemAssets === expectedRedeemAssets);
  const stockBefore = await bal(stock, LENDER2);
  r = await call({ from: LENDER2, to: vault, data: encode('redeem(uint256,address,address)', redeemShares, LENDER2, LENDER2) });
  check('LENDER2 redeems shares', !r.reverted, r.error);
  const redeemedAssets = toBig(words(r.ret)[0]);
  check('redeem() returns previewed assets', redeemedAssets === expectedRedeemAssets);
  check('LENDER2 stock balance increased accordingly', (await bal(stock, LENDER2)) === stockBefore + redeemedAssets);
  check('Withdraw event emitted', r.logs.some((l) => l.topics[0] === bytesToHex(keccak256(Buffer.from('Withdraw(address,address,address,uint256,uint256)')))));

  totalSupplyNow = await viewBig(vault, 'totalSupply()');
  totalAssetsNow = await viewBig(vault, 'totalAssets()');
  const withdrawAssets = 1_000n * STOCK_UNIT;
  const expectedWithdrawShares = vConvertToShares(withdrawAssets, totalSupplyNow, totalAssetsNow, true);
  const previewWithdrawShares = await viewBig(vault, 'previewWithdraw(uint256)', withdrawAssets);
  check('previewWithdraw matches ceil hand computation', previewWithdrawShares === expectedWithdrawShares);
  const l1SharesBefore = await bal(vault, LENDER1);
  r = await call({ from: LENDER1, to: vault, data: encode('withdraw(uint256,address,address)', withdrawAssets, LENDER1, LENDER1) });
  check('LENDER1 withdraws a fixed asset amount', !r.reverted, r.error);
  const burntShares = toBig(words(r.ret)[0]);
  check('withdraw() burns previewWithdraw() shares', burntShares === expectedWithdrawShares);
  check('LENDER1 balance decreased by burnt shares', (await bal(vault, LENDER1)) === l1SharesBefore - burntShares);

  // maxWithdraw / maxRedeem with no market: bounded only by the owner's own balance (idle == totalAssets).
  const l1Assets = await viewBig(vault, 'convertToAssets(uint256)', await bal(vault, LENDER1));
  check('maxWithdraw(LENDER1) == convertToAssets(balance) (all idle)', (await viewBig(vault, 'maxWithdraw(address)', LENDER1)) === l1Assets);
  check('maxRedeem(LENDER1) == balanceOf(LENDER1) (all idle)', (await viewBig(vault, 'maxRedeem(address)', LENDER1)) === (await bal(vault, LENDER1)));
  check('maxDeposit == max uint256', (await viewBig(vault, 'maxDeposit(address)', LENDER1)) === (1n << 256n) - 1n);
  check('maxMint == max uint256', (await viewBig(vault, 'maxMint(address)', LENDER1)) === (1n << 256n) - 1n);

  await vaultInvariant('end of section 1');

  // ===========================================================================================
  section('2. Allocation: setMarket, caps, queues, removeMarket, reallocate');
  // ===========================================================================================

  r = await call({ from: STRANGER, to: vault, data: encode(`setMarket(${MP_T},uint256)`, mpTuple(mp1), 1n) });
  check('setMarket() from a stranger reverts NotOwner()', r.reverted && errorIs(r.ret, 'NotOwner()'));

  const cap1 = 4_000n * STOCK_UNIT;
  r = await call({ to: vault, data: encode(`setMarket(${MP_T},uint256)`, mpTuple(mp1), cap1) });
  check('owner sets market1 with a cap', !r.reverted, r.error);
  check('MarketSet event emitted', r.logs.some((l) => l.topics[0] === bytesToHex(keccak256(Buffer.from('MarketSet(bytes32,uint256)')))));
  let mc = await view(vault, 'marketConfig(bytes32)', id1);
  check('marketConfig(id1) == (cap1, enabled)', toBig(mc[0]) === cap1 && toBig(mc[1]) === 1n);
  let sq = decodeBytes32Array((await viewRaw(vault, 'supplyQueue()')).ret);
  check('supplyQueue() == [id1]', sq.length === 1 && sq[0] === id1);
  let wq = decodeBytes32Array((await viewRaw(vault, 'withdrawQueue()')).ret);
  check('withdrawQueue() == [id1]', wq.length === 1 && wq[0] === id1);

  const idleBeforeP2 = await viewBig(vault, 'idle()');
  const depositAmt2 = 6_000n * STOCK_UNIT; // > cap1
  r = await call({ from: LENDER1, to: vault, data: encode('deposit(uint256,address)', depositAmt2, LENDER1) });
  check('deposit above cap succeeds', !r.reverted, r.error);
  check('supplied(id1) caps at cap1', (await viewBig(vault, 'supplied(bytes32)', id1)) === cap1);
  check('remainder stays idle', (await viewBig(vault, 'idle()')) === idleBeforeP2 + depositAmt2 - cap1);
  await vaultInvariant('after deposit above cap');

  // Second market: reuse loanToken/collateralToken/lltv, differ by oracle+irm (already-enabled LLTV is fine).
  const oracle2 = await deploy(ART.MockOracle, ['uint256'], [ORACLE_PRICE]);
  const irm2 = await deploy(ART.MockIrm, ['uint256'], [0n]);
  await call({ to: morpho, data: encode('enableIrm(address)', irm2) });
  const mp2 = { loanToken: stock, collateralToken: usdg, oracle: oracle2, irm: irm2, lltv: LLTV };
  const id2 = marketId(mp2);
  r = await call({ to: morpho, data: encode(`createMarket(${MP_T})`, mpTuple(mp2)) });
  check('market2 created on Morpho', !r.reverted, r.error);

  let cap2 = 3_000n * STOCK_UNIT;
  r = await call({ to: vault, data: encode(`setMarket(${MP_T},uint256)`, mpTuple(mp2), cap2) });
  check('owner adds market2', !r.reverted, r.error);
  sq = decodeBytes32Array((await viewRaw(vault, 'supplyQueue()')).ret);
  check('second market appended to supplyQueue in order', sq.length === 2 && sq[0] === id1 && sq[1] === id2);
  wq = decodeBytes32Array((await viewRaw(vault, 'withdrawQueue()')).ret);
  check('second market appended to withdrawQueue in order', wq.length === 2 && wq[0] === id1 && wq[1] === id2);

  // Allocation sweeps ALL idle (pre-existing leftover plus this new deposit), not just the amount just
  // deposited — market1 has no room (full at its cap), so market2 fills up to min(all available idle, cap2).
  const idleBeforeDeposit3 = await viewBig(vault, 'idle()');
  const deposit3 = 2_000n * STOCK_UNIT;
  r = await call({ from: LENDER1, to: vault, data: encode('deposit(uint256,address)', deposit3, LENDER1) });
  check('deposit routes to market2 once market1 is full', !r.reverted, r.error);
  const availableForAlloc3 = idleBeforeDeposit3 + deposit3;
  const expectedSuppliedId2 = availableForAlloc3 < cap2 ? availableForAlloc3 : cap2;
  const expectedIdleAfterDeposit3 = availableForAlloc3 - expectedSuppliedId2;
  check('supplied(id2) fills up to min(available idle, cap2)', (await viewBig(vault, 'supplied(bytes32)', id2)) === expectedSuppliedId2, `${await viewBig(vault, 'supplied(bytes32)', id2)} vs ${expectedSuppliedId2}`);
  check('idle holds whatever did not fit under cap2', (await viewBig(vault, 'idle()')) === expectedIdleAfterDeposit3, `${await viewBig(vault, 'idle()')} vs ${expectedIdleAfterDeposit3}`);

  r = await call({ to: vault, data: encode(`setMarket(${MP_T},uint256)`, mpTuple(mp2), 0n) });
  check('owner sets market2 cap to 0', !r.reverted, r.error);
  mc = await view(vault, 'marketConfig(bytes32)', id2);
  check('market2 still enabled, cap 0', toBig(mc[0]) === 0n && toBig(mc[1]) === 1n);

  const idleBeforeDeposit4 = await viewBig(vault, 'idle()');
  const suppliedId1BeforeDeposit4 = await viewBig(vault, 'supplied(bytes32)', id1);
  const suppliedId2BeforeDeposit4 = await viewBig(vault, 'supplied(bytes32)', id2);
  const deposit4 = 1_500n * STOCK_UNIT;
  r = await call({ from: LENDER1, to: vault, data: encode('deposit(uint256,address)', deposit4, LENDER1) });
  check('deposit with cap 0 on market2 and market1 full stays idle', !r.reverted, r.error);
  check('cap 0 disables NEW supply only: supplied(id1) unchanged', (await viewBig(vault, 'supplied(bytes32)', id1)) === suppliedId1BeforeDeposit4);
  check('cap 0 disables NEW supply only: supplied(id2) unchanged', (await viewBig(vault, 'supplied(bytes32)', id2)) === suppliedId2BeforeDeposit4);
  check('all of deposit4 stayed idle', (await viewBig(vault, 'idle()')) === idleBeforeDeposit4 + deposit4);
  await vaultInvariant('after cap-0 deposit');

  r = await call({ to: vault, data: encode('removeMarket(bytes32)', id2) });
  check('removeMarket refused while supplied != 0', r.reverted && errorIs(r.ret, 'MarketInUse()'));

  r = await call({ to: vault, data: encode('reallocate(bytes32,bytes32,uint256)', id1, id2, 100n * STOCK_UNIT) });
  check('reallocate into a zero-cap market reverts CapExceeded()', r.reverted && errorIs(r.ret, 'CapExceeded()'));

  const unknownId = '0x' + 'ff'.repeat(32);
  r = await call({ to: vault, data: encode('reallocate(bytes32,bytes32,uint256)', unknownId, id1, 1n) });
  check('reallocate from an unknown id reverts UnknownMarket()', r.reverted && errorIs(r.ret, 'UnknownMarket()'));
  r = await call({ to: vault, data: encode('reallocate(bytes32,bytes32,uint256)', id1, unknownId, 1n) });
  check('reallocate to an unknown id reverts UnknownMarket()', r.reverted && errorIs(r.ret, 'UnknownMarket()'));

  const hugeCap = 1_000_000n * STOCK_UNIT;
  r = await call({ to: vault, data: encode(`setMarket(${MP_T},uint256)`, mpTuple(mp1), hugeCap) });
  check('owner raises market1 cap to make room', !r.reverted, r.error);
  sq = decodeBytes32Array((await viewRaw(vault, 'supplyQueue()')).ret);
  check('re-setting an existing market does not duplicate the queue', sq.length === 2);

  const suppliedId1Before = await viewBig(vault, 'supplied(bytes32)', id1);
  const suppliedId2ToMove = await viewBig(vault, 'supplied(bytes32)', id2); // move ALL of market2's position
  r = await call({ to: vault, data: encode('reallocate(bytes32,bytes32,uint256)', id2, id1, suppliedId2ToMove) });
  check('owner reallocates market2 -> market1', !r.reverted, r.error);
  check('Reallocated event emitted', r.logs.some((l) => l.topics[0] === bytesToHex(keccak256(Buffer.from('Reallocated(bytes32,bytes32,uint256)')))));
  check('supplied(id2) == 0 after reallocate', (await viewBig(vault, 'supplied(bytes32)', id2)) === 0n);
  check('supplied(id1) increased by the reallocated amount', (await viewBig(vault, 'supplied(bytes32)', id1)) === suppliedId1Before + suppliedId2ToMove);
  await vaultInvariant('after reallocate');

  r = await call({ to: vault, data: encode('removeMarket(bytes32)', id2) });
  check('removeMarket succeeds once supplied is 0', !r.reverted, r.error);
  check('MarketRemoved event emitted', r.logs.some((l) => l.topics[0] === bytesToHex(keccak256(Buffer.from('MarketRemoved(bytes32)')))));
  sq = decodeBytes32Array((await viewRaw(vault, 'supplyQueue()')).ret);
  check('supplyQueue() back to [id1]', sq.length === 1 && sq[0] === id1);
  mc = await view(vault, 'marketConfig(bytes32)', id2);
  check('marketConfig(id2) cleared', toBig(mc[0]) === 0n && toBig(mc[1]) === 0n);

  r = await call({ to: vault, data: encode('removeMarket(bytes32)', id1) });
  check('removeMarket refused on market1 (still supplied)', r.reverted && errorIs(r.ret, 'MarketInUse()'));

  // only-owner checks
  for (const [label, data] of [
    ['removeMarket', encode('removeMarket(bytes32)', id1)],
    ['reallocate', encode('reallocate(bytes32,bytes32,uint256)', id1, id1, 1n)],
    ['setFee', encode('setFee(uint96,address)', 100n, STRANGER)],
    ['transferOwnership', encode('transferOwnership(address)', STRANGER)],
  ]) {
    r = await call({ from: STRANGER, to: vault, data });
    check(`${label}() from a stranger reverts NotOwner()`, r.reverted && errorIs(r.ret, 'NotOwner()'));
  }

  // ===========================================================================================
  section('3. LocateRouter: openShort / addCollateral / repay / closeShort / positionOf');
  // ===========================================================================================

  await call({ to: usdg, data: encode('mint(address,uint256)', STRANGER2, 10_000n * USDG_UNIT) });
  await call({ from: STRANGER2, to: usdg, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });
  r = await call({ from: STRANGER2, to: router, data: encode(`openShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), 100n * USDG_UNIT, 1n * STOCK_UNIT, STRANGER2) });
  check('openShort without Morpho authorization reverts (Morpho UNAUTHORIZED)', r.reverted && decodeStringRevert(r.ret) === 'unauthorized', decodeStringRevert(r.ret));
  const unauthPos = await morphoPosition(id1, STRANGER2);
  check('the failed attempt left no trace (atomic rollback)', unauthPos.collateral === 0n);

  await call({ from: BORROWER, to: morpho, data: encode('setAuthorization(address,bool)', router, true) });
  check('BORROWER authorizes the router on Morpho', (await view(morpho, 'isAuthorized(address,address)', BORROWER, router))[0].equals(word(true)));

  await call({ to: usdg, data: encode('mint(address,uint256)', BORROWER, 100_000n * USDG_UNIT) });
  await call({ from: BORROWER, to: usdg, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });
  await call({ to: stock, data: encode('mint(address,uint256)', BORROWER, 200n * STOCK_UNIT) }); // "bought back on a DEX" buffer
  await call({ from: BORROWER, to: stock, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });

  const collateral1 = 10_000n * USDG_UNIT;
  const borrow1 = 30n * STOCK_UNIT;
  let marketBefore = await morphoMarket(id1);
  r = await call({ from: BORROWER, to: router, data: encode(`openShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), collateral1, borrow1, RECEIVER) });
  check('BORROWER opens a short via the router', !r.reverted, r.error);
  const expectedBorrowShares1 = toSharesUp(borrow1, marketBefore.totalBorrowAssets, marketBefore.totalBorrowShares);
  let pos = await morphoPosition(id1, BORROWER);
  check('collateral posted on Morpho matches exactly', pos.collateral === collateral1);
  check('borrow shares match the hand computation', pos.borrowShares === expectedBorrowShares1, `${pos.borrowShares} vs ${expectedBorrowShares1}`);
  check('RECEIVER got the borrowed stock', (await bal(stock, RECEIVER)) === borrow1);
  const shortOpenedTopic = bytesToHex(keccak256(Buffer.from('ShortOpened(address,bytes32,uint256,uint256,address)')));
  const openedLog = r.logs.find((l) => l.topics[0] === shortOpenedTopic);
  check(
    'ShortOpened event decodes correctly',
    !!openedLog &&
      '0x' + strip(openedLog.topics[1]).slice(24) === BORROWER &&
      openedLog.topics[2] === id1 &&
      toBig(words(openedLog.data)[0]) === collateral1 &&
      toBig(words(openedLog.data)[1]) === borrow1 &&
      toAddr(words(openedLog.data)[2]) === RECEIVER
  );
  await routerEmpty('after openShort');
  await vaultInvariant('after openShort');

  // positionOf hand computation.
  let pv = await view(router, `positionOf(${MP_T},address)`, mpTuple(mp1), BORROWER);
  const [pvCollateral, pvBorrow, pvMaxBorrow, pvHf, pvLiqPrice] = pv.map(toBig);
  const expectedMaxBorrow1 = maxBorrowCalc(collateral1, ORACLE_PRICE, LLTV);
  const expectedHf1 = (expectedMaxBorrow1 * WAD) / borrow1;
  const expectedLiqPrice1 = liquidationPriceCalc(collateral1, LLTV, borrow1);
  check('positionOf: collateral matches', pvCollateral === collateral1);
  // First borrow ever in a virgin market: toSharesUp(borrow1,0,0) then toAssetsUp of that many shares against
  // the resulting totals round-trips exactly, so positionOf's borrowAssets should equal borrow1 exactly.
  check('positionOf: borrowAssets matches hand computation', pvBorrow === toAssetsUp(expectedBorrowShares1, borrow1, expectedBorrowShares1), `${pvBorrow} vs ${toAssetsUp(expectedBorrowShares1, borrow1, expectedBorrowShares1)}`);
  check('positionOf: borrowAssets == borrow1 exactly (virgin market round-trips exactly)', pvBorrow === borrow1, `${pvBorrow} vs ${borrow1}`);
  check('positionOf: maxBorrow matches hand computation', pvMaxBorrow === expectedMaxBorrow1, `${pvMaxBorrow} vs ${expectedMaxBorrow1}`);
  check('positionOf: healthFactorWad matches hand computation', pvHf === expectedHf1, `${pvHf} vs ${expectedHf1}`);
  check('positionOf: healthFactor > 1e18 (healthy)', pvHf > WAD);
  check('positionOf: liquidationPrice matches hand computation (~256.67 USDG/stock)', pvLiqPrice === expectedLiqPrice1, `${pvLiqPrice} vs ${expectedLiqPrice1}`);
  console.log(`       maxBorrow=${pvMaxBorrow} (~${Number(pvMaxBorrow) / 1e18} stock), hf=${(Number(pvHf) / 1e18).toFixed(3)}, liquidationPrice=${(Number(pvLiqPrice) / 1e18).toFixed(2)} USDG/stock`);
  const q1 = await viewBig(router, `quote(${MP_T})`, mpTuple(mp1));
  check('quote() passes through the oracle price', q1 === ORACLE_PRICE);

  // positionOf with no borrow at all.
  pv = await view(router, `positionOf(${MP_T},address)`, mpTuple(mp1), STRANGER);
  check('positionOf with no borrow: healthFactorWad == max uint256', toBig(pv[3]) === (1n << 256n) - 1n);
  check('positionOf with no borrow: liquidationPrice == 0', toBig(pv[4]) === 0n);

  // Over-leveraged borrow reverts INSUFFICIENT_COLLATERAL (Morpho's own health check).
  await call({ to: usdg, data: encode('mint(address,uint256)', BORROWER2, 5_000n * USDG_UNIT) });
  await call({ from: BORROWER2, to: usdg, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });
  await call({ from: BORROWER2, to: morpho, data: encode('setAuthorization(address,bool)', router, true) });
  r = await call({ from: BORROWER2, to: router, data: encode(`openShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), 100n * USDG_UNIT, 10n * STOCK_UNIT, BORROWER2) });
  check('over-leveraged openShort reverts (Morpho "insufficient collateral")', r.reverted && decodeStringRevert(r.ret) === 'insufficient collateral', decodeStringRevert(r.ret));
  await routerEmpty('after failed over-leverage attempt');

  // addCollateral
  r = await call({ from: BORROWER, to: router, data: encode(`addCollateral(${MP_T},uint256)`, mpTuple(mp1), 1_000n * USDG_UNIT) });
  check('addCollateral succeeds', !r.reverted, r.error);
  pos = await morphoPosition(id1, BORROWER);
  check('collateral increased by exactly the added amount', pos.collateral === collateral1 + 1_000n * USDG_UNIT);
  await routerEmpty('after addCollateral');

  // repay by assets
  marketBefore = await morphoMarket(id1);
  const repayAssets = 10n * STOCK_UNIT;
  const expectedRepaySharesA = toSharesDown(repayAssets, marketBefore.totalBorrowAssets, marketBefore.totalBorrowShares);
  const borrowerStockBefore = await bal(stock, BORROWER);
  const posBeforeRepayA = await morphoPosition(id1, BORROWER);
  r = await call({ from: BORROWER, to: router, data: encode(`repay(${MP_T},uint256,uint256)`, mpTuple(mp1), repayAssets, 0n) });
  check('repay by assets succeeds', !r.reverted, r.error);
  check('router pulled exactly repayAssets from BORROWER', (await bal(stock, BORROWER)) === borrowerStockBefore - repayAssets);
  pos = await morphoPosition(id1, BORROWER);
  check('borrowShares decreased by the hand-computed share amount', pos.borrowShares === posBeforeRepayA.borrowShares - expectedRepaySharesA, `${pos.borrowShares}`);
  await routerEmpty('after repay by assets');

  // repay by shares
  marketBefore = await morphoMarket(id1);
  const posBeforeRepayB = pos;
  const halfShares = posBeforeRepayB.borrowShares / 2n;
  const expectedPullB = toAssetsUp(halfShares, marketBefore.totalBorrowAssets, marketBefore.totalBorrowShares);
  const borrowerStockBefore2 = await bal(stock, BORROWER);
  r = await call({ from: BORROWER, to: router, data: encode(`repay(${MP_T},uint256,uint256)`, mpTuple(mp1), 0n, halfShares) });
  check('repay by shares succeeds', !r.reverted, r.error);
  check('router pulled exactly toAssetsUp(shares) from BORROWER', (await bal(stock, BORROWER)) === borrowerStockBefore2 - expectedPullB, `pulled ${borrowerStockBefore2 - (await bal(stock, BORROWER))} vs ${expectedPullB}`);
  pos = await morphoPosition(id1, BORROWER);
  check('borrowShares decreased by exactly halfShares', pos.borrowShares === posBeforeRepayB.borrowShares - halfShares, `${pos.borrowShares} vs ${posBeforeRepayB.borrowShares - halfShares}`);
  await routerEmpty('after repay by shares');

  // closeShort: full close for BORROWER.
  const borrowerUsdgBefore = await bal(usdg, BORROWER);
  const posBeforeClose = await morphoPosition(id1, BORROWER);
  r = await call({ from: BORROWER, to: router, data: encode(`closeShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), 0n, 0n, BORROWER) });
  check('BORROWER closes the short fully', !r.reverted, r.error);
  pos = await morphoPosition(id1, BORROWER);
  check('borrowShares == 0 after full close', pos.borrowShares === 0n);
  check('collateral == 0 after full close', pos.collateral === 0n);
  check('BORROWER received all remaining collateral', (await bal(usdg, BORROWER)) === borrowerUsdgBefore + posBeforeClose.collateral);
  const shortClosedTopic = bytesToHex(keccak256(Buffer.from('ShortClosed(address,bytes32,uint256,uint256)')));
  const closedLog = r.logs.find((l) => l.topics[0] === shortClosedTopic);
  check('ShortClosed event decodes with the collateral returned', !!closedLog && toBig(words(closedLog.data)[1]) === posBeforeClose.collateral);
  await routerEmpty('after full closeShort');
  await vaultInvariant('after full closeShort');

  // closeShort: partial close for BORROWER2 (real, conservative position this time).
  const collateral2 = 2_000n * USDG_UNIT;
  const borrow2 = 5n * STOCK_UNIT; // maxBorrow = 2000/200*0.77 = 7.7 stock > 5, healthy
  r = await call({ from: BORROWER2, to: router, data: encode(`openShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), collateral2, borrow2, BORROWER2) });
  check('BORROWER2 opens a conservative short', !r.reverted, r.error);
  await call({ to: stock, data: encode('mint(address,uint256)', BORROWER2, 3n * STOCK_UNIT) });
  await call({ from: BORROWER2, to: stock, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });

  const posB2Before = await morphoPosition(id1, BORROWER2);
  const partialRepayShares = posB2Before.borrowShares / 2n;
  const partialWithdrawCollateral = 500n * USDG_UNIT;
  marketBefore = await morphoMarket(id1);
  const expectedPartialPull = toAssetsUp(partialRepayShares, marketBefore.totalBorrowAssets, marketBefore.totalBorrowShares);
  const b2StockBefore = await bal(stock, BORROWER2);
  const b2UsdgBefore = await bal(usdg, BORROWER2);
  r = await call({ from: BORROWER2, to: router, data: encode(`closeShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), partialRepayShares, partialWithdrawCollateral, BORROWER2) });
  check('BORROWER2 partially closes the short', !r.reverted, r.error);
  check('router pulled exactly the hand-computed repay amount', (await bal(stock, BORROWER2)) === b2StockBefore - expectedPartialPull);
  check('BORROWER2 received exactly the requested collateral', (await bal(usdg, BORROWER2)) === b2UsdgBefore + partialWithdrawCollateral);
  pos = await morphoPosition(id1, BORROWER2);
  check('BORROWER2 borrowShares reduced by exactly partialRepayShares', pos.borrowShares === posB2Before.borrowShares - partialRepayShares);
  check('BORROWER2 collateral reduced by exactly the withdrawn amount', pos.collateral === posB2Before.collateral - partialWithdrawCollateral);
  pv = await view(router, `positionOf(${MP_T},address)`, mpTuple(mp1), BORROWER2);
  check('BORROWER2 position remains healthy after the partial close', toBig(pv[3]) > WAD);
  await routerEmpty('after partial closeShort');
  await vaultInvariant('after partial closeShort');

  // TransferFailed(): a token whose transfer/transferFrom returns false.
  const failToken = await deploy(ART.MockERC20, ['string', 'string', 'uint8'], ['Fail', 'FAIL', 6]);
  await call({ to: failToken, data: encode('mint(address,uint256)', FAIL_USER, 1_000n * USDG_UNIT) });
  await call({ from: FAIL_USER, to: failToken, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });
  await call({ to: failToken, data: encode('setFailTransfers(bool)', true) });
  const mpFailing = { loanToken: stock, collateralToken: failToken, oracle: oracle1, irm: irm1, lltv: LLTV };
  r = await call({ from: FAIL_USER, to: router, data: encode(`openShort(${MP_T},uint256,uint256,address)`, mpTuple(mpFailing), 100n * USDG_UNIT, 1n * STOCK_UNIT, FAIL_USER) });
  check('openShort with a failing collateral token reverts TransferFailed()', r.reverted && errorIs(r.ret, 'TransferFailed()'));
  r = await call({ from: FAIL_USER, to: router, data: encode(`addCollateral(${MP_T},uint256)`, mpTuple(mpFailing), 50n * USDG_UNIT) });
  check('addCollateral with a failing token reverts TransferFailed()', r.reverted && errorIs(r.ret, 'TransferFailed()'));
  await routerEmpty('after TransferFailed attempts');

  // ===========================================================================================
  section('4. Interest accrual and the vault performance fee');
  // ===========================================================================================

  const RATE_PER_SEC = 3_170_979n; // arbitrary WAD-scaled borrow rate per second
  await call({ to: irm1, data: encode('setRate(uint256)', RATE_PER_SEC) });

  let marketBeforeAccrue = await morphoMarket(id1);
  const vaultSupplySharesBeforeAccrue = (await morphoPosition(id1, vault)).supplyShares;
  let lastTotalAssetsBefore = await viewBig(vault, 'lastTotalAssets()');
  let totalSupplyBeforeAccrue = await viewBig(vault, 'totalSupply()');
  let idleBeforeAccrue = await viewBig(vault, 'idle()');
  const feeRecipientSharesBefore = await bal(vault, FEE_RECIPIENT);

  const ELAPSED = 30n * 86_400n;
  advance(ELAPSED);
  r = await call({ from: STRANGER, to: vault, data: encode('accrue()') });
  check('accrue() is permissionless (called by a stranger)', !r.reverted, r.error);

  const compounded = wTaylorCompounded(RATE_PER_SEC, ELAPSED);
  const interest = mulDivDown(marketBeforeAccrue.totalBorrowAssets, compounded, WAD);
  const newTotalSupplyAssets = marketBeforeAccrue.totalSupplyAssets + interest; // Morpho market fee == 0
  const expectedSuppliedId1 = toAssetsDown(vaultSupplySharesBeforeAccrue, newTotalSupplyAssets, marketBeforeAccrue.totalSupplyShares);
  const expectedNewTotal = idleBeforeAccrue + expectedSuppliedId1;
  const expectedYield = expectedNewTotal - lastTotalAssetsBefore;
  const expectedFeeAssets = (expectedYield * FEE_BPS) / 10000n;
  const expectedFeeShares = (expectedFeeAssets * (totalSupplyBeforeAccrue + VAULT_OFFSET_SHARES)) / (expectedNewTotal - expectedFeeAssets + VAULT_OFFSET_ASSETS);

  check('interest accrued is positive', interest > 0n, interest);
  check('vault totalAssets() grew to the hand-computed value', (await viewBig(vault, 'totalAssets()')) === expectedNewTotal, `${await viewBig(vault, 'totalAssets()')} vs ${expectedNewTotal}`);
  check('vault lastTotalAssets() updated to the new total', (await viewBig(vault, 'lastTotalAssets()')) === expectedNewTotal);
  const feeRecipientSharesAfter = await bal(vault, FEE_RECIPIENT);
  const actualFeeShares = feeRecipientSharesAfter - feeRecipientSharesBefore;
  check('fee shares minted match the hand computation exactly', actualFeeShares === expectedFeeShares, `${actualFeeShares} vs ${expectedFeeShares}`);
  const feeAccruedTopic = bytesToHex(keccak256(Buffer.from('FeeAccrued(uint256,uint256)')));
  const feeLog = r.logs.find((l) => l.topics[0] === feeAccruedTopic);
  check(
    'FeeAccrued event decodes to (feeAssets, feeShares)',
    !!feeLog && toBig(words(feeLog.data)[0]) === expectedFeeAssets && toBig(words(feeLog.data)[1]) === expectedFeeShares
  );
  const feeSharesAsAssets = await viewBig(vault, 'convertToAssets(uint256)', actualFeeShares);
  const diff = feeSharesAsAssets > expectedFeeAssets ? feeSharesAsAssets - expectedFeeAssets : expectedFeeAssets - feeSharesAsAssets;
  check('fee shares are worth yield*fee/10000 within 1 wei', diff <= 1n, `${feeSharesAsAssets} vs ${expectedFeeAssets}`);

  r = await call({ to: vault, data: encode('setFee(uint96,address)', 5001n, FEE_RECIPIENT) });
  check('setFee beyond 5000 bps reverts FeeTooHigh()', r.reverted && errorIs(r.ret, 'FeeTooHigh()'));
  r = await call({ from: STRANGER, to: vault, data: encode('setFee(uint96,address)', 500n, STRANGER) });
  check('setFee from a stranger reverts NotOwner()', r.reverted && errorIs(r.ret, 'NotOwner()'));

  // Fee recipient change accrues first (at the OLD fee rate/recipient) before switching.
  marketBeforeAccrue = await morphoMarket(id1);
  const vaultSupplySharesBefore2 = (await morphoPosition(id1, vault)).supplyShares;
  lastTotalAssetsBefore = await viewBig(vault, 'lastTotalAssets()');
  totalSupplyBeforeAccrue = await viewBig(vault, 'totalSupply()');
  idleBeforeAccrue = await viewBig(vault, 'idle()');
  const oldFeeRecipientBefore = await bal(vault, FEE_RECIPIENT);

  advance(86_400n);
  r = await call({ to: vault, data: encode('setFee(uint96,address)', 2000n, FEE_RECIPIENT2) });
  check('owner changes the fee to 20% and a new recipient', !r.reverted, r.error);

  const compounded2 = wTaylorCompounded(RATE_PER_SEC, 86_400n);
  const interest2 = mulDivDown(marketBeforeAccrue.totalBorrowAssets, compounded2, WAD);
  const newTotalSupplyAssets2 = marketBeforeAccrue.totalSupplyAssets + interest2;
  const expectedSuppliedId1b = toAssetsDown(vaultSupplySharesBefore2, newTotalSupplyAssets2, marketBeforeAccrue.totalSupplyShares);
  const expectedNewTotal2 = idleBeforeAccrue + expectedSuppliedId1b;
  const expectedYield2 = expectedNewTotal2 - lastTotalAssetsBefore;
  const expectedFeeAssets2 = (expectedYield2 * FEE_BPS) / 10000n; // still the OLD 10% bps at accrual time
  const expectedFeeShares2 = (expectedFeeAssets2 * (totalSupplyBeforeAccrue + VAULT_OFFSET_SHARES)) / (expectedNewTotal2 - expectedFeeAssets2 + VAULT_OFFSET_ASSETS);

  check('the OLD fee recipient received the pre-switch accrual', (await bal(vault, FEE_RECIPIENT)) === oldFeeRecipientBefore + expectedFeeShares2, `${await bal(vault, FEE_RECIPIENT)} vs ${oldFeeRecipientBefore + expectedFeeShares2}`);
  check('feeRecipient() is now FEE_RECIPIENT2', toAddr((await view(vault, 'feeRecipient()'))[0]) === FEE_RECIPIENT2);
  check('feeBps() is now 2000', (await viewBig(vault, 'feeBps()')) === 2000n);

  await vaultInvariant('end of section 4');

  // ===========================================================================================
  section('5. Liquidity under 100% utilisation, and recovery after repayment');
  // ===========================================================================================

  let marketNow = await morphoMarket(id1);
  const availableNow = marketNow.totalSupplyAssets - marketNow.totalBorrowAssets;
  check('there is spare liquidity to borrow out before maxing utilisation', availableNow > 0n, availableNow);

  const minCollateralExact = (availableNow * 10n ** 36n * WAD) / (ORACLE_PRICE * LLTV);
  const neededCollateral = (minCollateralExact * 110n) / 100n + USDG_UNIT; // generous buffer, over-collateralize
  await call({ to: usdg, data: encode('mint(address,uint256)', BORROWER3, neededCollateral) });
  await call({ from: BORROWER3, to: usdg, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });
  await call({ from: BORROWER3, to: morpho, data: encode('setAuthorization(address,bool)', router, true) });
  r = await call({ from: BORROWER3, to: router, data: encode(`openShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), neededCollateral, availableNow, RECEIVER2) });
  check('BORROWER3 borrows exactly the remaining spare liquidity', !r.reverted, r.error);

  marketNow = await morphoMarket(id1);
  check('market1 utilisation is now 100%', marketNow.totalBorrowAssets === marketNow.totalSupplyAssets, `${marketNow.totalBorrowAssets} vs ${marketNow.totalSupplyAssets}`);

  const idleAt100 = await viewBig(vault, 'idle()');
  const liquidityAt100 = await viewBig(vault, 'liquidity()');
  check('liquidity() == idle() when the only market is 100% utilised', liquidityAt100 === idleAt100, `${liquidityAt100} vs ${idleAt100}`);

  const lender1SharesNow = await bal(vault, LENDER1);
  const lender1AssetsNow = await viewBig(vault, 'convertToAssets(uint256)', lender1SharesNow);
  const withdrawAttempt = idleAt100 + 5_000n * STOCK_UNIT;
  check('LENDER1 owns enough shares for the liquidity-limited withdrawal to be the binding constraint', lender1AssetsNow >= withdrawAttempt, `${lender1AssetsNow} vs ${withdrawAttempt}`);
  check('maxWithdraw(LENDER1) reports only idle (market fully utilised)', (await viewBig(vault, 'maxWithdraw(address)', LENDER1)) === idleAt100);
  r = await call({ from: LENDER1, to: vault, data: encode('withdraw(uint256,address,address)', withdrawAttempt, LENDER1, LENDER1) });
  check('withdraw() beyond liquidity() reverts InsufficientLiquidity()', r.reverted && errorIs(r.ret, 'InsufficientLiquidity()'));

  // Borrower repays in full, freeing liquidity back up.
  await call({ to: stock, data: encode('mint(address,uint256)', BORROWER3, availableNow + 10n * STOCK_UNIT) });
  await call({ from: BORROWER3, to: stock, data: encode('approve(address,uint256)', router, (1n << 256n) - 1n) });
  r = await call({ from: BORROWER3, to: router, data: encode(`closeShort(${MP_T},uint256,uint256,address)`, mpTuple(mp1), 0n, 0n, BORROWER3) });
  check('BORROWER3 repays in full and reclaims collateral', !r.reverted, r.error);
  await routerEmpty('after BORROWER3 full repayment');

  marketNow = await morphoMarket(id1);
  const liquidityAfterRepay = await viewBig(vault, 'liquidity()');
  const idleAfterRepay = await viewBig(vault, 'idle()');
  const expectedAvailAfterRepay = marketNow.totalSupplyAssets > marketNow.totalBorrowAssets ? marketNow.totalSupplyAssets - marketNow.totalBorrowAssets : 0n;
  const suppliedId1AfterRepay = await viewBig(vault, 'supplied(bytes32)', id1);
  const expectedLiquidityAfterRepay = idleAfterRepay + (suppliedId1AfterRepay < expectedAvailAfterRepay ? suppliedId1AfterRepay : expectedAvailAfterRepay);
  check('liquidity() == idle + available after repayment (hand computation)', liquidityAfterRepay === expectedLiquidityAfterRepay, `${liquidityAfterRepay} vs ${expectedLiquidityAfterRepay}`);
  check('liquidity() is now well above the earlier failed withdrawal amount', liquidityAfterRepay >= withdrawAttempt, `${liquidityAfterRepay} vs ${withdrawAttempt}`);

  const l1StockBefore = await bal(stock, LENDER1);
  r = await call({ from: LENDER1, to: vault, data: encode('withdraw(uint256,address,address)', withdrawAttempt, LENDER1, LENDER1) });
  check('the same withdrawal now succeeds once liquidity is restored', !r.reverted, r.error);
  check('LENDER1 received exactly the withdrawn assets', (await bal(stock, LENDER1)) === l1StockBefore + withdrawAttempt);

  await vaultInvariant('end of section 5');

  // ===========================================================================================
  section('6. Final invariants');
  // ===========================================================================================
  await routerEmpty('final');
  await vaultInvariant('final');
  const finalIdle = await viewBig(vault, 'idle()');
  const finalSuppliedId1 = await viewBig(vault, 'supplied(bytes32)', id1);
  const finalTotal = await viewBig(vault, 'totalAssets()');
  check('final totalAssets == idle + supplied(id1) (only remaining market)', finalTotal === finalIdle + finalSuppliedId1, `${finalTotal} vs ${finalIdle}+${finalSuppliedId1}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
