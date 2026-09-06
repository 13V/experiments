#!/usr/bin/env node
'use strict';

/**
 * Manna — launch.js
 *
 * Launches the MANNA coin on the Pons V2 factory (base fee 1%, creator tax `--tax-bps`, quote
 * USDG), points Manna at it, deploys the two post-curve/post-graduation buyer adapters, and wires
 * Manna's seller/buyer/escrow so the desk is live. Optionally makes a dev-buy on the bonding curve.
 *
 *   node manna/scripts/launch.js [--dry-run] --name X --symbol MANNA --logo URL --description TEXT
 *     [--website U] [--twitter U] [--telegram U] [--tax-bps 100] [--dev-buy USDG_AMOUNT]
 *
 * Requires addresses.manna (run deploy.js first). Idempotent at the level of "has this launch
 * finished" — once token/curve/curveSwapper/v4Swapper are all recorded, rerunning is a pure no-op,
 * on purpose: dawn.js's --switch-buyer moves Manna's buyer from the curve to the v4 pool after
 * graduation, and this script must never re-run its own setAddresses over top of that later change.
 * Short of that, each individual step (setToken, each adapter, setPoolKey) is independently skipped
 * when already done, so a partially-completed launch (e.g. interrupted after paying the launch fee)
 * resumes cleanly. `setAddresses` here (like Manna's other owner setters except setToken) reverts
 * `Sabbath()` on Sundays: this script detects that and skips the send with a clear message.
 */

const chain = require('../../locate/scripts/chain');
const config = require('./config');

const ZERO = '0x' + '0'.repeat(40);
const MAX_TAX_BPS = 1000;
const DEFAULT_TAX_BPS = 100;

const SOCIALS_T = '(string,string,string,string,string)';
const TOKEN_PARAMS_T = `(string,string,string,string,${SOCIALS_T},address,uint16,bool,bytes32,bytes32)`;
const LAUNCH_TOKEN_TYPES = [TOKEN_PARAMS_T, 'uint256', 'address', 'address[]'];
const LAUNCH_TOKEN_SIG = `launchToken(${LAUNCH_TOKEN_TYPES.join(',')})`;
const TOKEN_LAUNCHED_EVENT = 'TokenLaunched(address,address,address,address,uint256,uint256)';

const isZero = (a) => chain.secp.sameAddress(a, ZERO);

function sabbath(label) {
  if (!config.isSundayUtc()) return false;
  console.log(`  [Sabbath] ${label} would revert Sabbath() today (Sunday UTC) — skipping the send. Rerun on any other day.`);
  return true;
}

function requireFlag(name) {
  const v = chain.flagValue(name);
  if (!v) throw new Error(`missing required flag ${name}`);
  return v;
}

