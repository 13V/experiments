#!/usr/bin/env node
'use strict';

/**
 * Manna — sunday.js
 *
 * Builds the weekly Sunday Service report as a JSON file for the site, and prints a Markdown
 * version to stdout for the human announcement. Read-only, no `--dry-run` (there is nothing to
 * send). Works before deployment: markets with no market yet or on hold are left out of `markets`
 * and explained in `notes` instead; `manna` reads as all zeros with a note if Manna is not deployed.
 *
 *   node manna/scripts/sunday.js [--out manna/site/data/sunday.json]
 */

const fs = require('fs');
const path = require('path');
const chain = require('../../locate/scripts/chain');
const config = require('./config');

const SECONDS_PER_YEAR = 31536000;
const ZERO_MANNA = { fallen: '0', gathered: '0', spoiled: '0', reserve: '0', charityAccrued: '0', stakedPool: '0' };

async function marketReport(m, addresses) {
  if (m.hold || !m.marketId || !m.oracle) return null;

  const mpArr = [m.token, addresses.usdg, m.oracle, addresses.adaptiveCurveIrm, chain.bpsToWad(m.lltvBps)];
  const mkt = await chain.call(addresses.morpho, 'market(bytes32)', [m.marketId], [
    'uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128',
  ]);
  await config.sleep(config.RPC_DELAY_MS);
  const [totalSupplyAssets, , totalBorrowAssets] = mkt;
  const utilisation = totalSupplyAssets > 0n ? Number((totalBorrowAssets * 1000000n) / totalSupplyAssets) / 1000000 : 0;

  const [rate] = await chain.call(
    addresses.adaptiveCurveIrm,
    `borrowRateView(${chain.MARKET_PARAMS_T},${chain.MARKET_T})`,
    [mpArr, mkt],
    ['uint256']
  );
  await config.sleep(config.RPC_DELAY_MS);
  const rateApr = (Number(rate) / 1e18) * SECONDS_PER_YEAR * 100; // a percent, e.g. 16.23

  const [price] = await chain.call(m.oracle, 'price()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const shortInterestUsd = price > 0n ? Number(chain.fromUnits(config.giantToUsdRaw(totalBorrowAssets, price), addresses.usdgDecimals)) : 0;

  return {
    symbol: m.symbol,
    rateApr: Number(rateApr.toFixed(4)),
    utilisation: Number(utilisation.toFixed(6)),
    shortInterestUsd: Number(shortInterestUsd.toFixed(2)),
    capUsd: m.initialCapUsd,
  };
}

/** Returns { manna, reserve, reserveTarget } — the last two (raw BigInts) are only for `notes`. */
async function mannaReport(addresses) {
  if (!addresses.manna) return { manna: ZERO_MANNA, reserve: 0n, reserveTarget: 0n };

  const M = addresses.manna;
  const [periodFallen] = await chain.call(M, 'periodFallen()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [periodGathered] = await chain.call(M, 'periodGathered()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [periodSpoiled] = await chain.call(M, 'periodSpoiled()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [reserve] = await chain.call(M, 'reserve()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [reserveTarget] = await chain.call(M, 'reserveTarget()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [charityAccrued] = await chain.call(M, 'charityAccrued()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [stakedPool] = await chain.call(M, 'stakedPool()', [], ['uint256']);

  let tokenDecimals = 18;
  if (addresses.token) {
    await config.sleep(config.RPC_DELAY_MS);
    const [d] = await chain.call(addresses.token, 'decimals()', [], ['uint8']);
    tokenDecimals = Number(d);
  }

  return {
    manna: {
      fallen: chain.fromUnits(periodFallen, tokenDecimals),
      gathered: chain.fromUnits(periodGathered, tokenDecimals),
      spoiled: chain.fromUnits(periodSpoiled, tokenDecimals),
      reserve: chain.fromUnits(reserve, addresses.usdgDecimals),
      charityAccrued: chain.fromUnits(charityAccrued, addresses.usdgDecimals),
      stakedPool: chain.fromUnits(stakedPool, tokenDecimals),
    },
    reserve,
    reserveTarget,
  };
}

function buildNotes(markets, addresses, reserve, reserveTarget) {
  const notes = [];
  for (const m of markets) {
    if (m.hold) notes.push(`${m.symbol} waits for its buffer`);
    else if (!m.marketId || !m.oracle) notes.push(`${m.symbol} market not created yet — run create-markets.js`);
  }
  if (!addresses.manna) {
    notes.push('Manna not yet deployed — run deploy.js');
  } else if (reserveTarget > 0n) {
    const pct = Number((reserve * 10000n) / reserveTarget) / 100;
    notes.push(`Reserve at ${pct.toFixed(0)}% of target`);
  } else {
    notes.push("Joseph's Reserve target is not yet meaningful (no Storehouse holds value)");
  }
  if (!addresses.token) notes.push('MANNA has not launched yet — run launch.js');
  return notes;
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# Sunday Service — ${report.generatedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`Week: ${report.week.from} to ${report.week.to}`);
  lines.push('');
  lines.push('## Markets');
  lines.push('');
  if (report.markets.length) {
    lines.push('| Symbol | Borrow APR | Utilisation | Short interest (USD) | Cap (USD) |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const m of report.markets) {
      lines.push(
        `| ${m.symbol} | ${m.rateApr.toFixed(2)}% | ${(m.utilisation * 100).toFixed(2)}% | ` +
          `$${m.shortInterestUsd.toLocaleString('en-US')} | $${m.capUsd.toLocaleString('en-US')} |`
      );
    }
  } else {
    lines.push('_No market is live yet._');
  }
  lines.push('');
  lines.push('## Manna');
  lines.push('');
  lines.push(`- Fallen: ${report.manna.fallen} MANNA`);
  lines.push(`- Gathered: ${report.manna.gathered} MANNA`);
  lines.push(`- Spoiled: ${report.manna.spoiled} MANNA`);
  lines.push(`- Reserve: ${report.manna.reserve} USDG`);
  lines.push(`- Charity accrued: ${report.manna.charityAccrued} USDG`);
  lines.push(`- Staked pool: ${report.manna.stakedPool} MANNA`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  if (report.notes.length) {
    for (const n of report.notes) lines.push(`- ${n}`);
  } else {
    lines.push('_Nothing notable this week._');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const { addresses, markets } = config.load();

  console.log(`sunday — building the weekly report for chain ${addresses.chainId}\n`);

  const now = new Date();
  const from = new Date(now.getTime() - 7 * config.DAY * 1000);

  const marketReports = [];
  for (const m of markets) {
    marketReports.push(await marketReport(m, addresses));
    await config.sleep(config.RPC_DELAY_MS);
  }

  const { manna, reserve, reserveTarget } = await mannaReport(addresses);
  const notes = buildNotes(markets, addresses, reserve, reserveTarget);

  const report = {
    generatedAt: now.toISOString(),
    week: { from: from.toISOString(), to: now.toISOString() },
    markets: marketReports.filter(Boolean),
    manna,
    notes,
  };

  const outArg = chain.flagValue('--out');
  const outPath = outArg ? path.resolve(outArg) : path.join(config.REPO_ROOT, 'manna', 'site', 'data', 'sunday.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${outPath}\n`);

  console.log(toMarkdown(report));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
