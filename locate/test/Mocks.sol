// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test-only mocks. These deliberately depend on the vendored Morpho Blue interfaces in ./morpho/ (unlike
// locate/contracts/**, which carries its own trimmed copies) so that MockIrm/MockOracle are guaranteed
// ABI-compatible with the exact Morpho Blue deployment they plug into here.
import {MarketParams, Market} from "./morpho/interfaces/IMorpho.sol";
import {IIrm} from "./morpho/interfaces/IIrm.sol";
import {IOracle} from "./morpho/interfaces/IOracle.sol";

/// @notice Minimal ERC-20 with a `setFailTransfers` switch so callers can exercise a router/vault's
/// `TransferFailed()` path: while enabled, `transfer`/`transferFrom` return `false` instead of moving
/// tokens or reverting outright (the classic "unsafe ERC20" failure mode low-level-call callers must
/// tolerate-detect rather than rely on a revert for).
contract MockERC20 {
    error InsufficientBalance();
    error InsufficientAllowance();

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failTransfers;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice `IOracle.price()` mock: an owner-less, permissionlessly-settable price for tests. Constructor and
/// `setPrice` both take the raw 1e36-convention value Morpho expects (see IOracle.sol / SPEC.md section 2) —
/// callers compute the human-to-raw conversion off-chain, same as `MorphoChainlinkOracleV2` would on-chain.
contract MockOracle is IOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }
}

/// @notice `IIrm` mock paying a fixed borrow rate per second (WAD-scaled), regardless of `marketParams`
/// or the market's current utilisation.
contract MockIrm is IIrm {
    uint256 public rate;

    constructor(uint256 rate_) {
        rate = rate_;
    }

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function borrowRate(MarketParams memory, Market memory) external view returns (uint256) {
        return rate;
    }

    function borrowRateView(MarketParams memory, Market memory) external view returns (uint256) {
        return rate;
    }
}

/// @notice Chainlink-style feed mock (`latestRoundData`, `decimals`), for completeness — not consumed by
/// Morpho directly (Morpho only talks to `IOracle`), but matches the feed shape the real
/// MorphoChainlinkOracleV2 markets read from and that locate/site and locate/scripts display.
contract MockFeed {
    int256 public answer;
    uint8 public decimals;
    uint80 public roundId;

    constructor(int256 answer_, uint8 decimals_) {
        answer = answer_;
        decimals = decimals_;
        roundId = 1;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        roundId += 1;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId_, int256 answer_, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (roundId, answer, block.timestamp, block.timestamp, roundId);
    }
}
