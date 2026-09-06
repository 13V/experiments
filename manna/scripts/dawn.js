#!/usr/bin/env node
'use strict';

/**
 * Manna — dawn.js
 *
 * Prints the desk's morning status (next dawn, whether it is open right now, the escrow balance
 * waiting to be claimed, fee shares waiting per Storehouse, the carry, and the current buyer), and
 * if dawn is open, calls `dawn()` — permissionless; the caller is tipped 0.5% of what falls — then
 * decodes and prints the `Dawn`/`Fallen` events from the receipt.
 *
 *   node manna/scripts/dawn.js [--dry-run] [--watch] [--switch-buyer]
 *
 * `--watch` loops forever: sleep until 5s past the next dawn, call, repeat, with a 30s backoff and
 * retry on RPC errors. `--switch-buyer` moves Manna's buyer from the Pons curve to the Uniswap v4
 * pool once the coin has graduated — an owner call, so (like every Manna owner setter except
 * setToken) it reverts `Sabbath()` on Sundays; this script detects that ahead of time and skips the
 * send rather than wasting gas.
 */

const chain = require('../../locate/scripts/chain');
const config = require('./config');

const ZERO = '0x' + '0'.repeat(40);
const DAWN_EVENT = 'Dawn(uint256,address,uint256,uint256,uint256,uint256,uint256)';
const FALLEN_EVENT = 'Fallen(uint256,uint256,uint256,uint256,uint256)';
const WATCH_SLEEP_CAP_MS = 6 * 3600 * 1000;
const RETRY_MS = 30000;

function sabbath(label) {
  if (!config.isSundayUtc()) return false;
  console.log(`  [Sabbath] ${label} would revert Sabbath() today (Sunday UTC) — skipping the send. Rerun on any other day.`);
  return true;
}

