# More ideas for Robinhood Chain

Written 5 September 2026, two months after mainnet, against what is actually deployed on the
chain. Three things in this repository already target it: Treasure Hunt, Stonk Packs and
Locate. The ideas below were chosen on four tests: nobody has shipped it here yet, it needs this
chain in particular to exist, somebody pays for it on a Tuesday and not only in a bull week, and
it reuses what is already built in this repo.

## The map as of today

What the chain is, and what follows from it:

| Fact | Consequence |
|---|---|
| Mainnet 1 July 2026. Arbitrum Nitro, id 4663, gas in ETH, first-come-first-served sequencer. | No priority-gas auctions. Ordering is latency, not bribes. |
| ERC-4337 is first class; Alchemy sponsors gas and supports session keys. | Gasless, policy-bound consumer accounts are cheap to build. |
| Stock Tokens are debt securities of Robinhood Assets (Jersey) for eligible non-US holders. ERC-20, 18 decimals, roughly 190 on chain, Chainlink feeds for about 95 of them. | Everything built on them serves the 120-country audience, never the US. Every front end geo-gates. |
| Only Authorised Participants mint and redeem, and today there is one (BBVI). | On-chain float is fixed between AP actions. Premiums and discounts to the exchange price are structural and worst on weekends. |
| Corporate actions and dividends never touch balances. They move `uiMultiplier()` (ERC-8056), and the Chainlink price of a raw token already includes the multiplier. | A raw token's price is continuous through splits and ex-dividend dates. There is no ex-div drop to model. |
| Chainlink stock feeds are 24/5 with overnight sessions. Off hours they post nothing and hold the last print. The token's `oraclePaused()` stops the feed during corporate actions. | The tokens trade 168 hours a week against a price that exists for about 120. Every lender, LP and borrower carries the other 48 blind. |
| $34.6B of DEX volume, 576M transactions, 12.3M addresses. Uniswap carries about 86% of DEX volume, stock tokens are at least 8.7% of it, and about 60% of Uniswap's stock-token volume is outside US market hours. | The users are here and they trade at night. Most of them came for memecoins launched on Pons, hood.fun and Flap. |
| The 90-day gas waiver has ended, chain revenue set records in early September, and the sequencer stopped for up to 14 minutes on 4 September. | Fees are real now. Anything that needs many small transactions needs a paymaster. |

What is already built, so these are not ideas:

