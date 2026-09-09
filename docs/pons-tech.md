# Pons graduates above $1M that have real tech, and what they are built on

Read on 6 September 2026. Method: every pool on the two Pons DEX ids in GeckoTerminal (499
tokens), kept at a market cap of $1M or more (46), stock tokens that appear as the base of a meme
pool removed, each token classified on chain by Pons's self-describing `description()` getter
(V1 tokens also answer `liquidityPool()`), then each project's site and docs read, and TVL from
DefiLlama's API. BOW and OTER are included as the comparables the question named, though neither
launched on Pons itself.

## The ones with a product

| Token | Cap | Pair | What it does | Built on | How the token earns |
|---|---|---|---|---|---|
| DELTA (Delta Liquidity) | $11.4M | WETH, Pons V1, 31 Jul | Manages concentrated liquidity positions: 13,873 positions, $2.29M in fees, $2.09M TVL | Uniswap v3 positions | staking with fee share |
| GRASS (Touch Grass) | $8.1M | ETH, V2, 3 Sep | A location game: stock-token fragments spawn at the companies' real stores, 721 drops in 121 cities, a whole NVDA share monthly | spawn table, claim server signing EIP-712 vouchers, a one-function vault, a swapper that buys stock hourly from the treasury | 37.5% of every fee funds the fragments |
| ORBIO | $6.9M | NVDA, V2, 1 Sep | Holding 1,000+ tokens earns OpenRouter inference credits hourly by time-weighted balance, claimed as $200 API keys | an off-chain ledger over on-chain fees | 1.5% trade fee, half converted to credits at face value |
| PARE | $5.35M | ETH, V2, 2 Sep | Splits a stock token into a principal token and a dividend token per maturity, using the ERC-8056 multiplier | StripVault, a MultiplierAccountant oracle that classifies dividends against splits with a 2-day guardian timelock, PT/stock and YT/stock v3 pools | 10 bps on split, 5% of dividend growth on redeem, to liquidity and buyback-burn; 97.74% of supply to the pool, 2.26% dev, zero emissions |
| VOXEL (Voxelithic) | $2.3M | ETH, V2, 1 Sep | Aggregator over six venues and 60 pools, read every 20 seconds, minimum-out enforced on chain | a router | fee zero today, 30 bps ceiling; no audit, says so |
| AA (Arbitrage Ape) | $1.2M | USDG, V2, 4 Sep | An autonomous desk: buys thin, pump-prone stock tokens at fair value with fees and sells into any pool 25% or more over the primary print | a bot with an on-chain payout | profit paid to holders every 15 minutes once $300 is owed |
| LDX (Lady Exchange) | $1.2M | ETH, V2, 4 Sep | aggregator and pools | a router | undefined |
| CLAN, UFG, TA | $1.8M to $2.6M | ETH, V2 | access keys to private chats; an ETH treasury with burn-to-redeem; a charity that publishes every fee | small contracts, a Safe | fees to the cause or the treasury |

Not on Pons, but the comparables asked about:

| Token | Cap | What it does | Built on | How the token earns |
|---|---|---|---|---|
| BOW (Longbow) | $8.7M, paired with SPY | Credit layer: borrow USDG against stock tokens, RWAs, crypto and project tokens, flash loans, NFT lending; plus its own stock-paired coin launcher | Morpho Blue, isolated markets, Chainlink and Uniswap TWAP oracles; launched through Longbow's own Pons-powered launcher on 8 Aug | a 10% performance fee on interest split 35% treasury, 30% vault, 25% buyback-and-burn, 10% stakers; 5% of BOW's trading fees to stakers; paid in USDG, streamed per second, no lockup |
| OTER (Oter Finance) | $10.8M, launched 5 Sep | Lending for stock tokens, ETH and USDG; $2.6M TVL | an Aave V3 fork with Chainlink feeds | not yet published |
| STONKBROKER | $37M | 4,444 NFTs loaded with stock, Clock In drops, an NFT AMM, a launchpad, a vote-directed DEX | own contracts | fee routing by token vote |

