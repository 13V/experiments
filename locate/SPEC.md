# Locate — stock-token lending and spot shorting on Robinhood Chain

Locate is the missing side of lending on Robinhood Chain. Longbow and Morpho let you borrow USDG
against a tokenized stock; nobody lets you borrow the stock itself. Locate does: holders lend their
stock tokens and earn the borrow rate; borrowers post USDG and take the stock out to short it spot,
to arbitrage a DEX premium, or to make markets through the weekend when Robinhood cannot mint.

This file is the contract between everyone building it. Interfaces, addresses and conventions here
are binding; if something is missing, add it here first.

## 1. Chain facts

| Thing | Value |
|---|---|
| Chain | Robinhood Chain, id 4663, Arbitrum Nitro, gas in ETH |
| RPC | https://rpc.mainnet.chain.robinhood.com (rejects script user agents; send a browser-like `User-Agent`) |
| Explorer | https://robinhoodchain.blockscout.com |
| `block.number` | the **Ethereum** block number (12 s ticks); the chain itself makes ~10 blocks/s. Never do block arithmetic off-chain against `eth_blockNumber`. |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals (Paxos) |
| Stock tokens | 18 decimals, ERC-20, canonical registry at https://api.robinhood.com/rhj/assets; addresses in `config/markets.json` |
| Chainlink feeds | 8 decimals, `latestRoundData()`, heartbeat 86400 s, 0.5% deviation, **24/5**: no updates from Friday 8pm ET to Sunday 8pm ET while DEX pools keep trading. The feed prices the token (corporate-action multiplier included). |
| Morpho Blue | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` |
| Adaptive Curve IRM | `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` |
| MorphoChainlinkOracleV2Factory | `0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2` |
| Enabled LLTVs on this Morpho | 38.5%, 62.5%, 77%, 86%, 91.5% (WAD-scaled: 0.385e18 …) |

All of the above is also in `config/addresses.json`.

## 2. Morpho Blue, the parts we use

```solidity
type Id is bytes32; // keccak256(abi.encode(marketParams))

struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }

