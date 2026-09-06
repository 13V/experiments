// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBuyer} from "../interfaces/IAdapters.sol";
import {IPonsV2BondingCurve} from "../interfaces/IPons.sol";

/// @title PonsCurveSwapper
/// @notice Buys the coin on its Pons V2 bonding curve while it is still there. The curve's `buy` pulls the
/// quote token from the caller, so this adapter approves and calls; a buy that the curve clamps at its
/// reserved allocation is refunded to the adapter, which hands the refund back to the caller. After
/// graduation the curve refuses buys, `quoteBuy` returns zero, and the owner points Manna at the v4 adapter.
contract PonsCurveSwapper is IBuyer {
    error ZeroAddress();
    error TransferFailed();

    /// @notice One buy may spend 1% of the curve's quote reserve (phantom included): about a 1% move on the
    /// constant-product curve, under the 2 x 1% fee a round trip through the curve pays.
    uint256 public constant IMPACT_CAP_BPS = 100;

    IPonsV2BondingCurve public immutable curve;
    address public immutable usdg;
    address public immutable token;

    constructor(address curve_, address usdg_, address token_) {
        if (curve_ == address(0) || usdg_ == address(0) || token_ == address(0)) revert ZeroAddress();
        curve = IPonsV2BondingCurve(curve_);
        usdg = usdg_;
        token = token_;
    }

    /// @inheritdoc IBuyer
    function quoteBuy(uint256 amountIn) external view returns (uint256 out) {
        if (curve.graduated()) return 0;
        (uint256 q, uint256 t) = curve.getReserves();
        uint256 feeBps = curve.feeBps() + curve.creatorTaxBps();
        uint256 net = (amountIn * (10000 - feeBps)) / 10000;
        if (q + net == 0) return 0;
        out = (t * net) / (q + net);
    }

    /// @inheritdoc IBuyer
    function maxSpend() external view returns (uint256) {
        if (curve.graduated()) return 0;
        (uint256 q,) = curve.getReserves();
        return (q * IMPACT_CAP_BPS) / 10000;
    }

    /// @inheritdoc IBuyer
    function buy(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        _pull(usdg, msg.sender, amountIn);
        _approve(usdg, address(curve), amountIn);
        out = curve.buy(amountIn, minOut, to);
        _approve(usdg, address(curve), 0);
        (bool ok, bytes memory ret) = usdg.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        uint256 left = ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        if (left > 0) _push(usdg, msg.sender, left);
    }

    function _pull(address t, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address t, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address t, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
