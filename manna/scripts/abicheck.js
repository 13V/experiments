#!/usr/bin/env node
'use strict';

/**
 * Manna — abicheck.js
 *
 * Like locate/scripts/abicheck.js: compiles the contracts and asserts that every hand-rolled
 * signature string the six operational scripts (create-markets, deploy, launch, dawn, status,
 * sunday) send to `chain.call`/`chain.encodeCall`, and every event signature they hash with
 * `chain.topic` (via config.findLog), actually exists — so a contract change (ours, or a fee
 * escrow/hook/factory redeploy on the Pons side) cannot silently desync the scripts into sending
 * calldata that reverts on chain.
 *
 *   NODE_PATH=/home/user/experiments/node_modules node manna/scripts/abicheck.js
 *
 * `USED` below is the "one place": every signature the scripts use, hand-audited against their
 * source (constructors and LocateVault.setMarket are excluded on purpose — they are built straight
 * from the compiled ABI at runtime via config.js's deployContract/findFn/buildArgs, so there is no
 * hard-coded string for them to desync from). Where a call's target is always one specific contract
 * (e.g. `dawn()` is always sent to Manna), the check is scoped to that contract's own compiled ABI —
 * the strictest check available. Where the target varies by config entry (a Giant's pool, its
 * token, a Storehouse's vault) or is a genuinely external contract this repo does not compile
 * (Morpho Blue, the Adaptive Curve IRM), the check falls back to the union of every compiled
 * contract's ABI plus Pons's own verified ABI (config/pons-abi.json) and a small external allow-list.
 */

const chain = require('../../locate/scripts/chain');
const config = require('./config');

// Genuinely external functions with no local interface to check against: neither Manna nor
// LocateVault/LocateRouter call these, so they are absent from every compiled ABI on purpose (see
// IMorpho.sol's own NatSpec) — only the operational scripts hard-code them, exactly as
// locate/scripts/create-markets.js already does for Morpho's createMarket.
const EXTERNAL_FUNCTIONS = [
  `createMarket(${chain.MARKET_PARAMS_T})`,
  `borrowRateView(${chain.MARKET_PARAMS_T},${chain.MARKET_T})`,
];

// Every signature string the six operational scripts pass to chain.call / chain.encodeCall.
// `contract: null` means "target varies per config entry or is external" — checked against the
// union of everything known; otherwise checked against that one compiled contract's own ABI.
const USED_FUNCTIONS = [
  // create-markets.js — the Giant's WETH pool
  { contract: null, sig: 'token0()' },
  { contract: null, sig: 'token1()' },
  { contract: null, sig: 'slot0()' },
  { contract: null, sig: 'observe(uint32[])' },
  { contract: null, sig: 'decimals()' }, // called on many different ERC20/vault addresses
  // create-markets.js / status.js / sunday.js / deploy.js — the Prophet
  { contract: 'MemeTwapOracle', sig: 'price()' },
  { contract: 'MemeTwapOracle', sig: 'spot()' },
  // Morpho Blue
  { contract: 'IMorpho', sig: 'market(bytes32)' },
  { contract: null, sig: `createMarket(${chain.MARKET_PARAMS_T})` },
  // Adaptive Curve IRM
  { contract: null, sig: `borrowRateView(${chain.MARKET_PARAMS_T},${chain.MARKET_T})` },
  // LocateVault (a Storehouse)
  { contract: 'LocateVault', sig: 'liquidity()' },
  { contract: 'LocateVault', sig: 'convertToAssets(uint256)' },
  // Manna
  { contract: 'Manna', sig: 'feeShares(address)' },
  { contract: 'Manna', sig: 'nextDawn()' },
  { contract: 'Manna', sig: 'dawnOpen()' },
  { contract: 'Manna', sig: 'carry()' },
  { contract: 'Manna', sig: 'maxBuy()' },
  { contract: 'Manna', sig: 'buyer()' },
  { contract: 'Manna', sig: 'storehouseCount()' },
  { contract: 'Manna', sig: 'storehouseAt(uint256)' },
  { contract: 'Manna', sig: 'dawn()' },
  { contract: 'Manna', sig: 'treasury()' },
  { contract: 'Manna', sig: 'charity()' },
  { contract: 'Manna', sig: 'seller()' },
  { contract: 'Manna', sig: 'escrow()' },
  { contract: 'Manna', sig: 'setAddresses(address,address,address,address,address)' },
  { contract: 'Manna', sig: 'reserve()' },
  { contract: 'Manna', sig: 'reserveTarget()' },
  { contract: 'Manna', sig: 'charityAccrued()' },
  { contract: 'Manna', sig: 'stakedPool()' },
  { contract: 'Manna', sig: 'lenderPool()' },
  { contract: 'Manna', sig: 'nextJubileeDay()' },
  { contract: 'Manna', sig: 'lastDawnDay()' },
  { contract: 'Manna', sig: 'restoreCap(uint256)' },
  { contract: 'Manna', sig: 'addStorehouse(address,address)' },
  { contract: 'Manna', sig: 'token()' },
  { contract: 'Manna', sig: 'setToken(address)' },
  { contract: 'Manna', sig: 'periodFallen()' },
  { contract: 'Manna', sig: 'periodGathered()' },
  { contract: 'Manna', sig: 'periodSpoiled()' },
  // The buyer adapter — either PonsCurveSwapper or UniswapV4Swapper depending on graduation
  { contract: null, sig: 'maxSpend()' },
  // UniswapV3Swapper (the seller)
  { contract: 'UniswapV3Swapper', sig: 'setRoute(address,address)' },
  // UniswapV4Swapper
  { contract: 'UniswapV4Swapper', sig: 'keySet()' },
  { contract: 'UniswapV4Swapper', sig: 'setPoolKey(uint24,int24,address,uint16)' },
  // The Pons bonding curve (IPonsV2BondingCurve)
  { contract: 'IPonsV2BondingCurve', sig: 'graduated()' },
  { contract: 'IPonsV2BondingCurve', sig: 'getReserves()' },
  { contract: 'IPonsV2BondingCurve', sig: 'buy(uint256,uint256,address)' },
  // ERC20 (USDG, for the dev-buy approval)
  { contract: null, sig: 'approve(address,uint256)' },
  // Pons factory (verified ABI, config/pons-abi.json)
  { contract: 'pons.factory', sig: 'launchFee()' },
  { contract: 'pons.factory', sig: 'previewLaunchEconomics(uint256,address)' },
  {
    contract: 'pons.factory',
    sig:
      'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),' +
      'uint256,address,address[])',
  },
  { contract: 'pons.factory', sig: 'getLaunchedToken(address)' },
  // Pons fee escrow (verified ABI)
  { contract: 'pons.feeEscrow', sig: 'balanceOfToken(address,address)' },
  // Pons Meme hook (verified ABI)
  { contract: 'pons.memeHook', sig: 'launches(bytes32)' },
  { contract: 'pons.memeHook', sig: 'hookFeeBps()' },
];

