#!/usr/bin/env node
'use strict';

/**
 * Locate — deploy.js
 *
 * Compiles locate/contracts/*.sol with solc 0.8.28 (optimizer 200 runs, evmVersion cancun;
 * any compiler warning or error aborts the run), deploys LocateRouter once, then one
 * LocateVault per market that already has a `marketId` (i.e. create-markets.js has run for
 * it), and calls setMarket with the USD cap converted to token units at the current feed
 * price. Addresses are recorded into config/addresses.json.
 *
 *   node locate/scripts/deploy.js [--dry-run] [--contracts <dir>]
 *
 * Constructor and function signatures are read from the compiled ABI, never hard-coded, so a
 * change to the Solidity doesn't silently desync this script — see valueForInput() below.
 * solc is the one npm dependency this script uses; run it with
 * NODE_PATH=/home/user/experiments/node_modules so `require('solc')` resolves.
 */

const fs = require('fs');
const path = require('path');
const solc = require('solc');
const chain = require('./chain');

const DEFAULT_CONTRACTS_DIR = path.join(__dirname, '..', 'contracts');
const contractsDir = path.resolve(chain.flagValue('--contracts') || DEFAULT_CONTRACTS_DIR);
const jsonBig = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

// ---------------------------------------------------------------------------
// Compile
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

function compile(dir) {
  const files = listSolFiles(dir);
  if (!files.length) throw new Error(`no .sol files found under ${dir}`);

  const sources = {};
  for (const f of files) {
    const key = path.relative(dir, f).split(path.sep).join('/');
    sources[key] = { content: fs.readFileSync(f, 'utf8') };
  }

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
      return { contents: fs.readFileSync(path.join(dir, importPath), 'utf8') };
    } catch (e) {
      return { error: `file not found: ${importPath}` };
    }
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  const problems = (output.errors || []).filter((e) => e.severity === 'error' || e.severity === 'warning');
  if (problems.length) {
    for (const p of problems) console.error(p.formattedMessage || p.message);
    throw new Error(`solc reported ${problems.length} error(s)/warning(s) in ${dir} — none are tolerated`);
  }
  if (!output.contracts) throw new Error(`solc produced no contract output for ${dir}`);

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
// ABI-driven signatures and argument building.
//
// Rather than hard-code "constructor(address,address,string,string,address,address,uint96)"
// we read the compiled ABI's parameter names and pull values out of a flat {name: value} map
// — so reordering or renaming a parameter in the Solidity (as long as it keeps the names this
// file's SPEC.md documents) never desyncs this script. A positional fallback covers the
// unlikely case of an ABI parameter with no name.
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

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

async function deployContract(label, abi, bytecode, namedValues, positionalFallback) {
  const inputs = ctorInputs(abi);
  const types = inputs.map(typeOfAbiInput);
  const args = buildArgs(inputs, namedValues, positionalFallback);
  const encodedArgs = types.length ? chain.abiEncode(types, args).slice(2) : '';
  const data = bytecode + encodedArgs;

  console.log(`  ${label} constructor(${types.join(', ')})`);
  console.log(`  ${label} args: ${JSON.stringify(args, jsonBig)}`);
  console.log(
    `  ${label} deploy data: ${(data.length - 2) / 2} bytes  (bytecode ${(bytecode.length - 2) / 2} + args ${encodedArgs.length / 2})`
  );

  const receipt = await chain.send({ to: null, data });
  const address = receipt.dryRun ? null : receipt.contractAddress;
  console.log(`  ${label} -> ${address || '(address known only once actually sent)'}`);
  return address;
}

