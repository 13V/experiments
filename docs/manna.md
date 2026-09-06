# Manna: the product, and where the 10% goes

Written 6 September 2026. The coin is called MANNA. This is what it does, what the site shows,
how the money moves each morning, and the answer to whether a 10% cut should buy the coin back.

## In one paragraph

Manna is the short desk for memecoins on Robinhood Chain, named after the thing it does every
morning. Holders of the chain's biggest memes, the Giants (PONS, CASHCAT and AI at launch), lend
them into Storehouses and earn the rate the shorts pay. Anyone with USDG can sling a Giant, the
only bear trade on the chain. And every morning at 12:00 UTC the desk's income buys MANNA in its
own pool and it falls on the lenders and the stakers. The contracts are Locate's vault and router
on Morpho Blue meme markets with two-hop TWAP oracles, exactly as `borrow-the-meme.md` sized
them. The coin is a plain Pons V2 token paired with USDG; the utility is one new contract that
receives the fees.

## What is on the site

1. **Storehouses**, one per Giant. Deposit PONS, receive shares. The Storehouse supplies Morpho
   markets where PONS is the loan token and USDG the collateral, up to the market's cap, and
   earns the borrow interest in PONS. A 10% performance fee on that interest, the tithe, is taken
   as shares by the Manna contract (`LocateVault` already has the parameter, capped at 50%).
   Withdraw whenever the unborrowed balance covers it. Depositors also receive Manna.
2. **Slings.** Post USDG, borrow the Giant at the lowest LLTV the chain's Morpho enables (38.5%),
   sell it. The page shows the liquidation price, the rate ticking by the second on Morpho's
   adaptive curve, and Proverbs 22:26-27 next to the collateral field. Close by buying the Giant
   back and repaying. The router has no fee of its own today, and should not at launch.
3. **The Tape.** Per market: borrow rate, utilisation, short interest, cap left, and the lag meter
   (spot against the Prophet, the 30-minute TWAP). The Watchmen's feed lists liquidations as they
   happen; anyone can be one through Morpho's callback with no capital.
4. **Manna.** A countdown to dawn, today's portion, a gather button, staking. Staked wallets
   gather automatically. Portions not gathered within seven days spoil and are burned at the next
   dawn (Exodus 16:20), so the diligent lose nothing and the burn costs nobody who shows up.
5. **Sunday Service and Jubilee.** The signed weekly report; no listings or parameter changes on
   Sundays. Every seventh Sunday, one transaction sends the charity slice and publishes seven
   weeks of Manna fallen, gathered and spoiled, with Joseph's Reserve's balance.

## How Manna falls

The Manna contract is the creator fee recipient of the Pons coin and the fee recipient of every
Storehouse. Six mornings a week, from 12:00 UTC, anyone can call `dawn()`; the caller is the
first to gather and keeps 0.5% of the day's portion, so no keeper is needed. On Sunday nothing
falls and Monday's portion carries two days. The call does this, in order:

1. Claims the coin's escrowed Pons fees, which arrive in USDG.
2. Redeems the tithe shares from each Storehouse, receives Giants, and sells them for USDG along
   the same two-hop route the oracle reads (Giant to WETH to USDG), with a minimum-out set from
   the TWAP, so the Prophet guards the buyback as well as the loans.
3. Splits the USDG: 20% to the treasury, 10% to Joseph's Reserve until the Reserve holds 10% of
   the Storehouses' value, 5% held for the charity transfer at Jubilee, and the remaining 65% buys
   MANNA in its own pool. The buy is capped at 1% of the pool's reserves per call; anything left
   rolls to the next morning, so a bot watching the sequencer feed for the noon call has almost
   nothing to take.
4. Allots the bought MANNA: 70% to stakers pro rata, 30% to the Storehouses, weighted by how much
   USDG-worth of each Giant is actually borrowed, so the Manna follows the shorts, and within a
   Storehouse pro rata by shares. Then it burns whatever spoiled.

Joseph's Reserve is USDG. If a market ends up with bad debt, the Reserve buys the Giant and
returns it to that Storehouse, so lenders are made whole from the fat years; if it is empty, the
Storehouse's share price takes the loss, as `borrow-the-meme.md` warned it sometimes will.