// Every event signature the scripts hash with chain.topic (via config.findLog) to find a log.
const USED_EVENTS = [
  { contract: 'pons.factory', sig: 'TokenLaunched(address,address,address,address,uint256,uint256)' },
  { contract: 'Manna', sig: 'Dawn(uint256,address,uint256,uint256,uint256,uint256,uint256)' },
  { contract: 'Manna', sig: 'Fallen(uint256,uint256,uint256,uint256,uint256)' },
];

/** ABI input/output entry -> its canonical type string, recursing into tuples. */
function typeOf(entry) {
  if (entry.type === 'tuple' || entry.type.startsWith('tuple[')) {
    const suffix = entry.type.slice('tuple'.length);
    return `(${entry.components.map(typeOf).join(',')})${suffix}`;
  }
  return entry.type;
}

function sigOfAbiEntry(e) {
  return `${e.name}(${(e.inputs || []).map(typeOf).join(',')})`;
}

/** {name: {abi}} (from config.compileContracts) -> Map<name, {functions: Set, events: Set}>. */
function collectFromCompiled(contracts) {
  const byContract = new Map();
  for (const name of Object.keys(contracts)) {
    const functions = new Set();
    const events = new Set();
    for (const e of contracts[name].abi) {
      if (e.type === 'function') functions.add(sigOfAbiEntry(e));
      else if (e.type === 'event') events.add(sigOfAbiEntry(e));
    }
    byContract.set(name, { functions, events });
  }
  return byContract;
}

/** Pons's own verified ABI (config/pons-abi.json): one pseudo-contract per key we cross-check. */
function collectFromPonsAbi() {
  const ponsAbi = chain.loadJson(require('path').join(__dirname, '..', 'config', 'pons-abi.json'));
  const byContract = new Map();
  for (const key of ['factory', 'feeEscrow', 'memeHook']) {
    const functions = new Set();
    const events = new Set();
    for (const e of ponsAbi[key] || []) {
      if (e.type === 'function') functions.add(sigOfAbiEntry(e));
      else if (e.type === 'event') events.add(sigOfAbiEntry(e));
    }
    byContract.set(`pons.${key}`, { functions, events });
  }
  return byContract;
}

function unionOf(byContract, field) {
  const out = new Set();
  for (const { [field]: set } of byContract.values()) for (const s of set) out.add(s);
  return out;
}

function checkAll(label, used, byContract, union, field) {
  console.log(`${label}: ${used.length} usage(s)`);
  let pass = 0;
  let fail = 0;
  for (const { contract, sig } of used) {
    let ok;
    let where;
    if (contract) {
      const entry = byContract.get(contract);
      ok = !!entry && entry[field].has(sig);
      where = contract;
    } else {
      ok = union.has(sig);
      where = '(any known contract)';
    }
    if (ok) {
      pass++;
      console.log(`  ok   [${where}] ${sig}`);
    } else {
      fail++;
      console.log(`  FAIL [${where}] ${sig}  — not found`);
    }
  }
  return { pass, fail };
}

function main() {
  console.log('abicheck — compiling manna/contracts + locate/contracts\n');
  const contracts = config.compileContracts(config.ALL_CONTRACT_DIRS);
  console.log(`compiled ${Object.keys(contracts).length} contract(s): ${Object.keys(contracts).sort().join(', ')}\n`);

  const byContract = collectFromCompiled(contracts);
  for (const [name, { functions, events }] of collectFromPonsAbi()) byContract.set(name, { functions, events });

  const unionFunctions = unionOf(byContract, 'functions');
  for (const s of EXTERNAL_FUNCTIONS) unionFunctions.add(s);
  const unionEvents = unionOf(byContract, 'events');

  const f = checkAll('Functions', USED_FUNCTIONS, byContract, unionFunctions, 'functions');
  console.log('');
  const e = checkAll('Events', USED_EVENTS, byContract, unionEvents, 'events');

  const pass = f.pass + e.pass;
  const fail = f.fail + e.fail;
  console.log(`\n${pass} matched, ${fail} unmatched`);
  process.exit(fail ? 1 : 0);
}

main();
