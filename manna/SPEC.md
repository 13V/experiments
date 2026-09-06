# Manna — lending, shorting and the morning buyback for memecoins on Robinhood Chain

Manna is Locate's lending and shorting contracts (`LocateVault`, `LocateRouter`) applied to
Robinhood Chain's biggest memecoins, plus one new contract, `Manna.sol`, which is the fee
recipient of both the coin and the lending vaults and runs a scripted buyback every morning.
Everything below is transcribed from the Solidity in `contracts/` and exercised by
`scripts/test.js`/`scripts/test-dawn.js`; if a future change to the contracts and this file ever
disagree, fix both together. This file is binding for anything built against Manna — the site,
the scripts, a future audit.

## 1. Chain and venue facts

### 1.1 Chain and shared infrastructure

| Thing | Value |
|---|---|
| Chain | Robinhood Chain, id 4663 |
| RPC | https://rpc.mainnet.chain.robinhood.com |
| Explorer | https://robinhoodchain.blockscout.com |
| Morpho Blue | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` |
| Adaptive Curve IRM | `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| WETH/USDG v3 pool | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` — the deepest pool on chain; the oracle's second hop |
| LLTV on every Storehouse market | 38.5% (`lltvBps` 3850) — the lowest this Morpho deployment enables |
| Liquidation bonus | Morpho's own formula at 38.5% LLTV, capped at 15% |

### 1.2 Pons V2

| Thing | Value |
|---|---|
| Launch factory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| Shared fee escrow | `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e` — `claimToken(usdg)` by the named creator fee recipient |
| Meme hook (v4) | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` — `afterSwap` only: takes a 1% hook fee plus the creator tax from the output currency |
| PoolManager (v4) | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Launch config id used | `0` — fixes supply at 1,000,000,000 tokens (18 decimals)\*, curve fee 1%, graduation pool fee 0, tick spacing 200 |
| Launch fee | 0.0005 ETH |
| Graduation, USDG pair | at 8,090 USDG of net quote in the curve (phantom quote 3,236 USDG) |
| Creator tax | up to 10% (`maxCreatorTaxBps` 1000); Manna launches at 1% |
| Creator fee recipient change | through the factory, 3-day timelock |

\* Supply is fixed by the factory's launch config, not chosen by the deployer. `docs/manna.md`
already flags and supersedes the earlier 144,000,000-supply idea from `docs/christian-theme.md`
("twelve by twelve by a million, if a number is wanted", Revelation 7:4); this spec repeats the
correction so nothing downstream re-derives the wrong figure.

### 1.3 Giants at launch (`config/markets.json`)

| Symbol | Pool (Giant/WETH, v3) | Initial cap | Status |
|---|---|---|---|
| PONS | `0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA` | $200,000 | live at launch |
| CASHCAT | `0xA70fc67C9F69da90B63a0e4C05D229954574E313` | $160,000 | live at launch |
| AI | `0xc4a21f9d6485FC5893DD4A491B320a83DAF4Da1D` | $100,000 | live at launch |
| Index | `0xD29893fFac8b29eC4Db2cfE0CDB3FE1377c028Ff` | $40,000 | held (`"hold": true`) until its v3 pool's observation buffer clears 1,800 slots |

Every market: `window` 1,800s, `fallbackWindow` 600s (§10), `lltvBps` 3850, IRM = the Adaptive
Curve IRM above.

### 1.4 Morpho Adaptive Curve IRM (the deployment every Storehouse market points to)

| Parameter | Value |
|---|---|
| Rate at target (90% utilisation), initial | 4% / year |
| Bounds on the rate at target | 0.1% – 200% / year |
| Curve steepness | 4× (rate at 100% utilisation = 4 × rate at target) |
| Adjustment speed | 50 / year, log scale |
| Ceiling (200% target × 4) | 800% / year |

The test suite exercises Manna/`LocateVault` accounting against a flat-rate `MockIrm`
(`locate/test/Mocks.sol`), not a vendored copy of the Adaptive Curve's own formula — the shape
above is a fact about the on-chain IRM the markets use, not something the unit tests re-derive.

## 2. Roles and glossary