| Category | Who | Notes |
|---|---|---|
| Spot | Uniswap v2/v3/v4 and UniswapX, Rialto (propAMM), Pleiades (institutional AMM), Arcus (24/7, zero-fee spot) | |
| Perps | Lighter (through Robinhood Wallet), Arcus (up to 50x, USDG margin, leveraged-ETF-style contracts), Meridian (RWA perps in USDe) | |
| Prediction markets | Meridian Predict (RFQ auctions, USDe) | General events. |
| Lending | Morpho (the Steakhouse vault behind Robinhood Earn, ~7%, Lloyd's/RELM cover), Maple syrupUSDG, Longbow (USDG against stock tokens) | Nobody lends the stock itself except Locate. |
| Dividends and rates | hdfi (PT/YT on the multiplier, Pendle-shaped), PARE (dividend claims as ERC-20s), RobinPay (multiplier growth harvested into USDG) | The obvious dividend products are taken. |
| Indexes | Robinfolio (equal-weight Mag7, rule-based rebalancing) | One basket, one team. |
| Options | StonkBrokers by Clutch Labs (covered calls on their own ERC-6551 NFTs) | Nothing on the stock tokens themselves. |
| Launchpads | Pons (now Uniswap Labs), hood.fun, Flap, Noxa, Pools.trade, TrustSwap, MintPlus, Team Finance | Saturated. |
| Uniswap v4 hooks | Uniliquid, Hookify (dynamic fees, anti-snipe) | Generic. None keyed to the feed clock. |
| Agents | Virtuals (agents as tokens). Robinhood Agentic Trading (US only, brokerage custody, MCP) | |
| Market making | Arrakis | |

What the ecosystem's own writers list as missing: structured products, insurance beyond Robinhood
Earn's policy, indexes, weekend pricing, analytics and safety tooling.

## The ideas, ranked

| # | Idea | Needs this chain because | Reuses from this repo | Effort |
|---|---|---|---|---|
| 1 | Gap Cover: weekend gap contracts settled on the reopen print | 24/7 tokens, 24/5 feeds | Locate's feed handling, the EVM harness, the site | 3-5 weeks |
| 2 | Options on stock tokens, expiring on the print | Same, and the multiplier makes a clean underlying | #1's settlement, Locate's ERC-4626 vault | 8-12 weeks |
| 3 | The closing-bell hook: Uniswap v4 fees keyed to the feed clock | 60% of stock volume is off hours | Locate's premium board | 4-6 weeks |
| 4 | Prize-linked savings with whole-share prizes | Morpho yield plus on-chain stock prizes | Stonk Packs' randomness, escrow, storefront, share cards | 3-4 weeks |
| 5 | Policy accounts for agents trading stock tokens | 4337 first class, Robinhood's agent push | Little | 6-8 weeks |
| 6 | Basket launchpad | Launchpad culture plus real stocks | Locate's oracle math | 5-8 weeks |
| 7 | Canonical token guard | Look-alike tokens, wrapper premiums | Locate's registry and quote code | 1-2 weeks |

### 1. Gap Cover

> The chain trades 168 hours a week. The price feed works about 120. Sell the other 48.

**The gap.** Locate's own README tells borrowers to keep their health factor "comfortably above 1
into weekends" because "a Monday gap is applied to every position at once when the feed reopens."
Longbow's borrowers, Morpho's lenders, weekend LPs on Uniswap and anyone short on Arcus carry the
same exposure, and there is no instrument for it anywhere on the chain.

**What it is.** A market per stock per closure window, for example NVDA from Friday 20:00 ET to
Sunday 20:00 ET. Reference `F` is the last print before the window and `R` the first print after;
`gap = R / F - 1`. Three contract shapes:

- Down cover pays `max(0, -gap - K) * notional` in USDG. A put on the gap, strike `K` in percent.
- Up cover is the mirror image.
- Binary pays one USDG if `gap < -K`.

Every contract is fully collateralised by the writer at issue, so the maximum payout is escrowed
and nobody can fail to pay. Each series (token, window, side, strike) is an ERC-20, so it trades
on Uniswap and sits in a wallet like anything else.

**Settlement without a new oracle.** Anyone calls `settle(series, roundId)`. The contract checks
the token's Chainlink aggregator:

```
getRoundData(roundId).updatedAt     >= windowEnd
getRoundData(roundId - 1).updatedAt <= windowStart
```

Both true means the feed was silent for the whole window, so `roundId - 1` is Friday's last print
and `roundId` is the reopen. If the feed printed inside the window (a corporate-action pause
lifted, a schedule change, an aggregator phase change so that `roundId - 1` reverts), the series
voids and refunds both sides. The same rule covers a holiday weekend as a longer window without
the contract knowing a calendar. Check the sequencer uptime feed and `answer > 0` exactly as
Locate and Stonk Packs already do.

**Pricing.** Version one is an order list: writers post (strike, premium), buyers take. Version
two is a writers' pool per token quoting from realised gap history, which is public (every Sunday
print for every feed is on chain) and from utilisation.

**Who pays.** Borrowers on Locate, Longbow and Morpho who want to stay levered through a weekend.
LPs hedging inventory. Weekend traders who want a cheap binary on Monday. The Locate site can
offer "cover this position through the weekend" in one click, sized from `positionOf()`'s
liquidation price.

**Why it is unique.** Nowhere else has 24/7 spot on real equities against a 24/5 feed with public
round history. The instrument cannot exist on an exchange (no weekend trading) or on another chain
(no equities with feeds).

**Token.** A fee on premium. The honest token design is a backstop pool: stake into a junior
tranche that writes when nobody else will and earns the fees for bearing the last loss. That is a
risk position, not free money, and the site should say so.

**Siblings on the same settlement idea.** Corporate-action binaries settled by the token itself.
"TSLA splits before 31 December" pays if `UIMultiplierUpdated` fires with
`newMultiplier / oldMultiplier >= 1.5`, or if `newUIMultiplier()` and `effectiveAt()` show one
scheduled. No oracle, no committee, and Meridian's general prediction markets do not do this.

