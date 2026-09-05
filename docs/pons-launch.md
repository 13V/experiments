# A memecoin on Pons V2, with a job

Read on 5 September 2026 from Pons's V2 docs, its factory on chain, and what the other
stock-paired memes already do. The premise: the coin itself is a plain Pons token, fixed supply,
nothing to hook. Every trade pays a fee in the pairing asset, most of it goes to whatever address
the creator names, and that address can be a contract. So the utility is not in the token; it is
in the contract that receives the fees, and the fee stream is the engine.

## Pons V2, verified

| Rule | Value |
|---|---|
| Factory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` (router `0xe33e9e47…62948`) |
| Supply | fixed per launch config, all of it minted onto a constant-product curve in the quote asset |
| Graduation | when the curve sells out, into a full-range Uniswap v4 position deposited in a locker forever; the pool charges no fee of its own and runs Pons's shared Meme hook at `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| Quote assets approved on chain | USDG, SPY, NVDA, AAPL, LLY, GME, HIMS, MSTR, TSLA, GLD, SGOV; native ETH by its own path; WETH no |
| Fees | protocol share first, an optional buyback slice, the rest plus the whole creator tax to the creator fee recipient; the common split is 70/30 |
| Creator tax | optional, capped by `maxCreatorTaxBps() = 1000`, so up to 10% on top of the base fee |
| Where fees land | an escrow in the pairing asset; the recipient calls `claim()` or `claimToken(asset)` whenever it likes |
| Fee recipient | set at launch, may be a contract, transferable at any time by the current recipient |
| Snipe protection | a 99% buy tax decaying to zero over the first five seconds; up to 32 exempt addresses |
| Dev buy | in the launch transaction, before anyone else; no allocation otherwise |

Two consequences. A coin paired with a stock receives its fees as that stock, so a treasury in
NVDA or LLY needs no swap. And a coin paired with USDG receives fees in the one asset Stonk
Packs are priced in. One caveat: a graduated Pons pool is a v4 pool with no price oracle, so
the coin cannot be borrowed or shorted through a TWAP-based market, including ours.

## What is already table stakes

Stock-paired memes with a fee-fed treasury and burn-to-redeem are the chain's dominant genre:
Artificial Inu's vault holds 16% of NVDA's on-chain float, BONER's holds 50% of HIMS's. PonsVault
sells three templates (stake for fees, stake and burn, fees buy a stock and holders claim by
balance) with a lottery template coming; Flap has a stocks vault; PAIR does baskets. A floor in a
stock is expected now, not a differentiator. The twist has to be something the templates cannot
do, and the things this repository has already built are exactly that.

## Five designs the templates cannot do

### 1. The pack coin (recommended)

> Every Friday the vault rips packs for the stakers. One in two thousand holds a whole share of Eli Lilly.

- **Pair:** USDG. Fees arrive in the packs' own payment token.
- **Fee recipient:** `PackVault`, immutable rules. Each Friday at the close it claims the escrow,
  spends a fixed share on Stonk Packs through `buy(bytes32 buyerSeed)`, and distributes the sealed
  packs to stakers by time-weighted stake, the remainder raffled with the same hash-chain draw
  the packs use, so the distribution is as verifiable as the packs. Stakers open their own
  packs, on the site, with the show.
- **Why it beats the templates:** a stock dividend by balance is a number in a wallet; a sealed
  pack with a published odds table, a verifier, and a whole LLY share at the top is an event,
  weekly, with a livestream. STONKBROKER's Clock In drops made an $80M peak out of a cruder
  version of this loop.
- **Economics:** base fee 1% plus a 1% creator tax puts about 1.7% of volume in the vault. A coin
  doing $1M a day funds 850 packs a day at $20; the pack contract's own 10% fee recycles to the
  vault if the vault is its fee recipient, so the community gets packs at roughly cost. Inventory
  is the operator's job and scales with volume.
- **Legal shape:** the public never buys a pack; the vault does, and hands them to stakers as a
  promotion. A different fact pattern from selling loot boxes, not a cleared one. Counsel.

### 2. The hunt

> The treasure grows with every trade. The key is in the coin's own history.

- **Pair:** native ETH, because `fundStage` is payable in ETH.
- **Fee recipient:** a forwarder that funds the Treasure Hunt escrow, which has no withdrawal path
  and pays only a solver whose own address is inside the signed claim. Stages open on a schedule;
  the key bytes are hidden in the coin's own transfers, the way the README describes.
- **Why it works on Pons:** anyone can check the prize balance grows with volume, and nobody,
  including the creator, can take it out. Freysa is the comparable.

### 3. NVDA500

> You can stake it today. You can unstake when NVIDIA prints $500.

- **Pair:** NVDA, so the fees are NVIDIA.
- **Fee recipient:** a vault where staked coins are locked until the NVDA feed prints the target
  and stakers, and only stakers, receive the NVDA fees pro rata by time-weighted stake. Paper
  hands are a choice, not a transfer restriction, so it needs no hook and cannot be called a
  honeypot. The whole coin is a price target everyone already watches.

### 4. The bear

> We lend your coin to your shorts and keep the interest.

- **Pair:** USDG.
- **Fee recipient:** a vault that buys PONS, CASHCAT and AI and lends them into the borrow-the-meme
  vaults at whatever rate the shorts pay, distributing the interest to stakers; optionally it runs
  a public short book. It is the first customer of the product this repository is building, and
  the most contrarian coin on a chain that is long everything. It waits for that market.

### 5. The dividend coin

> The SPY that pays its dividend.

