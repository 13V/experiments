#!/usr/bin/env node
'use strict';

/**
 * Manna — shared config/compile plumbing for the operational scripts (create-markets, deploy,
 * launch, dawn, status, sunday, abicheck). This is the only shared module manna/scripts is allowed
 * to add, so it also carries the small bits those six scripts would otherwise each duplicate:
 * ABI-driven constructor/call argument building (mirroring locate/scripts/deploy.js exactly),
 * an encode/decode round-trip self-test, the Prophet's USD<->Giant conversion (see the oracle
 * convention in MemeTwapOracle.sol's NatSpec), and a few presentation helpers status.js/sunday.js/
 * dawn.js all need.
 *
 * Requires locate/scripts/chain.js for RPC/ABI/signing; reads RPC_URL/PRIVATE_KEY/CHAIN_ID from the
 * environment and `--dry-run` from argv exactly as chain.js does (see its header).
 */

const fs = require('fs');
const path = require('path');
const solc = require('solc');
const chain = require('../../locate/scripts/chain');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const ADDRESSES_PATH = path.join(CONFIG_DIR, 'addresses.json');
const MARKETS_PATH = path.join(CONFIG_DIR, 'markets.json');
const MANNA_CONTRACTS_DIR = path.join(__dirname, '..', 'contracts');
const LOCATE_CONTRACTS_DIR = path.join(REPO_ROOT, 'locate', 'contracts');
const ALL_CONTRACT_DIRS = [MANNA_CONTRACTS_DIR, LOCATE_CONTRACTS_DIR];

const jsonBig = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

// ---------------------------------------------------------------------------
// Config load/save — manna's OWN addresses.json/markets.json, never locate's (chain.ADDRESSES_PATH
// and chain.MARKETS_PATH point at locate/config/*.json; every manna script must go through these
// instead). saveJson (from chain.js) preserves key order and writes no trailing newline.
// ---------------------------------------------------------------------------

function load() {
  return { addresses: chain.loadJson(ADDRESSES_PATH), markets: chain.loadJson(MARKETS_PATH) };
}

function save(addresses, markets) {
  chain.saveJson(ADDRESSES_PATH, addresses);
  chain.saveJson(MARKETS_PATH, markets);
}

// ---------------------------------------------------------------------------
// Calendar — mirrors Manna.sol's today()/isSunday() bit for bit: DAY = 86400 seconds; day 0
// (1 Jan 1970) was a Thursday, so a day index is a Sunday when (day + 4) % 7 == 0.
// ---------------------------------------------------------------------------

const DAY = 86400;

function dayIndex(ts) {
  return Math.floor(Number(ts) / DAY);
}

function isSundayDay(day) {
  return (Number(day) + 4) % 7 === 0;
}

/** True right now, in UTC (a unix timestamp has no timezone ambiguity, so "now" IS UTC "now"). */
function isSundayUtc(ts = Date.now() / 1000) {
  return isSundayDay(dayIndex(ts));
}

// ---------------------------------------------------------------------------
// Compile — manna/contracts + locate/contracts in one solc run. Source keys are REPO-RELATIVE
// (e.g. "manna/contracts/Manna.sol", "locate/contracts/interfaces/IMorpho.sol") rather than
// relative to each dir: Solidity resolves "./" and "../" imports against the importing file's own
// source-unit key, so repo-relative keys let both trees keep their real nested layout (avoiding a
// name collision between manna/contracts/interfaces/IMorpho.sol and locate's own copy) while every
// existing relative import inside each .sol file still resolves exactly as it does on disk.
//
// Any compiler error OR warning aborts the run — nothing here is tolerated, matching
// locate/scripts/deploy.js's own compile() exactly.
// ---------------------------------------------------------------------------

function listSolFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.sol')) out.push(p);
    }
  })(dir);
  return out;
}