async function main() {
  console.log(`deploy ${chain.dryRun ? '(dry-run) ' : ''}— contracts dir: ${contractsDir}\n`);

  const contracts = compile(contractsDir);
  console.log(`compiled ${Object.keys(contracts).length} contract(s): ${Object.keys(contracts).join(', ')}\n`);

  const addresses = chain.loadJson(chain.ADDRESSES_PATH);
  const markets = chain.loadJson(chain.MARKETS_PATH);
  if (!addresses.vaults) addresses.vaults = {};

  const { privateKey } = chain.env();
  const deployer = privateKey ? chain.secp.addressOf(privateKey) : null;
  if (!deployer) console.log('(no PRIVATE_KEY set — owner/feeRecipient constructor args cannot be resolved)\n');

  // --- LocateRouter --------------------------------------------------------
  let routerAddress = addresses.router || '';
  if (!routerAddress) {
    if (!contracts.LocateRouter) throw new Error('compiled output has no contract named LocateRouter');
    console.log('--- LocateRouter ---');
    const address = await deployContract(
      'LocateRouter',
      contracts.LocateRouter.abi,
      contracts.LocateRouter.bytecode,
      { morpho: addresses.morpho },
      [addresses.morpho]
    );
    if (!chain.dryRun) {
      routerAddress = address;
      addresses.router = address;
    }
    console.log('');
  } else {
    console.log(`--- LocateRouter already deployed: ${routerAddress} ---\n`);
  }

  // --- Cap conversions ------------------------------------------------------
  // Printed for every configured market regardless of deployment state: the USD->token
  // conversion only needs the feed price, not a live vault, so this is a useful preview even
  // before create-markets.js has run for a symbol.
  console.log('--- cap conversions (USD -> token units at the current feed price) ---');
  const caps = {};
  for (const m of markets) {
    const feed = await chain.feedPrice(m.feed);
    const capUnits = chain.capUnitsFromUsd(m.initialCapUsd, feed, addresses.stockDecimals);
    caps[m.symbol] = capUnits;
    const priceUsd = chain.fromUnits(feed.answer, feed.decimals);
    const capTokens = chain.fromUnits(capUnits, addresses.stockDecimals);
    console.log(
      `  ${m.symbol.padEnd(6)} $${m.initialCapUsd.toLocaleString('en-US').padStart(9)} @ $${priceUsd.padStart(9)}/token` +
        ` -> ${capTokens.padStart(14)} ${m.symbol}  (${capUnits} base units)`
    );
  }
  console.log('');

  // --- LocateVault + setMarket, one per market create-markets.js has finished -------------
  const ready = markets.filter((m) => m.marketId && m.oracle);
  if (!ready.length) {
    console.log('no market in config/markets.json has a marketId yet — run create-markets.js first.');
    console.log('(the cap conversions above are still accurate; there is just nothing to attach them to yet.)\n');
  }

  for (const m of ready) {
    console.log(`--- LocateVault(${m.symbol}) ---`);
    let vaultAddress = addresses.vaults[m.symbol] || '';
    if (!vaultAddress) {
      if (!contracts.LocateVault) throw new Error('compiled output has no contract named LocateVault');
      const owner = deployer || '0x' + '0'.repeat(40);
      const feeRecipient = addresses.feeRecipient || owner;
      const named = {
        morpho: addresses.morpho,
        asset: m.token,
        name: `Locate ${m.symbol}`,
        symbol: `lo${m.symbol}`,
        owner,
        feeRecipient,
        performanceFeeBps: 1000n,
      };
      const positional = [addresses.morpho, m.token, named.name, named.symbol, owner, feeRecipient, 1000n];
      const address = await deployContract(`LocateVault(${m.symbol})`, contracts.LocateVault.abi, contracts.LocateVault.bytecode, named, positional);
      if (!chain.dryRun) {
        vaultAddress = address;
        addresses.vaults[m.symbol] = address;
      }
    } else {
      console.log(`  already deployed: ${vaultAddress}`);
    }

    const mp = {
      loanToken: m.token,
      collateralToken: addresses.usdg,
      oracle: m.oracle,
      irm: addresses.adaptiveCurveIrm,
      lltv: chain.bpsToWad(m.lltvBps),
    };
    const capUnits = caps[m.symbol];
    const setMarketFn = findFn(contracts.LocateVault.abi, 'setMarket');
    const args = buildArgs(setMarketFn.inputs, { ...mp, cap: capUnits }, [
      [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv],
      capUnits,
    ]);
    const data = chain.encodeCall(sigOf('setMarket', setMarketFn.inputs), args);
    console.log(`  setMarket cap: $${m.initialCapUsd.toLocaleString('en-US')} -> ${chain.fromUnits(capUnits, addresses.stockDecimals)} ${m.symbol} (${capUnits} base units)`);
    const sendTarget = vaultAddress || `<vault not yet deployed for ${m.symbol} — illustrative only>`;
    await chain.send({ to: sendTarget, data });
    console.log('');
  }

  if (!chain.dryRun) {
    chain.saveJson(chain.ADDRESSES_PATH, addresses);
    console.log(`wrote ${chain.ADDRESSES_PATH}`);
  } else {
    console.log('[dry-run] not writing config/addresses.json');
  }
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
