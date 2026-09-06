// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Uniswap v4's PoolManager the v4 adapter uses. `Currency`, `IHooks` and `BalanceDelta`
/// are user-defined value types / contract types upstream and ABI-encode as `address` / `address` / `int256`,
/// so these plain declarations are wire-compatible with the real deployment.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
