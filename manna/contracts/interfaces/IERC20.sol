// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The ERC-20 surface Manna and its adapters use. Calls are made through low-level helpers that
/// tolerate both "returns false" and "returns nothing" tokens (see Manna._pull/_push), so this interface is
/// mostly for views and for typing.
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice OpenZeppelin ERC20Burnable's `burn`, which Pons V2 launch tokens expose. Manna tries it first and
/// falls back to sending to the dead address for tokens without it (the mocks in tests).
interface IBurnable {
    function burn(uint256 amount) external;
}