**Legal.** Parametric contracts on a price are derivatives. Full collateral removes the credit
question, not the licensing one. Same posture as Stonk Packs: eligible jurisdictions only, counsel
before launch.

### 2. Options on stock tokens

> Covered calls for people who have never been allowed to sell one.

**The gap.** Options are Robinhood's core US business. The chain's stock-token holders, all
outside the US, have no options venue at all. The only options on the chain are StonkBrokers'
covered calls on their own NFTs.

**Why stock tokens are the cleanest underlying options have ever had.** Splits and dividends move
`uiMultiplier()`, not the raw token, and the feed prices the raw token with the multiplier folded
in. So there is no ex-dividend drop, no strike adjustment on a split, and no early-exercise
incentive from dividends. European options on the raw token need none of the corporate-action
machinery listed exchanges carry.

**What it is.** Fully collateralised European options as ERC-20s, in the Opyn shape:

- A call writer escrows one stock token per contract and receives the call token plus a writer
  receipt. A put writer escrows `strike` in USDG.
- Cash settlement at expiry against the Chainlink print, using the same "first round after T" rule
  as Gap Cover, or physical settlement (the call holder pays the strike in USDG and takes the
  token).
- Expiries on the two prints the market cares about: the Friday close and the Sunday reopen. A
  weekend straddle that expires on a print nobody can see for 48 hours is a new instrument.
- Covered-call vaults per stock in Locate's ERC-4626 shape: deposit NVDA, the vault writes weekly
  calls 10% out of the money by auction, and the USDG premium accrues to the share price.
- Later, defined-outcome vaults: buffer the first 10% of downside for a quarter by selling upside.
  That product is tens of billions in listed ETFs and exactly what a holder who is afraid of
  weekends wants.

**Market.** Option tokens in Uniswap v4 pools for the liquid series, and an RFQ auction for vault
writes (Meridian shows market makers will quote on this chain). Start with NVDA, TSLA, SPY, MSTR
and GME: the highest implied volatility and the deepest pools, and five of Locate's ten markets.

**Who pays.** Holders who want income (covered calls are the most-used retail options strategy),
traders who want leverage without a perp's liquidation, and Locate's lenders, who could write calls
against the same inventory.

**Token.** The vault performance fee. An insurance fund for physically settled series where the
token side is thin.

**Risks.** Thin float: cash settlement avoids ever needing to buy tokens on a weekend. Corporate
actions: `oraclePaused()` at expiry defers settlement to the first print after the pause.

### 3. The closing-bell hook

> A Uniswap v4 hook that knows what time it is in New York.

**The gap.** About 60% of Uniswap's stock-token volume is outside market hours. LPs in those pools
quote continuously against a price that stops on Friday. Whoever trades at 19:59 on Sunday with a
view on the reopen is picking off an LP that structurally lacks the information. The HIMS wrapper
episode, a wrapper trading 40% above the underlying for a weekend, shows how far pools drift. The
hooks that exist (Uniliquid, Hookify) do dynamic fees and anti-snipe, not this.

**What it does.** A hook on stock-token/USDG pools that reads the token's Chainlink feed and
`oraclePaused()` on every swap:

- The fee follows feed age: base fee while the last print is fresh, stepping up as the feed goes
  silent, highest in the hours before the reopen when the asymmetry is worst.
- A deviation surcharge: while the feed is silent, trades that push the pool away from the last
  print pay more and trades that pull it back pay less. It is the fee-curve version of a spread
  that widens in the direction of flow.
- A reopen guard: for a few minutes after the first new print, pause or batch, so LPs are not the
  counterparty of choice at the exact moment the print lands.
- A corporate-action guard: while `oraclePaused()` is true, only allow trades within a band of the
  last print.

**Who pays.** LPs, through a hook fee (v4 supports one) that is a fraction of what the hook saves
them. Robinhood and Uniswap both want stock pools with durable liquidity, so this is also a thing to
take to them.

**Measure first.** Before writing the hook, compute LP markouts at the reopen across the ten
Locate markets from the public feed history and pool events. Locate's premium board already reads
the DEX side. If the number is small the hook is a nicety; if it is large the hook sells itself,
and the number is the pitch.

