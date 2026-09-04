#!/usr/bin/env node
'use strict';

/**
 * Locate — create-markets.js
 *
 * For each entry in config/markets.json: create its Morpho-Chainlink oracle (base = USDG,
 * quote = the stock) through the factory unless one is already recorded, compute the
 * MarketParams and its id, `createMarket` if Morpho doesn't already know it, and write
 * `oracle`/`marketId` back into config/markets.json. Idempotent — rerunning is a no-op for
 * anything already finished.
 *
 *   node locate/scripts/create-markets.js [--dry-run] [--only SYMBOL]
 *
 * Reads (market(), price()) always hit the real chain, dry-run or not — only sends are
 * skipped in dry-run. See chain.js for the RPC/ABI/signing plumbing.
 */

const chain = require('./chain');

const ZERO = '0x' + '0'.repeat(40);
const jsonBig = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const sameAddr = chain.secp.sameAddress;

const ORACLE_FACTORY_TYPES = [
  'address', 'uint256', 'address', 'address', 'uint256', // base: vault, sample, feed1, feed2, decimals
  'address', 'uint256', 'address', 'address', 'uint256', // quote: vault, sample, feed1, feed2, decimals
  'bytes32', // salt
];
const ORACLE_FACTORY_SIG = `createMorphoChainlinkOracleV2(${ORACLE_FACTORY_TYPES.join(',')})`;
const CREATE_MORPHO_ORACLE_EVENT = 'CreateMorphoChainlinkOracleV2(address,address)';

function oracleFactoryCalldata(m, addresses) {
  const salt = '0x' + chain.keccak256(Buffer.from(`locate:${m.symbol}`, 'utf8')).toString('hex');
  const args = [
    ZERO, 1n, addresses.usdgUsdFeed, ZERO, BigInt(addresses.usdgDecimals), // base = USDG
    ZERO, 1n, m.feed, ZERO, BigInt(addresses.stockDecimals), // quote = the stock
    salt,
  ];
  const data = chain.encodeCall(ORACLE_FACTORY_SIG, args);
  return { data, args, salt };
}

/** Decode our own factory calldata back and check it matches what we meant to send. */
function selfTestFactoryCalldata(data, args) {
  const decoded = chain.abiDecode(ORACLE_FACTORY_TYPES, '0x' + data.slice(10));
  const ok =
    decoded.length === args.length &&
    decoded.every((v, i) => (typeof v === 'string' && v.startsWith('0x') ? sameAddr(v, args[i]) || v.toLowerCase() === String(args[i]).toLowerCase() : v === args[i]));
  return { ok, decoded };
}

/** Handle one market entry. Mutates `m` in place when a real run advances it. */
async function processMarket(m, addresses) {
  let oracle = m.oracle;

  if (!oracle) {
    const { data, args, salt } = oracleFactoryCalldata(m, addresses);
    console.log(`  oracle factory calldata (${(data.length - 2) / 2} bytes):`);
    console.log(`    ${data}`);
    const { ok, decoded } = selfTestFactoryCalldata(data, args);
    console.log(`  self-test decode: ${ok ? 'OK' : 'MISMATCH'} ${JSON.stringify(decoded, jsonBig)}`);
    if (!ok) throw new Error('abiDecode(abiEncode(x)) != x for the oracle factory call — encoder bug');
    console.log(
      `  would-be market params: loanToken=${m.token} collateralToken=${addresses.usdg} ` +
        `oracle=<pending, read from ${CREATE_MORPHO_ORACLE_EVENT} in the receipt> ` +
        `irm=${addresses.adaptiveCurveIrm} lltv=${chain.bpsToWad(m.lltvBps)} (salt ${salt})`
    );

    const receipt = await chain.send({ to: addresses.chainlinkOracleV2Factory, data });
    if (receipt.dryRun) {
      return { symbol: m.symbol, done: false, note: 'dry-run: oracle not created, cannot compute a real market id yet' };
    }

    const eventTopic = chain.topic(CREATE_MORPHO_ORACLE_EVENT);
    const log = (receipt.logs || []).find(
      (l) => sameAddr(l.address, addresses.chainlinkOracleV2Factory) && l.topics[0].toLowerCase() === eventTopic.toLowerCase()
    );
    if (!log) throw new Error(`no ${CREATE_MORPHO_ORACLE_EVENT} event in receipt ${receipt.transactionHash}`);
    const [, oracleAddr] = chain.abiDecode(['address', 'address'], log.data);
    oracle = oracleAddr;
    m.oracle = oracle;
    console.log(`  oracle created: ${oracle}`);

    const [price] = await chain.call(oracle, 'price()', [], ['uint256']);
    console.log(`  sanity price(): ${chain.oracleHumanPrice(price, addresses.stockDecimals, addresses.usdgDecimals)} USDG per ${m.symbol}`);
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
  const addresses = chain.loadJson(chain.ADDRESSES_PATH);
  const markets = chain.loadJson(chain.MARKETS_PATH);
  const only = chain.flagValue('--only');
  const targets = only ? markets.filter((m) => m.symbol.toUpperCase() === only.toUpperCase()) : markets;

  if (only && targets.length === 0) {
    console.error(`no market with symbol "${only}" in ${chain.MARKETS_PATH}`);
    process.exit(1);
  }

  console.log(`create-markets ${chain.dryRun ? '(dry-run) ' : ''}— ${targets.length} market(s)\n`);

  const results = [];
  for (const m of targets) {
    console.log(`--- ${m.symbol} (${m.name}) ---`);
    try {
      results.push(await processMarket(m, addresses));
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      results.push({ symbol: m.symbol, done: false, error: e.message });
    }
    console.log('');
  }

  if (!chain.dryRun) {
    chain.saveJson(chain.MARKETS_PATH, markets);
    console.log(`wrote ${chain.MARKETS_PATH}`);
  } else {
    console.log('[dry-run] not writing config/markets.json');
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
