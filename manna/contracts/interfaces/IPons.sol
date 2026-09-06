// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Pons V2's shared fee escrow (PonsV2FeeEscrow, verified on Sourcify at
/// 0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e on Robinhood Chain). A coin's creator fee recipient calls
/// `claimToken(pairToken)` and receives its whole balance; it reverts `NoBalance()` when there is nothing.
interface IPonsV2FeeEscrow {
    function claimToken(address token) external returns (uint256 amount);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

/// @notice The slice of PonsV2BondingCurve the curve adapter uses while the coin is still on its curve.
interface IPonsV2BondingCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function graduated() external view returns (bool);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
}