**Token.** A share of the hook fee and governance over the curves, or none, and sell it as
infrastructure.

### 4. Prize-linked savings with whole-share prizes

> Deposit dollars, never lose them, maybe win a whole share of NVIDIA on Friday.

**The gap.** Stonk Packs is a paid game: $20 in, $17.18 expected out. This is its sober sibling.
Deposits stay whole and only the yield is played for. UK Premium Bonds hold well over £100B on
this exact mechanic. Nobody has done it on this chain, and the yield is right there: Robinhood
Earn's 7% comes from a Steakhouse-curated Morpho vault any contract can deposit into.

**What it is.** A USDG vault (ERC-4626) that supplies to that Morpho vault, or to Morpho markets
directly. Each week the accrued yield buys a prize on Uniswap: one whole share of a headline stock
(NVDA, LLY, COST) plus a ladder of smaller ones. A draw picks winners with odds proportional to
time-weighted balance. The prize is the stock token itself, sent to the winner's wallet. Withdraw
any time, in full.

**Fairness.** Stonk Packs' hash-chain seeds and buyer-seed pattern carry over unchanged, or use
Chainlink VRF v2.5, which is listed for the chain. The prize is bought before the draw at a visible
price and the draw block is announced ahead, so the operator can neither pick winners nor withhold
prizes, by the same argument the Stonk Packs README makes.

**Who pays.** Nobody, which is the point. The yield funds the prizes and a fee on yield funds the
operator. A $2M pool at 7% is about $2,700 of prizes a week, a share of LLY and change every Friday.

**Why it is unique.** A no-loss lottery whose prize is a security, on the one chain where the
security is an ERC-20 and the yield source is the broker's own Earn stack.

**Token.** The vault share is the ticket. A 10% fee on yield to token holders if a coin is wanted;
the fairer design routes it to a sponsor pool for bigger prizes.

**Legal.** Prize-linked savings is a savings product in some places and a lottery in others. The
deposit-is-never-at-risk fact pattern is the strongest available, and it is still counsel before
launch. The Treasure Hunt README's note on consideration applies word for word.

### 5. Policy accounts for agents

> Let an AI trade your stock tokens, inside walls it cannot climb.

**The gap.** Robinhood opened Agentic Trading in May and added crypto in August; more than 70,000
agentic accounts opened within weeks. That product is US only, brokerage custodied, and its agents
cannot touch on-chain stock tokens or DeFi. On the chain, ERC-4337 with session keys is first
class and Alchemy sponsors gas. Virtuals is agents as tokens, not guardrails. Nobody has built the
on-chain twin: an account that lets an agent trade stock tokens under rules the human set and the
chain enforces.

**What it is.** A smart account (ERC-4337, ERC-7579 modules) with a session key for the agent and
the policy inside the account:

- Only canonical stock tokens from the registry, and only named venues: the Uniswap router,
  Morpho, Locate.
- A daily notional cap, a per-token position cap, and a drawdown stop from the account's
  high-water mark, marked with the Chainlink feeds.
- Time rules. "No trades while the feed is silent" is one line of policy and removes the whole
  weekend problem for that account.
- A kill switch and a budget the owner tops up.
- An MCP server so Claude, ChatGPT or Codex drives the account the way Robinhood's own MCP drives a
  brokerage account.

Every trade is on chain, so an agent's track record is verifiable for free, and a "hire an agent"
listing with a performance fee the account itself enforces (high-water mark, paid in USDG) follows
without trusting anyone.

**Who pays.** Owners pay a small fee on notional or the performance fee. Agent operators post a
listing bond.

**Compliance.** This is for eligible holders in eligible countries, like any stock-token front end.
The geo gate is at onboarding and the account onboards nobody. There has been press about agents
being used to route around the US block; build the opposite, an account whose whole point is that
the rules bind the agent.

### 6. Basket launchpad

> Pons for portfolios.

**The gap.** The chain's dominant behaviour is launching tokens. Robinfolio shipped one
equal-weight Mag7 index. The launchpad energy and the underlying stocks are on the same chain and
nobody has connected them.

