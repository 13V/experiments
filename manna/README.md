# Manna

The short desk for memecoins on Robinhood Chain, named after the thing it does every morning.

Holders of the chain's biggest memes, the Giants (PONS, CASHCAT and AI at launch), lend them into
Storehouses and earn the rate the shorts pay. Anyone with USDG can sling a Giant through Locate's
router — the only bear trade on this chain. Every morning at 12:00 UTC, six days a week, the desk's
income (the coin's own trading fees plus a 10% tithe on the Storehouses' interest) buys MANNA in
its own pool and the purchase falls on the lenders and the stakers. The lending and shorting
contracts are Locate's `LocateVault` and `LocateRouter` on Morpho Blue markets, priced by a
two-hop TWAP oracle, exactly as sized in `docs/borrow-the-meme.md`. MANNA itself is a plain Pons V2
launch token; the only new contract is `Manna.sol`, which receives its fees and runs the morning.

## How it works

Six mornings a week, from 12:00 UTC, anyone can call `dawn()`. The caller keeps a 0.5% tip of what
falls, so no keeper needs to be paid to run it:

1. **Claim.** `dawn()` claims MANNA's escrowed Pons trading fees from the shared fee escrow. They
   arrive already converted to USDG by the Pons Meme hook's fee sweep.
2. **Tithe.** Each Storehouse's accrued performance fee (10% of the interest shorts paid, minted to
   Manna as `LocateVault` shares) is redeemed for the Giant and sold for USDG through the seller
   adapter, along the same route the oracle reads, bounded by the Prophet's price.
3. **Split.** The combined USDG — income = balance − Reserve − accrued charity − yesterday's carry —
   is split: 20% to the treasury, 10% to Joseph's Reserve (only until the Reserve reaches its
   target share of the Storehouses' value), 5% held for the next Jubilee's charity payment. The
   rest, plus anything carried from yesterday, is today's buy budget.
4. **Buy.** Up to `maxBuy` (5,000 USDG to start), and never more than 1% of the venue's own USDG
   depth, of the budget buys MANNA through the buyer adapter — the Pons curve before graduation,
   the graduated Uniswap v4 pool after — at no worse than 95% of the adapter's fee-net quote.
   Whatever the caps or a failed buy leave unspent carries to tomorrow; nothing is lost.
5. **Fall.** The caller keeps 0.5% of the MANNA bought. Of the rest, 70% goes to the staking pool
   and 30% is split across Storehouses weighted by how much USDG-value of each Giant is actually
   borrowed right now, then pro rata by staked shares within a Storehouse. If nobody has staked
   MANNA yet, the stakers' share falls on the lenders instead; whatever truly cannot be placed (no
   active Storehouse has a staked lender) is burned.
6. **Gather or spoil.** Lenders call `gather`/`gatherAll` to collect what fell on their shares.
   Anything left ungathered for seven days spoils and is burned instead of paid, the next time that
   lender's position is touched — so the diligent lose nothing, and the burn costs nobody who shows
   up (Exodus 16:20).

**Sunday** nothing falls: `dawn()` reverts `Sabbath()`, and every owner dial except naming the coin
or transferring ownership reverts the same way. Monday's dawn simply carries the weekend's fees.

**Jubilee**, every 49th day landing on a Sunday, `jubilee()` sends the accrued charity slice and
publishes the period's totals (Manna fallen, gathered, spoiled), then schedules the next one 49
days out. The first Jubilee is the first Sunday at least 49 days after the coin is named.

## Layout

| Path | What |
|---|---|
| `SPEC.md` | The binding spec: chain facts, every contract surface, the dawn arithmetic, invariants |
| `config/addresses.json` | Chain, Morpho, Pons and (once run) treasury/charity/contract addresses |
| `config/markets.json` | The Giants: pool, token, initial cap, oracle window; filled in by `create-markets.js` |
| `config/pons-abi.json` | Verified ABIs (Sourcify) for the Pons factory, meme hook and fee escrow |
| `contracts/Manna.sol` | The dawn, lenders, stakers, Joseph's Reserve, Jubilee — one contract |
| `contracts/MemeTwapOracle.sol` | "the Prophet": the two-hop Uniswap v3 TWAP Morpho oracle |
| `contracts/adapters/UniswapV3Swapper.sol` | Sells a tithed Giant for USDG; buys a Giant back for the Reserve |
| `contracts/adapters/UniswapV4Swapper.sol` | Buys MANNA in its graduated v4 pool (the Pons Meme hook pool) |
| `contracts/adapters/PonsCurveSwapper.sol` | Buys MANNA on its Pons bonding curve, before graduation |
| `contracts/interfaces/`, `contracts/libraries/` | Trimmed interfaces; vendored `TickMath`/`FullMath` |
| `test/Mocks.sol` | Mock v3 pool, v4 `PoolManager`, Pons escrow, Pons curve, a buyer that always fails |
| `scripts/test.js`, `scripts/test-dawn.js` | The test suite (sections 0–8; see `SPEC.md` §14) |
| `scripts/create-markets.js` | Deploys a Prophet per Giant, checks its pool's buffer, creates the Morpho market |
| `scripts/deploy.js` | Compiles and deploys `Manna` and the adapters, registers the Storehouses |
| `scripts/launch.js` | Launches MANNA on Pons V2 and wires the token/curve into config |
| `scripts/dawn.js` | Calls `dawn()`; `--watch` loops it daily; `--switch-buyer` hops to the v4 adapter at graduation |
| `scripts/status.js` | Read-only: every Storehouse, every sling market, the Reserve, the next dawn |
| `scripts/sunday.js` | Writes the weekly Sunday Service report |
| `scripts/abicheck.js` | Cross-checks every signature the scripts hand-roll against the compiled ABIs |
| `site/` | Static site, hash routes `#/storehouses #/slings #/tape #/manna #/sunday` |

