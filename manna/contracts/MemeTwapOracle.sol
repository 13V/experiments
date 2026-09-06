// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracle} from "./interfaces/IOracle.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title MemeTwapOracle, "the Prophet"
/// @notice Morpho Blue `IOracle` for a market whose loan token is a meme and whose collateral is USDG, priced
/// through two Uniswap v3 time-weighted average ticks: the meme's WETH pool and the chain's WETH/USDG pool.
///
/// `price()` returns raw meme units per raw USDG unit scaled by 1e36, Morpho's convention for
/// "1 unit of collateral quoted in loan units". With both pools' mean ticks tA (meme/WETH) and tB
/// (WETH/USDG) and each pool's token ordering, the combined tick is
///
///   t = (meme is token1 ? tA : -tA) + (WETH is token1 of the quote pool ? tB : -tB)
///
/// and price = 1.0001^t * 1e36, computed from TickMath's sqrt table so it matches what the pools themselves
/// would quote at that tick. Decimals need no separate adjustment: pool ticks already price raw units.
///
/// The mean over `window` seconds is tried first; if either pool's observation buffer cannot reach that far
/// back, `fallbackWindow` (never below MIN_WINDOW) is tried; if that fails too, the oracle reverts and every
/// Morpho action that needs a price (borrow, liquidate, health) reverts with it, which is the safe failure.
contract MemeTwapOracle is IOracle {
    error ZeroAddress();
    error InvalidWindow();
    error TokenNotInPool();
    error OracleUnavailable();

    uint32 public constant MIN_WINDOW = 300;

    IUniswapV3Pool public immutable memePool;
    IUniswapV3Pool public immutable quotePool;
    address public immutable meme;
    address public immutable weth;
    address public immutable usdg;
    /// @notice True when the meme is token1 of `memePool` (so the pool's tick prices meme per WETH).
    bool public immutable memeIsToken1;
    /// @notice True when WETH is token1 of `quotePool` (so the pool's tick prices WETH per USDG).
    bool public immutable wethIsToken1;
    uint32 public immutable window;
    uint32 public immutable fallbackWindow;

    constructor(
        address memePool_,
        address quotePool_,
        address meme_,
        address weth_,
        address usdg_,
        uint32 window_,
        uint32 fallbackWindow_
    ) {
        if (
            memePool_ == address(0) || quotePool_ == address(0) || meme_ == address(0) || weth_ == address(0)
                || usdg_ == address(0)
        ) revert ZeroAddress();
        if (fallbackWindow_ < MIN_WINDOW || window_ < fallbackWindow_) revert InvalidWindow();

        address t0 = IUniswapV3Pool(memePool_).token0();
        address t1 = IUniswapV3Pool(memePool_).token1();
        bool memeIs1;
        if (t0 == meme_ && t1 == weth_) memeIs1 = false;
        else if (t1 == meme_ && t0 == weth_) memeIs1 = true;
        else revert TokenNotInPool();

        t0 = IUniswapV3Pool(quotePool_).token0();
        t1 = IUniswapV3Pool(quotePool_).token1();
        bool wethIs1;
        if (t0 == weth_ && t1 == usdg_) wethIs1 = false;
        else if (t1 == weth_ && t0 == usdg_) wethIs1 = true;
        else revert TokenNotInPool();

        memePool = IUniswapV3Pool(memePool_);
        quotePool = IUniswapV3Pool(quotePool_);
        meme = meme_;
        weth = weth_;
        usdg = usdg_;
        memeIsToken1 = memeIs1;
        wethIsToken1 = wethIs1;
        window = window_;
        fallbackWindow = fallbackWindow_;
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        (int24 a, int24 b,) = meanTicks();
        return priceFromTicks(a, b);
    }

    /// @notice The same formula on the pools' current ticks: the spot price in Morpho's convention, for the
    /// desk's lag meter (spot against the Prophet). Never used for lending.
    function spot() external view returns (uint256) {
        (, int24 a,,,,,) = memePool.slot0();
        (, int24 b,,,,,) = quotePool.slot0();
        return priceFromTicks(a, b);
    }

    /// @notice Arithmetic mean ticks of both pools over `window`, or over `fallbackWindow` when a buffer is
    /// too short, with the window actually used.
    function meanTicks() public view returns (int24 memeTick, int24 quoteTick, uint32 usedWindow) {
        (bool okA, int24 a) = _meanTick(memePool, window);
        (bool okB, int24 b) = _meanTick(quotePool, window);
        if (okA && okB) return (a, b, window);
        (okA, a) = _meanTick(memePool, fallbackWindow);
        (okB, b) = _meanTick(quotePool, fallbackWindow);
        if (okA && okB) return (a, b, fallbackWindow);
        revert OracleUnavailable();
    }

    /// @notice 1.0001^t * 1e36 for the combined tick of the two pool ticks given.
    function priceFromTicks(int24 memeTick, int24 quoteTick) public view returns (uint256) {
        int256 t = (memeIsToken1 ? int256(memeTick) : -int256(memeTick))
            + (wethIsToken1 ? int256(quoteTick) : -int256(quoteTick));
        if (t > TickMath.MAX_TICK) t = TickMath.MAX_TICK;
        if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
        uint256 s = TickMath.getSqrtPriceAtTick(int24(t));
        // Uniswap's OracleLibrary.getQuoteAtTick: square in 256 bits when it fits, else through a 128-bit ratio.
        if (s <= type(uint128).max) {
            return FullMath.mulDiv(s * s, 1e36, 1 << 192);
        }
        uint256 ratioX128 = FullMath.mulDiv(s, s, 1 << 64);
        return FullMath.mulDiv(ratioX128, 1e36, 1 << 128);
    }

    /// @dev Uniswap's OracleLibrary.consult rounding: toward negative infinity when the cumulative delta is
    /// negative and not an exact multiple of the window.
    function _meanTick(IUniswapV3Pool pool, uint32 w) private view returns (bool ok, int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = w;
        ago[1] = 0;
        try pool.observe(ago) returns (int56[] memory c, uint160[] memory) {
            int56 delta = c[1] - c[0];
            int56 t = delta / int56(uint56(w));
            if (delta < 0 && (delta % int56(uint56(w)) != 0)) t--;
            return (true, int24(t));
        } catch {
            return (false, 0);
        }
    }
}