The two largest Pons "AI" tokens, NOVAAI at $124M and UBIK at $17.7M paired with GLD, have no
site and no product I could find. The tech tier and the meme tier are different markets.

Chain context from DefiLlama: total TVL $903M, of which Morpho Blue $518M (Steakhouse's vault
behind Robinhood Earn is $477M of it), Uniswap $257M across three versions, Lighter $64M, Arcus
$23M, Oter $2.6M, Meridian $2.4M.

## What the tech tokens have in common

1. A fair launch with a tiny team allocation and no emissions: PARE put 97.74% of supply in the
   pool and locked 2.26%. Fixed supply is Pons's rule; the discipline is theirs.
2. A working product on the day the coin trades, with a URL, not a roadmap.
3. A fee stream turned into something holders can watch arrive on a schedule: USDG per second
   (BOW), profit every fifteen minutes (AA), credits every hour (ORBIO), fragments every day
   (GRASS), a buyback that burns (PARE). The cadence is the product's heartbeat and the coin's.
4. Native to stock tokens: PARE reads the multiplier, AA trades the premiums, GRASS hands out the
   shares, BOW and Oter lend against them, Delta manages their pools.
5. Small teams and small contracts, unaudited and honest about it: GRASS's vault has one user
   function, AA is a bot and a payout, ORBIO is a ledger. Nobody waited for an audit to launch.
6. Half of them pair the coin with a stock, so the fees arrive as stock: ORBIO in NVDA, BOW in SPY.
7. The valuation tier: real tech sits at $1M to $12M. Lending tokens specifically sit at $8M to
   $11M on a few million of TVL (Oter $10.8M on $2.6M; BOW $8.7M on Longbow's slice of Morpho).
   That is the market's current price for a working lending product on this chain, and it is
   exactly the range asked about.

## What none of them do

No Pons graduate, and nothing else on the chain, lets anyone short or borrow a memecoin; nobody
lends the stock itself (Locate's side); there are no options; the oracle layer is PARE's
MultiplierAccountant and nothing else; nobody sponsors gas after Robinhood stops; nobody reads
the issuer's wallets; nobody fixes the dividend leak. One consequence worth telling PARE: its
dividend token redeems "the issuer's declared reinvestment", so its YT holders are paid on the
diluted, withheld multiplier the leak document describes, not on the dividend.

## What to build, if the model is BOW

BOW is Morpho Blue with a fee architecture and a launcher. Oter is an Aave fork. Both are valued
at $8M to $11M for lending stock tokens against USDG, the side Longbow already owns. The side
nobody owns is the other one, and its contracts are in this repository:

- **Product:** the short desk. Locate's vault and router on Morpho markets where the meme is the
  loan token and USDG the collateral, starting with PONS, CASHCAT and AI, whose pools are
  oracle-ready today (see `borrow-the-meme.md`). Lenders earn what the shorts pay; shorts get
  the only bear on the chain.
- **Token, copied from BOW where it works:** a performance fee on interest split between
  treasury, the vault's backstop, buyback-and-burn and stakers, plus a share of the coin's own
  Pons trading fee; stakers paid in USDG streamed per second with no lockup; an open fee on
  shorts as the second stream. Team allocation at PARE's scale, 2% to 3%, locked.
- **Launch:** Pons V2, paired with USDG so fees arrive in the desk's own collateral asset, or with
  SPY as BOW did if the narrative is worth the swap. The desk live before the curve opens, with
  the first three markets showing a borrow rate.
- **The heartbeat:** the borrow rate ticking, the payout streaming, and the short-interest board
  updating, which is the cadence every winner above has and the one thing the treasury coins
  lacked.

At the tier the market is paying for lending products this month, that is a $1M to $10M token
built on contracts that exist, for the loudest unmet demand on the chain.
