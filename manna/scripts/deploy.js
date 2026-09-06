#!/usr/bin/env node
'use strict';

/**
 * Manna — deploy.js
 *
 * Deploys the pieces `docs/manna.md` calls "already in this repository" plus the ones this desk
 * adds: LocateRouter (reused if already recorded), Manna, UniswapV3Swapper (with a route per market
 * create-markets.js has finished), one LocateVault ("Storehouse") per such market with `setMarket`
 * sized to its USD cap at the oracle's current price, `manna.addStorehouse` for each, and finally
 * `manna.setAddresses` (treasury, charity, buyer = zero until launch.js, seller = the v3 swapper,
 * escrow = the Pons fee escrow).
 *
 *   node manna/scripts/deploy.js [--dry-run]
 *
 * Idempotent: every piece is skipped (and reused) when addresses.json already records it.
 * `addStorehouse` and the final `setAddresses` are Manna owner calls guarded `notSunday` on-chain
 * (Manna.sol) — on a Sunday UTC this script prints the calldata it would have sent and skips the
 * send rather than wasting gas on a call that would revert `Sabbath()`.
 *
 * Constructor and setMarket signatures are read from the compiled ABI, never hard-coded — see
 * config.js's deployContract/findFn/buildArgs, which mirror locate/scripts/deploy.js exactly.
 */

const chain = require('../../locate/scripts/chain');
const config = require('./config');

const ZERO = '0x' + '0'.repeat(40);

/** True (and prints why) when a Manna owner call would revert Sabbath() today. */
function sabbath(label) {
  if (!config.isSundayUtc()) return false;
  console.log(`  [Sabbath] ${label} would revert Sabbath() today (Sunday UTC) — skipping the send. Rerun on any other day.`);
  return true;
}

