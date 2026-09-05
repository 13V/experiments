# Borrow the meme

> Locate, pointed at the other 99% of the chain.

Feasibility read on 5 September 2026. Robinhood Chain has launched more than 160,000
memecoins, three of them are worth $230M to $640M, one of those is two days old, and there is
no way to short any of them: Longbow takes memes as collateral but nobody lends them, and
neither perpetuals venue lists them. The only short on this chain is selling what you already
hold. Locate's design fills that side without changing a contract: Morpho markets with the
meme as loan token and USDG as collateral, `LocateVault` per meme for the lenders, `LocateRouter`
for the shorts. The one new piece is the oracle, and the chain turns out to already have what it
needs.

## What the chain offers today

Memes have no Chainlink feed, so the oracle has to be a Uniswap time-weighted price. A v3 pool
serves one only if its observation buffer has been grown; a v4 pool carries no oracle at all
unless it was created with an oracle hook. `scripts/meme-pools.js` checks that, live:

| Meme | Cap | v3 pool | Liquidity | 24h volume | Fee | Observations | 30-min TWAP | Meme side | Constant-L cost to double spot |
|---|---|---|---|---|---|---|---|---|---|
| PONS | $430M to $636M | `0x10CC…26bA` | $6.65M | $8.5M | 1% | 20,000 | yes | token1 | $2.6M |
| CASHCAT | $248M | `0xA70f…E313` | $5.42M | $5.6M | 1% | 20,000 | yes | token0 | $3.1M |
| AI | $232M | `0xc4a2…Da1D` | $3.26M | $10.5M | 1% | 20,000 | yes | token1 | $2.5M |
| Index | $56M | `0xD298…28Ff` | $1.35M | $4.0M | 1% | 1,801 | yes | token1 | $1.2M |
| BONER | $34M | `0xBd5c…e6b8` | $280K | $2.3M | 1% | 1,400 | yes | token1 | $0.2M |

All five are 18-decimal tokens quoted in WETH. The second hop, WETH/USDG, is the deepest pool
on the chain: v3 0.01% at `0x52e65B17…71Ca`, $29.4M of liquidity, 2,500 observations, a 30-minute
TWAP available. So the three largest memes on the chain, the ones people most want to short,
are oracle-ready today, and someone has already paid to grow their buffers to 20,000 slots.

Not today: MEME, SHROOM, ROBINCAT, MOO and NUDES have v3 pools with a single observation and
their depth in v4; OTER and SHRUB are v4 only; STONKBROKER's depth is in v4. A single
observation means "OLD" for any window, and anyone can fix it for a few dollars of gas with
`increaseObservationCardinalityNext`, but a pool with $300K behind it should not be a market
anyway.

## The oracle

One contract, `UniswapV3TwapOracle`, implementing Morpho's `IOracle.price()`. Both hops are v3
pools whose price is `1.0001^tick` in raw token1 per raw token0, and Morpho wants raw loan units
per raw collateral unit times 1e36. With the meme as token1 of its pool and WETH as token0 of
the WETH/USDG pool, the decimals cancel and the whole oracle is one tick difference:

```
tickMeme = arithmetic mean tick of the meme/WETH pool over the window   (raw meme per raw WETH)
tickWeth = arithmetic mean tick of the WETH/USDG pool over the window   (raw USDG per raw WETH)
price()  = 1.0001 ^ (tickMeme − tickWeth) × 1e36                        (raw meme per raw USDG)
```

For a meme that is token0 of its pool (CASHCAT), negate its tick. Compute it with TickMath's
`getSqrtRatioAtTick(Δtick)` squared, vendored from v3-core the way Morpho is vendored today, with
`mulDiv` for the scaling. It is the same number the Chainlink oracle factory produces for
Locate's stock markets, from ticks instead of feeds.