| Term | Meaning | Where |
|---|---|---|
| Giant | A meme token big enough to list (PONS, CASHCAT, AI, later Index) | `config/markets.json`, `Storehouse.asset` |
| Storehouse | A `LocateVault` holding one Giant, `feeRecipient` = Manna | `Manna._storehouses[i]`, `addStorehouse` |
| the tithe | The Storehouse's 10% performance fee on borrow interest | `LocateVault.feeBps`, `Manna._harvest` |
| sling | A short: post USDG, borrow the Giant, sell it | `LocateRouter.openShort`/`closeShort` |
| the Prophet | The two-hop Uniswap v3 TWAP oracle Morpho reads for a market | `MemeTwapOracle.sol` |
| the Watchmen | Anyone who liquidates an unsafe sling | `Morpho.liquidate` — no dedicated contract yet |
| Manna | The coin (`Manna.token`), and the daily allotment that "falls" | `Manna.sol`, events `Fallen`/`Fell` |
| Joseph's Reserve | USDG held for bad-debt buybacks | `Manna.reserve`, `restore()` |
| Jubilee | The 49-day charity payment and period report | `Manna.jubilee()` |

## 3. Contract surfaces

Solidity `^0.8.24`, compiled with solc 0.8.28, optimizer 200 runs, evmVersion cancun — the same
invocation that compiles `locate/contracts/**` (`scripts/test.js`). Custom errors, no revert
strings. A reentrancy lock guards every function that moves tokens or calls a vault/adapter
(`dawn`, `enter`, `leave`, `gather`, `gatherAll`, `stake`, `unstake`, `skim`, `restore`,
`jubilee`); the pure owner-configuration setters do not additionally lock. Every low-level token
call tolerates a token that returns no data and reverts `TransferFailed()` on a genuine failure
(a revert, or an explicit `false`).

### 3.1 `Manna`

```solidity
struct Dial {
    uint16 treasuryBps; uint16 reserveBps; uint16 charityBps; uint16 reserveTargetBps;
    uint16 stakersBps; uint16 callerBps; uint16 buySlippageBps; uint16 sellSlippageBps;
}
constructor(address usdg_, address owner_, address treasury_);
// dial = {2000, 1000, 500, 1000, 7000, 50, 500, 300} bps; maxBuy = 5_000e6

function transferOwnership(address newOwner) external;   // onlyOwner; sets pendingOwner (two-step)
function acceptOwnership() external;                     // only pendingOwner

function today() public view returns (uint256);           // block.timestamp / 86400
function isSunday(uint256 day) public pure returns (bool); // (day + 4) % 7 == 0
function dawnOpen() public view returns (bool);            // token set, a new day, not Sunday, past 12:00 UTC
function nextDawn() external view returns (uint256);       // earliest timestamp the next dawn() can succeed

function setToken(address token_) external;                // onlyOwner, once only (TokenAlreadySet); starts the Jubilee clock
function setAddresses(address treasury_, address charity_, address buyer_, address seller_, address escrow_) external; // onlyOwner, notSunday; treasury_ != 0
function setDial(Dial calldata d, uint256 maxBuy_) external; // onlyOwner, notSunday; BadDial() past the bounds in §4
function addStorehouse(address vault, address oracle) external; // onlyOwner, notSunday; StorehouseExists() if already added; NotFeeRecipient() unless vault.feeRecipient()==this
function setStorehouseActive(address vault, bool active) external; // onlyOwner, notSunday
function releaseReserve(uint256 amount) external;           // onlyOwner, notSunday; clamps to reserve, never reverts

function dawn() external;                                   // anyone; TokenNotSet()/Sabbath()/AlreadyFell()/NotYetDawn(); see §4
function enter(address vault, uint256 assets) external returns (uint256 shares); // ZeroAmount(); UnknownStorehouse(); StorehouseInactive()
function leave(address vault, uint256 shares) external returns (uint256 assets); // ZeroAmount(); InsufficientShares(); or the vault's own InsufficientLiquidity()
function gather(address vault) external returns (uint256 fresh, uint256 spoiled);
function gatherAll() external returns (uint256 fresh, uint256 spoiled);
function setAutoStake(bool on) external;

function stake(uint256 amount) external returns (uint256 shares);   // ZeroAmount(); TokenNotSet()
function unstake(uint256 shares) external returns (uint256 amount); // InsufficientStake()
function stakedOf(address user) external view returns (uint256);
function skim() external;                                    // TokenNotSet(); no-op unless there's an untracked surplus and totalStakeShares > 0

function restore(address vault) external returns (uint256 usdgSpent, uint256 donated); // NoSeller(); NothingToRestore() unless sharePrice < highWater and reserve > 0
function jubilee() external;                                  // TokenNotSet(); NotJubileeYet(); NoCharity()

function storehouseCount() external view returns (uint256);
function storehouseAt(uint256 i) external view returns (address vault, address asset, address oracle, bool active, uint256 totalStaked, uint256 accPerShare, uint256 highWater, uint256 checkpoints);
function storehouseIndex(address vault) external view returns (uint256); // UnknownStorehouse()
function feeShares(address vault) external view returns (uint256);       // the tithe waiting for the next dawn
function lenderOf(address vault, address user) external view returns (uint256 shares, uint256 fresh, uint256 spoiled, uint256 lastGatherDay);
function storehouseValueUsd() public view returns (uint256 total);
function borrowedUsd(uint256 i) public view returns (uint256);
function reserveTarget() public view returns (uint256);
```