## Running it

Dev dependencies (`solc` 0.8.28, `@ethereumjs/vm` 8.1.1, `@ethereumjs/common` 4.4.0,
`@ethereumjs/util` 9.1.0, `@ethereumjs/block` 5.3.0) live in the repository root's `node_modules`,
installed with `npm install --no-save ...`; nothing in `manna/` has its own.

```
NODE_PATH=/home/user/experiments/node_modules node manna/scripts/test.js   # N passed, 0 failed
node manna/scripts/status.js                                              # read-only
node manna/scripts/abicheck.js                                            # script signatures vs. compiled ABIs

RPC_URL=... PRIVATE_KEY=... node manna/scripts/create-markets.js --dry-run [--only PONS]
RPC_URL=... PRIVATE_KEY=... node manna/scripts/deploy.js --dry-run
RPC_URL=... PRIVATE_KEY=... node manna/scripts/launch.js --dry-run \
  --name "Manna" --symbol MANNA --logo https://... --description "..." \
  [--website U] [--twitter U] [--telegram U] [--tax-bps 100] [--dev-buy 1000]
RPC_URL=... PRIVATE_KEY=... node manna/scripts/dawn.js --dry-run --watch --switch-buyer
node manna/scripts/sunday.js --out manna/site/data/sunday.json
```

Deploy order: **create-markets → deploy → launch → dawn --watch.** Every sending script has
`--dry-run`, which prints the exact calldata and never signs; run it first, every time.

## For lenders

`enter(vault, assets)` deposits a Giant into its Storehouse and records the resulting `LocateVault`
shares under your address inside Manna (Manna itself holds every share; you never do). `leave(vault,
shares)` unstakes and redeems straight to you. `gather`/`gatherAll` pay out what has fallen on your
shares since you last settled; `setAutoStake(true)` stakes your gathered MANNA instead of
transferring it. Entering and leaving settle your pending Manna first, at your share count before
it changes, so nothing is mispriced across the change.

You earn two things: 90% of your Storehouse's borrow interest, compounding into the vault's own
share price (the other 10% is the tithe), and a pro-rata slice of the morning fall, weighted first
by how much of your Giant is currently borrowed and then by your share of your Storehouse. You
cannot leave with more than the vault's `liquidity()` — idle balance plus each market's own spare
capacity — covers right now; when the Giant is heavily borrowed by shorts, wait for repayments or
ask for less.

## For slings

Once, per wallet: `Morpho.setAuthorization(router, true)`. Then approve USDG to `LocateRouter` and
call `openShort(marketParams, collateralUSDG, borrowGiant, receiver)` to post collateral and borrow
the Giant in one transaction; sell it wherever you like. Every Storehouse market uses the lowest
LLTV this chain's Morpho enables, 38.5%. The router reports your liquidation price directly:

```
liquidationPrice = collateral × lltv × 1e12 / borrowAssets      (USDG per 1 Giant, 18-decimal fixed point)
```

Close with `closeShort(marketParams, repayShares, withdrawCollateralAssets, receiver)` — `0` for
either amount means "all of it." The Watchmen are anyone who calls Morpho's own `liquidate()` on an
unsafe sling; there is no special role, and the seized collateral pays Morpho's own bonus (capped at
15% at this LLTV). A zero-capital, flash-settled liquidator is sketched in
`docs/borrow-the-meme.md` but is not part of this contract set today.

## For stakers

`stake(amount)`/`unstake(shares)` MANNA with no lock-up; `stakedOf(user)` is what your stake is
worth right now. Every dawn that finds at least one staker grows the shared pool, so a stake share's
value rises over time rather than paying a separate reward token. `skim()` lets anyone fold a stray
MANNA balance (a bare transfer to the contract, outside a dawn) into the stakers' pool.

