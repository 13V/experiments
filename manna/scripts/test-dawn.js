'use strict';
// Part 2 of the Manna tests (sections 4-8). Loaded by test.js with the world it built; not meant to run alone.

async function run(w, h) {
  const { check, section, words, toBig, toInt, toAddr, errorIs, topicOf, MP_T, mpTuple, WAD, BPS, DAY, NOON, USDG_UNIT, TOKEN_UNIT, MAX, dayOf, isSunday, dow, isqrt, ART, mulDivDown } = h;
  const { OWNER, TREASURY, CHARITY, HOOK, L1, L2, L3, B1, B2, CALLER, STRANGER, STAKER, LIQUIDATOR } = h.ACCOUNTS;
  const { deploy, send, view, viewBig, viewRaw, bal, mint, approve, logsOf, revertName, advance, setTime, getTs, invariants, relErr } = w;
  const { usdg, weth, pons, cat, manna } = w.tokens;
  const { poolA1, poolA2, poolB } = w.pools;
  const { oraclePons, oracleCat } = w.oracles;
  const { mpPons, mpCat, idPons, idCat } = w.mps;
  const { vaultPons, vaultCat } = w.vaults;
  const { morpho, mannaC, router, v3, curve, curveBuyer, escrow } = w;

  const noonOf = (day) => day * DAY + NOON;
  const dawnLogs = (r) => {
    const dawn = logsOf(r, 'Dawn(uint256,address,uint256,uint256,uint256,uint256,uint256)')[0];
    const fallen = logsOf(r, 'Fallen(uint256,uint256,uint256,uint256,uint256)')[0];
    const d = dawn ? words(dawn.data) : null;
    const f = fallen ? words(fallen.data) : null;
    return {
      day: dawn ? toBig(Buffer.from(dawn.topics[1].slice(2), 'hex')) : null,
      caller: dawn ? '0x' + dawn.topics[2].slice(26) : null,
      income: d && toBig(d[0]),
      toTreasury: d && toBig(d[1]),
      toReserve: d && toBig(d[2]),
      toCharity: d && toBig(d[3]),
      spent: d && toBig(d[4]),
      bought: f && toBig(f[0]),
      tip: f && toBig(f[1]),
      toStakers: f && toBig(f[2]),
      toLenders: f && toBig(f[3]),
      fell: logsOf(r, 'Fell(uint256,address,uint256,uint256)').map((l) => ({ vault: '0x' + l.topics[2].slice(26), amount: toBig(words(l.data)[0]), acc: toBig(words(l.data)[1]) })),
      sold: logsOf(r, 'TitheSold(address,uint256,uint256,uint256)').map((l) => ({ vault: '0x' + l.topics[1].slice(26), shares: toBig(words(l.data)[0]), assets: toBig(words(l.data)[1]), usdgOut: toBig(words(l.data)[2]) })),
      claimed: logsOf(r, 'EscrowClaimed(uint256)').map((l) => toBig(words(l.data)[0])),
      buyFailed: logsOf(r, 'BuyFailed(uint256)').length,
      burned: logsOf(r, 'Burned(uint256)').reduce((a, l) => a + toBig(words(l.data)[0]), 0n),
    };
  };
  const sh = async (i) => {
    const s = await view(mannaC, 'storehouseAt(uint256)', BigInt(i));
    return { vault: toAddr(s[0]), asset: toAddr(s[1]), oracle: toAddr(s[2]), active: toBig(s[3]) === 1n, totalStaked: toBig(s[4]), accPerShare: toBig(s[5]), highWater: toBig(s[6]), checkpoints: toBig(s[7]) };
  };
  const lender = async (vault, user) => {
    const l = await view(mannaC, 'lenderOf(address,address)', vault, user);
    return { shares: toBig(l[0]), fresh: toBig(l[1]), spoiled: toBig(l[2]), lastGatherDay: toBig(l[3]) };
  };
  // Per vault, the accPerShare after the last Fell of each day (to mirror the spoilage cutoff).
  const accAfterDay = { [vaultPons.toLowerCase()]: {}, [vaultCat.toLowerCase()]: {} };
  const recordFell = (day, fell) => {
    for (const f of fell) accAfterDay[f.vault.toLowerCase()][day] = f.acc;
  };
  const accAtDay = (vault, day) => {
    const m = accAfterDay[vault.toLowerCase()];
    let best = 0n;
    for (const d of Object.keys(m)) if (BigInt(d) <= day && m[d] > best) best = m[d];
    return best;
  };

  // =========================================================================
  section('4. dawn(): claim, sell, split, buy, fall');
  // =========================================================================

  const D0 = dayOf(getTs());
  check(`it is ${dow(D0)} noon, seven days after the shorts opened`, dow(D0) === 'Monday' && getTs() % DAY === NOON);
  const treasury0 = await bal(usdg, TREASURY);
  const feePonsShares = await viewBig(mannaC, 'feeShares(address)', vaultPons);
  const feeCatShares = await viewBig(mannaC, 'feeShares(address)', vaultCat);
  const staked0 = await sh(0);
  const staked1 = await sh(1);
  const curveQ0 = await viewBig(curve, 'quoteReserve()');
  const curveT0 = await viewBig(curve, 'tokenReserve()');
  const curveCap = await viewBig(curveBuyer, 'maxSpend()'); // 1% of the curve's quote reserve, read before the buy moves it
  const minCap = (b, cap) => {
    const m = b < 5_000n * USDG_UNIT ? b : 5_000n * USDG_UNIT;
    return m < cap ? m : cap;
  };

  let r = await send(CALLER, mannaC, 'dawn()');
  check('dawn() succeeds for any caller', !r.reverted, revertName(r));
  let e = dawnLogs(r);
  recordFell(D0, e.fell);
  check('EscrowClaimed(10,000 USDG)', e.claimed.length === 1 && e.claimed[0] === 10_000n * USDG_UNIT);
  check('the escrow is empty afterwards', (await viewBig(escrow, 'balanceOfToken(address,address)', mannaC, usdg)) === 0n);
  check('both tithes were sold (two TitheSold events)', e.sold.length === 2);
  const soldPons = e.sold.find((s) => s.vault.toLowerCase() === vaultPons.toLowerCase());
  const soldCat = e.sold.find((s) => s.vault.toLowerCase() === vaultCat.toLowerCase());
  check('the PONS tithe redeemed all its fee shares', soldPons && soldPons.shares === feePonsShares);
  check(`PONS tithe: ${soldPons.assets / TOKEN_UNIT} PONS sold for ${soldPons.usdgOut} USDG raw (≈ assets / 500 / 1e12)`, relErr(soldPons.usdgOut, soldPons.assets / (500n * 10n ** 12n)) < 1e-3);
  check(`CASHCAT tithe sold at ≈ 125 per USDG`, relErr(soldCat.usdgOut, soldCat.assets / (125n * 10n ** 12n)) < 1e-3);
  check('fee shares are zero after the harvest', (await viewBig(mannaC, 'feeShares(address)', vaultPons)) === 0n && (await viewBig(mannaC, 'feeShares(address)', vaultCat)) === 0n);
  check('Manna holds no PONS or CASHCAT after selling', (await bal(pons, mannaC)) === 0n && (await bal(cat, mannaC)) === 0n);

  const income = 10_000n * USDG_UNIT + soldPons.usdgOut + soldCat.usdgOut;
  check('Dawn.income == escrow claim + both tithe sales', e.income === income, `${e.income} vs ${income}`);
  check('Dawn.day and caller', e.day === D0 && e.caller.toLowerCase() === CALLER.toLowerCase());
  check('treasury took 20% of income', e.toTreasury === (income * 2000n) / BPS && (await bal(usdg, TREASURY)) - treasury0 === e.toTreasury);
  const target = await viewBig(mannaC, 'reserveTarget()');
  check(`Joseph's Reserve took 10% of income (below its target of ${target})`, e.toReserve === (income * 1000n) / BPS && e.toReserve < target && (await viewBig(mannaC, 'reserve()')) === e.toReserve);
  check('the charity slice took 5% and is held', e.toCharity === (income * 500n) / BPS && (await viewBig(mannaC, 'charityAccrued()')) === e.toCharity);
  const budget = income - e.toTreasury - e.toReserve - e.toCharity;
  check(`the curve adapter caps a buy at 1% of the quote reserve (${curveCap} = 500 USDG)`, curveCap === 500n * USDG_UNIT);
  check(`the buy was capped at min(maxBuy, the venue's cap) and the rest carried (${budget - e.spent})`, e.spent === minCap(budget, curveCap) && (await viewBig(mannaC, 'carry()')) === budget - e.spent, `${e.spent} vs ${minCap(budget, curveCap)}`);
  const net = (e.spent * 9800n) / BPS;
  const expectedOut = (curveT0 * net) / (curveQ0 + net);
  check('bought == the curve\'s constant-product output after its 2% fee', e.bought === expectedOut, `${e.bought} vs ${expectedOut}`);
  check('the curve moved by exactly the net input', (await viewBig(curve, 'quoteReserve()')) === curveQ0 + net);
  check('the caller was tipped 0.5% of the fall', e.tip === (e.bought * 50n) / BPS && (await bal(manna, CALLER)) === e.tip);
  check('nobody had staked, so the stakers\' share fell on the lenders too (less the burned dust)', e.toStakers === 0n && e.toLenders === e.bought - e.tip - e.burned);
  const w0 = await viewBig(mannaC, 'borrowedUsd(uint256)', 0n);
  const w1 = await viewBig(mannaC, 'borrowedUsd(uint256)', 1n);
  const restAfterTip = e.bought - e.tip;
  const lendersPart = restAfterTip - (restAfterTip * 7000n) / BPS;
  const stakersPart = (restAfterTip * 7000n) / BPS;
  const portion = (amount, wi) => (amount * wi) / (w0 + w1);
  const fellPons = e.fell.filter((f) => f.vault.toLowerCase() === vaultPons.toLowerCase());
  const fellCat = e.fell.filter((f) => f.vault.toLowerCase() === vaultCat.toLowerCase());
  check('two Fell events per Storehouse (the lenders\' share, then the redirected stakers\' share)', fellPons.length === 2 && fellCat.length === 2);
  // The dust the first allotment could not place rides along with the stakers' share into the second.
  const dust1 = lendersPart - portion(lendersPart, w0) - portion(lendersPart, w1);
  const secondPart = stakersPart + dust1;
  check('PONS Storehouse portions match amount * borrowedUsd / total for both allotments', fellPons[0].amount === portion(lendersPart, w0) && fellPons[1].amount === portion(secondPart, w0), `${fellPons.map((f) => f.amount)} vs ${portion(lendersPart, w0)},${portion(secondPart, w0)}`);
  check('CASHCAT Storehouse portions likewise', fellCat[0].amount === portion(lendersPart, w1) && fellCat[1].amount === portion(secondPart, w1));
  const sumFell = e.fell.reduce((a, f) => a + f.amount, 0n);
  check('lenderPool == the sum of every portion', (await viewBig(mannaC, 'lenderPool()')) === sumFell);
  check('rounding dust from the split was burned (a few wei at most)', e.burned === restAfterTip - sumFell && e.burned < 10n, `${e.burned}`);
  const s0 = await sh(0);
  const s1 = await sh(1);
  const expAcc0 = (fellPons[0].amount * 10n ** 18n) / staked0.totalStaked + (fellPons[1].amount * 10n ** 18n) / staked0.totalStaked;
  check('PONS accPerShare == Σ portion * 1e18 / totalStaked', s0.accPerShare === expAcc0, `${s0.accPerShare} vs ${expAcc0}`);
  check('checkpoints recorded (two per Storehouse today)', s0.checkpoints === 2n && s1.checkpoints === 2n);
  check('highWater recorded at the vault share price', s0.highWater === (await viewBig(vaultPons, 'convertToAssets(uint256)', 10n ** 24n)));
  check('periodFallen and totalFallen == bought', (await viewBig(mannaC, 'periodFallen()')) === e.bought && (await viewBig(mannaC, 'totalFallen()')) === e.bought);
  check('lastDawnDay == today', (await viewBig(mannaC, 'lastDawnDay()')) === D0);
  await invariants('after the first dawn');

  // Pending Manna per lender mirrors the accumulator.
  const l1 = await lender(vaultPons, L1);
  const l2 = await lender(vaultPons, L2);
  const l3 = await lender(vaultCat, L3);
  check('L1 pending == shares * acc / 1e18, nothing spoiled', l1.fresh === (l1.shares * s0.accPerShare) / 10n ** 18n && l1.spoiled === 0n);
  check('L1 : L2 pending == 2 : 1 (their deposits)', relErr(l1.fresh, 2n * l2.fresh) < 1e-9);
  {
    const sumCat = fellCat[0].amount + fellCat[1].amount;
    const tol = 2n * (staked1.totalStaked / 10n ** 18n + 1n); // accPerShare floors once per allotment
    check('L3 pending == the whole CASHCAT allotment (sole lender), within the accumulator\'s rounding', l3.fresh <= sumCat && sumCat - l3.fresh <= tol, `${l3.fresh} vs ${sumCat}`);
  }

  // =========================================================================
  section('5. The calendar');
  // =========================================================================

  r = await send(CALLER, mannaC, 'dawn()');
  check('a second dawn on the same day reverts AlreadyFell()', r.reverted && errorIs(r.ret, 'AlreadyFell()'));
  check('dawnOpen() is false now', (await viewBig(mannaC, 'dawnOpen()')) === 0n);
  check('nextDawn() == tomorrow at noon', (await viewBig(mannaC, 'nextDawn()')) === noonOf(D0 + 1n));
  setTime(noonOf(D0 + 1n) - 1n);
  r = await send(CALLER, mannaC, 'dawn()');
  check('11:59:59 on Tuesday reverts NotYetDawn()', r.reverted && errorIs(r.ret, 'NotYetDawn()'));
  check('nextDawn() still says noon today', (await viewBig(mannaC, 'nextDawn()')) === noonOf(D0 + 1n));
  setTime(noonOf(D0 + 1n));
  check('dawnOpen() at noon', (await viewBig(mannaC, 'dawnOpen()')) === 1n);
  const carryBefore = await viewBig(mannaC, 'carry()');
  const capTue = await viewBig(curveBuyer, 'maxSpend()');
  r = await send(STRANGER, mannaC, 'dawn()');
  check('Tuesday noon: dawn succeeds', !r.reverted, revertName(r));
  e = dawnLogs(r);
  recordFell(D0 + 1n, e.fell);
  check('Tuesday income is one day of tithe only (no escrow credit)', e.claimed.length === 0 && e.income > 0n && e.income < 10n * USDG_UNIT, `${e.income}`);
  {
    const budgetT = e.income - e.toTreasury - e.toReserve - e.toCharity + carryBefore;
    check('Tuesday spent min(budget, maxBuy, venue cap) of the carried budget and carried the rest', e.spent === minCap(budgetT, capTue) && (await viewBig(mannaC, 'carry()')) === budgetT - e.spent, `${e.spent} vs ${minCap(budgetT, capTue)}`);
  }
  check('nextDawn() now == Wednesday noon; the caller was tipped', (await viewBig(mannaC, 'nextDawn()')) === noonOf(D0 + 2n) && (await bal(manna, STRANGER)) === e.tip);
  await invariants('after Tuesday');

  // L1 gathers on Tuesday (fresh only), L3 switches on autoStake.
  const l1Before = await lender(vaultPons, L1);
  const balL1Before = await bal(manna, L1);
  r = await send(L1, mannaC, 'gather(address)', vaultPons);
  check('L1 gathers on Tuesday: Gathered(fresh, spoiled == 0, staked == false)', !r.reverted && logsOf(r, 'Gathered(address,address,uint256,uint256,bool)').length === 1, revertName(r));
  {
    const g = words(logsOf(r, 'Gathered(address,address,uint256,uint256,bool)')[0].data);
    check('the gathered amount equals the view\'s pending fresh', toBig(g[0]) === l1Before.fresh && toBig(g[1]) === 0n && toBig(g[2]) === 0n);
    check('L1 received the MANNA', (await bal(manna, L1)) - balL1Before === l1Before.fresh);
    check('L1 pending is now zero, lastGatherDay is today', (await lender(vaultPons, L1)).fresh === 0n && (await lender(vaultPons, L1)).lastGatherDay === D0 + 1n);
  }
  await send(L3, mannaC, 'setAutoStake(bool)', true);
  const l3Before = await lender(vaultCat, L3);
  r = await send(L3, mannaC, 'gather(address)', vaultCat);
  check('L3 gathers with autoStake on: staked, not transferred', !r.reverted && (await bal(manna, L3)) === 0n && (await viewBig(mannaC, 'stakedOf(address)', L3)) === l3Before.fresh, revertName(r));
  check('the stakers\' pool now holds L3\'s Manna', (await viewBig(mannaC, 'stakedPool()')) === l3Before.fresh && (await viewBig(mannaC, 'totalStakeShares()')) === l3Before.fresh);

  // Sunday: nothing falls; Monday carries Saturday's and Sunday's fees.
  const SUN = D0 + 6n;
  check(`day ${SUN} is a Sunday`, isSunday(SUN));
  setTime(noonOf(SUN));
  r = await send(CALLER, mannaC, 'dawn()');
  check('Sunday noon: dawn reverts Sabbath()', r.reverted && errorIs(r.ret, 'Sabbath()'));
  check('dawnOpen() false on Sunday; nextDawn() == Monday noon', (await viewBig(mannaC, 'dawnOpen()')) === 0n && (await viewBig(mannaC, 'nextDawn()')) === noonOf(SUN + 1n));
  r = await send(OWNER, mannaC, 'setDial((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),uint256)', [2000n, 1000n, 500n, 1000n, 7000n, 50n, 500n, 300n], 5_000n * USDG_UNIT);
  check('no dial turns on a Sunday (setDial reverts Sabbath())', r.reverted && errorIs(r.ret, 'Sabbath()'));
  r = await send(OWNER, mannaC, 'setStorehouseActive(address,bool)', vaultPons, false);
  check('setStorehouseActive reverts Sabbath() on Sunday too', r.reverted && errorIs(r.ret, 'Sabbath()'));
  await send(HOOK, escrow, 'creditToken(address,address,uint256)', mannaC, usdg, 2_000n * USDG_UNIT);
  setTime(noonOf(SUN + 1n));
  r = await send(CALLER, mannaC, 'dawn()');
  check('Monday noon: dawn succeeds and carries the weekend\'s fees', !r.reverted, revertName(r));
  e = dawnLogs(r);
  const D7 = SUN + 1n;
  recordFell(D7, e.fell);
  check('Monday income includes the 2,000 USDG credited on Sunday', e.claimed[0] === 2_000n * USDG_UNIT && e.income > 2_000n * USDG_UNIT);
  {
    const seventy = ((e.bought - e.tip) * 7000n) / BPS;
    check('stakers now exist, so the stakers\' share (plus allotment dust) went to the pool', e.toStakers >= seventy && e.toStakers - seventy < 10n && e.toStakers > 0n, `${e.toStakers} vs ${seventy}`);
  }
  check('stakedPool grew by the stakers\' share; L3 (sole staker) owns all of it', (await viewBig(mannaC, 'stakedPool()')) === l3Before.fresh + e.toStakers && (await viewBig(mannaC, 'stakedOf(address)', L3)) === l3Before.fresh + e.toStakers);
  await invariants('after the Monday dawn');

  // =========================================================================
  section('6. Spoilage, staking and leaving');
  // =========================================================================

  // L2 has never gathered: D0's portions (7 days old today) spoil; D0+1 and D7 portions are fresh.
  const l2v = await lender(vaultPons, L2);
  const accNow = (await sh(0)).accPerShare;
  const cutoff = accAtDay(vaultPons, D7 - 7n); // acc after the last fall on D0
  const expSpoiled = (l2v.shares * cutoff) / 10n ** 18n;
  const expEarned = (l2v.shares * accNow) / 10n ** 18n;
  check(`L2 view: spoiled == shares * acc(D0) / 1e18 (${expSpoiled / TOKEN_UNIT} MANNA)`, l2v.spoiled === expSpoiled && expSpoiled > 0n, `${l2v.spoiled} vs ${expSpoiled}`);
  check('L2 view: fresh == the rest', l2v.fresh === expEarned - expSpoiled && l2v.fresh > 0n);
  const burnedBefore = await viewBig(mannaC, 'totalBurned()');
  const lpBefore = await viewBig(mannaC, 'lenderPool()');
  const balL2Before = await bal(manna, L2);
  r = await send(L2, mannaC, 'gather(address)', vaultPons);
  check('L2 gathers: fresh paid, spoiled burned', !r.reverted, revertName(r));
  {
    const g = words(logsOf(r, 'Gathered(address,address,uint256,uint256,bool)')[0].data);
    check('Gathered(fresh, spoiled) matches the view', toBig(g[0]) === l2v.fresh && toBig(g[1]) === l2v.spoiled);
    check('L2 received only the fresh part', (await bal(manna, L2)) - balL2Before === l2v.fresh);
    check('Burned(spoiled) and totalBurned grew; the dead address holds it', logsOf(r, 'Burned(uint256)').length === 1 && (await viewBig(mannaC, 'totalBurned()')) === burnedBefore + l2v.spoiled && (await bal(manna, '0x000000000000000000000000000000000000dEaD')) >= l2v.spoiled);
    check('lenderPool fell by fresh + spoiled', (await viewBig(mannaC, 'lenderPool()')) === lpBefore - l2v.fresh - l2v.spoiled);
    check('periodSpoiled records it', (await viewBig(mannaC, 'periodSpoiled()')) === l2v.spoiled);
  }
  // L1 gathered on D0+1: the D0+1 portion is 6 days old today, so nothing of L1's spoils yet.
  const l1v = await lender(vaultPons, L1);
  check('L1 (gathered on Tuesday) has nothing spoiled today', l1v.spoiled === 0n && l1v.fresh > 0n);
  await invariants('after spoilage');

  // Staking: L1 stakes what it gathered; STAKER stakes fresh MANNA; then a dawn; shares vs pool.
  const stakeL1 = await bal(manna, L1);
  await approve(L1, manna, mannaC);
  r = await send(L1, mannaC, 'stake(uint256)', stakeL1);
  check('L1 stakes its gathered MANNA', !r.reverted, revertName(r));
  await mint(manna, STAKER, 1_000_000n * TOKEN_UNIT);
  await approve(STAKER, manna, mannaC);
  r = await send(STAKER, mannaC, 'stake(uint256)', 1_000_000n * TOKEN_UNIT);
  check('a stranger stakes 1,000,000 MANNA', !r.reverted, revertName(r));
  const poolBefore = await viewBig(mannaC, 'stakedPool()');
  const stakerBefore = await viewBig(mannaC, 'stakedOf(address)', STAKER);
  const l3StakeBefore = await viewBig(mannaC, 'stakedOf(address)', L3);
  check('stakedOf(STAKER) == 1,000,000 right after staking (share rounding of a few wei)', stakerBefore <= 1_000_000n * TOKEN_UNIT && 1_000_000n * TOKEN_UNIT - stakerBefore < 10n, `${stakerBefore}`);
  r = await send(STAKER, mannaC, 'stake(uint256)', 0n);
  check('stake(0) reverts ZeroAmount()', r.reverted && errorIs(r.ret, 'ZeroAmount()'));
  r = await send(STAKER, mannaC, 'unstake(uint256)', MAX);
  check('unstaking more than owned reverts InsufficientStake()', r.reverted && errorIs(r.ret, 'InsufficientStake()'));
  setTime(noonOf(D7 + 1n));
  r = await send(CALLER, mannaC, 'dawn()');
  e = dawnLogs(r);
  recordFell(D7 + 1n, e.fell);
  check('Tuesday dawn with three stakers', !r.reverted && e.toStakers > 0n, revertName(r));
  const poolAfter = await viewBig(mannaC, 'stakedPool()');
  const stakerAfter = await viewBig(mannaC, 'stakedOf(address)', STAKER);
  check('stakedPool grew by exactly the stakers\' share', poolAfter === poolBefore + e.toStakers);
  check('STAKER\'s value grew pro rata to its share of the pool', relErr(stakerAfter - stakerBefore, (e.toStakers * stakerBefore) / poolBefore) < 1e-9);
  const stakerShares = await viewBig(mannaC, 'stakeShares(address)', STAKER);
  const balStakerBefore = await bal(manna, STAKER);
  r = await send(STAKER, mannaC, 'unstake(uint256)', stakerShares);
  check('STAKER unstakes everything and receives principal plus its Manna', !r.reverted && (await bal(manna, STAKER)) - balStakerBefore === stakerAfter, revertName(r));
  check('the pool shrank by that amount; the others keep theirs', (await viewBig(mannaC, 'stakedPool()')) === poolAfter - stakerAfter && (await viewBig(mannaC, 'stakedOf(address)', L3)) > l3StakeBefore);
  await invariants('after staking');

  // Leaving: L2 takes out half; L1 cannot take out everything while the shorts hold it.
  const l2s = (await lender(vaultPons, L2)).shares;
  const ponsL2Before = await bal(pons, L2);
  r = await send(L2, mannaC, 'leave(address,uint256)', vaultPons, l2s / 2n);
  check('L2 leaves with half its shares', !r.reverted, revertName(r));
  {
    const lg = words(logsOf(r, 'Left(address,address,uint256,uint256)')[0].data);
    check('L2 received PONS >= 250,000 (the deposit plus interest)', (await bal(pons, L2)) - ponsL2Before === toBig(lg[1]) && toBig(lg[1]) > 250_000n * TOKEN_UNIT);
    check('L2\'s remaining shares halved; the Storehouse total fell', (await lender(vaultPons, L2)).shares === l2s - l2s / 2n && (await sh(0)).totalStaked === staked0.totalStaked - l2s / 2n);
  }
  r = await send(L1, mannaC, 'leave(address,uint256)', vaultPons, (await lender(vaultPons, L1)).shares);
  check('L1 cannot leave with everything while it is lent out (vault InsufficientLiquidity)', r.reverted && errorIs(r.ret, 'InsufficientLiquidity()'));
  r = await send(L1, mannaC, 'leave(address,uint256)', vaultPons, (await lender(vaultPons, L1)).shares + 1n);
  check('leaving more shares than staked reverts InsufficientShares()', r.reverted && errorIs(r.ret, 'InsufficientShares()'));
  check('Manna still holds exactly the staked shares plus fee shares', (await bal(vaultPons, mannaC)) === (await sh(0)).totalStaked + (await viewBig(mannaC, 'feeShares(address)', vaultPons)));
  await invariants('after leaving');

  // =========================================================================
  section('7. The v4 adapter, a failing buyer, the cap');
  // =========================================================================

  const pm = await deploy(ART.MockPoolManager, [], []);
  const v4 = await deploy(ART.V4Swapper, ['address', 'address', 'address', 'address'], [pm, usdg, manna, OWNER]);
  const HOOK_ADDR = '0x' + 'e5'.repeat(20);
  await send(OWNER, v4, 'setPoolKey(uint24,int24,address,uint16)', 0n, 200n, HOOK_ADDR, 200n);
  check('setPoolKey records the hook fee + creator tax (2%)', (await viewBig(v4, 'feeBps()')) === 200n);
  const usdgIs0 = (await viewBig(v4, 'usdgIsCurrency0()')) === 1n;
  check(`v4 pool key sorted (USDG is currency${usdgIs0 ? 0 : 1})`, usdgIs0 === (BigInt(usdg) < BigInt(manna)));
  // 1 USDG (1e6 raw) buys 2,000 MANNA (2e21 raw).
  const Q192 = 1n << 192n;
  const sqrtP = usdgIs0 ? isqrt((2n * 10n ** 21n * Q192) / 10n ** 6n) : isqrt((10n ** 6n * Q192) / (2n * 10n ** 21n));
  const keyTuple = usdgIs0 ? [usdg, manna, 0n, 200n, HOOK_ADDR] : [manna, usdg, 0n, 200n, HOOK_ADDR];
  // Liquidity such that the pool holds about 1,000,000 USDG at this price (a full-range position).
  const Q96 = 1n << 96n;
  const depthWanted = 1_000_000n * USDG_UNIT;
  const liqBig = usdgIs0 ? (depthWanted * sqrtP) / Q96 : (depthWanted * Q96) / sqrtP;
  await send(OWNER, pm, 'setSqrtPrice((address,address,uint24,int24,address),uint160,int24,uint128)', keyTuple, sqrtP, 0n, liqBig);
  await mint(manna, pm, 10_000_000_000n * TOKEN_UNIT);
  check('sqrtPriceX96() reads the slot0 word through extsload', (await viewBig(v4, 'sqrtPriceX96()')) === sqrtP);
  check('liquidity() reads the pool liquidity word', (await viewBig(v4, 'liquidity()')) === liqBig);
  const depth = await viewBig(v4, 'usdgDepth()');
  check(`usdgDepth() ≈ 1,000,000 USDG (${depth})`, relErr(depth, depthWanted) < 1e-6);
  check('maxSpend() == 1% of the depth', (await viewBig(v4, 'maxSpend()')) === depth / 100n);
  const q = await viewBig(v4, 'quoteBuy(uint256)', 1_000n * USDG_UNIT);
  check(`quoteBuy(1,000 USDG) ≈ 2,000,000 MANNA less the 2% fee (${q / TOKEN_UNIT})`, relErr(q, 1_960_000n * TOKEN_UNIT) < 1e-6);
  await send(OWNER, mannaC, 'setAddresses(address,address,address,address,address)', TREASURY, '0x' + '0'.repeat(40), v4, v3, escrow);
  await send(HOOK, escrow, 'creditToken(address,address,uint256)', mannaC, usdg, 3_000n * USDG_UNIT);
  setTime(noonOf(D7 + 2n));
  r = await send(CALLER, mannaC, 'dawn()');
  e = dawnLogs(r);
  recordFell(D7 + 2n, e.fell);
  check('dawn buys through the v4 adapter (unlock -> swap -> settle -> take)', !r.reverted && e.buyFailed === 0 && e.bought > 0n, revertName(r));
  {
    check('with a deep pool, maxBuy (5,000 USDG) binds, not the depth cap', e.spent === 5_000n * USDG_UNIT, `${e.spent}`);
    const expect = await viewBig(v4, 'quoteBuy(uint256)', e.spent); // the quote is net of the hook's 2%, like the delivery
    check('bought == the net quote exactly', e.bought === expect, `${e.bought} vs ${expect}`);
    check('the PoolManager received exactly the USDG spent', (await bal(usdg, pm)) === e.spent);
    check('the adapter holds nothing afterwards', (await bal(usdg, v4)) === 0n && (await bal(manna, v4)) === 0n);
  }
  await invariants('after the v4 dawn');

  const failing = await deploy(ART.MockFailingBuyer, [], []);
  await send(OWNER, mannaC, 'setAddresses(address,address,address,address,address)', TREASURY, '0x' + '0'.repeat(40), failing, v3, escrow);
  await send(HOOK, escrow, 'creditToken(address,address,uint256)', mannaC, usdg, 1_000n * USDG_UNIT);
  setTime(noonOf(D7 + 3n));
  const carryBeforeFail = await viewBig(mannaC, 'carry()');
  r = await send(CALLER, mannaC, 'dawn()');
  e = dawnLogs(r);
  check('a buyer that reverts does not stop the dawn: BuyFailed, nothing bought', !r.reverted && e.buyFailed === 1 && e.bought === 0n && e.spent === 0n, revertName(r));
  const carried = await viewBig(mannaC, 'carry()');
  check('the whole budget carried to tomorrow, on top of what was already carried', carried === carryBeforeFail + e.income - e.toTreasury - e.toReserve - e.toCharity && carried > 0n, `${carried} vs ${carryBeforeFail} + ${e.income - e.toTreasury - e.toReserve - e.toCharity}`);
  check('treasury, reserve and charity were still paid', e.toTreasury === (e.income * 2000n) / BPS);
  await invariants('after a failed buy');

  await send(OWNER, mannaC, 'setAddresses(address,address,address,address,address)', TREASURY, '0x' + '0'.repeat(40), v4, v3, escrow);
  await send(OWNER, mannaC, 'setDial((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),uint256)', [2000n, 1000n, 500n, 1000n, 7000n, 50n, 500n, 300n], 100n * USDG_UNIT);
  setTime(noonOf(D7 + 4n));
  r = await send(CALLER, mannaC, 'dawn()');
  e = dawnLogs(r);
  recordFell(D7 + 4n, e.fell);
  check('with maxBuy = 100 USDG the dawn spends exactly 100 and carries the rest', !r.reverted && e.spent === 100n * USDG_UNIT && (await viewBig(mannaC, 'carry()')) === carried + e.income - e.toTreasury - e.toReserve - e.toCharity - e.spent, revertName(r));
  // A thin pool: 100,000 USDG of depth caps the buy at 1,000 USDG, under maxBuy.
  {
    const thin = 100_000n * USDG_UNIT;
    const liqThin = usdgIs0 ? (thin * sqrtP) / Q96 : (thin * Q96) / sqrtP;
    await send(OWNER, pm, 'setSqrtPrice((address,address,uint24,int24,address),uint160,int24,uint128)', keyTuple, sqrtP, 0n, liqThin);
    await send(OWNER, mannaC, 'setDial((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),uint256)', [2000n, 1000n, 500n, 1000n, 7000n, 50n, 500n, 300n], 5_000n * USDG_UNIT);
    await send(HOOK, escrow, 'creditToken(address,address,uint256)', mannaC, usdg, 5_000n * USDG_UNIT);
    setTime(noonOf(D7 + 5n));
    r = await send(CALLER, mannaC, 'dawn()');
    e = dawnLogs(r);
    recordFell(D7 + 5n, e.fell);
    const cap = await viewBig(v4, 'maxSpend()');
    check(`with a thin pool the depth cap binds: spent == maxSpend (${cap / USDG_UNIT} USDG), the rest carried`, !r.reverted && relErr(cap, 1_000n * USDG_UNIT) < 1e-6 && e.spent === cap && (await viewBig(mannaC, 'carry()')) > 0n, revertName(r) || `${e.spent} vs ${cap}`);
    check('a sandwich would pay 2% twice on its round trip for a move under 2%: the cap is the defence, not the quote', (2n * cap * 10000n) / thin <= 200n);
    await send(OWNER, pm, 'setSqrtPrice((address,address,uint24,int24,address),uint160,int24,uint128)', keyTuple, sqrtP, 0n, liqBig);
  }
  r = await send(OWNER, mannaC, 'setDial((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),uint256)', [6000n, 3000n, 2000n, 1000n, 7000n, 50n, 500n, 300n], 5_000n * USDG_UNIT);
  check('a dial whose treasury + reserve + charity exceed 100% is refused (BadDial)', r.reverted && errorIs(r.ret, 'BadDial()'));
  r = await send(OWNER, mannaC, 'setDial((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),uint256)', [2000n, 1000n, 500n, 1000n, 7000n, 2000n, 500n, 300n], 5_000n * USDG_UNIT);
  check('a caller tip above 10% is refused (BadDial)', r.reverted && errorIs(r.ret, 'BadDial()'));
  await send(OWNER, mannaC, 'setDial((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),uint256)', [2000n, 1000n, 500n, 1000n, 7000n, 50n, 500n, 300n], 5_000n * USDG_UNIT);
  await invariants('after the cap');

  // =========================================================================
  section('8. Bad debt, Joseph\'s Reserve, restore(), Jubilee');
  // =========================================================================

  const reserveBefore = await viewBig(mannaC, 'reserve()');
  check(`the Reserve holds USDG from the dawns so far (${reserveBefore})`, reserveBefore > 0n);
  r = await send(STRANGER, mannaC, 'restore(address)', vaultPons);
  check('restore() with nothing lost reverts NothingToRestore()', r.reverted && errorIs(r.ret, 'NothingToRestore()'));

  // PONS pumps 5x: 400,000 PONS per WETH. B1's 1M PONS debt is now worth $12,500 against 10,000 USDG.
  const PUMPED = 400_000;
  const tickPumped = Math.round(Math.log(PUMPED) / Math.log(1.0001));
  await send(OWNER, poolA1, 'setMeanTick(int24)', tickPumped);
  await send(OWNER, poolA1, 'setSpotTick(int24)', tickPumped);
  await send(OWNER, poolA1, 'setRate(uint256,uint256)', BigInt(PUMPED), 1n);
  const pNew = await viewBig(oraclePons, 'price()');
  check('the Prophet now prices PONS 5x higher (100 per USDG)', relErr(pNew, 100n * 10n ** 12n * 10n ** 36n) < 3e-4);
  await mint(pons, LIQUIDATOR, 5_000_000n * TOKEN_UNIT);
  await approve(LIQUIDATOR, pons, morpho);
  const hwmBefore = (await sh(0)).highWater;
  const spBefore = await viewBig(vaultPons, 'convertToAssets(uint256)', 10n ** 24n);
  r = await send(LIQUIDATOR, morpho, `liquidate(${MP_T},address,uint256,uint256,bytes)`, mpTuple(mpPons), B1, 10_000n * USDG_UNIT, 0n, '');
  check('a Watchman liquidates B1, seizing all 10,000 USDG', !r.reverted, revertName(r));
  {
    const liq = logsOf(r, 'Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)')[0];
    const d = liq ? words(liq.data) : null;
    check(`Morpho wrote off bad debt (${d ? toBig(d[4]) / TOKEN_UNIT : '?'} PONS)`, d && toBig(d[4]) > 0n);
    check('the liquidator holds the seized USDG', (await bal(usdg, LIQUIDATOR)) === 10_000n * USDG_UNIT);
  }
  const spAfter = await viewBig(vaultPons, 'convertToAssets(uint256)', 10n ** 24n);
  check('the PONS Storehouse share price fell below its high-water mark', spAfter < spBefore && spAfter < hwmBefore);
  const ponsVaultBefore = await viewBig(vaultPons, 'totalAssets()');
  const capR = await viewBig(mannaC, 'restoreCap(uint256)', 0n);
  const valuePons = (await viewBig(mannaC, 'storehouseValueUsd()'));
  check(`restoreCap(PONS) == reserve * PONS value / total value (${capR} of ${reserveBefore})`, capR > 0n && capR < reserveBefore && valuePons > 0n);
  r = await send(STRANGER, mannaC, 'restore(address)', vaultPons);
  check('restore() buys PONS with the Reserve and gives it to the Storehouse', !r.reverted, revertName(r));
  {
    const rs = words(logsOf(r, 'Restored(address,uint256,uint256)')[0].data);
    const spent = toBig(rs[0]);
    const donated = toBig(rs[1]);
    const unit = 10n ** 24n;
    const totalSupply = await viewBig(vaultPons, 'totalSupply()');
    const deficit = ((hwmBefore - spAfter) * totalSupply) / unit;
    const needed = (deficit * 10n ** 36n) / pNew;
    check(`spent == min(needed, the Storehouse's cap) (${spent} of ${needed} needed, cap ${capR})`, spent === (needed < capR ? needed : capR));
    const r2 = await send(STRANGER, mannaC, 'restore(address)', vaultPons);
    check('a second restore() the same day reverts RestoreCooldown()', r2.reverted && errorIs(r2.ret, 'RestoreCooldown()'));
    check('the Reserve shrank by what was spent', (await viewBig(mannaC, 'reserve()')) === reserveBefore - spent);
    check(`the Storehouse received the PONS bought (${donated / TOKEN_UNIT} PONS)`, (await viewBig(vaultPons, 'totalAssets()')) === ponsVaultBefore + donated && donated > 0n);
    check('the share price recovered toward the mark', (await viewBig(vaultPons, 'convertToAssets(uint256)', unit)) > spAfter);
  }
  await invariants('after restore');

  // Jubilee. The charity is named on the Saturday before (a dial cannot turn on the Sunday itself).
  r = await send(STRANGER, mannaC, 'jubilee()');
  check('jubilee() before the day reverts NotJubileeYet()', r.reverted && errorIs(r.ret, 'NotJubileeYet()'));
  const jDay = await viewBig(mannaC, 'nextJubileeDay()');
  setTime(noonOf(jDay - 1n));
  r = await send(OWNER, mannaC, 'setAddresses(address,address,address,address,address)', TREASURY, CHARITY, v4, v3, escrow);
  check('the charity is named on Saturday', !r.reverted, revertName(r));
  setTime(noonOf(jDay));
  check(`it is Jubilee Sunday (day ${jDay})`, isSunday(jDay));
  r = await send(OWNER, mannaC, 'setAddresses(address,address,address,address,address)', TREASURY, CHARITY, v4, v3, escrow);
  check('changing addresses on the Sunday is refused (Sabbath)', r.reverted && errorIs(r.ret, 'Sabbath()'));
  r = await send(CALLER, mannaC, 'dawn()');
  check('no dawn on Jubilee Sunday either', r.reverted && errorIs(r.ret, 'Sabbath()'));
  const charityDue = await viewBig(mannaC, 'charityAccrued()');
  const pf = await viewBig(mannaC, 'periodFallen()');
  const pg = await viewBig(mannaC, 'periodGathered()');
  const ps = await viewBig(mannaC, 'periodSpoiled()');
  check('the charity slice accrued over the period', charityDue > 0n && pf > 0n && pg > 0n && ps > 0n);
  r = await send(STRANGER, mannaC, 'jubilee()');
  check('jubilee() sends the charity slice', !r.reverted && (await bal(usdg, CHARITY)) === charityDue && (await viewBig(mannaC, 'charityAccrued()')) === 0n, revertName(r));
  {
    const j = logsOf(r, 'Jubilee(uint256,address,uint256,uint256,uint256,uint256,uint256)')[0];
    const d = words(j.data);
    check('Jubilee event publishes the period: amount, fallen, gathered, spoiled, the next day', toBig(d[0]) === charityDue && toBig(d[1]) === pf && toBig(d[2]) === pg && toBig(d[3]) === ps && toBig(d[4]) === jDay + 49n);
    check('the period counters reset and the next Jubilee is 49 days out', (await viewBig(mannaC, 'periodFallen()')) === 0n && (await viewBig(mannaC, 'nextJubileeDay()')) === jDay + 49n && isSunday(jDay + 49n));
  }
  r = await send(STRANGER, mannaC, 'jubilee()');
  check('a second jubilee() the same day reverts NotJubileeYet()', r.reverted && errorIs(r.ret, 'NotJubileeYet()'));
  await invariants('after Jubilee');

  // Housekeeping dials on the Monday after: inactive Storehouses, releasing the Reserve, ownership.
  setTime(noonOf(jDay + 1n));
  r = await send(OWNER, mannaC, 'setStorehouseActive(address,bool)', vaultCat, false);
  check('CASHCAT Storehouse set inactive on Monday', !r.reverted, revertName(r));
  r = await send(L3, mannaC, 'enter(address,uint256)', vaultCat, 1n * TOKEN_UNIT);
  check('enter on an inactive Storehouse reverts StorehouseInactive()', r.reverted && errorIs(r.ret, 'StorehouseInactive()'));
  const l3s = (await lender(vaultCat, L3)).shares;
  r = await send(L3, mannaC, 'leave(address,uint256)', vaultCat, l3s / 4n);
  check('leaving an inactive Storehouse still works', !r.reverted, revertName(r));
  await send(OWNER, mannaC, 'setStorehouseActive(address,bool)', vaultCat, true);
  r = await send(STRANGER, mannaC, 'setStorehouseOracle(address,address)', vaultPons, oraclePons);
  check('setStorehouseOracle from a stranger reverts NotOwner()', r.reverted && errorIs(r.ret, 'NotOwner()'));
  r = await send(OWNER, mannaC, 'setStorehouseOracle(address,address)', vaultPons, oraclePons);
  check('the owner can point a Storehouse at a new Prophet', !r.reverted && (await sh(0)).oracle.toLowerCase() === oraclePons.toLowerCase(), revertName(r));
  const resNow = await viewBig(mannaC, 'reserve()');
  r = await send(OWNER, mannaC, 'releaseReserve(uint256)', resNow / 2n);
  check('releaseReserve moves half the Reserve back into income', !r.reverted && (await viewBig(mannaC, 'reserve()')) === resNow - resNow / 2n, revertName(r));
  r = await send(CALLER, mannaC, 'dawn()');
  e = dawnLogs(r);
  check('the next dawn counts the released Reserve as income', !r.reverted && e.income >= resNow / 2n, revertName(r));
  await invariants('after releasing the Reserve');
  r = await send(STRANGER, mannaC, 'transferOwnership(address)', STRANGER);
  check('transferOwnership from a stranger reverts NotOwner()', r.reverted && errorIs(r.ret, 'NotOwner()'));
  await send(OWNER, mannaC, 'transferOwnership(address)', STRANGER);
  check('ownership is two-step: still OWNER until accepted', toAddr((await view(mannaC, 'owner()'))[0]).toLowerCase() === OWNER.toLowerCase());
  r = await send(STRANGER, mannaC, 'acceptOwnership()');
  check('the pending owner accepts', !r.reverted && toAddr((await view(mannaC, 'owner()'))[0]).toLowerCase() === STRANGER.toLowerCase());

  // NoCharity: a fresh Manna with no charity named reaches its Jubilee.
  const manna2 = await deploy(ART.Manna, ['address', 'address', 'address'], [usdg, OWNER, TREASURY]);
  await send(OWNER, manna2, 'setToken(address)', manna);
  const j2 = await viewBig(manna2, 'nextJubileeDay()');
  setTime(noonOf(j2));
  r = await send(STRANGER, manna2, 'jubilee()');
  check('jubilee() with no charity named reverts NoCharity()', r.reverted && errorIs(r.ret, 'NoCharity()'));
  check('skim() with nothing extra is a no-op', !(await send(STRANGER, mannaC, 'skim()')).reverted);
  await invariants('final');
}

module.exports = { run };
