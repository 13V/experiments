#!/usr/bin/env node
'use strict';

/**
 * Manna — status.js ("the Tape")
 *
 * Read-only. Works before any Manna contract exists: a market without a recorded
 * `marketId`/`oracle` just shows dashes and a note; Manna's own section says so plainly if
 * `addresses.manna` is still empty.
 *
 *   node manna/scripts/status.js
 *
 * Per market with a marketId: borrow APR (simple, not compounded: rate-per-second WAD *
 * 31536000), utilisation, short interest in the Giant and in USD, cap left (the Storehouse's
 * `liquidity()`), the Prophet's TWAP price against the pool's spot price and the lag between them,
 * and fee shares waiting at Manna. Then Manna's own numbers: next dawn, last dawn day, reserve vs
 * target, charity accrued, carry, staked/lender pools, escrow balance, and the next Jubilee date.
 * Finally, any Storehouse whose vault share price sits below its high-water mark (bad debt) with
 * what `restore()` could spend on it right now (`Manna.restoreCap`).
 */

const chain = require('../../locate/scripts/chain');
const config = require('./config');

const SECONDS_PER_YEAR = 31536000;

function printTable(headers, aligns, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) =>
    cells.map((c, i) => (aligns[i] === 'r' ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

async function marketRow(m, addresses) {
  if (m.hold) return [m.symbol, '(on hold)', '-', '-', '-', '-', '-', '-', '-', '-'];
  if (!m.marketId || !m.oracle) return [m.symbol, '(no market — run create-markets.js)', '-', '-', '-', '-', '-', '-', '-', '-'];

  const mpArr = [m.token, addresses.usdg, m.oracle, addresses.adaptiveCurveIrm, chain.bpsToWad(m.lltvBps)];
  const mkt = await chain.call(addresses.morpho, 'market(bytes32)', [m.marketId], [
    'uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128',
  ]);
  await config.sleep(config.RPC_DELAY_MS);
  const [totalSupplyAssets, , totalBorrowAssets] = mkt;
  const util = totalSupplyAssets > 0n ? Number((totalBorrowAssets * 1000000n) / totalSupplyAssets) / 1000000 : 0;

  const [rate] = await chain.call(
    addresses.adaptiveCurveIrm,
    `borrowRateView(${chain.MARKET_PARAMS_T},${chain.MARKET_T})`,
    [mpArr, mkt],
    ['uint256']
  );
  await config.sleep(config.RPC_DELAY_MS);
  const apr = (Number(rate) / 1e18) * SECONDS_PER_YEAR;

  const [price] = await chain.call(m.oracle, 'price()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [spot] = await chain.call(m.oracle, 'spot()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [tokenDecimalsRaw] = await chain.call(m.token, 'decimals()', [], ['uint8']);
  const tokenDecimals = Number(tokenDecimalsRaw);
  await config.sleep(config.RPC_DELAY_MS);

  const shortUsd = price > 0n ? config.giantToUsdRaw(totalBorrowAssets, price) : 0n;
  const lag = price > 0n ? Number(spot - price) / Number(price) : 0;

  let capLeft = '-';
  const vaultAddr = addresses.vaults && addresses.vaults[m.symbol];
  if (vaultAddr) {
    const [liq] = await chain.call(vaultAddr, 'liquidity()', [], ['uint256']);
    await config.sleep(config.RPC_DELAY_MS);
    capLeft = config.fmtUnits(liq, tokenDecimals, 2);
  }

  let feeShares = '-';
  if (addresses.manna && vaultAddr) {
    try {
      const [fs] = await chain.call(addresses.manna, 'feeShares(address)', [vaultAddr], ['uint256']);
      feeShares = fs.toString();
    } catch (e) {
      feeShares = '-';
    }
    await config.sleep(config.RPC_DELAY_MS);
  }

  return [
    m.symbol,
    config.fmtPct(apr),
    config.fmtPct(util),
    config.fmtUnits(totalBorrowAssets, tokenDecimals, 2),
    `$${config.fmtUnits(shortUsd, addresses.usdgDecimals, 2)}`,
    capLeft,
    `$${chain.oracleHumanPrice(price, tokenDecimals, addresses.usdgDecimals, 8)}`,
    `$${chain.oracleHumanPrice(spot, tokenDecimals, addresses.usdgDecimals, 8)}`,
    `${lag >= 0 ? '+' : ''}${(lag * 100).toFixed(2)}%`,
    feeShares,
  ];
}

async function printManna(addresses) {
  console.log('\nManna:');
  if (!addresses.manna) {
    console.log('  not deployed yet — run deploy.js');
    return;
  }

  const M = addresses.manna;
  const [nextDawn] = await chain.call(M, 'nextDawn()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [lastDawnDay] = await chain.call(M, 'lastDawnDay()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [reserve] = await chain.call(M, 'reserve()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [reserveTarget] = await chain.call(M, 'reserveTarget()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [charityAccrued] = await chain.call(M, 'charityAccrued()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [carry] = await chain.call(M, 'carry()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [stakedPool] = await chain.call(M, 'stakedPool()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [lenderPool] = await chain.call(M, 'lenderPool()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [nextJubileeDay] = await chain.call(M, 'nextJubileeDay()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [escrowBal] = await chain.call(addresses.pons.feeEscrow, 'balanceOfToken(address,address)', [M, addresses.usdg], ['uint256']);

  let tokenDecimals = 18;
  if (addresses.token) {
    await config.sleep(config.RPC_DELAY_MS);
    const [d] = await chain.call(addresses.token, 'decimals()', [], ['uint8']);
    tokenDecimals = Number(d);
  }

  const pct = reserveTarget > 0n ? Number((reserve * 10000n) / reserveTarget) / 100 : 0;

  console.log(`  next dawn       : ${new Date(Number(nextDawn) * 1000).toISOString()}`);
  console.log(`  last dawn day   : ${lastDawnDay > 0n ? new Date(Number(lastDawnDay) * config.DAY * 1000).toISOString().slice(0, 10) : '(never — dawn has not fallen yet)'}`);
  console.log(`  reserve         : ${chain.fromUnits(reserve, addresses.usdgDecimals)} / ${chain.fromUnits(reserveTarget, addresses.usdgDecimals)} USDG target (${pct.toFixed(1)}%)`);
  console.log(`  charity accrued : ${chain.fromUnits(charityAccrued, addresses.usdgDecimals)} USDG`);
  console.log(`  carry           : ${chain.fromUnits(carry, addresses.usdgDecimals)} USDG`);
  console.log(`  staked pool     : ${chain.fromUnits(stakedPool, tokenDecimals)} MANNA`);
  console.log(`  lender pool     : ${chain.fromUnits(lenderPool, tokenDecimals)} MANNA`);
  console.log(`  escrow balance  : ${chain.fromUnits(escrowBal, addresses.usdgDecimals)} USDG`);
  console.log(`  next Jubilee    : ${new Date(Number(nextJubileeDay) * config.DAY * 1000).toISOString().slice(0, 10)}`);
}

/** Any Storehouse whose vault share price sits below its high-water mark has taken bad debt; prints
 * how much `restore()` could spend on it right now (Reserve times that Storehouse's share of value,
 * at most once a day per Storehouse — see Manna.sol's `restoreCap`/`RestoreCooldown`). */
async function printRestoreStatus(addresses, markets) {
  if (!addresses.manna) return;
  const M = addresses.manna;
  const [count] = await chain.call(M, 'storehouseCount()', [], ['uint256']);
  if (count === 0n) return;

  const atRisk = [];
  for (let i = 0n; i < count; i++) {
    await config.sleep(config.RPC_DELAY_MS);
    const s = await chain.call(M, 'storehouseAt(uint256)', [i], [
      'address', 'address', 'address', 'bool', 'uint256', 'uint256', 'uint256', 'uint256',
    ]);
    const [vault, asset, , , , , highWater] = s;
    await config.sleep(config.RPC_DELAY_MS);
    const [vaultDecimals] = await chain.call(vault, 'decimals()', [], ['uint8']);
    const unit = 10n ** BigInt(vaultDecimals);
    await config.sleep(config.RPC_DELAY_MS);
    const [sharePrice] = await chain.call(vault, 'convertToAssets(uint256)', [unit], ['uint256']);
    if (sharePrice >= highWater) continue;

    await config.sleep(config.RPC_DELAY_MS);
    const [assetDecimalsRaw] = await chain.call(asset, 'decimals()', [], ['uint8']);
    const assetDecimals = Number(assetDecimalsRaw);
    await config.sleep(config.RPC_DELAY_MS);
    const [cap] = await chain.call(M, 'restoreCap(uint256)', [i], ['uint256']);
    const m = markets.find((mm) => mm.token && chain.secp.sameAddress(mm.token, asset));
    atRisk.push({ label: m ? m.symbol : vault, sharePrice, highWater, assetDecimals, cap });
  }

  console.log('\nStorehouses below high-water (restore available):');
  if (!atRisk.length) {
    console.log('  none — every Storehouse is at or above its high-water mark.');
    return;
  }
  for (const r of atRisk) {
    console.log(
      `  ${r.label}: share price ${config.fmtUnits(r.sharePrice, r.assetDecimals, 6)} < high-water ${config.fmtUnits(r.highWater, r.assetDecimals, 6)}` +
        ` — restoreCap ${chain.fromUnits(r.cap, addresses.usdgDecimals)} USDG`
    );
  }
}

async function main() {
  const { addresses, markets } = config.load();
  const chainIdHex = await chain.rpc('eth_chainId', []);
  console.log(`Manna status ("the Tape") — chain ${parseInt(chainIdHex, 16)} (${chainIdHex})`);
  console.log(`rpc ${addresses.rpc}\n`);

  const headers = ['SYMBOL', 'BORROW-APR', 'UTIL', 'SHORT(GIANT)', 'SHORT(USD)', 'CAP-LEFT(LIQ)', 'PROPHET', 'SPOT', 'LAG', 'FEE-SHARES'];
  const aligns = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];
  const rows = [];
  for (const m of markets) {
    rows.push(await marketRow(m, addresses));
    await config.sleep(config.RPC_DELAY_MS);
  }
  printTable(headers, aligns, rows);

  await printManna(addresses);
  await printRestoreStatus(addresses, markets);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