Plus the default public getter for every field under Storage and every constant (`DAY`,
`DAWN_SECONDS`, `SPOIL_DAYS`, `JUBILEE_DAYS`, `BPS`).

Every revert above is named in-line next to the call that throws it. Two cross-cutting ones
aren't: `Reentrancy()` (any guarded function, §3 intro) and `TransferFailed()` (any low-level
token call that fails or returns `false`). The full set of 21: `NotOwner ZeroAddress ZeroAmount
Reentrancy TransferFailed Sabbath NotYetDawn AlreadyFell TokenNotSet TokenAlreadySet
UnknownStorehouse StorehouseExists StorehouseInactive NotFeeRecipient BadDial
InsufficientShares InsufficientStake NothingToRestore NotJubileeYet NoCharity NoSeller`.

**Events**

```solidity
event Dawn(uint256 indexed day, address indexed caller, uint256 income, uint256 toTreasury, uint256 toReserve, uint256 toCharity, uint256 spent);
event Fallen(uint256 indexed day, uint256 bought, uint256 tip, uint256 toStakers, uint256 toLenders);
event Fell(uint256 indexed day, address indexed vault, uint256 amount, uint256 accPerShare);
event TitheSold(address indexed vault, uint256 shares, uint256 assets, uint256 usdgOut);
event TitheSaleFailed(address indexed vault, uint256 assets);
event EscrowClaimed(uint256 amount);
event BuyFailed(uint256 amount);
event Entered(address indexed vault, address indexed user, uint256 assets, uint256 shares);
event Left(address indexed vault, address indexed user, uint256 shares, uint256 assets);
event Gathered(address indexed vault, address indexed user, uint256 fresh, uint256 spoiled, bool staked);
event Staked(address indexed user, uint256 amount, uint256 shares);
event Unstaked(address indexed user, uint256 shares, uint256 amount);
event Burned(uint256 amount);
event Restored(address indexed vault, uint256 usdgSpent, uint256 assetsDonated);
event Jubilee(uint256 indexed day, address indexed charity, uint256 amount, uint256 fallen, uint256 gathered, uint256 spoiled, uint256 nextJubileeDay);
event StorehouseAdded(address indexed vault, address indexed asset, address indexed oracle);
event StorehouseActiveSet(address indexed vault, bool active);
event TokenSet(address indexed token, uint256 nextJubileeDay);
event DialSet(Dial dial, uint256 maxBuy);
event AddressesSet(address treasury, address charity, address buyer, address seller, address escrow);
event ReserveReleased(uint256 amount);
event AutoStakeSet(address indexed user, bool on);
event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

### 3.2 `MemeTwapOracle` ("the Prophet")

```solidity
constructor(address memePool_, address quotePool_, address meme_, address weth_, address usdg_, uint32 window_, uint32 fallbackWindow_);
// ZeroAddress(); TokenNotInPool() unless each pool actually contains the two tokens named;
// InvalidWindow() unless fallbackWindow_ >= MIN_WINDOW (300s) and window_ >= fallbackWindow_

