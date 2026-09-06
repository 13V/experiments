# Products and tools for Robinhood Chain, against what already exists

Brainstormed on 6 September 2026 against the needs in `needs.md` and the tools already live.
The incumbents matter: FOMO (gasless swaps, 0.45% plus a $0.95 minimum, 36% of terminal volume),
GMGN and Axiom (terminals with sniping, limit orders, safety flags), Robinhood Checker and
TokenChecker and TrustSwap (free honeypot, insider, wash-trade and serial-rugger checks with a
0 to 100 score and a Telegram buybot), Bubblemaps (holder maps and the 63% study). Anything on
that list is not a product for us. What follows is what none of them do, ranked by the need it
meets and by how much of it this repository already contains.

| # | Tool | Need | Nobody has it because | Our edge | Coin's role |
|---|---|---|---|---|---|
| 1 | The short desk | stop losing, yield | no borrow market exists | borrow the meme, Locate | equity |
| 2 | Gas Pass | gas | FOMO sponsors only its own users; nobody sponsors EOAs | 7702 plus a paymaster | gate and fund |
| 3 | The tape bot | stop losing, clarity | nobody reads the issuer's wallets | the plumbing map | gate |
| 4 | Report card | stop losing, distribution | Bubblemaps did it once as a study | share-card tooling | viral hook |
| 5 | Graduation odds | launch quality | scanners score safety, not survival | curve reading, creator history | gate |
| 6 | Weekend router | weekend execution | the app's quote is nobody else's problem | the spread board | feature |
| 7 | Holder's portfolio | clarity | stock holders are a small crowd | the leak, the multiplier | pro tier |
| 8 | Launch templates for creators | launch quality | PonsVault stops at staking and dividends | packs, hunt, tournament contracts | fee share |

## 1. The short desk

One screen: pick PONS, CASHCAT or AI; a slider for size; open. Behind it, Locate's router and the
borrow-the-meme markets. Beside it, "lend your bags": deposit the coin, earn what the shorts pay,
with the live rate. A short-interest ticker per coin, which is data that has never existed on
this chain. A "liquidate" button on every underwater short, capital-free through Morpho's
callback, so holders hunt the shorts of their own coin. The coin launched on Pons is the desk's
equity: the vault fee on interest and an open fee flow to it. This is the product; the rest are
its instruments.

## 2. Gas Pass

Robinhood's subsidy ends 29 September and never covered anyone outside its wallet's swap flow.
EIP-7702 is reported live on the chain, so an ordinary EOA can delegate once and then have its
transactions sponsored by a paymaster without moving to a new wallet. Gas Pass: stake the coin,
delegate once, and your swaps on Pons, Uniswap and the desk are paid from the fee stream, with
a daily allowance scaled by stake and topped up by partner protocols who want the users. Ship it
on 29 September with one line: the subsidy that does not end. Verify 7702 on the chain by
sending one type-4 transaction on testnet before promising it.

## 3. The tape bot

A Telegram bot that says what the issuer just did: "3,000 SPY minted", "UPS multiplier raised
0.22%, holders were paid on 20%", "GME paused", "Monday backlog: 960 mints", "wholesale account
moved 1,000 NVDA". Nobody else reads those wallets. Free headline alerts; the per-order tape,
the leak forecasts and the API behind a stake. The same feed powers the desk's short-interest
ticker and the portfolio below.

## 4. Report card

Paste a wallet, get a card: realised P&L, win rate, best and worst trade, the percentile against
the 164,538 wallets Bubblemaps measured, and one line ("you are in the 37%" or not). The Stonk
Packs share-card renderer already makes the image. Everyone posts theirs; every card carries the
desk's name and a short button under the worst trade. Costs nothing to run and is the cheapest
distribution on this list.

## 5. Graduation odds

Scanners answer "is it a honeypot". Nobody answers "will it graduate", which is the question that
loses people money: 1.1% do. A live probability per Pons curve from fill velocity, distinct buyer
count, the creator's previous launches and their survival, the dev buy, and whether the creator
exempted its own wallets from the snipe tax, all readable on chain. Shown as an overlay on Pons
and DexScreener pages, and as the resolution source for graduation markets later.

## 6. Weekend router

Inside Robinhood Wallet's dapp browser: the app's published bid and ask for the token you hold
against the best pool right now, and a button that fills on the chain when the chain is better,
which on a Saturday is most of the time (median app spread 3.8%, pools within 0.4% of the print).
A feature of the desk, and a screenshot machine.

## 7. The holder's portfolio

For the smaller crowd who hold stock tokens: your holdings in shares rather than raw tokens,
every dividend as a multiplier event with what you were owed and what you got, the ex-dates
ahead with the expected leak, the weekend premium on each position, and the custody caveats in
plain words. Pro tier for tax-year exports.

## 8. Launch templates for creators

PonsVault sells staking, stake-and-burn and a stock dividend. We have contracts it does not: the
pack vault, the fee-funded hunt, the tournament prize pool, the price-target vault, the people's
portfolio vote. Offer them as fee-recipient templates any Pons creator can point their launch at,
for a slice of the routed fees. Every launch that adopts one is a customer, and a few of them
will be the biggest coins on the chain.

## What to build, in order

The desk first, because it is the only thing on this list that is a venue rather than a feature,
and the coin's economics depend on it. Then the report card and the tape bot in the same week,
because they are cheap and they are how people find the desk. Gas Pass on 29 September. Odds,
the router and the portfolio as the desk's instruments. Templates when there is a community to
sell them to.