## Fees and where the money goes

| Flow | Share | Notes |
|---|---|---|
| Storehouse performance fee (the tithe) | 10% of borrow interest | Minted as vault shares to Manna, sold each dawn |
| Pons trading fee on MANNA | 1% base + 1% creator tax | Claimed from the shared fee escrow, already net-settled to USDG |
| Treasury | 20% of each dawn's income | Dial-settable, not on Sunday |
| Joseph's Reserve | 10% of income | Only until the Reserve reaches 10% of the Storehouses' value (also a dial) |
| Charity (held for Jubilee) | 5% of income | Paid out at the next Jubilee |
| The buy | Rest of income + carry, capped at `maxBuy` (5,000 USDG) and at 1% of the venue's USDG depth | Min-out = 95% of the adapter's fee-net quote; the remainder carries |
| Caller's tip | 0.5% of the MANNA bought | Paid to whoever calls `dawn()` |
| Stakers | 70% of the bought MANNA after the tip | Redirected to lenders if nobody has staked |
| Lenders | 30% of the bought MANNA after the tip | Weighted by borrowed USD value, then by staked shares |
| Spoilage | Whatever a lender leaves ungathered 7+ days | Burned |
| Reserve `restore()` | Bad-debt Giant bought back and donated to a Storehouse | Booked as vault yield, so 10% of it is tithed straight back |

All percentages above but the trading and performance fee are the constructor defaults and can be
changed by the owner (`setDial`) on any day but Sunday.

## Risks you should read before using it

- **Oracle lag and manipulation, bounded by caps.** The Prophet is a 30-minute TWAP (falling back to
  10 minutes, reverting below that). A fast pump outruns it; a liquidator then buys at spot to repay
  debt Morpho still values at the lag, and Morpho's 15%-capped bonus at 38.5% LLTV covers a 15% gap
  and no more. Beyond that the loss is bad debt, isolated to that one Storehouse's lenders — Morpho
  isolates markets and each Storehouse holds only one Giant. Moving the mean price meaningfully costs
  roughly the pool's own depth, and caps are sized to a few percent of it, so manipulation for profit
  should not pay at these sizes; it can still happen.
- **Bad debt is not fully covered.** Joseph's Reserve only ever spends up to what it currently holds
  when `restore()` buys a Giant back for a Storehouse sitting below its high-water mark. A loss
  larger than the Reserve's balance is not made whole; the Storehouse's own share price carries the
  rest, permanently, exactly as `docs/borrow-the-meme.md` warned it sometimes will.
- **The buyback cannot be sandwiched for profit, by construction.** A quote read from the same pool
  in the same transaction is no defence: an attacker moves the price first and the quote moves
  with it. So each dawn's buy is capped at 1% of the pool's own USDG depth (`maxSpend`), which
  moves the price about 2%, less than the 2 × 2% the hook charges a sandwich for its round trip.
  The 95%-of-quote minimum only guards against a broken adapter. The cost of the rule is pace: a
  thin pool takes the budget in small daily bites and the rest carries.
- **Owner powers, and their limits.** The owner sets the dials, the treasury/charity/adapter/escrow
  addresses, and which Storehouses are active — all frozen on Sundays. The owner **cannot** move a
  lender's staked vault shares or a staker's staked MANNA (there is no such function), **cannot**
  mint MANNA (nothing in this contract mints — it only buys, stakes and unstakes what already
  exists), and can replace the buyer or seller adapter with a bad one, but Manna approves an adapter
  for only the exact amount of one call and checks delivery by balance, not by trust — a malicious
  adapter can misroute or fail one day's buy or tithe sale and nothing more.
- **It is a memecoin.** MANNA is a fixed-supply Pons V2 launch token; its price depends on its own
  trading and on the daily buyback, both of which shrink if volume does. Nothing here promises a
  floor or a return.
- **This is unaudited.** The contracts are tested end to end against the vendored Morpho Blue and
  `LocateVault`/`LocateRouter` code inside an in-process EVM (`scripts/test.js`,
  `scripts/test-dawn.js`), but nobody outside this repository has reviewed them yet.

## Legal shape

Manna lends and shorts memecoins, not securities, through Morpho Blue markets that are permissionless
to create; the contracts hold lenders' vault shares and stakers' MANNA under rules with no owner
withdrawal path, and nothing else. A coin whose fees
buy it back and pay holders looks more like a claim on revenue the larger that flow gets, which is a
risk MANNA shares with every fee-sharing coin on this chain; this is not legal advice, and counsel
should review the launch before it is real money. The site describes what the contracts do and
promises nothing beyond that.