- **Window: 30 minutes**, read as `observe([1800, 0])` on both pools. At market creation the
  script requires `observationCardinality ≥ 1,800` on the meme pool and grows it if not (1,800
  slots is about 36M gas, a few dollars at this chain's floor fee, tens at its peaks).
- **Never revert.** Morpho reads the oracle on every borrow, collateral withdrawal and
  liquidation; an oracle that reverts freezes the market with the shorts inside it. If the
  buffer cannot cover 30 minutes, the oracle uses the longest window it can down to a floor of
  10 minutes, and reverts only below that, on purpose: a market with no oracle must not lend.
- **Grow the buffer before the market exists.** A pool's cardinality is also its history; it
  cannot be made retroactively.

## What can go wrong, in order of likelihood

**The lag, not the manipulation.** A 30-minute mean lags a pump. When spot runs ahead of the
oracle, a liquidator must buy the meme at spot to repay debt that Morpho values at the TWAP, and
the 15% liquidation bonus (the cap Morpho applies at a 38.5% LLTV) covers a 15% gap. Beyond that,
liquidations pause until the average catches up, at most 30 minutes, and a max-leverage short
can go underwater inside that window. That is bad debt, and it lands on the lenders of that one
market and nobody else: Morpho isolates it, and a Locate vault holds one meme, so a PONS blowup
never touches CASHCAT's lenders. Memes on this chain gap that hard organically (AI went from
nothing to $232M in two days), so lenders should expect occasional bad debt as a cost the rate
pays for, and the market list and caps exist to keep it occasional.

**Manipulation, bounded by the caps.** A borrower profits from an oracle that underprices the
meme (borrow too much per USDG, sell at true spot, walk away); a liquidator profits from one that
overprices it (seize USDG at a 15% bonus). Moving a 30-minute mean by X% means holding spot X%
off for 30 minutes against everyone arbitraging it back, or spiking it harder for less time: a
spike of factor F for a fraction f of the window moves the mean by F^f. The table's last column
bounds a spot spike: roughly $2.5M into PONS's pool for a double, before the $8.5M a day of flow
pulls it back. Against that, the prize is the market's borrow cap times the mispricing, so with
caps in the low hundreds of thousands neither attack pays. Caps are the security parameter.

**The squeeze.** The closest precedent is Aave, November 2022: a short built by borrowing 92M CRV
against USDC, a squeeze, and $1.6M of bad debt on a pooled-risk protocol. The design answer is
the one above: isolated markets, one vault per meme, caps a few percent of pool depth, and the
lowest LLTV the chain's Morpho enables. The rate is the other answer. Someone paid 600% a year
to keep that CRV short on; shorts of a meme that has tripled will pay whatever the curve asks.

**The rate curve.** Morpho's Adaptive Curve IRM starts at 4% a year at 90% utilization, bounded
between 0.1% and 200% at target, times four at full utilization, so 800% is the ceiling. It
adjusts at a log speed of 50 a year: fully borrowed, the rate at target grows about 15% a day and
doubles every five days, so a market that stays fully borrowed goes from 16% to the ceiling in
about a month unless lenders show up. That is the product working: the borrow rate is the
price of shorting, and it is set by people who want to short.

## Markets and caps

Caps at about 3% of the oracle pool's liquidity, the lowest enabled LLTV, and the adaptive IRM:

| Market | Oracle pool liquidity | Initial cap | LLTV |
|---|---|---|---|
| PONS / USDG | $6.65M | $200K | 38.5% |
| CASHCAT / USDG | $5.42M | $160K | 38.5% |
| AI / USDG | $3.26M | $100K | 38.5% |
| Index / USDG | $1.35M | $40K | 38.5% |
| BONER / USDG | $280K | hold until the v3 pool deepens | |

About $500K borrowable at launch. At full utilization and a 200% rate that is $900K a year of
interest and $90K to the vault's 10% fee; at the opening 16% it is $7K. The rate is what shorts
pay, and the demand is the loudest thing on the chain. Caps rise with pool depth, in public.