async function readStatus(addresses) {
  const [nextDawn] = await chain.call(addresses.manna, 'nextDawn()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [dawnOpen] = await chain.call(addresses.manna, 'dawnOpen()', [], ['bool']);
  await config.sleep(config.RPC_DELAY_MS);
  const [escrowBal] = await chain.call(addresses.pons.feeEscrow, 'balanceOfToken(address,address)', [addresses.manna, addresses.usdg], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [carry] = await chain.call(addresses.manna, 'carry()', [], ['uint256']);
  await config.sleep(config.RPC_DELAY_MS);
  const [buyer] = await chain.call(addresses.manna, 'buyer()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  const [count] = await chain.call(addresses.manna, 'storehouseCount()', [], ['uint256']);

  const storehouses = [];
  for (let i = 0n; i < count; i++) {
    await config.sleep(config.RPC_DELAY_MS);
    const s = await chain.call(addresses.manna, 'storehouseAt(uint256)', [i], [
      'address', 'address', 'address', 'bool', 'uint256', 'uint256', 'uint256', 'uint256',
    ]);
    const [vault, asset, oracle, active] = s;
    await config.sleep(config.RPC_DELAY_MS);
    const [feeShares] = await chain.call(addresses.manna, 'feeShares(address)', [vault], ['uint256']);
    let feeAssets = 0n;
    let assetDecimals = 18;
    if (feeShares > 0n) {
      await config.sleep(config.RPC_DELAY_MS);
      [feeAssets] = await chain.call(vault, 'convertToAssets(uint256)', [feeShares], ['uint256']);
      await config.sleep(config.RPC_DELAY_MS);
      const [d] = await chain.call(asset, 'decimals()', [], ['uint8']);
      assetDecimals = Number(d);
    }
    storehouses.push({ index: i, vault, asset, oracle, active, feeShares, feeAssets, assetDecimals });
  }

  return { nextDawn, dawnOpen, escrowBal, carry, buyer, storehouses };
}

function labelStorehouse(markets, s) {
  const m = markets.find((mm) => mm.token && chain.secp.sameAddress(mm.token, s.asset));
  return m ? m.symbol : s.vault;
}

function printStatus(addresses, markets, st) {
  const nextDawnMs = Number(st.nextDawn) * 1000;
  const secsToDawn = Math.round((nextDawnMs - Date.now()) / 1000);
  console.log(`next dawn      : ${new Date(nextDawnMs).toISOString()} ${st.dawnOpen ? '(OPEN NOW)' : `(in ~${Math.max(0, secsToDawn)}s)`}`);
  console.log(`escrow (Manna) : ${chain.fromUnits(st.escrowBal, addresses.usdgDecimals)} USDG waiting to be claimed`);
  console.log(`carry          : ${chain.fromUnits(st.carry, addresses.usdgDecimals)} USDG (unspent budget rolling to the next dawn)`);
  let buyerLabel = st.buyer;
  if (chain.secp.sameAddress(st.buyer, ZERO)) buyerLabel = '(none — zero address; run launch.js)';
  else if (addresses.curveSwapper && chain.secp.sameAddress(st.buyer, addresses.curveSwapper)) buyerLabel = `${st.buyer} (Pons curve)`;
  else if (addresses.v4Swapper && chain.secp.sameAddress(st.buyer, addresses.v4Swapper)) buyerLabel = `${st.buyer} (Uniswap v4)`;
  console.log(`buyer          : ${buyerLabel}`);
  console.log('fee shares waiting:');
  if (!st.storehouses.length) {
    console.log('  (no Storehouse registered yet — run deploy.js)');
  }
  for (const s of st.storehouses) {
    const label = labelStorehouse(markets, s);
    const assets = s.feeShares > 0n ? `${chain.fromUnits(s.feeAssets, s.assetDecimals)} ${label}` : 'nothing yet';
    console.log(`  ${String(label).padEnd(10)} ${s.feeShares.toString().padStart(20)} shares (~${assets})${s.active ? '' : '  [inactive]'}`);
  }
}

function explainNotOpen(st) {
  const now = Date.now() / 1000;
  const day = config.dayIndex(now);
  if (config.isSundayDay(day)) return 'today is Sunday UTC — nothing falls (Sabbath); Monday carries the weekend.';
  const secOfDay = now - day * config.DAY;
  if (secOfDay < 12 * 3600) return `not yet dawn today (opens 12:00 UTC, next dawn ${new Date(Number(st.nextDawn) * 1000).toISOString()}).`;
  return `Manna already fell today; next dawn ${new Date(Number(st.nextDawn) * 1000).toISOString()}.`;
}

/** Sends dawn() if `st.dawnOpen`, and prints the decoded Dawn/Fallen events. */
async function tryDawn(addresses, st) {
  if (!st.dawnOpen) {
    console.log(`\ndawn: ${explainNotOpen(st)}`);
    return;
  }
  console.log('\ndawn is open — calling dawn() (permissionless; the caller keeps a 0.5% tip)...');
  const receipt = await chain.send({ to: addresses.manna, data: chain.encodeCall('dawn()', []) });
  if (receipt.dryRun) return;

  const dawnLog = config.findLog(receipt, addresses.manna, DAWN_EVENT);
  if (dawnLog) {
    const [day] = chain.abiDecode(['uint256'], dawnLog.topics[1]);
    const [caller] = chain.abiDecode(['address'], dawnLog.topics[2]);
    const [income, toTreasury, toReserve, toCharity, spent] = chain.abiDecode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      dawnLog.data
    );
    const u = (x) => chain.fromUnits(x, addresses.usdgDecimals);
    console.log(`Dawn   day=${day} caller=${caller}`);
    console.log(`       income=${u(income)} toTreasury=${u(toTreasury)} toReserve=${u(toReserve)} toCharity=${u(toCharity)} spent=${u(spent)} USDG`);
  } else {
    console.log('  (no Dawn event found in the receipt)');
  }

  const fallenLog = config.findLog(receipt, addresses.manna, FALLEN_EVENT);
  if (fallenLog) {
    const [day] = chain.abiDecode(['uint256'], fallenLog.topics[1]);
    const [bought, tip, toStakers, toLenders] = chain.abiDecode(['uint256', 'uint256', 'uint256', 'uint256'], fallenLog.data);
    console.log(`Fallen day=${day} bought=${chain.fromUnits(bought, 18)} MANNA  tip=${chain.fromUnits(tip, 18)} toStakers=${chain.fromUnits(toStakers, 18)} toLenders=${chain.fromUnits(toLenders, 18)}`);
  } else {
    console.log('  (no Fallen event found in the receipt)');
  }
}

/** Moves Manna's buyer from the curve to the v4 pool once graduated, preserving every other
 * address setAddresses takes (reads them live rather than assuming config.json is current). */
async function maybeSwitchBuyer(addresses) {
  if (!addresses.curve) {
    console.log('  addresses.curve is not set yet (the coin has not launched) — skipping.');
    return;
  }
  if (!addresses.v4Swapper) {
    console.log('  addresses.v4Swapper is not set yet — run launch.js first — skipping.');
    return;
  }
  const [graduated] = await chain.call(addresses.curve, 'graduated()', [], ['bool']);
  await config.sleep(config.RPC_DELAY_MS);
  const [buyer] = await chain.call(addresses.manna, 'buyer()', [], ['address']);
  if (!graduated) {
    console.log('  the curve has not graduated yet — skipping.');
    return;
  }
  if (!addresses.curveSwapper || !chain.secp.sameAddress(buyer, addresses.curveSwapper)) {
    console.log(`  buyer is already ${buyer}, not the curve swapper — nothing to switch.`);
    return;
  }
  if (sabbath('manna.setAddresses (switch buyer to v4)')) return;

  await config.sleep(config.RPC_DELAY_MS);
  const [treasury] = await chain.call(addresses.manna, 'treasury()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  const [charity] = await chain.call(addresses.manna, 'charity()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  const [seller] = await chain.call(addresses.manna, 'seller()', [], ['address']);
  await config.sleep(config.RPC_DELAY_MS);
  const [escrow] = await chain.call(addresses.manna, 'escrow()', [], ['address']);

  console.log(`  graduated — switching buyer ${buyer} -> ${addresses.v4Swapper} (treasury/charity/seller/escrow unchanged)`);
  const args = [treasury, charity, addresses.v4Swapper, seller, escrow];
  config.selfTestAndLog('setAddresses (switch buyer)', ['address', 'address', 'address', 'address', 'address'], args);
  await chain.send({ to: addresses.manna, data: chain.encodeCall('setAddresses(address,address,address,address,address)', args) });
}

async function main() {
  const { addresses, markets } = config.load();
  const watch = process.argv.includes('--watch');
  const switchBuyer = process.argv.includes('--switch-buyer');

  console.log(`dawn ${chain.dryRun ? '(dry-run) ' : ''}${watch ? '(watching) ' : ''}\n`);
  console.log('Plan: print next-dawn status; if dawn is open, call dawn() and decode the receipt.');
  if (switchBuyer) console.log('Also: switch the buyer to the v4 pool if the coin has graduated.');
  if (watch) console.log('Also: loop forever, sleeping until each dawn.');
  console.log('');

  if (!addresses.manna) {
    console.log('Manna is not deployed yet (addresses.manna is empty) — run deploy.js first.');
    return;
  }

  if (switchBuyer) {
    console.log('--- --switch-buyer ---');
    await maybeSwitchBuyer(addresses);
    console.log('');
  }

  if (!watch) {
    const st = await readStatus(addresses);
    printStatus(addresses, markets, st);
    await tryDawn(addresses, st);
    return;
  }

  console.log('--watch: looping forever (Ctrl-C to stop)\n');
  for (;;) {
    let st;
    try {
      st = await readStatus(addresses);
    } catch (e) {
      console.error(`  RPC error reading status: ${e.message} — retrying in ${RETRY_MS / 1000}s`);
      await config.sleep(RETRY_MS);
      continue;
    }
    printStatus(addresses, markets, st);

    const waitMs = Number(st.nextDawn) * 1000 + 5000 - Date.now();
    if (waitMs > 0) {
      const chunk = Math.min(waitMs, WATCH_SLEEP_CAP_MS);
      console.log(`  sleeping ~${Math.ceil(chunk / 1000)}s...\n`);
      await config.sleep(chunk);
      continue;
    }
    try {
      await tryDawn(addresses, st);
    } catch (e) {
      console.error(`  error calling dawn(): ${e.message} — retrying in ${RETRY_MS / 1000}s`);
      await config.sleep(RETRY_MS);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
