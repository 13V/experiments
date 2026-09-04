#!/usr/bin/env node
'use strict';

/**
 * Locate — status.js
 *
 * Read-only. Works today, before any Locate contract exists: markets without a recorded
 * `oracle`/`marketId` just show feed price / cap and skip the Morpho/vault columns.
 *
 *   node locate/scripts/status.js
 *
 * Prints Morpho's owner/enabled flags (so the run proves the reads are actually reaching
 * the right contract), then one aligned line per configured market.
 */

const chain = require('./chain');

const SECONDS_PER_YEAR = 365 * 24 * 3600;
const STALE_HOURS = 26;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(decimalStr, places) {
  const neg = decimalStr.startsWith('-');
  const s = neg ? decimalStr.slice(1) : decimalStr;
  const [i, f = ''] = s.split('.');
  const out = places === 0 ? i : `${i}.${(f + '0'.repeat(places)).slice(0, places)}`;
  return neg ? `-${out}` : out;
}

function fmtUnits(units, decimals, places = 4) {
  return truncate(chain.fromUnits(units, decimals), places);
}

function fmtPct(fraction, places = 2) {
  return `${(fraction * 100).toFixed(places)}%`;
}

/** Fri 20:00 ET through Sun 20:00 ET — the window Chainlink freezes these feeds in. */
function isWeekendFreeze(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const wd = parts.find((p) => p.type === 'weekday').value;
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  if (wd === 'Fri' && hour >= 20) return true;
  if (wd === 'Sat') return true;
  if (wd === 'Sun' && hour < 20) return true;
  return false;
}

function ageFlag(ageSeconds) {
  if (ageSeconds <= STALE_HOURS * 3600) return '';
  return isWeekendFreeze(new Date()) ? 'WEEKEND' : 'STALE';
}

/** Simple left/right-aligned column table. `aligns[i]` = 'l' | 'r'. */
function printTable(headers, aligns, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) =>
    cells.map((c, i) => (aligns[i] === 'r' ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ---------------------------------------------------------------------------

async function main() {
  const addresses = chain.loadJson(chain.ADDRESSES_PATH);
  const markets = chain.loadJson(chain.MARKETS_PATH);
  const MORPHO = addresses.morpho;
  const IRM = addresses.adaptiveCurveIrm;
  const STOCK_DEC = addresses.stockDecimals;
  const USDG_DEC = addresses.usdgDecimals;

  const chainIdHex = await chain.rpc('eth_chainId', []);
  console.log(`Locate status — chain ${parseInt(chainIdHex, 16)} (${chainIdHex})  morpho ${MORPHO}`);
  console.log(`rpc ${addresses.rpc}\n`);

  const [owner] = await chain.call(MORPHO, 'owner()', [], ['address']);
  console.log(`Morpho owner            : ${owner}`);
  const [irmEnabled] = await chain.call(MORPHO, 'isIrmEnabled(address)', [IRM], ['bool']);
  console.log(`Adaptive Curve IRM      : ${IRM}  enabled=${irmEnabled}`);
  console.log('Enabled LLTVs:');
  for (const bps of addresses.enabledLltvBps) {
    const wad = chain.bpsToWad(bps);
    const [enabled] = await chain.call(MORPHO, 'isLltvEnabled(uint256)', [wad], ['bool']);
    console.log(`  ${(bps / 100).toFixed(2).padStart(6)}%  (${wad.toString().padStart(20)} wad)  enabled=${enabled}`);
  }
  console.log('');

  const headers = [
    'SYMBOL', 'PRICE(USD)', 'AGE(m)', 'FLAG', 'LLTV', 'CAP(USD)', 'CAP(TOKENS)',
    'SUPPLY', 'BORROW', 'UTIL', 'BORROW-APY', 'ORACLE(USDG/tok)', 'VAULT-ASSETS', 'VAULT-LIQ', 'VAULT-IDLE',
  ];
  const aligns = ['l', 'r', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];
  const rows = [];

  for (const m of markets) {
    const feed = await chain.feedPrice(m.feed);
    const priceUsd = truncate(chain.fromUnits(feed.answer, feed.decimals), 2);
    const ageMin = Math.floor(feed.ageSeconds / 60);
    const flag = ageFlag(feed.ageSeconds);
    const capTokenUnits = chain.capUnitsFromUsd(m.initialCapUsd, feed, STOCK_DEC);
    const capTokens = fmtUnits(capTokenUnits, STOCK_DEC, 2);

    let supply = '-', borrow = '-', util = '-', apy = '-', oraclePrice = '-';
    if (m.marketId && m.oracle) {
      const mp = [m.token, addresses.usdg, m.oracle, IRM, chain.bpsToWad(m.lltvBps)];
      const mkt = await chain.call(MORPHO, 'market(bytes32)', [m.marketId], [
        'uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128',
      ]);
      const [totalSupplyAssets, , totalBorrowAssets] = mkt;
      supply = fmtUnits(totalSupplyAssets, STOCK_DEC, 2);
      borrow = fmtUnits(totalBorrowAssets, STOCK_DEC, 2);
      util = totalSupplyAssets > 0n ? fmtPct(Number(totalBorrowAssets * 1000000n / totalSupplyAssets) / 1000000) : '0.00%';

      const [rate] = await chain.call(IRM, `borrowRateView(${chain.MARKET_PARAMS_T},${chain.MARKET_T})`, [mp, mkt], ['uint256']);
      const ratePerSecond = Number(rate) / 1e18;
      apy = fmtPct(Math.exp(ratePerSecond * SECONDS_PER_YEAR) - 1);

      const [price] = await chain.call(m.oracle, 'price()', [], ['uint256']);
      oraclePrice = truncate(chain.oracleHumanPrice(price, STOCK_DEC, USDG_DEC), 2);
    }

    let vAssets = '-', vLiq = '-', vIdle = '-';
    const vaultAddr = addresses.vaults && addresses.vaults[m.symbol];
    if (vaultAddr) {
      const [totalAssets] = await chain.call(vaultAddr, 'totalAssets()', [], ['uint256']);
      const [liquidity] = await chain.call(vaultAddr, 'liquidity()', [], ['uint256']);
      const [idle] = await chain.call(vaultAddr, 'idle()', [], ['uint256']);
      vAssets = fmtUnits(totalAssets, STOCK_DEC, 2);
      vLiq = fmtUnits(liquidity, STOCK_DEC, 2);
      vIdle = fmtUnits(idle, STOCK_DEC, 2);
    }

    rows.push([
      m.symbol, priceUsd, ageMin, flag, `${(m.lltvBps / 100).toFixed(2)}%`,
      m.initialCapUsd.toLocaleString('en-US'), capTokens,
      supply, borrow, util, apy, oraclePrice, vAssets, vLiq, vIdle,
    ]);
  }

  printTable(headers, aligns, rows);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
