#!/usr/bin/env node
'use strict';

/**
 * Manna — create-markets.js
 *
 * For each market in config/markets.json not marked `hold`:
 *   1. derive `token` from the Giant's WETH pool (whichever of token0()/token1() is not WETH) if not
 *      already recorded;
 *   2. check the pool's TWAP buffer (observationCardinality, and that observe([window,0]) does not
 *      revert right now) — warns loudly but never aborts, since the Prophet degrades to its
 *      fallback window rather than failing outright;
 *   3. deploy a MemeTwapOracle for it if `oracle` is not already recorded (sanity-printing price()
 *      as USDG per Giant);
 *   4. compute its Morpho MarketParams and id, and `createMarket` if Morpho does not already know it.
 *
 *   node manna/scripts/create-markets.js [--dry-run] [--only SYMBOL]
 *
 * Reads always hit the real chain, dry-run or not — only sends (the oracle deployment and
 * createMarket) are skipped in dry-run. Idempotent: rerunning is a no-op for anything already
 * finished. See config.js for the compile/ABI-argument plumbing and locate/scripts/chain.js for the
 * RPC/ABI/signing plumbing this mirrors.
 */

const chain = require('../../locate/scripts/chain');
const config = require('./config');

const sameAddr = chain.secp.sameAddress;
const MIN_CARDINALITY = 1800n;

