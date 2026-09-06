// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only mocks for the Manna harness. MockERC20 / MockOracle / MockIrm come from locate/test/Mocks.sol
// (compiled alongside); these cover the venues Manna's adapters talk to: a Uniswap v3 pool, the v4
// PoolManager, the Pons fee escrow and bonding curve, and a buyer that always fails.

import {IUniswapV3SwapCallback} from "../contracts/interfaces/IUniswapV3.sol";
import {IUnlockCallback, PoolKey, SwapParams} from "../contracts/interfaces/IPoolManager.sol";
import {IBuyer} from "../contracts/interfaces/IAdapters.sol";

interface IMockERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function mint(address, uint256) external;
}

/// @notice A v3 pool with a settable mean tick (observe returns tick * elapsed cumulatives), a settable spot
/// tick, an "oldest observation" age so windows beyond it revert like a short buffer, and a fixed-rate swap
/// that pays the recipient and expects the callback to pay the pool.
contract MockV3Pool {
    address public token0;
    address public token1;
    uint24 public fee;
    int24 public meanTick;
    int24 public spotTick;
    uint32 public oldest = type(uint32).max; // seconds of history available
    // token1 per token0, as a rational num/den, for swaps
    uint256 public num = 1;
    uint256 public den = 1;
    uint128 public liquidity = 1e18;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function setMeanTick(int24 t) external {
        meanTick = t;
    }

    function setSpotTick(int24 t) external {
        spotTick = t;
    }

    function setOldest(uint32 s) external {
        oldest = s;
    }

    function setRate(uint256 num_, uint256 den_) external {
        num = num_;
        den = den_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, spotTick, 0, 1, 1, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            require(secondsAgos[i] <= oldest, "OLD");
            int56 t = int56(int256(block.timestamp) - int256(uint256(secondsAgos[i])));
            tickCumulatives[i] = int56(meanTick) * t;
        }
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut = zeroForOne ? (amountIn * num) / den : (amountIn * den) / num;
        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(amountOut);
            uint256 before = IMockERC20(token0).balanceOf(address(this));
            IMockERC20(token1).transfer(recipient, amountOut);
            IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            require(IMockERC20(token0).balanceOf(address(this)) >= before + amountIn, "IIA");
        } else {
            amount1 = int256(amountIn);
            amount0 = -int256(amountOut);
            uint256 before = IMockERC20(token1).balanceOf(address(this));
            IMockERC20(token0).transfer(recipient, amountOut);
            IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
            require(IMockERC20(token1).balanceOf(address(this)) >= before + amountIn, "IIA");
        }
    }
}

