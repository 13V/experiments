// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test doubles for StonkPacks. Never deploy these.

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
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
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;
    uint256 public startedAt;
    uint8 public immutable decimals;

    constructor(int256 a, uint8 d) {
        answer = a;
        decimals = d;
        updatedAt = block.timestamp;
        startedAt = block.timestamp;
    }

    function set(int256 a, uint256 at) external {
        answer = a;
        updatedAt = at;
        startedAt = at;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}

/// @dev A contract buyer that receives packs. Used to prove a contract cannot revert a bad open:
///      opens are separate transactions by other parties, so there is nothing to revert.
contract PackHolder {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function approveAndBuy(address packs, address token, uint256 price, bytes32 seed) external returns (uint256) {
        MockERC20(token).approve(packs, price);
        (bool ok, bytes memory ret) = packs.call(abi.encodeWithSignature("buy(bytes32)", seed));
        require(ok, "buy failed");
        return abi.decode(ret, (uint256));
    }
}

/// @dev A stablecoin with an asset-protection freeze, like the ones regulated issuers ship.
contract FreezingERC20 {
    string public name = "Frozen Dollar";
    string public symbol = "FUSD";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;

    constructor(uint8 d) { decimals = d; }
    function freeze(address who, bool f) external { frozen[who] = f; }
    function mint(address to, uint256 amount) external { totalSupply += amount; balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { return _move(msg.sender, to, amount); }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _move(from, to, amount);
    }
    function _move(address from, address to, uint256 amount) private returns (bool) {
        require(!frozen[from] && !frozen[to], "frozen");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev A tier token whose transfers always revert, standing in for a paused or hostile stock token.
contract RevertingERC20 {
    uint8 public constant decimals = 18;
    function balanceOf(address) external pure returns (uint256) { return type(uint256).max; }
    function transfer(address, uint256) external pure returns (bool) { revert("paused"); }
    function transferFrom(address, address, uint256) external pure returns (bool) { revert("paused"); }
}