## Who uses it

- **Shorts.** Anyone who thinks a two-day-old $232M coin is not worth $232M. Market makers
  hedging inventory. LPs hedging the meme leg of a pool. The same people who make the
  memecoins move, the other way.
- **Lenders.** Holders who will not sell, earning the rate their own token's shorts pay.
  Treasuries of the memes themselves: lending your own token to your shorts is the oldest
  trade in the book, it earns yield, and it puts a number on short interest.
- **Everyone else.** The first short-interest and borrow-rate figures for memecoins on this
  chain, per market, on chain. The communities being shorted will make the marketing.

## The moat problem and its answer

New memes launch into Uniswap v4 pools, which carry no oracle, so today only v3-pooled memes
qualify, and that happens to be the top of the market. Three ways to widen it:

1. Uniswap's truncated-oracle hook (`TruncGeoOracle`) makes a v4 pool an oracle with a per-block
   cap on how far the recorded price can move, which is exactly the property a lending oracle
   wants. It needs full-range, permanently locked liquidity, which is what launchpads do
   anyway. A launchpad that adopts it makes every graduate shortable on day one; Pons and Stonk
   Launcher are the two to pitch.
2. Pons's own v2-style DEX exposes cumulative prices, so its graduates are oracle-able with a
   v2 adapter and a keeper that checkpoints.
3. Grow the buffers on the v3 pools of memes that already have them thin, when their depth
   earns a market.

## The build, on top of Locate

| | |
|---|---|
| Contracts | `UniswapV3TwapOracle.sol`, about 120 lines plus vendored TickMath. Vault and router unchanged: an 18-decimal loan token and 6-decimal USDG collateral is the case they already handle. |
| Scripts | `create-markets.js` gains an oracle kind: deploy the TWAP oracle with the meme pool, its side, the window and the WETH/USDG pool, then check and grow cardinality, then `createMarket`. `markets.json` entries gain `pool`, `memeIsToken0`, `window`. |
| Tests | A `MockV3Pool` whose `observe()` returns settable tick cumulatives, against the vendored real Morpho: both token orientations, the window fallback, the floor revert, a manipulation scenario (a three-minute spike moving the 30-minute mean by F^0.1), and the lag scenario (spot 40% over the mean, liquidation unprofitable, bad debt through the vault's accounting). |
| Site | The Locate desk with a meme list. The premium board becomes a borrow board: rate, utilisation, short interest, cap left, and the lag meter (spot against the oracle). |
| Effort | One to two weeks on top of Locate. |

## Legal shape

Memecoins are not securities in most readings, and borrowing and lending them is not
securities lending, so the Reg S wall that surrounds the stock tokens does not apply here; the
front end still geo-gates the way Locate's does, and some jurisdictions treat crypto lending as a
regulated activity for whoever operates the surface. Communities will call shorting their coin
manipulation; a borrow market is the opposite, and the numbers it publishes are the argument.
Counsel before launch, as ever.

## Open questions

1. Whether the 20,000-slot buffers on the three big pools are Uniswap's launch-tooling default
   or something the teams did; if the default, every future v3 launch arrives oracle-ready.
2. Whether the vault should take more than 10% of interest when interest runs at 200%.
3. Whether to seed lender supply with inventory bought for the purpose, to open with depth.
4. Whether to open with three markets or five.

## Reproduce

```bash
node scripts/meme-pools.js PONS CASHCAT AI Index BONER     # pools, depth, buffers, TWAP availability, spike cost
```

Pool discovery goes through DexScreener; everything else is the public RPC. The cost-to-double
column assumes the in-range liquidity stays constant to twice the price, which real books do not,
so it bounds a spot spike from above. The rate-model constants are from Morpho's
`ConstantsLib`; the liquidation bonus is Morpho's formula at a 38.5% LLTV, capped at 15%.