function compileContracts(dirs) {
  const sources = {};
  for (const dir of dirs) {
    for (const f of listSolFiles(dir)) {
      const key = path.relative(REPO_ROOT, f).split(path.sep).join('/');
      sources[key] = { content: fs.readFileSync(f, 'utf8') };
    }
  }
  if (!Object.keys(sources).length) throw new Error(`no .sol files found under ${dirs.join(', ')}`);

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  function findImports(importPath) {
    try {
      return { contents: fs.readFileSync(path.join(REPO_ROOT, importPath), 'utf8') };
    } catch (e) {
      return { error: `file not found: ${importPath}` };
    }
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const problems = (output.errors || []).filter((e) => e.severity === 'error' || e.severity === 'warning');
  if (problems.length) {
    for (const p of problems) console.error(p.formattedMessage || p.message);
    throw new Error(`solc reported ${problems.length} error(s)/warning(s) across ${dirs.join(', ')} — none are tolerated`);
  }
  if (!output.contracts) throw new Error(`solc produced no contract output for ${dirs.join(', ')}`);

  // {Name: {abi, bytecode}} — flat by contract/interface name (matches locate/scripts/deploy.js's
  // own collation). manna/contracts and locate/contracts each declare their own copy of a couple of
  // shared interfaces (IMorpho, IOracle) with identical ABIs, so whichever is processed last simply
  // wins that name; neither is ever deployed, so it never matters which copy answers a lookup.
  const contracts = {};
  for (const file of Object.keys(output.contracts)) {
    for (const name of Object.keys(output.contracts[file])) {
      const c = output.contracts[file][name];
      contracts[name] = { file, name, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
    }
  }
  return contracts;
}

// ---------------------------------------------------------------------------
// ABI-driven signatures and argument building — identical to locate/scripts/deploy.js's own
// helpers, reused here because create-markets.js (MemeTwapOracle), deploy.js (LocateRouter, Manna,
// UniswapV3Swapper, LocateVault, LocateVault.setMarket) and launch.js (PonsCurveSwapper,
// UniswapV4Swapper) all need the exact same "read the signature from the compiled ABI, take named
// values with a positional fallback" pattern. A parameter is looked up by its ABI name first so a
// harmless rename or reorder in the Solidity never desyncs these scripts; the positional array is
// the fallback (and, for a tuple argument, the actual source — see valueForInput below, which
// mirrors deploy.js's exactly).
// ---------------------------------------------------------------------------

function typeOfAbiInput(input) {
  if (input.type === 'tuple' || input.type.startsWith('tuple[')) {
    const suffix = input.type.slice('tuple'.length);
    return `(${input.components.map(typeOfAbiInput).join(',')})${suffix}`;
  }
  return input.type;
}

function valueForInput(input, namedValues, positional) {
  if (input.type === 'tuple' || input.type.startsWith('tuple[')) {
    const arr = Array.isArray(positional) ? positional : [];
    return input.components.map((c, i) => valueForInput(c, namedValues, arr[i]));
  }
  if (input.name && Object.prototype.hasOwnProperty.call(namedValues, input.name)) return namedValues[input.name];
  if (positional !== undefined) return positional;
  throw new Error(`no value for ABI parameter "${input.name || '(unnamed)'}" of type ${input.type}`);
}

function buildArgs(inputs, namedValues, positionalFallback = []) {
  return inputs.map((input, i) => valueForInput(input, namedValues, positionalFallback[i]));
}

function sigOf(name, inputs) {
  return `${name}(${inputs.map(typeOfAbiInput).join(',')})`;
}

function ctorInputs(abi) {
  const c = abi.find((x) => x.type === 'constructor');
  return c ? c.inputs : [];
}

function findFn(abi, name) {
  const fn = abi.find((x) => x.type === 'function' && x.name === name);
  if (!fn) throw new Error(`ABI has no function named "${name}"`);
  return fn;
}

/** Deploys `art` ({abi, bytecode}), printing the constructor call and self-testing the encoding
 * before sending. Dry-run safe: chain.send() prints and returns a fake receipt without signing. */
async function deployContract(label, art, namedValues, positionalFallback) {
  const inputs = ctorInputs(art.abi);
  const types = inputs.map(typeOfAbiInput);
  const args = buildArgs(inputs, namedValues, positionalFallback);
  const encodedArgs = types.length ? chain.abiEncode(types, args).slice(2) : '';
  const data = art.bytecode + encodedArgs;

  console.log(`  ${label} constructor(${types.join(', ')})`);
  console.log(`  ${label} args: ${JSON.stringify(args, jsonBig)}`);
  if (types.length) {
    const { ok, decoded } = selfTestEncode(types, args);
    console.log(`  ${label} self-test decode(encode(args)): ${ok ? 'OK' : 'MISMATCH'} ${JSON.stringify(decoded, jsonBig)}`);
    if (!ok) throw new Error(`${label}: abiDecode(abiEncode(x)) != x — encoder bug`);
  }
  console.log(
    `  ${label} deploy data: ${(data.length - 2) / 2} bytes  (bytecode ${(art.bytecode.length - 2) / 2} + args ${encodedArgs.length / 2})`
  );

  const receipt = await chain.send({ to: null, data });
  const address = receipt.dryRun ? null : receipt.contractAddress;
  console.log(`  ${label} -> ${address || '(address known only once actually sent)'}`);
  return address;
}

// ---------------------------------------------------------------------------
// Self-test: does decode(encode(x)) round-trip? Compared byte-for-byte via re-encoding the decoded
// value rather than structurally comparing decoded-vs-original, which sidesteps representational
// wrinkles that are not actually bugs (abiDecode always checksums addresses and lowercases bytesN,
// even when the original argument was not given that way) while still catching a genuine encoder
// or nesting mistake, which will NOT re-encode to the same bytes.
// ---------------------------------------------------------------------------

function selfTestEncode(types, args) {
  const data = chain.abiEncode(types, args);
  const decoded = chain.abiDecode(types, data);
  const reEncoded = chain.abiEncode(types, decoded);
  const ok = reEncoded.toLowerCase() === data.toLowerCase();
  return { ok, decoded, data };
}

/** selfTestEncode, printed and thrown on failure — the shared shape every hardcoded-signature call
 * uses right before chain.send(), so a hand-rolled encoding bug is caught before anything is sent. */
function selfTestAndLog(label, types, args) {
  const { ok, decoded } = selfTestEncode(types, args);
  console.log(`  ${label} self-test decode(encode(args)): ${ok ? 'OK' : 'MISMATCH'} ${JSON.stringify(decoded, jsonBig)}`);
  if (!ok) throw new Error(`${label}: abiDecode(abiEncode(x)) != x — encoder bug`);
}

// ---------------------------------------------------------------------------
// The Prophet's USD<->Giant conversion (MemeTwapOracle.price() / Morpho's oracle convention):
// price() is raw Giant units per raw USDG unit, scaled by 1e36. See MemeTwapOracle.sol's NatSpec
// and manna/site/lib.js's giantToUsdRaw/usdToGiantRaw, which this mirrors exactly.
// ---------------------------------------------------------------------------

const ORACLE_SCALE = 10n ** 36n;

/** A whole-dollar USD cap -> raw Giant token units at the oracle's current price. */
function usdToGiantRaw(capUsd, price, usdgDecimals) {
  const usdRaw = chain.toUnits(capUsd, usdgDecimals);
  return (usdRaw * BigInt(price)) / ORACLE_SCALE;
}

/** Raw Giant token units -> raw USDG (6dp) at the oracle's current price. */
function giantToUsdRaw(giantRaw, price) {
  return (BigInt(giantRaw) * ORACLE_SCALE) / BigInt(price);
}

// ---------------------------------------------------------------------------
// Small presentation helpers shared by status.js, sunday.js and dawn.js (mirrors
// locate/scripts/status.js's own private truncate/fmtUnits/fmtPct).
// ---------------------------------------------------------------------------

function truncateDecimal(decimalStr, places) {
  const neg = decimalStr.startsWith('-');
  const s = neg ? decimalStr.slice(1) : decimalStr;
  const [i, f = ''] = s.split('.');
  const out = places === 0 ? i : `${i}.${(f + '0'.repeat(places)).slice(0, places)}`;
  return neg ? `-${out}` : out;
}

function fmtUnits(units, decimals, places = 4) {
  return truncateDecimal(chain.fromUnits(units, decimals), places);
}

function fmtPct(fraction, places = 2) {
  if (!Number.isFinite(fraction)) return '-';
  return `${(fraction * 100).toFixed(places)}%`;
}

/** The first log on `address` matching event signature `sig`, or undefined. */
function findLog(receipt, address, sig) {
  const t0 = chain.topic(sig).toLowerCase();
  return (receipt.logs || []).find(
    (l) => chain.secp.sameAddress(l.address, address) && l.topics[0].toLowerCase() === t0
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A small, polite gap between chain calls in a loop — the public RPC 429s if hammered. */
const RPC_DELAY_MS = 200;

module.exports = {
  REPO_ROOT,
  CONFIG_DIR,
  ADDRESSES_PATH,
  MARKETS_PATH,
  MANNA_CONTRACTS_DIR,
  LOCATE_CONTRACTS_DIR,
  ALL_CONTRACT_DIRS,
  load,
  save,
  DAY,
  dayIndex,
  isSundayDay,
  isSundayUtc,
  compileContracts,
  typeOfAbiInput,
  valueForInput,
  buildArgs,
  sigOf,
  ctorInputs,
  findFn,
  deployContract,
  selfTestEncode,
  selfTestAndLog,
  ORACLE_SCALE,
  usdToGiantRaw,
  giantToUsdRaw,
  truncateDecimal,
  fmtUnits,
  fmtPct,
  findLog,
  sleep,
  RPC_DELAY_MS,
};
