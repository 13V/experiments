// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Buys the coin with USDG. Manna approves `amountIn` of USDG to the adapter and calls `buy`; the
/// adapter pulls the USDG, executes wherever the coin trades right now (the Pons curve before graduation,
/// the Uniswap v4 pool after), and delivers at least `minOut` coin to `to`. Manna verifies the delivery by
/// balance, never by the return value.
interface IBuyer {
    function buy(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);
    function quoteBuy(uint256 amountIn) external view returns (uint256 out);
}

/// @notice Sells a Giant (a meme token) for USDG, and the reverse for Joseph's Reserve. Same pull-on-approval
/// convention as IBuyer.
interface ISeller {
    function sell(address token, uint256 amountIn, uint256 minOut, address to) external returns (uint256 out);
    function buyToken(address token, uint256 usdgIn, uint256 minOut, address to) external returns (uint256 out);
}