async function main() {
  console.log(`deploy ${chain.dryRun ? '(dry-run) ' : ''}— manna/contracts + locate/contracts\n`);
  console.log('Plan:');
  console.log('  1. LocateRouter (reused if already deployed)');
  console.log('  2. Manna(usdg, deployer, treasury || deployer)');
  console.log('  3. UniswapV3Swapper(weth, usdg, wethUsdgPool, deployer) + setRoute per created market');
  console.log('  4. one LocateVault ("Storehouse") per created market: setMarket, then manna.addStorehouse');
  console.log('  5. manna.setAddresses(treasury, charity, buyer=0x0 until launch, seller=v3Swapper, escrow=feeEscrow)\n');

  const contracts = config.compileContracts(config.ALL_CONTRACT_DIRS);
  console.log(`compiled ${Object.keys(contracts).length} contract(s)\n`);

  const { addresses, markets } = config.load();
  if (!addresses.vaults) addresses.vaults = {};

  const { privateKey } = chain.env();
  const deployer = privateKey ? chain.secp.addressOf(privateKey) : null;
  const deployerOrZero = deployer || ZERO;
  if (!deployer) {
    console.log('(no PRIVATE_KEY set — owner/feeRecipient/deployer constructor args cannot be resolved;');
    console.log(' using the zero address as an illustrative placeholder for printing purposes)\n');
  }

  // --- 1. LocateRouter -----------------------------------------------------
  let routerAddress = addresses.router || '';
  if (!routerAddress) {
    if (!contracts.LocateRouter) throw new Error('compiled output has no contract named LocateRouter');
    console.log('--- LocateRouter ---');
    const address = await config.deployContract('LocateRouter', contracts.LocateRouter, { morpho_: addresses.morpho }, [addresses.morpho]);
    if (!chain.dryRun) {
      routerAddress = address;
      addresses.router = address;
    }
    console.log('');
  } else {
    console.log(`--- LocateRouter already deployed: ${routerAddress} ---\n`);
  }

  // --- 2. Manna --------------------------------------------------------
  let mannaAddress = addresses.manna || '';
  const treasury = addresses.treasury || deployerOrZero;
  if (!mannaAddress) {
    if (!contracts.Manna) throw new Error('compiled output has no contract named Manna');
    console.log('--- Manna ---');
    const named = { usdg_: addresses.usdg, owner_: deployerOrZero, treasury_: treasury };
    const positional = [addresses.usdg, deployerOrZero, treasury];
    const address = await config.deployContract('Manna', contracts.Manna, named, positional);
    if (!chain.dryRun) {
      mannaAddress = address;
      addresses.manna = address;
    }
    console.log('');
  } else {
    console.log(`--- Manna already deployed: ${mannaAddress} ---\n`);
  }
  const mannaSendTarget = mannaAddress || '<Manna not yet deployed — illustrative only>';
  const mannaForEncoding = mannaAddress || ZERO;

  // --- 3. UniswapV3Swapper -------------------------------------------------
  let v3Address = addresses.v3Swapper || '';
  if (!v3Address) {
    if (!contracts.UniswapV3Swapper) throw new Error('compiled output has no contract named UniswapV3Swapper');
    console.log('--- UniswapV3Swapper ---');
    const named = { weth_: addresses.weth, usdg_: addresses.usdg, quotePool_: addresses.wethUsdgPool, owner_: deployerOrZero };
    const positional = [addresses.weth, addresses.usdg, addresses.wethUsdgPool, deployerOrZero];
    const address = await config.deployContract('UniswapV3Swapper', contracts.UniswapV3Swapper, named, positional);
    if (!chain.dryRun) {
      v3Address = address;
      addresses.v3Swapper = address;
    }
    console.log('');
  } else {
    console.log(`--- UniswapV3Swapper already deployed: ${v3Address} ---\n`);
  }
  const v3SendTarget = v3Address || '<UniswapV3Swapper not yet deployed — illustrative only>';
  const v3ForEncoding = v3Address || ZERO;

  // --- 4. Storehouses: one LocateVault per market create-markets.js has finished ---
  const ready = markets.filter((m) => m.marketId && m.oracle && !m.hold);
  if (!ready.length) {
    console.log('no market in manna/config/markets.json has a marketId yet — run create-markets.js first.');
    console.log('(LocateRouter/Manna/UniswapV3Swapper above are still deployed regardless.)\n');
  }

  for (const m of ready) {
    console.log(`--- ${m.symbol}: route, LocateVault, setMarket, addStorehouse ---`);

    const routeArgs = [m.token, m.pool];
    config.selfTestAndLog(`setRoute(${m.symbol})`, ['address', 'address'], routeArgs);
    console.log(`  setRoute(${m.symbol} -> pool ${m.pool})`);
    await chain.send({ to: v3SendTarget, data: chain.encodeCall('setRoute(address,address)', routeArgs) });

    let vaultAddress = addresses.vaults[m.symbol] || '';
    if (!vaultAddress) {
      if (!contracts.LocateVault) throw new Error('compiled output has no contract named LocateVault');
      const name_ = `Storehouse ${m.symbol}`;
      const symbol_ = `sh${m.symbol}`;
      const named = {
        morpho_: addresses.morpho,
        asset_: m.token,
        name_,
        symbol_,
        owner_: deployerOrZero,
        feeRecipient_: mannaForEncoding,
        performanceFeeBps_: 1000n,
      };
      const positional = [addresses.morpho, m.token, name_, symbol_, deployerOrZero, mannaForEncoding, 1000n];
      const address = await config.deployContract(`LocateVault(${m.symbol})`, contracts.LocateVault, named, positional);
      if (!chain.dryRun) {
        vaultAddress = address;
        addresses.vaults[m.symbol] = address;
      }
    } else {
      console.log(`  vault already deployed: ${vaultAddress}`);
    }
    const vaultSendTarget = vaultAddress || `<vault not yet deployed for ${m.symbol} — illustrative only>`;
    const vaultForEncoding = vaultAddress || ZERO;

    // setMarket, cap = initialCapUsd converted to Giant units at the oracle's current price.
    const mp = {
      loanToken: m.token,
      collateralToken: addresses.usdg,
      oracle: m.oracle,
      irm: addresses.adaptiveCurveIrm,
      lltv: chain.bpsToWad(m.lltvBps),
    };
    await config.sleep(config.RPC_DELAY_MS);
    const [price] = await chain.call(m.oracle, 'price()', [], ['uint256']);
    await config.sleep(config.RPC_DELAY_MS);
    const [tokenDecimals] = await chain.call(m.token, 'decimals()', [], ['uint8']);
    const capUnits = config.usdToGiantRaw(m.initialCapUsd, price, addresses.usdgDecimals);
    const setMarketFn = config.findFn(contracts.LocateVault.abi, 'setMarket');
    const setMarketArgs = config.buildArgs(setMarketFn.inputs, { ...mp, cap: capUnits }, [
      [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv],
      capUnits,
    ]);
    const setMarketTypes = setMarketFn.inputs.map(config.typeOfAbiInput);
    config.selfTestAndLog(`setMarket(${m.symbol})`, setMarketTypes, setMarketArgs);
    console.log(
      `  setMarket cap: $${m.initialCapUsd.toLocaleString('en-US')} -> ${chain.fromUnits(capUnits, Number(tokenDecimals))} ${m.symbol}` +
        ` (${capUnits} base units, at price ${price})`
    );
    const setMarketData = chain.encodeCall(config.sigOf('setMarket', setMarketFn.inputs), setMarketArgs);
    await chain.send({ to: vaultSendTarget, data: setMarketData });

    // manna.addStorehouse(vault, oracle) — owner + notSunday.
    if (!sabbath(`manna.addStorehouse(${m.symbol})`)) {
      const asArgs = [vaultForEncoding, m.oracle];
      config.selfTestAndLog(`addStorehouse(${m.symbol})`, ['address', 'address'], asArgs);
      await chain.send({ to: mannaSendTarget, data: chain.encodeCall('addStorehouse(address,address)', asArgs) });
    }
    console.log('');
  }

  // --- 5. manna.setAddresses -------------------------------------------
  console.log('--- manna.setAddresses ---');
  const charity = addresses.charity || ZERO;
  const buyer = ZERO; // no buyer until launch.js runs
  const escrow = addresses.pons.feeEscrow;
  console.log(`  treasury=${treasury}`);
  console.log(`  charity=${addresses.charity || '(none yet — zero address)'}`);
  console.log(`  buyer=${buyer} (zero until launch.js sets the real buyer)`);
  console.log(`  seller=${v3Address || '(not yet deployed — illustrative placeholder)'}`);
  console.log(`  escrow=${escrow}`);
  if (!sabbath('manna.setAddresses')) {
    const saArgs = [treasury, charity, buyer, v3ForEncoding, escrow];
    config.selfTestAndLog('setAddresses', ['address', 'address', 'address', 'address', 'address'], saArgs);
    await chain.send({
      to: mannaSendTarget,
      data: chain.encodeCall('setAddresses(address,address,address,address,address)', saArgs),
    });
  }

  if (!chain.dryRun) {
    config.save(addresses, markets);
    console.log(`\nwrote ${config.ADDRESSES_PATH}`);
  } else {
    console.log('\n[dry-run] not writing manna/config/addresses.json');
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