**What it is.** Anyone creates a basket: canonical stock tokens, weights, and a rebalance rule
(calendar, drift threshold, or never). The basket is an ERC-20 minted from USDG through a router
that buys the components on Uniswap or by RFQ, and redeemed to components or USDG. A basket oracle
computes NAV from the component Chainlink feeds so a basket can be Morpho or Longbow collateral,
which is the oracle math Locate already does for single stocks. Creators earn basis points of
assets and the protocol takes a cut. Creator pages with NAV history from the feeds, clone-a-basket
and a leaderboard are the growth loop. The first hundred baskets will be "my ten AI stocks" from
the people launching memecoins today, and that is fine: it is the first thing a normal person would
actually buy on this chain.

**Token.** A share of protocol fees, or creator-listing bonds.

**Risks.** A basket with a paid manager is a fund in most jurisdictions. Rule-based,
non-discretionary weights help and do not settle it. Rebalances in thin pools cost slippage, so cap
each basket's size against its components' pool depth.

### 7. Canonical token guard

> Is this the real AAPL?

**The gap.** Robinhood's docs warn that "a token with a matching name/ticker but a different
contract address is not a Robinhood Stock Token." The HIMS wrapper traded 40% above the
underlying for a weekend. Analytics and safety tooling is on every list of what is missing.

**What it is.** An on-chain mirror of the registry with a permissionless update path from the
docs' live table, a router wrapper that reverts on non-canonical tokens, a wrapper-premium monitor
(Locate's premium board already reads DEX prices against Robinhood's quotes), and a badge other
sites can embed. One to two weeks. Free. It earns the distribution and trust the products above
need.

## Smaller ones

- Claim links for stock tokens: send 0.1 NVDA to a phone number and the recipient claims with a
  passkey wallet. The Treasure Hunt claim design, with the recipient inside the signed digest, is
  exactly the primitive.
- Recovery and inheritance for self-custodied securities: a 4337 account with social recovery and
  a dead-man beneficiary. Lost keys now lose stock, not jpegs.
- Tax lots: cost basis and lot tracking for stock-token wallets from transfer and multiplier
  events, for the European holders who will need it in April.
- Auto-invest: a weekly USDG buy of a basket under a session key with sponsored gas. A feature of
  #5 or #6 rather than a product.

## What to build first

Gap Cover. It is the smallest, it is the most obviously native to this chain, Locate's README is
its first advertisement, and its settlement library is the foundation for options next. Ship the
market, then "cover this position" inside Locate, then options on the same rounds logic. For a
consumer product instead, prize-linked savings reuses the most of what is here and has the
friendliest legal shape.

## Thinking differently

The first seven fill holes in a DeFi map. These start from the other end: what the tokens are
(real companies, with fans, customers, employees and weekends), who the audience is (120
countries, most of which never had a brokerage account), and what people actually do on this
chain (launch things, talk, gamble, and trade at three in the morning). Same tests as before,
looser on precedent.

### 8. Stock as a reward currency

> Stop airdropping memecoins. Airdrop Apple.

Merchants and creators pay rewards in stock dust. A creator with fifty thousand followers sends
each of them a few cents of NVDA instead of launching a coin that rugs by Thursday. A shop gives
a slice of SBUX with every coffee. Stash's Stock-Back card did this in the US with a bank in the
middle; here it is a transfer.

Mechanics: a sponsor deposits USDG. Claims are Merkle drops or claim links with the recipient
inside the signed digest (the Treasure Hunt design). On claim the contract buys the stock on
Uniswap at that moment and sends it, gas sponsored through 4337, so the recipient needs nothing
but a passkey. A webhook for merchants: order paid, dust sent. The growth stunt is obvious and
cheap: a sponsor funds a few cents of SPY to every active wallet on the chain, and a few cents
times a million wallets is a marketing budget, not a treasury.

Why it is different: it makes the security the unit of appreciation instead of the object of
speculation. A reward that has a chart. Legal: giving securities away as a promotion is a
regulated act in some places, recipients must be eligible, and the shape has to be a gift, not a
sale.

### 9. Positions or ban

> A social feed where every take is collateralised.

