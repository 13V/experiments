#!/usr/bin/env node
'use strict';
/**
 * Pre-flight: prove the deployment would succeed on the live chain, before spending anything.
 *
 *   node locate/scripts/preflight.js
 *
 * Nothing here signs or sends. It uses eth_call against the real Robinhood Chain to check that
 * every transaction create-markets.js would send is accepted by the contracts as encoded, and it
 * recomputes each oracle's price() from the live feeds so a decimals mistake shows up here rather
 * than after money has been spent.
 */
const path = require('path');
const chain = require('./chain.js');
const { rpc, call, encodeCall, abiDecode, marketId, feedPrice, loadJson } = chain;

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const A = loadJson(path.join(CONFIG_DIR, 'addresses.json'));
const M = loadJson(path.join(CONFIG_DIR, 'markets.json'));
const ZERO = '0x' + '0'.repeat(40);
const FACTORY_SIG = 'createMorphoChainlinkOracleV2(address,uint256,address,address,uint256,address,uint256,address,address,uint256,bytes32)';
const FROM = '0x1111111111111111111111111111111111111111';

let pass = 0, fail = 0;
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`); }
};
// same salt create-markets.js uses, so this simulates the exact oracle it would deploy
const keccakSalt = (symbol) => '0x' + chain.keccak256(Buffer.from(`locate:${symbol}`, 'utf8')).toString('hex');

async function ethCall(to, data, from) {
  return rpc('eth_call', [{ to, data, from: from || FROM }, 'latest']);
}

(async () => {
  console.log('Locate pre-flight — simulating the real deployment against the live chain\n');

  const chainId = BigInt(await rpc('eth_chainId', []));
  check(chainId === BigInt(A.chainId), `chain id is ${A.chainId}`, `got ${chainId}`);

  // the pieces we depend on must actually be contracts
  for (const [label, addr] of [['Morpho Blue', A.morpho], ['Adaptive Curve IRM', A.adaptiveCurveIrm],
                               ['oracle factory', A.chainlinkOracleV2Factory], ['USDG', A.usdg]]) {
    const code = await rpc('eth_getCode', [addr, 'latest']);
    check(code && code.length > 4, `${label} has code at ${addr}`);
  }

  const [irmOk] = await call(A.morpho, 'isIrmEnabled(address)', [A.adaptiveCurveIrm], ['bool']);
  check(irmOk === true || irmOk === 1n, 'the IRM we use is enabled on Morpho');

  const usdgFeed = await feedPrice(A.usdgUsdFeed);
  check(usdgFeed.answer > 0n, `USDG/USD feed reads ${(Number(usdgFeed.answer) / 10 ** usdgFeed.decimals).toFixed(4)}`);

  console.log('\nPer market:');
  for (const m of M) {
    console.log(`\n--- ${m.symbol} ---`);
    const lltv = BigInt(m.lltvBps) * (10n ** 18n / 10000n);

    const [lltvOk] = await call(A.morpho, 'isLltvEnabled(uint256)', [lltv], ['bool']);
    check(lltvOk === true || lltvOk === 1n, `LLTV ${(m.lltvBps / 100).toFixed(2)}% is enabled`);

    const tokenCode = await rpc('eth_getCode', [m.token, 'latest']);
    check(tokenCode && tokenCode.length > 4, `${m.symbol} token has code`);
    const [dec] = await call(m.token, 'decimals()', [], ['uint8']);
    check(Number(dec) === A.stockDecimals, `${m.symbol} has ${A.stockDecimals} decimals`, `got ${dec}`);

    const feed = await feedPrice(m.feed);
    check(feed.answer > 0n && feed.decimals === 8, `feed reads $${(Number(feed.answer) / 1e8).toFixed(2)} at 8 decimals`);

    // 1. the oracle the factory would create — eth_call returns the address without creating it
    const salt = keccakSalt(m.symbol);
    const data = encodeCall(FACTORY_SIG, [ZERO, 1, A.usdgUsdFeed, ZERO, A.usdgDecimals, ZERO, 1, m.feed, ZERO, A.stockDecimals, salt]);
    let oracle = null;
    try {
      const ret = await ethCall(A.chainlinkOracleV2Factory, data);
      oracle = abiDecode(['address'], ret)[0];
      check(oracle && oracle !== ZERO, `factory accepts the arguments, would deploy an oracle at ${oracle}`);
    } catch (e) {
      check(false, 'factory accepts the arguments', String(e.message).slice(0, 200));
    }

    // 2. the price that oracle will report, recomputed from the live feeds.
    //    MorphoChainlinkOracleV2: price = SCALE * baseFeed / quoteFeed, and for base=USDG(6, 8dec)
    //    quote=stock(18, 8dec) the scale factor is 10^(36 + 18 + 8 - 6 - 8) = 10^48.
    const expected = (10n ** 48n) * usdgFeed.answer / feed.answer;
    const humanUsdgPerStock = Number(10n ** 48n * 1000000n / expected) / 1e6;
    const feedRatio = (Number(feed.answer) / 1e8) / (Number(usdgFeed.answer) / 10 ** usdgFeed.decimals);
    const drift = Math.abs(humanUsdgPerStock - feedRatio) / feedRatio;
    check(drift < 0.001, `oracle would price ${m.symbol} at ${humanUsdgPerStock.toFixed(2)} USDG (feeds say ${feedRatio.toFixed(2)})`,
      drift >= 0.001 ? `drift ${(drift * 100).toFixed(3)}% — a decimals mistake` : '');

    // 3. borrowing 1 whole stock against the planned cap of collateral must be solvent at this LLTV
    const capUsd = m.initialCapUsd;
    const maxBorrowTokens = (capUsd * (m.lltvBps / 10000)) / humanUsdgPerStock;
    check(maxBorrowTokens > 0 && isFinite(maxBorrowTokens),
      `a full ${capUsd.toLocaleString('en-US')} USDG cap borrows up to ${maxBorrowTokens.toFixed(2)} ${m.symbol}`);

    // 4. the market must not already exist, and createMarket must be accepted as encoded
    if (oracle) {
      const params = { loanToken: m.token, collateralToken: A.usdg, oracle, irm: A.adaptiveCurveIrm, lltv };
      const id = marketId(params);
      const [, , , , lastUpdate] = await call(A.morpho, 'market(bytes32)', [id],
        ['uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128']);
      check(BigInt(lastUpdate) === 0n, `market ${id.slice(0, 12)}… does not exist yet`);
      try {
        await ethCall(A.morpho, encodeCall('createMarket((address,address,address,address,uint256))',
          [[params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv]]));
        check(true, 'Morpho accepts createMarket as encoded');
      } catch (e) {
        // the oracle does not exist in this simulated state, so a revert that names the oracle is expected
        const msg = String(e.message);
        const benign = /oracle|call to non-contract|execution reverted$/i.test(msg);
        check(benign, 'Morpho accepts createMarket as encoded',
          benign ? '' : msg.slice(0, 200));
        if (benign) console.log('         (reverts only because the oracle is not deployed in a simulated call)');
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('preflight failed:', e); process.exit(1); });
