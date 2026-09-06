// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISeller} from "../interfaces/IAdapters.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback} from "../interfaces/IUniswapV3.sol";

/// @title UniswapV3Swapper
/// @notice Sells a Giant for USDG along the same two-hop route the Prophet reads (Giant -> WETH on the
/// Giant's v3 pool, WETH -> USDG on the chain's deepest pool), and buys a Giant back with USDG for Joseph's
/// Reserve. Talks to the pools directly through `swap` + the swap callback, so it needs no periphery router
/// address and holds nothing between calls. Routes are set by the owner, one pool per Giant.
contract UniswapV3Swapper is ISeller, IUniswapV3SwapCallback {
    error NotOwner();
    error ZeroAddress();
    error TokenNotInPool();
    error NoRoute();
    error BadCallback();
    error Slippage();
    error TransferFailed();
    error Reentrancy();

    event RouteSet(address indexed token, address indexed pool, bool tokenIsToken0);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct Route {
        IUniswapV3Pool pool;
        bool tokenIsToken0;
    }

    // TickMath.MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1: the widest limits a swap may pass.
    uint160 private constant MIN_SQRT_LIMIT = 4295128739 + 1;
    uint160 private constant MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    address public immutable weth;
    address public immutable usdg;
    IUniswapV3Pool public immutable quotePool;
    /// @notice True when WETH is token0 of the WETH/USDG pool.
    bool public immutable wethIsToken0;

    address public owner;
    mapping(address token => Route) public routes;
    /// @dev The one pool allowed to call `uniswapV3SwapCallback` right now; zero outside a swap.
    address private _activePool;
    uint256 private _lock = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address weth_, address usdg_, address quotePool_, address owner_) {
        if (weth_ == address(0) || usdg_ == address(0) || quotePool_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        address t0 = IUniswapV3Pool(quotePool_).token0();
        address t1 = IUniswapV3Pool(quotePool_).token1();
        bool weth0;
        if (t0 == weth_ && t1 == usdg_) weth0 = true;
        else if (t1 == weth_ && t0 == usdg_) weth0 = false;
        else revert TokenNotInPool();
        weth = weth_;
        usdg = usdg_;
        quotePool = IUniswapV3Pool(quotePool_);
        wethIsToken0 = weth0;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Registers `pool` as the token/WETH pool used for `token`. Pass the zero pool to remove.
    function setRoute(address token, address pool) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (pool == address(0)) {
            delete routes[token];
            emit RouteSet(token, address(0), false);
            return;
        }
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        bool token0;
        if (t0 == token && t1 == weth) token0 = true;
        else if (t1 == token && t0 == weth) token0 = false;
        else revert TokenNotInPool();
        routes[token] = Route(IUniswapV3Pool(pool), token0);
        emit RouteSet(token, pool, token0);
    }

    /// @inheritdoc ISeller
    function sell(address token, uint256 amountIn, uint256 minOut, address to) external nonReentrant returns (uint256 out) {
        Route memory r = routes[token];
        if (address(r.pool) == address(0)) revert NoRoute();
        _pull(token, msg.sender, amountIn);
        uint256 wethOut = _swap(r.pool, r.tokenIsToken0, amountIn, token, address(this));
        out = _swap(quotePool, wethIsToken0, wethOut, weth, to);
        if (out < minOut) revert Slippage();
    }

    /// @inheritdoc ISeller
    function buyToken(address token, uint256 usdgIn, uint256 minOut, address to) external nonReentrant returns (uint256 out) {
        Route memory r = routes[token];
        if (address(r.pool) == address(0)) revert NoRoute();
        _pull(usdg, msg.sender, usdgIn);
        uint256 wethOut = _swap(quotePool, !wethIsToken0, usdgIn, usdg, address(this));
        out = _swap(r.pool, !r.tokenIsToken0, wethOut, weth, to);
        if (out < minOut) revert Slippage();
    }

    /// @dev Exact-input swap on `pool`, paying `payToken` from this contract's balance inside the callback.
    function _swap(IUniswapV3Pool pool, bool zeroForOne, uint256 amountIn, address payToken, address recipient)
        private
        returns (uint256 out)
    {
        _activePool = address(pool);
        (int256 a0, int256 a1) = pool.swap(
            recipient, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_LIMIT : MAX_SQRT_LIMIT, abi.encode(payToken)
        );
        _activePool = address(0);
        int256 o = zeroForOne ? a1 : a0; // the pool's delta of the output token; negative means we received it
        out = o < 0 ? uint256(-o) : 0;
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (_activePool == address(0) || msg.sender != _activePool) revert BadCallback();
        address payToken = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : (amount1Delta > 0 ? uint256(amount1Delta) : 0);
        if (owed > 0) _push(payToken, msg.sender, owed);
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount)); // transferFrom
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