async function resolveToken(m, addresses) {
  if (m.token) {
    console.log(`  token already recorded: ${m.token}`);
    return m.token;
  }
  const [t0] = await chain.call(m.pool, 'token0()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  const [t1] = await chain.call(m.pool, 'token1()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  let token;
  if (sameAddr(t0, addresses.weth)) token = t1;
  else if (sameAddr(t1, addresses.weth)) token = t0;
  else throw new Error(`pool ${m.pool} does not contain WETH (${addresses.weth}); token0=${t0} token1=${t1}`);
  console.log(`  token derived from pool (${sameAddr(t0, addresses.weth) ? 'token1' : 'token0'}): ${token}`);
  return token;
}

/** Warns (never aborts) when the Giant's pool cannot yet reliably serve the configured TWAP window. */
async function checkBuffer(m) {
  const slot0 = await chain.call(m.pool, 'slot0()', [], [
    'uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool',
  ]);
  await config.sleep(config.RPC_DELAY_MS);
  const cardinality = slot0[3];
  if (cardinality < MIN_CARDINALITY) {
    console.log(
      `  WARNING: ${m.symbol} pool observationCardinality is only ${cardinality} (< ${MIN_CARDINALITY}) — ` +
        `the ${m.window}s window may not always be reachable; the Prophet will run on its ${m.fallbackWindow}s ` +
        `fallback window until the buffer grows.`
    );
  } else {
    console.log(`  pool observationCardinality: ${cardinality} (>= ${MIN_CARDINALITY}, OK)`);
  }
  try {
    await chain.call(m.pool, 'observe(uint32[])', [[BigInt(m.window), 0n]], ['int56[]', 'uint160[]']);
    console.log(`  observe([${m.window},0]) OK — the ${m.window}s window is reachable right now`);
  } catch (e) {
    console.log(
      `  WARNING: observe([${m.window},0]) reverted (${e.message}) — the Prophet will run on its ` +
        `${m.fallbackWindow}s fallback window until the buffer grows`
    );
  }
  await config.sleep(config.RPC_DELAY_MS);
}

async function deployOracle(m, addresses, contracts) {
  const art = contracts.MemeTwapOracle;
  if (!art) throw new Error('compiled output has no contract named MemeTwapOracle');
  const named = {
    memePool: m.pool,
    quotePool: addresses.wethUsdgPool,
    meme: m.token,
    weth: addresses.weth,
    usdg: addresses.usdg,
    window: BigInt(m.window),
    fallbackWindow: BigInt(m.fallbackWindow),
  };
  const positional = [m.pool, addresses.wethUsdgPool, m.token, addresses.weth, addresses.usdg, BigInt(m.window), BigInt(m.fallbackWindow)];
  return config.deployContract(`MemeTwapOracle(${m.symbol})`, art, named, positional);
}

/** Mutates `m` in place when a real run advances it; returns a result summary. */
async function processMarket(m, addresses, contracts) {
  if (m.hold) {
    console.log('  on hold — skipping');
    return { symbol: m.symbol, done: false, note: 'hold' };
  }

  m.token = await resolveToken(m, addresses);
  await checkBuffer(m);

  let oracle = m.oracle;
  if (!oracle) {
    const address = await deployOracle(m, addresses, contracts);
    if (!address) {
      return { symbol: m.symbol, done: false, note: 'dry-run: oracle not deployed, cannot compute a real market id yet' };
    }
    oracle = address;
    m.oracle = oracle;
    await config.sleep(config.RPC_DELAY_MS);
    const [price] = await chain.call(oracle, 'price()', [], ['uint256']);
    await config.sleep(config.RPC_DELAY_MS);
    const [memeDecimals] = await chain.call(m.token, 'decimals()', [], ['uint8']);
    console.log(`  sanity price(): ${chain.oracleHumanPrice(price, Number(memeDecimals), addresses.usdgDecimals)} USDG per ${m.symbol}`);
  } else {
    console.log(`  oracle already recorded: ${oracle}`);
  }

  const mp = {
    loanToken: m.token,
    collateralToken: addresses.usdg,
    oracle,
    irm: addresses.adaptiveCurveIrm,
    lltv: chain.bpsToWad(m.lltvBps),
  };
  const id = chain.marketId(mp);
  console.log(`  market id: ${id}`);

  await config.sleep(config.RPC_DELAY_MS);
  const marketState = await chain.call(addresses.morpho, 'market(bytes32)', [id], [
    'uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128',
  ]);
  const lastUpdate = marketState[4];
  if (lastUpdate !== 0n) {
    console.log(`  market already exists on Morpho (lastUpdate=${lastUpdate}) — nothing to do`);
    m.marketId = id;
    return { symbol: m.symbol, done: true, id, alreadyExisted: true };
  }

  const mpArgs = [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv];
  config.selfTestAndLog(`createMarket(${m.symbol})`, [chain.MARKET_PARAMS_T], [mpArgs]);

  const data = chain.encodeCall(`createMarket(${chain.MARKET_PARAMS_T})`, [mpArgs]);
  console.log(`  createMarket calldata (${(data.length - 2) / 2} bytes): ${data}`);
  console.log(`  market params: ${JSON.stringify({ ...mp, lltv: mp.lltv.toString() })}`);

  await chain.send({ to: addresses.morpho, data });

  if (!chain.dryRun) {
    m.marketId = id;
    return { symbol: m.symbol, done: true, id };
  }
  return { symbol: m.symbol, done: false, note: 'dry-run: createMarket not sent' };
}

async function main() {
  const { addresses, markets } = config.load();
  const only = chain.flagValue('--only');
  const targets = only ? markets.filter((m) => m.symbol.toUpperCase() === only.toUpperCase()) : markets;

  if (only && targets.length === 0) {
    console.error(`no market with symbol "${only}" in ${config.MARKETS_PATH}`);
    process.exit(1);
  }

  console.log(`create-markets ${chain.dryRun ? '(dry-run) ' : ''}— ${targets.length} market(s) to consider\n`);
  console.log('Plan: for each market not on hold, resolve its Giant token, check its pool TWAP buffer,');
  console.log('deploy a MemeTwapOracle if it has none, then createMarket on Morpho if it does not exist yet.\n');

  const contracts = config.compileContracts(config.ALL_CONTRACT_DIRS);
  console.log(`compiled ${Object.keys(contracts).length} contract(s)\n`);

  const results = [];
  for (const m of targets) {
    console.log(`--- ${m.symbol} (${m.name}) ---`);
    try {
      results.push(await processMarket(m, addresses, contracts));
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      results.push({ symbol: m.symbol, done: false, error: e.message });
    }
    console.log('');
  }

  if (!chain.dryRun) {
    config.save(addresses, markets);
    console.log(`wrote ${config.MARKETS_PATH}`);
  } else {
    console.log('[dry-run] not writing manna/config/markets.json');
  }

  const failed = results.filter((r) => r.error);
  const finished = results.filter((r) => r.done);
  console.log(`\n${results.length} processed, ${finished.length} finished, ${failed.length} error(s)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
