// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Id, MarketParams, IMorpho} from "./interfaces/IMorpho.sol";
import {IOracle} from "./interfaces/IOracle.sol";

/// @title LocateRouter
/// @notice Stateless one-transaction spot short on top of Morpho Blue (SPEC.md section 3.2). Posts USDG as
/// collateral and borrows the stock token out to `receiver`, who sells it on a DEX; closing does the
/// reverse. The router never holds funds after a call and approves Morpho for exactly the amount pulled.
///
/// @dev The user must call `morpho.setAuthorization(router, true)` once before any function here that
/// borrows or withdraws on their behalf (Morpho's own authorization model — see SPEC.md section 2).
///
/// Liquidation-price convention (worked out from Morpho's oracle convention in SPEC.md section 2): for our
/// markets, `loanToken` is the stock and `collateralToken` is USDG, and `IOracle.price()` returns "the
/// price of 1 unit of collateral quoted in 1 unit of loan, scaled 1e36" — i.e. stock-per-USDG, decimals-
/// adjusted (see Morpho's `_isHealthy`: `maxBorrow = collateral * price / 1e36 * lltv / 1e18`, in raw loan
/// units). `positionOf` instead reports `liquidationPrice` in the more human direction, USDG-per-1-stock,
/// as an 18-decimal fixed point (1e18 = 1 USDG), at which health drops to exactly 1:
///
///   hf = 1  <=>  collateral * price / 1e36 * lltv / 1e18 = borrowAssets
///
/// Substituting price = 1e36 * 10**(loanDecimals - collateralDecimals) / H, where H is USDG-per-stock in
/// human units, and solving for H, the 1e36/1e18/decimals terms collapse to a single scale factor of 1e12
/// between raw USDG (6 decimals) and an 18-decimal fixed-point human price:
///
///   liquidationPrice = collateral * lltv * 1e12 / borrowAssets     (0 when borrowAssets == 0)
///
/// e.g. collateral = 1_000e6 (1,000 USDG), lltv = 0.77e18, borrowAssets = 3e18 (3 stock) gives
/// liquidationPrice = 1_000e6 * 0.77e18 * 1e12 / 3e18 = 256_666...e18, i.e. ~256.67 USDG per stock — checked
/// against the hand computation c * lltv / b = 1000 * 0.77 / 3 in locate/scripts/test.js.
contract LocateRouter {
    error Reentrancy();
    error TransferFailed();
    error ZeroAmount();

    event ShortOpened(address indexed user, Id indexed id, uint256 collateral, uint256 borrowed, address receiver);
    event ShortClosed(address indexed user, Id indexed id, uint256 repaid, uint256 collateralOut);

    bytes4 private constant TRANSFER_FROM_SELECTOR = bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 private constant APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));

    uint256 private constant MORPHO_VIRTUAL_SHARES = 1e6;
    uint256 private constant MORPHO_VIRTUAL_ASSETS = 1;

    IMorpho public immutable morpho;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address morpho_) {
        morpho = IMorpho(morpho_);
    }

    /// @notice Pulls `collateralAssets` of `mp.collateralToken` from the caller, posts it as collateral on
    /// Morpho on the caller's behalf, then borrows `borrowAssets` of `mp.loanToken` to `receiver`. Requires
    /// the caller to have authorized this router on Morpho beforehand.
    function openShort(MarketParams calldata mp, uint256 collateralAssets, uint256 borrowAssets, address receiver)
        external
        nonReentrant
    {
        if (collateralAssets == 0 || borrowAssets == 0) revert ZeroAmount();
        _pull(mp.collateralToken, msg.sender, collateralAssets);
        _approve(mp.collateralToken, address(morpho), collateralAssets);
        morpho.supplyCollateral(mp, collateralAssets, msg.sender, "");
        morpho.borrow(mp, borrowAssets, 0, msg.sender, receiver);
        emit ShortOpened(msg.sender, _id(mp), collateralAssets, borrowAssets, receiver);
    }

    /// @notice Pulls `assets` of `mp.collateralToken` from the caller and posts it as additional collateral.
    function addCollateral(MarketParams calldata mp, uint256 assets) external nonReentrant {
        if (assets == 0) revert ZeroAmount();
        _pull(mp.collateralToken, msg.sender, assets);
        _approve(mp.collateralToken, address(morpho), assets);
        morpho.supplyCollateral(mp, assets, msg.sender, "");
    }

    /// @notice Repays the caller's borrow by exact `assets`, or by `shares` (0 for the other). On the
    /// shares path, accrues interest first and converts to assets up, so the router pulls exactly what
    /// Morpho's own `repay` will consume — no dust, no refund needed.
    function repay(MarketParams calldata mp, uint256 assets, uint256 shares) external nonReentrant {
        uint256 pullAmt = assets;
        if (assets == 0 && shares > 0) {
            morpho.accrueInterest(mp);
            (, , uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(_id(mp));
            pullAmt = _toAssetsUpMorpho(shares, totalBorrowAssets, totalBorrowShares);
        }
        if (pullAmt > 0) {
            _pull(mp.loanToken, msg.sender, pullAmt);
            _approve(mp.loanToken, address(morpho), pullAmt);
        }
        morpho.repay(mp, assets, shares, msg.sender, "");
    }

    /// @notice Repays `repayShares` of the caller's borrow (0 = all of it), then withdraws
    /// `withdrawCollateralAssets` of collateral to `receiver` (0 = all of it). Repay happens first so that
    /// a full close (both zero) always leaves a healthy (borrowShares == 0) position to withdraw against.
    function closeShort(MarketParams calldata mp, uint256 repayShares, uint256 withdrawCollateralAssets, address receiver)
        external
        nonReentrant
    {
        Id id = _id(mp);
        if (repayShares == 0) {
            (, uint128 borrowShares,) = morpho.position(id, msg.sender);
            repayShares = borrowShares;
        }
        uint256 repaidAssets;
        if (repayShares > 0) {
            morpho.accrueInterest(mp);
            (, , uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(id);
            uint256 pullAmt = _toAssetsUpMorpho(repayShares, totalBorrowAssets, totalBorrowShares);
            if (pullAmt > 0) {
                _pull(mp.loanToken, msg.sender, pullAmt);
                _approve(mp.loanToken, address(morpho), pullAmt);
            }
            (repaidAssets,) = morpho.repay(mp, 0, repayShares, msg.sender, "");
        }
        if (withdrawCollateralAssets == 0) {
            (,, uint128 collateral) = morpho.position(id, msg.sender);
            withdrawCollateralAssets = collateral;
        }
        if (withdrawCollateralAssets > 0) {
            morpho.withdrawCollateral(mp, withdrawCollateralAssets, msg.sender, receiver);
        }
        emit ShortClosed(msg.sender, id, repaidAssets, withdrawCollateralAssets);
    }

    /// @notice Reads `user`'s position in market `mp` from Morpho's currently-stored (possibly a little
    /// stale between accruals) totals: collateral and borrow in raw units, `maxBorrow` in loan units,
    /// health factor scaled 1e18 (`type(uint256).max` when there is no borrow), and `liquidationPrice` per
    /// the convention documented on the contract (0 when there is no borrow).
    function positionOf(MarketParams calldata mp, address user)
        external
        view
        returns (uint256 collateral, uint256 borrowAssets, uint256 maxBorrow, uint256 healthFactorWad, uint256 liquidationPrice)
    {
        Id id = _id(mp);
        (, uint128 borrowSharesRaw, uint128 collateralRaw) = morpho.position(id, user);
        (, , uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(id);
        collateral = collateralRaw;
        borrowAssets = _toAssetsUpMorpho(borrowSharesRaw, totalBorrowAssets, totalBorrowShares);
        uint256 price = IOracle(mp.oracle).price();
        maxBorrow = (collateral * price / 1e36) * mp.lltv / 1e18;
        if (borrowAssets == 0) {
            healthFactorWad = type(uint256).max;
            liquidationPrice = 0;
        } else {
            healthFactorWad = (maxBorrow * 1e18) / borrowAssets;
            liquidationPrice = (collateral * mp.lltv * 1e12) / borrowAssets;
        }
    }

    /// @notice Oracle price passthrough (1e36 convention, see SPEC.md section 2 and the NatSpec above).
    function quote(MarketParams calldata mp) external view returns (uint256 price) {
        price = IOracle(mp.oracle).price();
    }

    function _toAssetsUpMorpho(uint256 shares, uint256 totalAssetsM, uint256 totalSharesM)
        private
        pure
        returns (uint256)
    {
        if (shares == 0) return 0;
        uint256 num = shares * (totalAssetsM + MORPHO_VIRTUAL_ASSETS);
        uint256 den = totalSharesM + MORPHO_VIRTUAL_SHARES;
        return (num + den - 1) / den;
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(TRANSFER_FROM_SELECTOR, from, address(this), amount));
        if (!_success(ok, ret)) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(APPROVE_SELECTOR, spender, amount));
        if (!_success(ok, ret)) revert TransferFailed();
    }

    function _success(bool ok, bytes memory ret) private pure returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length >= 32) return abi.decode(ret, (bool));
        return false;
    }

    /// @dev keccak256 of the struct's 160-byte memory layout, matching Morpho Blue's MarketParamsLib.id().
    function _id(MarketParams memory mp) private pure returns (Id id) {
        assembly ("memory-safe") {
            id := keccak256(mp, 160)
        }
    }
}