To post about NVDA you lock a position for the life of the post: tokens, or a Locate short. The
post's hash is committed with the lock. The feed shows direction, size, entry and live P&L from
the Chainlink feed. Unlock early and the post is deleted and the profile marked. Subscriptions in
USDG, tips in stock dust (#8), a leaderboard by realised P&L.

Why it is different: it is a social product and the chain is the fact-checker. It is also the
cheapest thing in this document: a lock contract and a site, with posts living in calldata.
"Positions or ban" is already the rule of the subreddit that made retail trading a culture.

### 10. Holder perks

> Hold the stock, get the discount.

Japanese shareholder perks (kabunushi yutai) on chain. Any merchant publishes a perk gated on
`balanceOfUI(token) >= n`, proven by sign-in with Ethereum; vouchers are signed, single use and
non-transferable. Tesla accessory shops for TSLA holders, game stores for GME holders, who would
enjoy it more than anyone. The issuers will not join on day one. Their fans' merchants will.

Why it is different: commerce, not trading, and zero securities-law surface, since nothing is sold
or transferred.

### 11. Savings circles in the S&P 500

> The chit fund, the tanda and the susu, paid out in SPY.

Rotating savings groups are how a large share of the world saves. N members contribute USDG
weekly, swapped to SPY; one member takes the pot each round. Order by random draw (the Stonk
Packs hash chain) or by a chit-fund discount auction. Missed payments come out of a stake. The
group's whole history is public, so groups can form across borders with strangers.

Why it is different: a savings ritual from Lagos, Chennai and Mexico City, in a US index, on a US
broker's chain. Legal: lending circles are mostly tolerated; India's Chit Funds Act is the
exception to check.

### 12. The Weekend Exchange

> Open only when Wall Street is closed.

A venue that runs from Friday's last print to Sunday's first. Hourly uniform-price batch auctions
(the frequent-batch-auction design from Budish, Cramton and Shim), no AMM, no oracle, no MEV,
and the clearing price published on chain every hour as the weekend index. Orders are limit
orders with USDG or tokens escrowed; unfilled orders roll to the next batch.

Why it is different: the first list protected LPs from the weekend; this stops pretending there
should be a continuous market when there is no continuous information. A published weekend index
is what every lender on the chain needs and nobody has. Fees: a taker fee on cleared volume. No
token needed.

### 13. Backed memes

> Every memecoin on this launchpad has a floor made of stock.

The chain's memecoin crowd already pays a premium for wrappers of stocks (the HIMS wrapper traded
40% over). A launchpad where every meme is an honest wrapper: minting burns USDG to buy the named
stock into a treasury, and any holder can redeem pro rata for the stock at any time. The meme is
the story and the community; the floor is NVDA. The redemption path is exactly what that wrapper
lacked.

Why it is different: it takes the chain's dominant behaviour and gives it a bottom. Legal: a
redeemable wrapper of a security is a security; hdfi and Robinfolio already wrap, and it still
needs counsel.

### 14. Chores for shares

> A child's first share, earned, and locked until they are eighteen.

A family account. The parent's 4337 account funds a child sub-account whose policy is "can
receive, cannot send, unlocks on a date." The child earns SPY dust for chores (the parent taps
approve), watches the balance and the multiplier tick, and cannot lose it to a bad trade or a lost
phone. A time-capsule message rides with each deposit.

Why it is different: family finance for the 120 countries with no custodial accounts. Legal: the
parent holds; the child is the beneficiary of a rule, not a holder.

### 15. Contractor equity

> RSUs for the people who never got them.

A payroll product for remote teams: part of a contractor's fee paid in the employer's own stock
token where one exists, or in SPY, with on-chain vesting, cliffs, and per-second streaming.
Coinbase, Shopify and Uber have thousands of non-US contractors who cannot get RSUs.

Why it is different: B2B, boring, and paid for from a real budget. Legal: compensation in
securities to non-US persons is well trodden but not paperwork-free; the employer's counsel does
that part.

### 16. Wild cards

- A tontine in the S&P 500: proof-of-life check-ins; miss a year and your share goes to the
  rest. Longevity insurance without an insurer. Legal in some places, banned in others.
- Physical packs: Stonk Packs as NFC cards in foil, sold in shops, each card a claim on a stock
  token. Atoms, and a customs form.
