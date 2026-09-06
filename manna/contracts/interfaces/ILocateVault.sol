// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of LocateVault (locate/contracts/LocateVault.sol) that Manna calls. A Storehouse is a
/// LocateVault whose `feeRecipient` is the Manna contract: the vault mints its performance fee to Manna as
/// shares, and Manna also holds the shares lenders stake through it.
interface ILocateVault {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function liquidity() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);
    function feeRecipient() external view returns (address);
    function accrue() external;
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}
