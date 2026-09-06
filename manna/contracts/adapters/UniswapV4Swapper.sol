// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBuyer} from "../interfaces/IAdapters.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "../interfaces/IPoolManager.sol";
import {FullMath} from "../libraries/FullMath.sol";

/// @title UniswapV4Swapper
/// @notice Buys the coin with USDG in its graduated Uniswap v4 pool (the Pons Meme hook pool: fee 0, the
/// launch config's tick spacing, the shared hook) through the PoolManager's unlock/swap/settle/take cycle.
/// The hook takes its fee and the creator tax out of the output inside afterSwap and the PoolManager's
/// returned delta already nets that out, so what this contract takes is exactly what arrives.
contract UniswapV4Swapper is IBuyer, IUnlockCallback {
    error NotOwner();
    error ZeroAddress();
    error NotPoolManager();
    error PoolNotSet();
    error Slippage();
    error TransferFailed();
    error Reentrancy();

    event PoolKeySet(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    uint160 private constant MIN_SQRT_LIMIT = 4295128739 + 1;
    uint160 private constant MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;
    /// @dev PoolManager's `_pools` mapping lives at storage slot 6 (v4-core StateLibrary.POOLS_SLOT).
    bytes32 private constant POOLS_SLOT = bytes32(uint256(6));

    IPoolManager public immutable poolManager;
    address public immutable usdg;
    address public immutable token;
    /// @notice True when USDG sorts below the coin, i.e. USDG is currency0 of the pool.
    bool public immutable usdgIsCurrency0;

    address public owner;
    PoolKey public key;
    bool public keySet;
    address private _buyer;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address poolManager_, address usdg_, address token_, address owner_) {
        if (poolManager_ == address(0) || usdg_ == address(0) || token_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        poolManager = IPoolManager(poolManager_);
        usdg = usdg_;
        token = token_;
        usdgIsCurrency0 = usdg_ < token_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Fixes the pool: currencies are derived from `usdg`/`token`, the rest from the launch config.
    function setPoolKey(uint24 fee, int24 tickSpacing, address hooks) external onlyOwner {
        key = PoolKey({
            currency0: usdgIsCurrency0 ? usdg : token,
            currency1: usdgIsCurrency0 ? token : usdg,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: hooks
        });
        keySet = true;
        emit PoolKeySet(key.currency0, key.currency1, fee, tickSpacing, hooks);
    }

    function poolId() public view returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice The pool's current sqrt price, read from the PoolManager's storage the way StateLibrary does.
    function sqrtPriceX96() public view returns (uint160) {
        bytes32 slot = keccak256(abi.encodePacked(poolId(), POOLS_SLOT));
        return uint160(uint256(poolManager.extsload(slot)));
    }

    /// @inheritdoc IBuyer
    function quoteBuy(uint256 amountIn) external view returns (uint256 out) {
        if (!keySet) return 0;
        uint256 s = sqrtPriceX96();
        if (s == 0) return 0;
        if (usdgIsCurrency0) {
            // price = token1/token0 = coin per USDG
            out = FullMath.mulDiv(FullMath.mulDiv(amountIn, s, 1 << 96), s, 1 << 96);
        } else {
            out = FullMath.mulDiv(FullMath.mulDiv(amountIn, 1 << 96, s), 1 << 96, s);
        }
    }

    /// @inheritdoc IBuyer
    function buy(uint256 amountIn, uint256 minOut, address to) external returns (uint256 out) {
        if (!keySet) revert PoolNotSet();
        if (_buyer != address(0)) revert Reentrancy();
        _buyer = msg.sender;
        _pull(usdg, msg.sender, amountIn);
        bytes memory ret = poolManager.unlock(abi.encode(amountIn, minOut, to));
        out = abi.decode(ret, (uint256));
        _buyer = address(0);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut, address to) = abi.decode(data, (uint256, uint256, address));
        bool zeroForOne = usdgIsCurrency0;
        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_LIMIT : MAX_SQRT_LIMIT
            }),
            ""
        );
        // BalanceDelta packs amount0 in the upper 128 bits and amount1 in the lower 128 bits, both signed.
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        int128 dIn = zeroForOne ? d0 : d1;
        int128 dOut = zeroForOne ? d1 : d0;
        uint256 owed = dIn < 0 ? uint256(uint128(-dIn)) : 0;
        uint256 out = dOut > 0 ? uint256(uint128(dOut)) : 0;
        if (owed > 0) {
            poolManager.sync(usdg);
            _push(usdg, address(poolManager), owed);
            poolManager.settle();
        }
        if (out < minOut) revert Slippage();
        if (out > 0) poolManager.take(token, to, out);
        // A swap that stopped at the price limit leaves part of the input unspent: hand it back.
        if (amountIn > owed) _push(usdg, _buyer, amountIn - owed);
        return abi.encode(out);
    }

    function _pull(address t, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address t, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