- A shadow proxy: token holders have no vote, so hold one anyway, weighted by `balanceOfUI`, and
  publish "what the tokenholders would have said" before every AGM. No utility, all press.

### Which of these

The Weekend Exchange if you want a company: it is the one thing only this chain makes possible,
and it turns the weekend from a risk into a venue. Positions or ban if you want something live in
two weeks that could catch: a lock contract, a feed, and a name everyone already knows.

## The one that is a finding, not an idea

Dividends on these tokens leak: the multiplier is raised on the pay date, not the ex-date, and the
raise is spread over whatever supply exists that day, after about 30% withholding. Ford's
record-date holders were paid on 2% of their dividend cash, UPS's on 20%, and SPY's first
on-chain dividend has a six-week window starting 18 September. The evidence, the formula that
fits it to three decimals, and the three things to build on it (a tracker, ex-date shorts in
Locate, and a wrapper that does not leak) are in [`dividend-leak.md`](dividend-leak.md).

## On tokens

The cleanest utility is when the token is the product: the cover contract, the option, the basket
share, the prize-vault share. A fee-sharing coin is a security almost everywhere, as the Treasure
Hunt README already says. The token designs above that survive scrutiny are risk-bearing (a
backstop tranche that earns fees for taking the last loss) or bonds (creators and agent operators
stake to list). Decide that per product with counsel, not in a launch thread.

## Sources

- Robinhood Chain docs: [about](https://docs.robinhood.com/chain/), [stock tokens](https://docs.robinhood.com/chain/stock-tokens/), [building with stock tokens](https://docs.robinhood.com/chain/building-with-stock-tokens/), [oracles and price feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [contracts](https://docs.robinhood.com/chain/contracts/)
- [ERC-8056](https://eips.ethereum.org/EIPS/eip-8056) and [Chainlink's Robinhood tokenized equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)
- [Robinhood mainnet announcement](https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/), [CoinDesk](https://www.coindesk.com/business/2026/07/01/robinhood-rolls-out-public-blockchain-as-it-expands-deeper-into-crypto), [The Block](https://www.theblock.co/news/business/2026-07-01-robinhood-chain-goes-live-mainnet-alongside-24-7-tokenized-stocks-lighter-perps-planned-crypto-agentic-trading-406918)
- Ecosystem and metrics: [insights4vc, two months in](https://insights4vc.substack.com/p/robinhood-chain-two-months-in), [FalconX primer](https://www.falconx.io/newsroom/robinhood-chain-primer-early-traction-and-protocols-to-watch), [TrustSwap ecosystem map](https://trustswap.com/robinhood/ecosystem), [Uniswap v4 hooks on Robinhood Chain](https://cryptobriefing.com/robinhood-chain-uniswap-v4-hooks-tokenized-stocks/), [Pons and DEX volume](https://thedefiant.io/news/blockchains/robinhood-chain-dex-volume-hits-usd1-49-billion-as-pons-takes-two-thirds-of-launchpad-fees), [gas subsidy ending](https://crypto.news/robinhood-chain-flipped-solana-revenue-gas-subsidy-expires/), [4 September outage](https://cryptobriefing.com/robinhood-chain-restores-block-production-outage/)
- Projects: [Arcus](https://www.theblock.co/post/408895/arcus-rolls-out-24-7-tokenized-us-stocks-and-perpetual-markets-on-robinhood-chain), [Meridian](https://docs.meridian.xyz/), [hdfi](https://hdfi.io/), [PARE](https://parestocks.com/docs), [RobinPay](https://robinpay.org/), [Robinfolio](https://robinfolio.xyz/), [StonkBrokers](https://www.clutch.markets/), [Robinhood Earn and Morpho](https://cryptobriefing.com/robinhood-earn-decentralized-lending-morpho/)
- Agents: [Robinhood is now open to agents](https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/), [agentic trading adds crypto](https://finance.yahoo.com/markets/crypto/articles/robinhood-brings-ai-agent-trading-234600114.html), [agents and the US block](https://news.bitcoin.com/crypto-news/robinhood-chain-ai-agents-stock-token-compliance-gap/)
- Grants: [Robinhood's $1M for Arbitrum Open House 2026](https://blog.arbitrum.io/robinhood-chain-testnet/)