- **Pair:** SPY.
- **Fee recipient:** a treasury in SPY that publishes NAV from the feed, buys back below it, and
  pays holders the dividend the token leaks, in USDG, by running the ex-date hedge once Locate is
  live. The leak exposé is the launch post and 18 September is the first date. Story-first.

## Launch checklist for the pack coin

1. Deploy `PackVault` with the rules fixed in the constructor: pack share, buyback share, the
   packs contract, the stake contract, the Friday schedule. No owner functions that touch funds.
2. Deploy Stonk Packs with the vault as `feeRecipient`, lock the odds, seed inventory.
3. Launch on the V2 factory: quote USDG, base fee 1%, creator tax 1%, creator fee recipient the
   vault, buybacks off (the vault does them, visibly), the vault and the packs contract in the
   snipe-exempt list, a small disclosed dev buy.
4. Publish the rules, the odds table, the verifier and the vault address before the first buy.
   The first Friday rip is the marketing; stream it.
5. Dates that matter: 18 September (SPY's first on-chain ex-date, if the dividend story is part
   of the launch), 29 September (Robinhood stops covering gas in its wallet, volume risk).

## What to check before any of it

- The Meme hook's code, for an oracle: if it records one, the coin becomes borrowable and the
  bear coin's sibling, the anti-coin, becomes possible on Pons tokens.
- The exact fee policy per launch, read from `getLaunchFeePolicy(token)` after a dry run on the
  factory, since the split is per-config rather than fixed.
- Whether the escrow's `claimToken` can be called by anyone for the recipient or only by the
  recipient; the vault's claim step depends on it.

## Six more, fresh

**The people's portfolio.** Pair with USDG. Every week stakers vote, stake-weighted and on chain,
which of the eleven approved stocks the vault buys with the week's fees; the treasury becomes a
basket the community picked, with burn-to-redeem across it. The templates buy one stock forever.
This one produces a vote, a result, a buy and an argument every seven days, which is what a
community actually wants from a treasury.

**The gold coin.** Pair with GLD, which the factory approves and nobody has used. Fees arrive as
gold, the floor is gold, burn-to-redeem pays gold. Gold bugs and degens have never had a shared
coin, and "the meme backed by gold" is the oldest pitch in money made literal. SGOV is approved
too: the same coin with a floor in T-bills is "the boring coin," whose floor is the only one on
the chain that earns yield while it sits there.

**The gasless coin.** Pair with USDG. The vault pays holders' gas: a weekly rebate in USDG for the
gas a holder spent on the chain, computed from their receipts, published as a Merkle root anyone
can recompute, scaled by stake. Gas became real on 29 September for everyone outside
Robinhood's wallet, and this is the one utility every trader on the chain feels every day.

**The dip coin.** Pair with a stock. The vault holds fees as USDG and buys the stock only when the
feed shows it down a set percentage from its 20-day high, proven by round IDs a keeper submits
and the contract checks. "Buys the dip so you don't have to." A rule you can read, applied to the
one behaviour retail says it wants and never manages.

**Never sold.** Pair with a stock. Fees are distributed in that stock only to wallets that have
never made an outgoing transfer of the coin, computed from the coin's own transfer events and
published as a root; one sale and you are off the list forever, publicly. The templates pay by
balance. This pays by conviction, and the list of the fallen is the content.

**The tournament coin.** Pair with USDG. The week's fees are the prize pool of a stock-picking
tournament that stakers enter free: pick a lineup on Sunday, settle on Friday's prints, the pool
pays the top of the table. A skill contest with free entry, which is a better legal shape than a
lottery, and a scoreboard to post every Friday.

Pairing angles the factory allows and nobody has taken: GLD, SGOV, and TSLA for the obvious
crowd. GME is approved and should be left alone; a fee-fed treasury in a stock with a few million
dollars of on-chain float is a weekend squeeze by construction.

## The honest version

Everything above is passive by construction: fees in, a contract buys something, holders receive
it. That is a treasury with a mascot. High utility on this chain means the coin is the equity of a
venue that lets people do something they cannot do today. There are three such venues, and the
proven comparables for each are the largest "utility meme" outcomes of the last cycles.

**$SHORT: the coin is the exchange where you short memecoins.** Borrow the meme is the backend;
the product is a one-click long/short desk on PONS, CASHCAT and AI (and every meme with an
oracle-grade pool after them), and the coin takes the vaults' fee on interest plus a buyback.
Launched on Pons itself, against the coins launched on Pons. It is the most controversial launch
possible on a chain that is long everything, every community it lists will talk about it, and the
utility is the one thing 160,000 coins' worth of traders cannot get anywhere. Comparable: HYPE,
the token that was the exchange.

**The bot: a trading bot for this chain whose fees pay the coin.** Telegram-native, like Banana
Gun and BONKbot, which turned bot fees into nine-figure tokens, with what no other bot has: the
tape (the issuer's mints as they happen), ex-date and dividend-leak warnings, the weekend spread
against the app's quote, graduation odds on Pons curves, one-tap shorts through the market above.
Real tool, proven model, and every alert is a reason to open it.

**The house: an HLP-style vault token.** One pool that takes the other side of the chain: it lends
memes to shorts, provides the liquidity in stock and meme pools, and underwrites weekend gap
cover for leveraged borrowers, earning the borrow rate, the swap fees and the premium. The token
is the vault's equity. Comparable: Hyperliquid's HLP and GMX's GLP, the two counterparty pools
that became the most valuable things on their chains.

These are one thing seen from three sides. $SHORT is the venue, the house is its capital, the bot
is its distribution. If the launch is a memecoin on Pons, make it the product's token, not a
treasury beside it: the meme framing gives the product the attention it needs, and the product
gives the meme the only utility on this chain that is not already a template.