/// @notice A v4 PoolManager that runs unlock/swap/sync/settle/take with a fixed price per pool and a hook fee
/// taken from the output (2%, the Pons hook's 1% + a 1% creator tax), and answers extsload for slot0.
contract MockPoolManager {
    error NotUnlocked();
    error CurrencyNotSettled();

    uint24 public feeBps = 200; // hook fee + creator tax, on the output
    mapping(bytes32 => uint160) public sqrtPrices;
    mapping(bytes32 => bytes32) private _slots;
    address private _locker;
    address private _syncedCurrency;
    uint256 private _syncedBalance;
    int256 private _owed; // positive: locker owes the manager
    address private _owedCurrency;

    function setSqrtPrice(PoolKey calldata key, uint160 sqrtPriceX96, int24 tick, uint128 liquidity) external {
        bytes32 id = keccak256(abi.encode(key));
        sqrtPrices[id] = sqrtPriceX96;
        bytes32 slot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        uint256 packed = uint256(sqrtPriceX96) | (uint256(uint24(tick)) << 160);
        _slots[slot] = bytes32(packed);
        _slots[bytes32(uint256(slot) + 3)] = bytes32(uint256(liquidity));
    }

    function setFeeBps(uint24 bps) external {
        feeBps = bps;
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _slots[slot];
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        _locker = msg.sender;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        if (_owed != 0) revert CurrencyNotSettled();
        _locker = address(0);
    }

    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata) external returns (int256) {
        if (msg.sender != _locker) revert NotUnlocked();
        require(params.amountSpecified < 0, "exact input only");
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 s = sqrtPrices[keccak256(abi.encode(key))];
        require(s != 0, "no pool");
        // price token1/token0 = (s/2^96)^2
        uint256 gross;
        if (params.zeroForOne) gross = (((amountIn * s) >> 96) * s) >> 96;
        else gross = (((amountIn << 96) / s) << 96) / s;
        uint256 out = gross - (gross * feeBps) / 10000;
        _owed = int256(amountIn);
        _owedCurrency = params.zeroForOne ? key.currency0 : key.currency1;
        int256 d0;
        int256 d1;
        if (params.zeroForOne) {
            d0 = -int256(amountIn);
            d1 = int256(out);
        } else {
            d1 = -int256(amountIn);
            d0 = int256(out);
        }
        return (d0 << 128) | (d1 & int256(uint256(type(uint128).max)));
    }

    function sync(address currency) external {
        _syncedCurrency = currency;
        _syncedBalance = IMockERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        require(_syncedCurrency == _owedCurrency, "sync mismatch");
        paid = IMockERC20(_syncedCurrency).balanceOf(address(this)) - _syncedBalance;
        require(int256(paid) >= _owed, "underpaid");
        _owed = 0;
    }

    function take(address currency, address to, uint256 amount) external {
        if (msg.sender != _locker) revert NotUnlocked();
        IMockERC20(currency).transfer(to, amount);
    }
}

/// @notice The Pons fee escrow's token side: credit and claim.
contract MockEscrow {
    error NoBalance();

    mapping(address => mapping(address => uint256)) public balanceOfToken;

    function creditToken(address recipient, address token, uint256 amount) external {
        IMockERC20(token).transferFrom(msg.sender, address(this), amount);
        balanceOfToken[recipient][token] += amount;
    }

    function claimToken(address token) external returns (uint256 amount) {
        amount = balanceOfToken[msg.sender][token];
        if (amount == 0) revert NoBalance();
        balanceOfToken[msg.sender][token] = 0;
        IMockERC20(token).transfer(msg.sender, amount);
    }
}

/// @notice A Pons bonding curve: constant product on (quoteReserve, tokenReserve) after a fee on the quote leg.
contract MockCurve {
    error CurveGraduated();

    address public usdg;
    address public token;
    uint256 public feeBps;
    uint256 public creatorTaxBps;
    uint256 public quoteReserve;
    uint256 public tokenReserve;
    bool public graduated;

    constructor(address usdg_, address token_, uint256 feeBps_, uint256 creatorTaxBps_) {
        usdg = usdg_;
        token = token_;
        feeBps = feeBps_;
        creatorTaxBps = creatorTaxBps_;
    }

    function setReserves(uint256 q, uint256 t) external {
        quoteReserve = q;
        tokenReserve = t;
    }

    function setGraduated(bool g) external {
        graduated = g;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (quoteReserve, tokenReserve);
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut) {
        if (graduated) revert CurveGraduated();
        IMockERC20(usdg).transferFrom(msg.sender, address(this), quoteIn);
        uint256 net = (quoteIn * (10000 - feeBps - creatorTaxBps)) / 10000;
        tokensOut = (tokenReserve * net) / (quoteReserve + net);
        require(tokensOut >= minTokensOut, "slippage");
        quoteReserve += net;
        tokenReserve -= tokensOut;
        IMockERC20(token).transfer(recipient, tokensOut);
    }
}

/// @notice A buyer whose buy always reverts, to exercise Manna's carry-over path.
contract MockFailingBuyer is IBuyer {
    function quoteBuy(uint256 amountIn) external pure returns (uint256) {
        return amountIn;
    }

    function maxSpend() external pure returns (uint256) {
        return type(uint256).max;
    }

    function buy(uint256, uint256, address) external pure returns (uint256) {
        revert("down");
    }
}