function price() external view returns (uint256);   // IOracle; OracleUnavailable() if neither window can be read
function spot() external view returns (uint256);     // same formula on current ticks; informational only, never read by Morpho
function meanTicks() public view returns (int24 memeTick, int24 quoteTick, uint32 usedWindow);
function priceFromTicks(int24 memeTick, int24 quoteTick) public view returns (uint256); // clamps the combined tick to [MIN_TICK, MAX_TICK] instead of reverting
```

Immutables: `memePool`, `quotePool`, `meme`, `weth`, `usdg`, `memeIsToken1`, `wethIsToken1`,
`window`, `fallbackWindow`. Full formula and failure modes in §10.

### 3.3 Adapters

Two interfaces (`contracts/interfaces/IAdapters.sol`) every buyer/seller implements. Manna
approves exactly the amount of one call before invoking either and verifies delivery by balance,
never by return value (§11):

```solidity
interface IBuyer  { function buy(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out); function quoteBuy(uint256 amountIn) external view returns (uint256 out); }
interface ISeller { function sell(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out); function buyToken(address token, uint256 usdgIn, uint256 minOut, address to) external returns (uint256 out); }
```

`UniswapV3Swapper` (`ISeller` — sells the tithe, buys back for the Reserve):
```solidity
constructor(address weth_, address usdg_, address quotePool_, address owner_);
function setRoute(address token, address pool) external; // onlyOwner; TokenNotInPool() unless pool holds token & weth; zero pool removes it
function sell(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);   // token -> WETH -> USDG; NoRoute(); Slippage()
function buyToken(address token, uint256 usdgIn, uint256 minOut, address to) external returns (uint256 out); // USDG -> WETH -> token, for restore()
function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external; // BadCallback() unless mid-swap on the active pool
```

`UniswapV4Swapper` (`IBuyer` — buys MANNA in its graduated pool):
```solidity
constructor(address poolManager_, address usdg_, address token_, address owner_);
function setPoolKey(uint24 fee, int24 tickSpacing, address hooks) external; // onlyOwner; currencies derived from usdg/token, sorted
function quoteBuy(uint256 amountIn) external view returns (uint256 out); // reads sqrtPriceX96 from PoolManager storage via extsload; 0 if unset
function buy(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out); // Reentrancy(); PoolNotSet(); unlock -> swap -> sync/settle -> take; refunds input left unspent at a price-limit stop
function unlockCallback(bytes calldata data) external returns (bytes memory); // NotPoolManager() unless msg.sender == poolManager
```

`PonsCurveSwapper` (`IBuyer` — buys MANNA on its bonding curve, pre-graduation):
```solidity
constructor(address curve_, address usdg_, address token_);
function quoteBuy(uint256 amountIn) external view returns (uint256 out); // 0 once curve.graduated()
function buy(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out); // refunds any USDG the curve's own allocation clamp returns
```

### 3.4 `LocateVault` / `LocateRouter` surface Manna relies on

Manna never imports Locate's contracts; `contracts/interfaces/ILocateVault.sol` trims the surface
to what it calls:

```solidity
interface ILocateVault {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);           // asset decimals + 6 (LocateVault's ERC-4626 offset)
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function totalAssets() external view returns (uint256);       // idle + Σ supplied, current stored Morpho totals
    function liquidity() external view returns (uint256);         // what could be withdrawn right now
    function convertToAssets(uint256 shares) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);
    function feeRecipient() external view returns (address);
    function accrue() external;                                   // permissionless; accrues every market, mints fee shares
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets); // InsufficientLiquidity() if the markets can't cover it
}
```

Manna never calls `LocateRouter` — slings use it directly. Its `positionOf` reports
`liquidationPrice = collateral × lltv × 1e12 / borrowAssets` (USDG per 1 Giant, 18-decimal fixed
point); `openShort`/`closeShort`/`addCollateral`/`repay` are exactly as specified in
`locate/SPEC.md` §3.2, unchanged for Manna's markets.

## 4. The dawn algorithm

`d = dial` is read once at the top; `v` accumulates the numbers later emitted in `Dawn`/`Fallen`.

1. **Guard.** `TokenNotSet()` unless `token != 0`. `day = today()`; `Sabbath()` if Sunday;
   `AlreadyFell()` if `day <= lastDawnDay`; `NotYetDawn()` if before 12:00 UTC. `lastDawnDay = day`
   is set immediately (checks-effects).
2. **Claim.** If an escrow is set, `try escrow.claimToken(usdg)`; a revert (nothing owed) is
   swallowed.
3. **Tithe, per active Storehouse** (`_harvest`): `vault.accrue()` (best-effort); redeem this
   contract's unstaked fee shares (`balanceOf(this) − totalStaked`, capped by `maxRedeem(this)`);
   sell the Giant that came out through the seller, `minOut = (assets × 1e36 / oracle.price()) ×
   (1 − sellSlippageBps)` (3% default) — a failed sale emits `TitheSaleFailed` and leaves the
   Giant in Manna for next time; update `highWater` if the share price rose (§7).
4. **Split.** `income = balance(usdg) − reserve − charityAccrued − carry` (floored at 0).
   `toTreasury = income × treasuryBps / BPS`; `toReserve = income × reserveBps / BPS`, clamped so
   `reserve + toReserve` never exceeds `reserveTarget()`; `toCharity = income × charityBps / BPS`.
   `budget = income − toTreasury − toReserve − toCharity + carry`. Treasury is paid immediately;
   `reserve`/`charityAccrued` accumulate in place.
5. **Buy.** `spend = min(budget, maxBuy)`. If `spend > 0` and a buyer is set: `quote =
   buyer.quoteBuy(spend)`; `minOut = quote × (1 − buySlippageBps)` (5% default); approve exactly
   `spend`; on success, `spent`/`bought` are read back from balance deltas, never the return
   value; a zero quote or any revert emits `BuyFailed` with `spent = bought = 0`. `carry = budget
   − spent` (a full failure carries the whole budget to tomorrow).
6. **Fall**, only if `bought > 0`:
   - `tip = bought × callerBps / BPS` (0.5% default) to `msg.sender`; `rest = bought − tip`.
   - `toStakers = rest × stakersBps / BPS` (70% default); `toLenders = rest − toStakers`.
   - **Weights**: for every active Storehouse with staked lender shares, `w[i] = borrowedUsd(i) =
     usdgFor(oracle, totalAssets() − liquidity(), 0)`; `total = Σ w[i]`.
   - If `toLenders > 0`: allot it across Storehouses in proportion to `w[i] / total` (§5); the
     entire amount if `total == 0`, or any rounding remainder, moves from `toLenders` into
     `toStakers` instead of being lost.
   - If `toStakers > 0`: if MANNA is currently staked (`totalStakeShares > 0`), add it to
     `stakedPool`. **Otherwise**, re-run the same weighted allotment over `toStakers` with the
     same `w`/`total`; whatever gets placed is booked back into `toLenders`; whatever still
     cannot be placed — no active Storehouse has any staked lender at all — is **burned**. In the
     limiting case (no lenders anywhere and no stakers), the whole day's buy is burned.
7. Emit `Dawn` and `Fallen`.

`setDial` bounds: `treasuryBps + reserveBps + charityBps <= BPS`; `stakersBps <= BPS`; `callerBps
<= 1000` (10% max tip); `buySlippageBps <= BPS`; `sellSlippageBps <= BPS`; `reserveTargetBps <=
BPS` — `BadDial()` otherwise.

## 5. Lender accounting

Per Storehouse, `accPerShare` (scaled by `ACC = 1e18`) is a cumulative "Manna per staked share"
counter, raised by every allotment in §4 step 6:
```
s.accPerShare += portion × ACC / s.totalStaked
s.checkpoints.push({day: uint64, acc: uint192(accPerShare)})   // up to two per Storehouse per dawn
```
Per lender per Storehouse (`Lender{shares, accAt, lastGatherDay}`), settlement (`_settle`, run by
`enter`/`leave`/`gather`/`gatherAll` before anything else changes):
```
acc = s.accPerShare;  d = today();
if (l.shares > 0 && acc > l.accAt) {
    earned    = l.shares × (acc − l.accAt) / ACC;
    cutoffAcc = l.accAt;
    if (d >= l.lastGatherDay + SPOIL_DAYS) {                 // 7+ days since this lender last touched this Storehouse
        a = accAtDay(s, d − SPOIL_DAYS);                     // accPerShare as of the last dawn on/before (d−7), binary search over checkpoints
        if (a > cutoffAcc) cutoffAcc = a;
    }
    spoiled = l.shares × (cutoffAcc − l.accAt) / ACC;         // fell more than 7 days ago, never gathered
    fresh   = earned − spoiled;                               // still inside the 7-day grace window
    lenderPool -= earned;
    if (spoiled > 0) { periodSpoiled += spoiled; burn(spoiled); }
    if (fresh   > 0) { periodGathered += fresh; autoStake[user] ? stakeFor(user, fresh) : push(token, user, fresh); }
}
l.accAt = acc; l.lastGatherDay = d;
```
A lender who gathered within the last 7 days has `d < lastGatherDay + SPOIL_DAYS`, so `cutoffAcc`
stays at `l.accAt` and `spoiled` is `0` by construction — the diligent lose nothing, not by
convention but because nothing old enough to spoil can exist since their last visit. `accAtDay` is
a binary search over `s.checkpoints` (always appended in non-decreasing `day` order); `0` before
the first checkpoint.

`enter`/`leave` call `_settle` **before** changing `l.shares` (or `s.totalStaked`): settling after
would price the pending Manna at the new share count against an accumulator built on the old one,
over- or under-paying by the size of the deposit or withdrawal.

## 6. Staking pool math

Global, not per-Storehouse: `stakedPool` (MANNA), `totalStakeShares`, `stakeShares[user]`.
```
stake(amount):    shares = (totalStakeShares == 0 || stakedPool == 0) ? amount : amount × totalStakeShares / stakedPool
                  stakeShares[user] += shares; totalStakeShares += shares; stakedPool += amount
