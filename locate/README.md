# Locate

Borrow the stock, not the dollars.

Robinhood Chain has two lenders (Morpho Blue and Longbow) and both do the same thing: you post a
tokenized stock and borrow USDG. Nobody lends the stock itself. Locate is that missing side. Holders
of a stock token deposit it into a vault and earn the borrow rate; a borrower posts USDG, takes the
stock out, and does what they like with it: sells it spot to be short, sells it into a DEX pool that
is trading above Robinhood's quote, or makes markets through the weekend when Robinhood cannot mint.

Everything settles on Morpho Blue. Locate adds three things:

1. Ten Morpho markets with `loanToken = stock`, `collateralToken = USDG`, priced by the stock's
   Chainlink feed through Morpho's own oracle factory. Creating them is permissionless; we just did it.
2. `LocateVault`, an ERC-4626 vault per stock. Lenders deposit the stock and get shares; the vault
   supplies the stock into its Morpho market up to a cap and takes a performance fee on the interest.
3. `LocateRouter`, a stateless contract that turns "post USDG, borrow stock" into one transaction and
   reports a position's health factor and liquidation price.

The site is a trading desk: markets, lend, short, and a premium board that shows every stock token's
DEX price against Robinhood's 24/5 quote.

## Layout

| Path | What |
|---|---|
| `SPEC.md` | The binding spec: chain facts, Morpho interface, contract surfaces, market list, conventions |
| `config/addresses.json` | Chain, Morpho, oracle factory, USDG, and (after deploy) router and vault addresses |
| `config/markets.json` | The ten markets: token, feed, LLTV, initial cap; oracle and market id are recorded once created |
| `contracts/` | `LocateVault.sol`, `LocateRouter.sol` |
| `test/` | Vendored Morpho Blue sources and mocks for the EVM harness |
| `scripts/test.js` | The test harness (ethereumjs VM, real Morpho accounting) |
| `scripts/chain.js` | RPC, ABI, signing, `--dry-run` |
| `scripts/create-markets.js` | Creates oracles and markets, records them into `config/markets.json` |
| `scripts/deploy.js` | Compiles and deploys the router and vaults, sets caps, records `config/addresses.json` |
| `scripts/status.js` | Prints every market: feed, supply, borrow, utilisation, APY, vault liquidity |
| `site/` | Static site, no build step; `site/api/quotes.js` is the Vercel function that proxies Robinhood |
| `deploy-site.py` | Deploys `site/` to Vercel |

## Running it

Dev dependencies live in the repository root (`node_modules`); nothing in `locate/` has its own.

```
node locate/scripts/test.js                     # N passed, 0 failed
node locate/scripts/status.js                   # read-only, works before anything is deployed
RPC_URL=... PRIVATE_KEY=... node locate/scripts/create-markets.js --dry-run
RPC_URL=... PRIVATE_KEY=... node locate/scripts/deploy.js --dry-run
VERCEL_TOKEN=... python3 locate/deploy-site.py
```

Every script that can send a transaction has `--dry-run`, which prints the exact calldata and never
signs. Run it first, every time.

## How a short works

1. Once: `Morpho.setAuthorization(router, true)`. The router can then borrow on your behalf; it can
   never move your funds anywhere but to you, because it holds nothing and every call names you as
   the receiver.
2. Approve USDG to the router, call `openShort(marketParams, collateralUSDG, borrowStock, you)`.
   The router supplies the USDG as collateral and borrows the stock to your wallet in one transaction.
3. Sell the stock on the DEX. You are short. Buy it back and `closeShort` when you are done: the router
   repays the borrow and returns your USDG.

Your position is liquidatable when `borrow > collateral × price × LLTV`. The site shows the health
factor and the stock price at which that happens; keep the health factor comfortably above 1 into
weekends (see below).

## Risks you should read before using it

- **Feeds are 24/5.** Chainlink stock feeds stop updating Friday 8pm ET and resume Sunday 8pm ET,
  while DEX pools keep trading. A Monday gap is applied to every position at once when the feed
  reopens. LLTVs (86% index, 77% mega cap, 62.5% volatile, 38.5% GME) are chosen so a 10–15% gap
  does not create bad debt in the large caps, but a bigger gap can. Lenders are exposed to bad debt
  in their market; borrowers are exposed to liquidation at the reopen.
- **Caps are owner-controlled with no timelock** in this version. The vault owner can raise or lower
  a market's cap and reallocate between markets at any time. The owner cannot withdraw lenders'
  assets: the only exits from the vault are `withdraw`/`redeem` to the share owner.
- **Lending is illiquid at high utilisation.** If the whole vault is borrowed, lenders wait for
  repayments or for the borrow rate to bring borrowers back. `liquidity()` and `maxWithdraw` tell you
  what can leave right now.
- **Corporate actions.** The feed prices the token including any corporate-action multiplier, so a
  split shows up as a price change on the feed and on the DEX at the same time. A delisting or a
  frozen feed (no update for more than 26 hours on a weekday) should be treated as a market to exit.
- **This is unaudited.** The contracts are small and tested against Morpho Blue's real code, but
  nobody outside this repository has reviewed them yet.

## Fees

The vault takes a performance fee (initially 10%) on interest only, minted as vault shares to the
fee recipient at each accrual. There is no deposit, withdrawal, or borrow fee beyond Morpho's own
(currently zero on these markets). The router is free.