function createMarket(MarketParams memory) external;
function supply(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, bytes memory data) external returns (uint256 assetsSupplied, uint256 sharesSupplied);
function withdraw(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, address receiver) external returns (uint256, uint256);
function supplyCollateral(MarketParams memory, uint256 assets, address onBehalf, bytes memory data) external;
function withdrawCollateral(MarketParams memory, uint256 assets, address onBehalf, address receiver) external;
function borrow(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, address receiver) external returns (uint256, uint256);
function repay(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, bytes memory data) external returns (uint256, uint256);
function liquidate(MarketParams memory, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes memory data) external returns (uint256, uint256);
function accrueInterest(MarketParams memory) external;
function setAuthorization(address authorized, bool newIsAuthorized) external;
function isAuthorized(address authorizer, address authorized) external view returns (bool);
function position(Id, address) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
function market(Id) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee);
function idToMarketParams(Id) external view returns (MarketParams memory);
```
Rules that matter:
- Exactly one of `assets`/`shares` may be nonzero in supply/withdraw/borrow/repay.
- `borrow` and `withdraw*` on behalf of a user require `isAuthorized[user][caller]`. The router relies on `setAuthorization(router, true)` by the user.
- Shares math: `VIRTUAL_SHARES = 1e6`, `VIRTUAL_ASSETS = 1`. `toAssetsDown(shares) = shares * (totalAssets + 1) / (totalShares + 1e6)`, `toAssetsUp` rounds up, `toSharesDown(assets) = assets * (totalShares + 1e6) / (totalAssets + 1)`.
- Oracle: `price()` returns the price of 1 unit of collateral in loan units, scaled by `1e36`. Max borrow = `collateral * price / 1e36 * lltv / 1e18`. A position is liquidatable when borrow assets exceed that.
- Health factor as we display it: `hf = collateral * price / 1e36 * lltv / 1e18 / borrowAssets`; liquidation when `hf < 1`.

Our markets are **loan = stock token, collateral = USDG**. The oracle for such a market comes from the factory:
`createMorphoChainlinkOracleV2(baseVault=0, baseVaultConversionSample=1, baseFeed1=USDG/USD feed, baseFeed2=0, baseTokenDecimals=6, quoteVault=0, quoteVaultConversionSample=1, quoteFeed1=<stock feed>, quoteFeed2=0, quoteTokenDecimals=18, salt)`. Base is the collateral (USDG), quote is the loan (stock). The factory scales so that `price()` = USDG-per-stock in the 1e36 convention. Source: morpho-org/morpho-blue-oracles.

## 3. Contracts (`locate/contracts/`)

Solidity `^0.8.24`, compiled with solc 0.8.28, optimizer 200 runs, evmVersion cancun. No external libraries; write what you need. Every external call to tokens uses low-level calls that tolerate missing return values. Reentrancy guard on every state-changing external function. Custom errors, no revert strings.

### 3.1 `LocateVault` (ERC-4626, one per stock)

Lenders deposit the stock token and receive vault shares. The vault supplies the stock into one or more Morpho markets whose `loanToken` is the stock, up to a cap per market, and earns the borrow interest. A performance fee on the interest goes to `feeRecipient` as vault shares.

```solidity
constructor(address morpho, address asset, string memory name, string memory symbol, address owner, address feeRecipient, uint96 performanceFeeBps); // fee <= 5000
// ERC-20 + ERC-4626 surface: name, symbol, decimals (= asset decimals), totalSupply, balanceOf, transfer, approve, transferFrom, allowance,
// asset(), totalAssets(), convertToShares, convertToAssets, maxDeposit, previewDeposit, deposit(assets, receiver), maxMint, previewMint, mint(shares, receiver),
// maxWithdraw(owner), previewWithdraw, withdraw(assets, receiver, owner), maxRedeem(owner), previewRedeem, redeem(shares, receiver, owner)
function setMarket(MarketParams calldata mp, uint256 cap) external;          // onlyOwner; mp.loanToken must equal asset(); cap in asset units; cap 0 disables new supply; appends to the queues if new
function removeMarket(Id id) external;                                        // onlyOwner; only when the vault's supply in it is zero
function reallocate(Id from, Id to, uint256 assets) external;                 // onlyOwner; withdraw from one market, supply to another, respecting caps
function setFee(uint96 bps, address recipient) external;                      // onlyOwner; bps <= 5000; accrues first
function transferOwnership(address) external;
function supplyQueue() external view returns (Id[] memory);                   // order in which deposits are allocated
function withdrawQueue() external view returns (Id[] memory);                 // order in which withdrawals are pulled
function marketConfig(Id) external view returns (uint256 cap, bool enabled);
function idle() external view returns (uint256);                              // asset balance held by the vault, not supplied
function supplied(Id) external view returns (uint256);                        // this vault's supply assets in a market, from current market totals
function liquidity() external view returns (uint256);                         // idle + sum over withdrawQueue of min(supplied, market totalSupplyAssets - totalBorrowAssets); what can actually be withdrawn now
function accrue() external;                                                   // accrue interest on every market and mint the fee shares
event MarketSet(Id indexed id, uint256 cap); event MarketRemoved(Id indexed id); event Reallocated(Id indexed from, Id indexed to, uint256 assets);
event FeeSet(uint96 bps, address recipient); event FeeAccrued(uint256 assets, uint256 shares);
```
Behaviour:
- `deposit`: accrue, pull assets, mint shares at the pre-deposit rate, then supply to markets in `supplyQueue` order up to each cap; anything left stays idle.
- `withdraw`/`redeem`: accrue, burn, pay from idle first, then pull from markets in `withdrawQueue` order; if the markets cannot provide (utilisation), revert `InsufficientLiquidity()`. `maxWithdraw(owner)` = min(owner's assets, `liquidity()`).
- `totalAssets()` = idle + Σ supplied (using current stored market totals; may be a little stale between accruals; every state-changing call accrues first).
- Fee: on `accrue()`, `yield = totalAssets - lastTotalAssets` (if positive); mint `feeShares` to `feeRecipient` so they are worth `yield * fee / 10000` at the post-accrual rate (MetaMorpho's formula). Update `lastTotalAssets` after every accrue/deposit/withdraw.
- Caps are a lender-side safety valve: they bound how much of a stock can be borrowed. Owner-only, no timelock in this version; state that in the README.

### 3.2 `LocateRouter` (stateless; the one-transaction short)

```solidity
constructor(address morpho);
function openShort(MarketParams calldata mp, uint256 collateralAssets, uint256 borrowAssets, address receiver) external; // pulls mp.collateralToken from msg.sender, supplyCollateral on behalf of msg.sender, then borrow on behalf of msg.sender to `receiver`. Requires the user to have authorized the router on Morpho.
function addCollateral(MarketParams calldata mp, uint256 assets) external;                                                 // pull and supplyCollateral on behalf of msg.sender
function repay(MarketParams calldata mp, uint256 assets, uint256 shares) external;                                         // pull exactly what is needed (shares path: accrue, compute assets up) and repay on behalf of msg.sender; returns nothing; refunds nothing because it pulls exactly
function closeShort(MarketParams calldata mp, uint256 repayShares, uint256 withdrawCollateralAssets, address receiver) external; // repay (by shares, 0 = all of the caller's borrow shares) then withdrawCollateral on behalf of msg.sender to receiver (0 = all collateral)
function positionOf(MarketParams calldata mp, address user) external view returns (uint256 collateral, uint256 borrowAssets, uint256 maxBorrow, uint256 healthFactorWad, uint256 liquidationPrice); // liquidationPrice = the loan-token USD price (1e8 scaled if the oracle has 8-decimal feeds; document what you return) at which hf hits 1, or 0 when no borrow
function quote(MarketParams calldata mp) external view returns (uint256 price);                                            // oracle price passthrough
event ShortOpened(address indexed user, Id indexed id, uint256 collateral, uint256 borrowed, address receiver);
event ShortClosed(address indexed user, Id indexed id, uint256 repaid, uint256 collateralOut);
```
Behaviour: the router never holds funds after a call; it approves Morpho for exactly the amount pulled; if a token pull fails it reverts `TransferFailed()`. It does not swap; the site links the user to a DEX to sell the borrowed stock and to buy it back.

## 4. Markets (`config/markets.json`)

Ten initial markets, all `loanToken = stock`, `collateralToken = USDG`, `irm = Adaptive Curve IRM`, oracle from the factory as in §2:

| Stock | LLTV | Initial cap (USD) | Why |
|---|---|---|---|
| SPY, QQQ | 86% | 300k | index, lowest gap risk |
| NVDA | 77% | 500k | deepest DEX pool ($8M) |
| AAPL, GOOGL, AMZN, META | 77% | 250k | mega caps |
| TSLA, MSTR | 62.5% | 250k / 150k | volatile |
| GME | 38.5% | 100k | squeeze risk |

Caps are converted from USD to token units by the scripts using the feed price at creation time. The weekend rule: feeds freeze Fri 8pm ET to Sun 8pm ET; LLTVs above are chosen so a 10-15% gap at the Sunday reopen does not create bad debt on the large caps.

## 5. Tests (`locate/scripts/test.js`, `locate/test/`)

Same harness as `scripts/packs/test.js` in this repo (ethereumjs VM, Cancun, hand-rolled ABI, `check()`/`section()`, dev dependencies installed in the repo's `node_modules`). Vendor Morpho Blue's real `Morpho.sol` and its libraries into `locate/test/morpho/` (from github.com/morpho-org/morpho-blue, `src/`, relax `pragma solidity 0.8.19` to `^0.8.19`), so the vault and router are tested against real Morpho accounting. Mocks in `locate/test/Mocks.sol`: `MockERC20(name, symbol, decimals)`, `MockOracle(price)` with `setPrice`, `MockIrm(borrowRatePerSecondWad)` with `setRate`, `MockFeed(answer, decimals)`. Morpho's owner must `enableIrm` and `enableLltv` before `createMarket`.

## 6. Scripts (`locate/scripts/`)

Zero-dependency Node, reusing `scripts/keccak.js` and `scripts/secp256k1.js` from the repo root for signing (see `scripts/packs/operator.js` for the RLP/EIP-1559 pattern). Env: `RPC_URL`, `PRIVATE_KEY`, `CHAIN_ID=4663`. Every script has `--dry-run` that prints the exact calldata and never sends.
- `chain.js`: shared RPC, ABI, signing, `call`, `send`, `waitReceipt`.
- `create-markets.js`: for each entry in `config/markets.json`: create the oracle through the factory (or reuse if `oracle` is already recorded), compute market params and id, `createMarket` if missing, record `oracle`/`marketId` back into `config/markets.json`.
- `deploy.js`: compile with solc 0.8.28 and deploy `LocateRouter` and one `LocateVault` per market, then `setMarket` with the USD cap converted to token units; record addresses into `config/addresses.json`.
- `status.js`: print every market: supply, borrow, utilisation, borrow APY (from the IRM's `borrowRateView`), oracle price, feed age, vault liquidity.

## 7. Site (`locate/site/`)

Static, no build step, no dependencies, wallet through EIP-1193, reads through the public RPC, hand-rolled ABI (copy the pattern from `site/lib.js` in this repo). Pages: Markets (table: stock, supply APY, borrow APY, utilisation, available to borrow, DEX price vs Robinhood quote), Lend (deposit/withdraw into a vault), Short (authorize router once, approve USDG, open; then "sell on" links to the DEX pair; positions with health factor and liquidation price; add collateral / repay / close), Premium Board (every stock token with a pool: DEX price vs Robinhood quote, from DexScreener in the browser and Robinhood's quotes via a Vercel function `site/api/quotes.js` because Robinhood's API has no CORS). Design: not the Stonk Packs paper look and not a dark neon dashboard. Locate is a trading desk: dense, monospace numbers, a terminal-amber-on-black or ink-on-bone palette with real typographic character; pick one and commit. Deploy with a copy of `scripts/deploy-site.py` (root of the deployment = `locate/site`).

## 8. Conventions

- Work only inside your assigned directory. The spec and config are read-only for agents; propose changes in your report.
- Commit with a clear message ending with the two attribution lines used in this repo's history (`git log -1` shows them). No pushes, no PRs.
- Verify before you report: contracts compile with no warnings; tests print `N passed, 0 failed`; scripts run `--dry-run` against the real RPC; the site is driven in headless Chromium with zero console errors.