unstake(shares):  amount = shares × stakedPool / totalStakeShares
                  stakeShares[user] -= shares; totalStakeShares -= shares; stakedPool -= amount
stakedOf(user):   totalStakeShares == 0 ? 0 : stakeShares[user] × stakedPool / totalStakeShares
```
Every dawn that finds `totalStakeShares > 0` adds to `stakedPool` without minting new shares
(§4 step 6), so a share's value rises for every existing staker instead of paying a separate
reward token — the same shape `LocateVault`'s own share price uses for interest.

`skim()`: if `balanceOf(token, this) > stakedPool + lenderPool` (a stray transfer landed outside a
dawn) and `totalStakeShares > 0`, the whole surplus is added to `stakedPool` — no new shares
minted, so it is a pure windfall to whoever is already staked. A no-op with no surplus, or with
nobody staked to receive it.

## 7. Joseph's Reserve and `restore()`

`reserveTarget() = storehouseValueUsd() × reserveTargetBps / BPS`, where `storehouseValueUsd()`
sums every active Storehouse's `totalAssets()` priced by its own Prophet. Each dawn's `toReserve`
(§4 step 4) is clamped so `reserve` never overshoots this target (10% of the Storehouses' value,
by default).

Every Storehouse tracks `highWater`, the highest vault share price (`convertToAssets(1 unit)`)
ever observed — ratcheted upward at the end of every `_harvest` (§4 step 3), initialised to the
share price at the moment the Storehouse was added. A liquidation that writes off bad debt lowers
the actual share price below `highWater` without moving `highWater` itself.

`restore(vault)`, callable by anyone:
```
sp = sharePrice(vault); NothingToRestore() unless sp < highWater && reserve > 0
deficit   = (highWater − sp) × totalSupply(vault) / 10**vault.decimals()   // Giant units short, across every outstanding share
needed    = deficit × 1e36 / oracle.price()                                // priced into USDG (Morpho's 1e36 convention, §10)
usdgSpent = min(needed, reserve); reserve -= usdgSpent
expected  = usdgSpent × oracle.price() / 1e36
minOut    = expected × (1 − sellSlippageBps)
donated   = seller.buyToken(asset, usdgSpent, minOut, this), clamped to what Manna actually received
push(asset, vault, donated)                                                // a raw transfer, not deposit()
```
The donated Giant lands as the vault's idle balance, raising `totalAssets()` exactly as interest
would — the vault cannot tell a Reserve donation from a morning's borrow interest, so its next
`accrue()` mints 10% of the increase as fresh fee shares to Manna. **A Reserve payout is partially
recycled back through the tithe on its very next dawn.** `restore()` never spends more than the
Reserve currently holds; a deficit larger than that is left on the Storehouse's own share price,
permanently, for its lenders to carry — exactly what `docs/borrow-the-meme.md` warned would
sometimes happen.

## 8. Jubilee

`nextJubileeDay` is set once, in `setToken`, to the first Sunday on or after `today() +
JUBILEE_DAYS` (49). `jubilee()`, callable by anyone once `today() >= nextJubileeDay`:
```
NotJubileeYet() if today() < nextJubileeDay;  NoCharity() if charity == 0
amount = charityAccrued; charityAccrued = 0; if (amount > 0) push(usdg, charity, amount)
next = nextJubileeDay + 49; while (next <= today()) next += 49
emit Jubilee(today(), charity, amount, periodFallen, periodGathered, periodSpoiled, next)
nextJubileeDay = next; periodFallen = periodGathered = periodSpoiled = 0
```
`jubilee()` carries no Sunday restriction of its own — it is only ever *due* on a Sunday. Because
49 is a multiple of 7, `nextJubileeDay + 49` (repeated, for a late call) always lands on a Sunday
again, so a missed Jubilee never drifts off the weekly grid. `periodFallen`/`periodGathered`/
`periodSpoiled` are since-the-last-Jubilee counters reset here; `totalFallen`/`totalBurned` are
lifetime counters that never reset.

## 9. Calendar rules

`DAY = 86400`; `DAWN_SECONDS = 43200` (12:00 UTC); `today() = block.timestamp / DAY`;
`isSunday(d) = (d + 4) % 7 == 0` (day 0, 1 Jan 1970, was a Thursday). `dawnOpen() = token != 0 &&
day > lastDawnDay && !isSunday(day) && (block.timestamp % DAY) >= DAWN_SECONDS`. `nextDawn()`
returns the exact timestamp that condition first holds: today at noon if it hasn't passed yet and
today isn't Sunday, otherwise the next non-Sunday day at noon.

`Sabbath()` is enforced two ways: `dawn()` checks `isSunday(today())` directly; every other
dial-turning owner call (`setAddresses`, `setDial`, `addStorehouse`, `setStorehouseActive`,
`releaseReserve`) carries the `notSunday` modifier. `setToken`, `transferOwnership`,
`acceptOwnership`, `jubilee`, and everything lenders/stakers call are **not** Sunday-restricted —
the coin can be named, ownership can move, and Jubilee (which is *supposed* to land on a Sunday)
can run any day.

## 10. Oracle spec and failure modes

`MemeTwapOracle.price()` implements Morpho's `IOracle`: raw Giant units per raw USDG unit, scaled
`1e36`. With `tA` the mean tick of the Giant/WETH pool and `tB` the mean tick of the WETH/USDG
pool over the same window:
```
t     = (Giant is token1 of its pool ? tA : −tA) + (WETH is token1 of the quote pool ? tB : −tB)
price = 1.0001^t × 1e36  =  TickMath.getSqrtPriceAtTick(t) squared, rescaled Q96 -> 1e36 via FullMath.mulDiv
```
Token orientation (`memeIsToken1`, `wethIsToken1`) is fixed at construction from each pool's
`token0()`/`token1()`; a pool that does not contain the named tokens reverts `TokenNotInPool()` at
deploy time, not at read time. A combined tick outside `[TickMath.MIN_TICK, MAX_TICK]` is
**clamped**, not reverted (`priceFromTicks`).

`meanTicks()` tries `window` seconds first (1,800s for every Giant), reading `observe([window,
0])` on both pools; if either buffer cannot reach back that far, it retries at `fallbackWindow`
(600s); if that also fails, `price()` reverts `OracleUnavailable()` rather than guess.
`fallbackWindow` can never be set below `MIN_WINDOW` (300s, enforced at construction as
`InvalidWindow()`), so a market's floor is always at least 5 minutes of real TWAP, never zero.
Because Morpho calls the oracle on every borrow, `withdrawCollateral` and `liquidate`, an
`OracleUnavailable()` market simply freezes — existing slings can neither be extended nor
liquidated until a buffer recovers — the deliberate failure mode: a market with no price must not
lend or seize. `spot()` runs the identical formula on the pools' current tick (`slot0`) instead of
the mean, for the site's lag meter; neither Morpho nor Manna ever calls it.

## 11. Adapters and the trust model

Adapters are owner-set (`setAddresses`, not on Sunday) and swappable any day but Sunday. Manna
treats every adapter as untrusted in three ways:

- **Bounded approval.** USDG or the Giant is approved to the adapter for exactly the amount about
  to be spent, then reset to `0` after the call — never a standing allowance.
- **Balance-verified delivery.** `_buy` and `_harvest` compute what was actually spent/received
  from `balanceOf` before and after the call, never from the adapter's return value, so a lying
  adapter cannot mislead Manna's accounting (it can still under-deliver, recorded as a smaller
  `bought`/`usdgOut`).
- **`try`/`catch` around every adapter and vault call** (`escrow.claimToken`, `vault.accrue`,
  `seller.sell`, `buyer.quoteBuy`/`buy`), so one broken venue degrades gracefully — a failed tithe
  sale leaves the Giant for next time (`TitheSaleFailed`), a failed buy carries the whole budget
  forward (`BuyFailed`) — and never blocks treasury/Reserve/charity from being paid or the next
  Storehouse from being processed.

A malicious or broken adapter can therefore misroute or waste at most one call's worth of value
that day (bounded above by `maxBuy` for the buyer, by one Storehouse's tithe sale for the seller);
it is never given any access to lenders' staked vault shares, stakers' `stakedPool`, or any
balance beyond the single approval for that call.

## 12. Config file shapes and the script sequence

`config/addresses.json`: chain/RPC/explorer, `morpho`, `adaptiveCurveIrm`, `usdg`/`usdgDecimals`,
`weth`, `wethUsdgPool`, `lltvBps`, a `pons{factory, feeEscrow, memeHook, poolManager,
launchConfigId, supply, poolFee, tickSpacing, launchFeeWei}` block, then `treasury`/`charity`/
`manna`/`token`/`curve`/`v3Swapper`/`v4Swapper`/`curveSwapper`/`router` (blank until deployed) and
`vaults{}` (Storehouse addresses by symbol).

`config/markets.json`: one entry per Giant — `symbol`, `name`, `pool` (the Giant/WETH v3 pool),
`token` (filled in once resolved), `initialCapUsd`, `lltvBps`, `window`, `fallbackWindow`, and an
optional `hold: true` (Index) meaning `create-markets.js` should skip it until its buffer clears.

`config/pons-abi.json`: Sourcify-verified ABIs for the factory, meme hook and fee escrow, keyed
`factory`/`memeHook`/`feeEscrow`; `abicheck.js` cross-checks every hand-rolled call signature in
the site and scripts against these plus the compiled Manna ABIs.

Script sequence (each with `--dry-run`, printing calldata and never signing):

1. `create-markets.js [--dry-run] [--only SYMBOL]` — deploys a `MemeTwapOracle` per Giant not
   held, grows its buffer if short of 1,800 observations, creates the Morpho market, records
   `oracle`/`token`/market id.
2. `deploy.js [--dry-run]` — compiles and deploys `Manna` and the three adapters, calls
   `addStorehouse` for each market, records everything into `config/addresses.json`.
3. `launch.js [--dry-run] --name X --symbol MANNA --logo URL --description TEXT [--website U]
   [--twitter U] [--telegram U] [--tax-bps 100] [--dev-buy USDG]` — calls the Pons factory's
   `launchToken`, then `setToken`/`setAddresses` on Manna, points the curve adapter at the new
   curve.
4. `dawn.js [--dry-run] [--watch] [--switch-buyer]` — calls `dawn()`; `--watch` loops it once a
   day; `--switch-buyer` detects graduation and repoints Manna at the v4 adapter first.
5. `status.js` / `sunday.js [--out manna/site/data/sunday.json]` — read-only reporting;
   `sunday.js` feeds the site's Sunday Service page.

Tests: `NODE_PATH=/home/user/experiments/node_modules node manna/scripts/test.js`. Dev
dependencies (`solc` 0.8.28, `@ethereumjs/vm` 8.1.1, `@ethereumjs/common` 4.4.0,
`@ethereumjs/util` 9.1.0, `@ethereumjs/block` 5.3.0) are installed with `npm install --no-save
...` into the repository root's `node_modules`; nothing under `manna/` has its own.

## 13. Invariants the tests hold

Checked by `invariants(label)` at every major step of `scripts/test-dawn.js`:

| Invariant | Why |
|---|---|
| `balanceOf(MANNA, manna) >= stakedPool + lenderPool`, difference `< 1e6` raw units | Manna's MANNA balance is entirely accounted for by the two pools; the small allowed dust is `mulDiv` floor rounding across repeated allotments |
| `balanceOf(USDG, manna) == reserve + charityAccrued + carry` | Every dawn either pays USDG straight out (treasury, the buy) or books it into exactly one of these three counters |
| `feeShares(vault) == vault.balanceOf(manna) − Storehouse.totalStaked` | Manna's only holdings of a Storehouse's vault shares are lenders' staked shares plus the tithe waiting for the next dawn |

## 14. Test plan

`scripts/test.js` runs the sections below against a real Morpho Blue inside an in-process
`ethereumjs` VM (Cancun), loading `scripts/test-dawn.js` for sections 4–8. Quoted from its header:

0. Compile `manna/contracts/**` + `manna/test/Mocks.sol` + `locate/contracts/**` + `locate/test/**`
   in one run.
1. `TickMath` against an independent floating-point computation; the Prophet: both pool
   orientations, the window fallback, the floor, spot vs. mean.
2. World: Morpho, tokens, mock pools, oracles, markets, Storehouses (`LocateVault`s with Manna as
   fee recipient), the v3 seller, the curve buyer, the escrow.
3. Lenders enter through Manna; shorts open through `LocateRouter`; interest accrues; the tithe
   appears.
4. `dawn()`: claim, sell, split, buy, fall; the caller's tip; weights by borrowed value; the cap
   and carry.
5. The calendar: once a day, from noon, never on Sunday, Monday carries.
6. Gathering and spoilage; `autoStake`; the staking pool.
7. The v4 adapter against a mock `PoolManager`; a failing buyer carries the budget.
8. Bad debt, Joseph's Reserve and `restore()`; Jubilee; the Sunday rule on dials; invariants
   throughout.

Run: `NODE_PATH=/home/user/experiments/node_modules node manna/scripts/test.js`, printing
`ok`/`FAIL` per check and `N passed, 0 failed` at the end.