## Should a 10% cut buy the coin back

There are five places a cut could be taken. Only one of them is the tithe, and it is not where
the buyback money comes from at first.

| Where | What it yields | Verdict |
|---|---|---|
| A 10% performance fee on the interest shorts pay (`performanceFeeBps = 1000`, already built) | $500K of caps at the opening 16% rate and 90% utilisation: about $7K a year; at 100%: $45K; fully borrowed at 200%: $90K | **Yes.** This is the tithe. BOW charges the same 10%; lenders keep 90%. |
| The Pons creator tax at its 10% maximum | on paper ten times the fee income; in practice an 11% round trip that scanners flag, aggregators and Voxelithic route around, and volume avoids | **No.** Base fee 1% plus a 1% creator tax, as every winner in `pons-tech.md`. |
| A sling open fee, say 0.25% of notional | shorts already pay the rate; the demand is new and nobody knows its elasticity | **Not at launch.** Add it only if the Tape shows shorts paying any price. |
| A cut of the 15% liquidation bonus | Morpho pays the whole bonus to whoever liquidates; the desk could only skim it by being the sole liquidator, which defeats the Watchmen | **No.** |
| Manna that is not gathered | whatever spoils after seven days | **Yes**, as the burn. It costs the diligent nothing. |

The money for the morning buy comes from the coin's own trading, not from the desk, for as long
as the caps are small. Pons tokens between $1M and $15M trade a median 0.32 times their market
cap a day in their launch month and about 0.10 in steady state, and about 1.7% of volume reaches
the creator fee recipient at a 1% base fee plus a 1% creator tax. At a $3M market cap:

| Stream | Launch month | Steady state |
|---|---|---|
| Trading fees, 1.7% of volume | about $16K a day | about $5K a day |
| The tithe, 10% of interest on $500K of caps | $20 to $250 a day | the same until caps rise; $685 a day at $5M borrowed and a 50% rate |
| MANNA bought each morning (65% of the pool) | about $10K a day | about $3.3K a day, roughly 40% of the cap a year, falling with volume |

So the tithe is ceremonial at launch and becomes real as caps grow with pool depth, which is the
same shape as BOW, whose $8.7M rests on its fee architecture rather than its TVL. Say that in
public; it reads better than pretending the desk funds the coin on day one.

Buy back and burn, or buy back and rain? Burning treats every holder alike and does nothing for
the desk. Raining fills the Storehouses, which is the desk's real constraint (holders must lend
their Giants before anyone can short them, and the rate alone will not persuade everyone), and it
makes staking the default, which takes float off the market. Spoilage supplies the burn. The
plainer alternative is BOW's, paying USDG per second, and it is a fine product; the name argues
for the rain, and the rain gives the coin the one visible daily event the treasury coins lacked.
The 70/30 split between stakers and Storehouses is a dial for Sunday Service to turn as the
caps rise; at launch 30% of the morning buy is already about a 79% yearly rate in MANNA on
$500K of deposits, on top of the borrow rate itself.

One line on the law: the more a coin is a claim on revenue, the more it looks like a security.
That risk is shared with BOW, PARE and every fee coin on Pons, and none of this is legal advice.
The site describes what the contract does and promises nothing.

## What has to be built

Already in this repository: `LocateVault` (three instances, fee 1,000 bps, fee recipient the
Manna contract), `LocateRouter`, the Morpho market parameters and the two-hop oracle from
`borrow-the-meme.md`, the desk site with the premium board that becomes the Tape.

New: `Manna.sol`, one contract of a few hundred lines: `dawn()`, `gather()`, `stake()` and
`unstake()`, the seven-day spoilage, Joseph's Reserve, the charity ledger, Jubilee, the tranche
cap on the buy; the four site pages above; and the Sunday report script. Nothing needs an admin
key after launch except market listings and the split dial, both announced on Sunday and
executed on Monday.

Launch: Pons V2 factory, quote USDG, base fee 1%, creator tax 1%, fee recipient the Manna
contract, supply 144,000,000, dev buy of 2% to 3% locked. The three Storehouses and their
markets live before the curve opens, with a borrow rate showing on the Tape. The curve is the
Wilderness; graduation is the Jordan; the first dawn is the morning after.