async function main() {
  const { addresses, markets } = config.load();
  if (!addresses.manna) throw new Error('addresses.manna is not set — run deploy.js first');

  const name = requireFlag('--name');
  const symbol = requireFlag('--symbol');
  const logo = requireFlag('--logo');
  const description = requireFlag('--description');
  const website = chain.flagValue('--website') || '';
  const twitter = chain.flagValue('--twitter') || '';
  const telegram = chain.flagValue('--telegram') || '';
  const taxBpsRaw = chain.flagValue('--tax-bps');
  const taxBps = taxBpsRaw === undefined ? DEFAULT_TAX_BPS : parseInt(taxBpsRaw, 10);
  if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > MAX_TAX_BPS) {
    throw new Error(`--tax-bps must be an integer between 0 and ${MAX_TAX_BPS} (got "${taxBpsRaw}")`);
  }
  const devBuyRaw = chain.flagValue('--dev-buy');

  console.log(`launch ${chain.dryRun ? '(dry-run) ' : ''}— ${name} (${symbol})\n`);
  console.log('Plan:');
  console.log('  1. read launchFee() and previewLaunchEconomics(launchConfigId, usdg)');
  console.log('  2. factory.launchToken(...) paying launchFee, creatorFeeRecipient = Manna');
  console.log('  3. parse TokenLaunched -> token, curve; manna.setToken(token)');
  console.log('  4. deploy PonsCurveSwapper(curve) and UniswapV4Swapper(...) + setPoolKey');
  console.log('  5. manna.setAddresses(treasury, charity, buyer=curveSwapper, seller=v3Swapper, escrow)');
  if (devBuyRaw) console.log(`  6. approve + curve.buy(${devBuyRaw} USDG) for the deployer`);
  console.log('');

  const { privateKey } = chain.env();
  const deployer = privateKey ? chain.secp.addressOf(privateKey) : null;
  const deployerOrZero = deployer || ZERO;
  if (!deployer) {
    console.log('(no PRIVATE_KEY set — the deployer/dev-buy recipient cannot be resolved;');
    console.log(' using the zero address as an illustrative placeholder for printing purposes)\n');
  }

  const factory = addresses.pons.factory;
  const launchConfigId = BigInt(addresses.pons.launchConfigId);

  const alreadyLaunched = !!(addresses.token && addresses.curve && addresses.curveSwapper && addresses.v4Swapper);
  if (alreadyLaunched) {
    console.log(`already fully launched: token=${addresses.token} curve=${addresses.curve}`);
    console.log(`curveSwapper=${addresses.curveSwapper} v4Swapper=${addresses.v4Swapper}`);
    console.log('nothing to do — rerun dawn.js --switch-buyer if you want to move the buyer post-graduation.');
    return;
  }

  const contracts = config.compileContracts(config.ALL_CONTRACT_DIRS);
  console.log(`compiled ${Object.keys(contracts).length} contract(s)\n`);

  let token = addresses.token || '';
  let curve = addresses.curve || '';

  if (!token) {
    await config.sleep(config.RPC_DELAY_MS);
    const [launchFee] = await chain.call(factory, 'launchFee()', [], ['uint256']);
    if (addresses.pons.launchFeeWei && BigInt(addresses.pons.launchFeeWei) !== launchFee) {
      console.log(`  NOTE: live launchFee() (${launchFee}) differs from the recorded launchFeeWei (${addresses.pons.launchFeeWei}) — using the live value.`);
    }
    await config.sleep(config.RPC_DELAY_MS);
    const [expectedEconomics] = await chain.call(
      factory,
      'previewLaunchEconomics(uint256,address)',
      [launchConfigId, addresses.usdg],
      ['bytes32']
    );

    const salt = '0x' + chain.keccak256(Buffer.from(`manna:${symbol}`, 'utf8')).toString('hex');
    const socials = [twitter, telegram, '', website, '']; // (twitter, telegram, discord, website, farcaster)
    const tokenParams = [name, symbol, logo, description, socials, addresses.manna, BigInt(taxBps), false, expectedEconomics, salt];
    const snipeTaxExemptions = [deployerOrZero, addresses.manna];
    const launchArgs = [tokenParams, launchConfigId, addresses.usdg, snipeTaxExemptions];

    console.log('--- launchToken ---');
    console.log(`  name=${name}  symbol=${symbol}  logo=${logo}`);
    console.log(`  description=${description}`);
    console.log(`  socials (twitter,telegram,discord,website,farcaster)=${JSON.stringify(socials)}`);
    console.log(`  creatorFeeRecipient=${addresses.manna}  creatorTaxBps=${taxBps}  buybackEnabled=false`);
    console.log(`  expectedEconomics=${expectedEconomics}  salt=${salt}`);
    console.log(`  launchConfigId=${launchConfigId}  pairToken=${addresses.usdg}`);
    console.log(`  snipeTaxExemptions=${JSON.stringify(snipeTaxExemptions)}`);
    console.log(`  launchFee (msg.value)=${launchFee} (${chain.fromUnits(launchFee, 18)} native)`);
    config.selfTestAndLog('launchToken', LAUNCH_TOKEN_TYPES, launchArgs);

    const data = chain.encodeCall(LAUNCH_TOKEN_SIG, launchArgs);
    const receipt = await chain.send({ to: factory, data, value: launchFee });

    if (receipt.dryRun) {
      console.log('\n  [dry-run] launchToken not sent; token/curve are unknown, so the rest of the sequence');
      console.log('  (setToken, adapters, setAddresses) cannot be previewed meaningfully yet — stopping here.');
      console.log('\n[dry-run] not writing manna/config/addresses.json');
      return;
    }

    const log = config.findLog(receipt, factory, TOKEN_LAUNCHED_EVENT);
    if (!log) throw new Error(`no ${TOKEN_LAUNCHED_EVENT} event in receipt ${receipt.transactionHash}`);
    const [tokenAddr] = chain.abiDecode(['address'], log.topics[1]);
    const [curveAddr] = chain.abiDecode(['address'], log.topics[2]);
    token = tokenAddr;
    curve = curveAddr;
    addresses.token = token;
    addresses.curve = curve;
    console.log(`  token=${token}  curve=${curve}`);
    console.log('');
  } else {
    console.log(`--- already launched: token=${token} curve=${curve} ---\n`);
  }

  const tokenForEncoding = token || ZERO;
  const curveForEncoding = curve || ZERO;

  // --- manna.setToken(token) — once ever; NOT Sunday-gated (Manna.sol has no notSunday on it). ---
  console.log('--- manna.setToken ---');
  let mannaToken = ZERO;
  try {
    await config.sleep(config.RPC_DELAY_MS);
    [mannaToken] = await chain.call(addresses.manna, 'token()', [], ['address']);
  } catch (e) {
    console.log(`  could not read manna.token() (${e.message}); proceeding to set it`);
  }
  if (!isZero(mannaToken)) {
    if (chain.secp.sameAddress(mannaToken, tokenForEncoding)) {
      console.log(`  already set on-chain: ${mannaToken}`);
    } else {
      console.log(`  WARNING: manna.token() is already ${mannaToken}, which does not match ${tokenForEncoding} — skipping (setToken would revert TokenAlreadySet).`);
    }
  } else {
    const stArgs = [tokenForEncoding];
    config.selfTestAndLog('setToken', ['address'], stArgs);
    await chain.send({ to: addresses.manna, data: chain.encodeCall('setToken(address)', stArgs) });
  }
  console.log('');

  // --- PonsCurveSwapper(curve, usdg, token) ---------------------------------
  console.log('--- PonsCurveSwapper ---');
  let curveSwapperAddress = addresses.curveSwapper || '';
  if (!curveSwapperAddress) {
    if (!contracts.PonsCurveSwapper) throw new Error('compiled output has no contract named PonsCurveSwapper');
    const named = { curve_: curveForEncoding, usdg_: addresses.usdg, token_: tokenForEncoding };
    const positional = [curveForEncoding, addresses.usdg, tokenForEncoding];
    const address = await config.deployContract('PonsCurveSwapper', contracts.PonsCurveSwapper, named, positional);
    if (!chain.dryRun) {
      curveSwapperAddress = address;
      addresses.curveSwapper = address;
    }
  } else {
    console.log(`  already deployed: ${curveSwapperAddress}`);
  }
  console.log('');

  // --- UniswapV4Swapper(poolManager, usdg, token, deployer) + setPoolKey ----
  console.log('--- UniswapV4Swapper ---');
  let v4Address = addresses.v4Swapper || '';
  if (!v4Address) {
    if (!contracts.UniswapV4Swapper) throw new Error('compiled output has no contract named UniswapV4Swapper');
    const named = { poolManager_: addresses.pons.poolManager, usdg_: addresses.usdg, token_: tokenForEncoding, owner_: deployerOrZero };
    const positional = [addresses.pons.poolManager, addresses.usdg, tokenForEncoding, deployerOrZero];
    const address = await config.deployContract('UniswapV4Swapper', contracts.UniswapV4Swapper, named, positional);
    if (!chain.dryRun) {
      v4Address = address;
      addresses.v4Swapper = address;
    }
  } else {
    console.log(`  already deployed: ${v4Address}`);
  }
  const v4SendTarget = v4Address || '<UniswapV4Swapper not yet deployed — illustrative only>';

  let keySet = false;
  if (v4Address) {
    await config.sleep(config.RPC_DELAY_MS);
    [keySet] = await chain.call(v4Address, 'keySet()', [], ['bool']);
  }
  if (keySet) {
    console.log('  pool key already set');
  } else {
    const poolFee = BigInt(addresses.pons.poolFee);
    const tickSpacing = BigInt(addresses.pons.tickSpacing);
    const hooks = addresses.pons.memeHook;
    console.log(`  setPoolKey(fee=${poolFee}, tickSpacing=${tickSpacing}, hooks=${hooks})`);
    const spkArgs = [poolFee, tickSpacing, hooks];
    config.selfTestAndLog('setPoolKey', ['uint24', 'int24', 'address'], spkArgs);
    await chain.send({ to: v4SendTarget, data: chain.encodeCall('setPoolKey(uint24,int24,address)', spkArgs) });
  }
  console.log('');

  // --- manna.setAddresses(treasury, charity, buyer=curveSwapper, seller=v3Swapper, escrow) ---
  console.log('--- manna.setAddresses ---');
  await config.sleep(config.RPC_DELAY_MS);
  const [currentTreasury] = await chain.call(addresses.manna, 'treasury()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  const [currentCharity] = await chain.call(addresses.manna, 'charity()', [], ['address']);
  if (!addresses.v3Swapper) console.log('  WARNING: addresses.v3Swapper is not set — run deploy.js first; using the zero address placeholder for seller.');
  const escrow = addresses.pons.feeEscrow;
  console.log(`  treasury=${currentTreasury}  charity=${currentCharity}`);
  console.log(`  buyer=${curveSwapperAddress || '(curve swapper not yet deployed)'}  seller=${addresses.v3Swapper || '(missing)'}  escrow=${escrow}`);
  if (!sabbath('manna.setAddresses')) {
    const saArgs = [currentTreasury, currentCharity, curveSwapperAddress || ZERO, addresses.v3Swapper || ZERO, escrow];
    config.selfTestAndLog('setAddresses', ['address', 'address', 'address', 'address', 'address'], saArgs);
    await chain.send({ to: addresses.manna, data: chain.encodeCall('setAddresses(address,address,address,address,address)', saArgs) });
  }
  console.log('');

  // --- optional dev-buy on the curve -----------------------------------
  if (devBuyRaw) {
    console.log('--- dev-buy ---');
    const amount = chain.toUnits(devBuyRaw, addresses.usdgDecimals);
    await config.sleep(config.RPC_DELAY_MS);
    const [quoteReserve, tokenReserve] = await chain.call(curveForEncoding, 'getReserves()', [], ['uint256', 'uint256']);
    const estimate = (tokenReserve * amount) / (quoteReserve + amount);
    const minOut = (estimate * 98n) / 100n; // 2% slippage tolerance
    console.log(`  reserves: quote=${quoteReserve} token=${tokenReserve}`);
    console.log(`  buying with ${devBuyRaw} USDG (${amount} raw): estimate ${estimate}, minOut ${minOut} (2% slippage)`);

    const approveArgs = [curveForEncoding, amount];
    config.selfTestAndLog('approve(curve)', ['address', 'uint256'], approveArgs);
    await chain.send({ to: addresses.usdg, data: chain.encodeCall('approve(address,uint256)', approveArgs) });

    const buyArgs = [amount, minOut, deployerOrZero];
    config.selfTestAndLog('curve.buy', ['uint256', 'uint256', 'address'], buyArgs);
    await chain.send({ to: curveForEncoding, data: chain.encodeCall('buy(uint256,uint256,address)', buyArgs) });
    console.log('');
  }

  if (!chain.dryRun) {
    config.save(addresses, markets);
    console.log(`wrote ${config.ADDRESSES_PATH}`);
  } else {
    console.log('[dry-run] not writing manna/config/addresses.json');
  }

  console.log('\nResulting addresses:');
  console.log(`  token=${addresses.token || '(not launched)'}`);
  console.log(`  curve=${addresses.curve || '(not launched)'}`);
  console.log(`  curveSwapper=${addresses.curveSwapper || '(not deployed)'}`);
  console.log(`  v4Swapper=${addresses.v4Swapper || '(not deployed)'}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
