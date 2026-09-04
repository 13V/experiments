// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Id, MarketParams, IMorpho} from "./interfaces/IMorpho.sol";

/// @dev Minimal ERC-20 metadata read at construction time to size this vault's own decimals.
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title LocateVault
/// @notice ERC-4626 vault for a single stock token (SPEC.md section 3.1). Lenders deposit the stock and the
/// vault supplies it into one or more Morpho Blue markets whose `loanToken` is that stock, up to a cap per
/// market, earning the borrow rate paid by Locate's shorters. A performance fee on the interest is minted
/// to `feeRecipient` as vault shares.
///
/// @dev Share pricing (spec amendment, documented here per SPEC.md section 3's instructions): to blunt the
/// classic ERC-4626 first-depositor inflation attack, this vault uses an OpenZeppelin-style "decimals
/// offset" of 6 — i.e. it behaves as though the pool always has an extra 10**6 virtual shares and 1 virtual
/// asset (see https://docs.openzeppelin.com/contracts/5.x/erc4626#inflation-attack):
///
///   decimals()          = asset decimals + 6
///   convertToShares(a)  = a * (totalSupply + 1e6) / (totalAssets + 1)              (round down)
///   convertToAssets(s)  = s * (totalAssets + 1) / (totalSupply + 1e6)              (round down)
///   previewMint(s)      = ceil(s * (totalAssets + 1) / (totalSupply + 1e6))        (round up)
///   previewWithdraw(a)  = ceil(a * (totalSupply + 1e6) / (totalAssets + 1))        (round up)
///
/// The first depositor's share price therefore starts at roughly 1e-6 assets per share instead of 1:1, so
/// donating assets directly to the vault cannot meaningfully inflate away a later depositor's shares.
///
/// Every state-changing external function takes a reentrancy lock. Token transfers go through low-level
/// `call`s that tolerate a token returning no data, reverting `TransferFailed()` on genuine failure (a
/// revert, or an explicit `false` return). Morpho is approved for exactly the amount supplied on every
/// allocation, never left with a standing approval.
///
/// Caps are a lender-side safety valve bounding how much of the stock can be borrowed out through each
/// market; they are owner-controlled with no timelock in this version.
contract LocateVault {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error NotOwner();
    error ZeroAddress();
    error ZeroAssets();
    error ZeroShares();
    error FeeTooHigh();
    error Reentrancy();
    error TransferFailed();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InsufficientLiquidity();
    error LoanTokenMismatch();
    error MarketNotOnMorpho();
    error UnknownMarket();
    error MarketInUse();
    error CapExceeded();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event MarketSet(Id indexed id, uint256 cap);
    event MarketRemoved(Id indexed id);
    event Reallocated(Id indexed from, Id indexed to, uint256 assets);
    event FeeSet(uint96 bps, address recipient);
    event FeeAccrued(uint256 assets, uint256 shares);

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    uint256 private constant DECIMALS_OFFSET_SHARES = 1e6; // this vault's own virtual shares (10**decimals offset)
    uint256 private constant DECIMALS_OFFSET_ASSETS = 1; // this vault's own virtual assets
    uint256 private constant MORPHO_VIRTUAL_SHARES = 1e6; // Morpho Blue's VIRTUAL_SHARES (SharesMathLib)
    uint256 private constant MORPHO_VIRTUAL_ASSETS = 1; // Morpho Blue's VIRTUAL_ASSETS (SharesMathLib)
    uint256 private constant MAX_FEE_BPS = 5000;

    bytes4 private constant TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant TRANSFER_FROM_SELECTOR = bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 private constant APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant BALANCE_OF_SELECTOR = bytes4(keccak256("balanceOf(address)"));

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------
    IMorpho public immutable morpho;
    address public immutable asset;
    uint8 private immutable ASSET_DECIMALS;

    // ---------------------------------------------------------------------
    // ERC-20 storage
    // ---------------------------------------------------------------------
    string public name;
    string public symbol;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---------------------------------------------------------------------
    // Vault storage
    // ---------------------------------------------------------------------
    address public owner;
    address public feeRecipient;
    uint96 public feeBps;
    uint256 public lastTotalAssets;

    struct MarketConfig {
        uint256 cap;
        bool enabled;
    }

    /// @notice cap in asset units (0 disables new supply into this market); enabled tracks membership.
    mapping(Id => MarketConfig) public marketConfig;
    mapping(Id => MarketParams) private _marketParams;

    /// @dev A single append-order list of every active market id. `supplyQueue()` and `withdrawQueue()`
    /// both expose a copy of it: this version has no reordering function (only `setMarket` appends and
    /// `removeMarket` removes), so the two queues are always identical in content and order and there is
    /// no externally observable difference from maintaining them as two independent arrays.
    Id[] private _queue;

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address morpho_,
        address asset_,
        string memory name_,
        string memory symbol_,
        address owner_,
        address feeRecipient_,
        uint96 performanceFeeBps_
    ) {
        if (morpho_ == address(0) || asset_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (performanceFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        morpho = IMorpho(morpho_);
        asset = asset_;
        ASSET_DECIMALS = IERC20Decimals(asset_).decimals();
        name = name_;
        symbol = symbol_;
        owner = owner_;
        feeRecipient = feeRecipient_;
        feeBps = performanceFeeBps_;
    }

    // ---------------------------------------------------------------------
    // ERC-20
    // ---------------------------------------------------------------------
    function decimals() external view returns (uint8) {
        return ASSET_DECIMALS + 6;
    }

    function transfer(address to, uint256 amount) external nonReentrant returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external nonReentrant returns (bool) {
        _approveShares(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external nonReentrant returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _approveShares(address owner_, address spender, uint256 amount) private {
        allowance[owner_][spender] = amount;
        emit Approval(owner_, spender, amount);
    }

    function _spendAllowance(address owner_, address spender, uint256 amount) private {
        if (spender == owner_) return;
        uint256 allowed = allowance[owner_][spender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[owner_][spender] = allowed - amount;
            }
        }
    }

    function _mint(address to, uint256 amount) private {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) private {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    // ---------------------------------------------------------------------
    // ERC-4626 accounting
    // ---------------------------------------------------------------------

    /// @notice idle + sum of this vault's supply in every configured market, from current stored Morpho
    /// totals (may be a little stale between accruals; every state-changing function accrues first).
    function totalAssets() public view returns (uint256 total) {
        total = idle();
        uint256 n = _queue.length;
        for (uint256 i; i < n; ++i) {
            total += supplied(_queue[i]);
        }
    }

    /// @notice The asset balance held by the vault itself, not supplied to any market.
    function idle() public view returns (uint256) {
        return _staticBalanceOf(asset, address(this));
    }

    /// @notice This vault's supply in market `id`, converted from its Morpho supply shares using Morpho's
    /// own virtual-shares/virtual-assets convention (SharesMathLib: 1e6 virtual shares, 1 virtual asset).
    function supplied(Id id) public view returns (uint256) {
        MarketParams memory mp = _marketParams[id];
        if (mp.loanToken == address(0)) return 0;
        (uint256 supplyShares,,) = morpho.position(id, address(this));
        if (supplyShares == 0) return 0;
        (uint128 totalSupplyAssets_, uint128 totalSupplyShares_,,,,) = morpho.market(id);
        return _toAssetsDownMorpho(supplyShares, totalSupplyAssets_, totalSupplyShares_);
    }

    /// @notice What can actually be withdrawn right now: idle plus, for every market, the smaller of this
    /// vault's supply there and that market's actual spare liquidity (totalSupplyAssets - totalBorrowAssets).
    function liquidity() public view returns (uint256 total) {
        total = idle();
        uint256 n = _queue.length;
        for (uint256 i; i < n; ++i) {
            Id id = _queue[i];
            uint256 sup = supplied(id);
            if (sup == 0) continue;
            (uint128 totalSupplyAssets_,, uint128 totalBorrowAssets_,,,) = morpho.market(id);
            uint256 avail =
                totalSupplyAssets_ > totalBorrowAssets_ ? uint256(totalSupplyAssets_) - uint256(totalBorrowAssets_) : 0;
            total += sup < avail ? sup : avail;
        }
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return _convertToShares(assets, false);
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return _convertToAssets(shares, false);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return _convertToShares(assets, false);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _convertToAssets(shares, true);
    }

    function maxWithdraw(address owner_) external view returns (uint256) {
        uint256 ownerAssets = _convertToAssets(balanceOf[owner_], false);
        uint256 avail = liquidity();
        return ownerAssets < avail ? ownerAssets : avail;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _convertToShares(assets, true);
    }

    function maxRedeem(address owner_) external view returns (uint256) {
        uint256 bal = balanceOf[owner_];
        uint256 availShares = _convertToShares(liquidity(), false);
        return bal < availShares ? bal : availShares;
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return _convertToAssets(shares, false);
    }

    function _convertToShares(uint256 assets, bool roundUp) private view returns (uint256) {
        uint256 supply_ = totalSupply + DECIMALS_OFFSET_SHARES;
        uint256 total_ = totalAssets() + DECIMALS_OFFSET_ASSETS;
        return roundUp ? _mulDivUp(assets, supply_, total_) : (assets * supply_) / total_;
    }

    function _convertToAssets(uint256 shares, bool roundUp) private view returns (uint256) {
        uint256 supply_ = totalSupply + DECIMALS_OFFSET_SHARES;
        uint256 total_ = totalAssets() + DECIMALS_OFFSET_ASSETS;
        return roundUp ? _mulDivUp(shares, total_, supply_) : (shares * total_) / supply_;
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 d) private pure returns (uint256) {
        return (x * y + (d - 1)) / d;
    }

    function _toAssetsDownMorpho(uint256 shares, uint256 totalAssetsM, uint256 totalSharesM)
        private
        pure
        returns (uint256)
    {
        return (shares * (totalAssetsM + MORPHO_VIRTUAL_ASSETS)) / (totalSharesM + MORPHO_VIRTUAL_SHARES);
    }

    // ---------------------------------------------------------------------
    // Deposit / mint
    // ---------------------------------------------------------------------
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAssets();
        if (receiver == address(0)) revert ZeroAddress();
        _accrue();
        shares = _convertToShares(assets, false);
        if (shares == 0) revert ZeroShares();
        _pull(asset, msg.sender, assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _allocate();
        lastTotalAssets = totalAssets();
    }

    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        _accrue();
        assets = previewMint(shares);
        if (assets == 0) revert ZeroAssets();
        _pull(asset, msg.sender, assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _allocate();
        lastTotalAssets = totalAssets();
    }

    /// @dev Sweeps idle assets into markets in `_queue` order up to each market's cap; any remainder (cap
    /// reached, or no markets configured) stays idle.
    function _allocate() private {
        uint256 room = idle();
        uint256 n = _queue.length;
        for (uint256 i; i < n && room > 0; ++i) {
            Id id = _queue[i];
            MarketConfig memory cfg = marketConfig[id];
            uint256 sup = supplied(id);
            if (cfg.cap <= sup) continue;
            uint256 want = cfg.cap - sup;
            uint256 amt = room < want ? room : want;
            if (amt == 0) continue;
            MarketParams memory mp = _marketParams[id];
            _approve(asset, address(morpho), amt);
            morpho.supply(mp, amt, 0, address(this), "");
            room -= amt;
        }
    }

    // ---------------------------------------------------------------------
    // Withdraw / redeem
    // ---------------------------------------------------------------------
    function withdraw(uint256 assets, address receiver, address owner_) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAssets();
        if (receiver == address(0)) revert ZeroAddress();
        _accrue();
        shares = previewWithdraw(assets);
        if (shares == 0) revert ZeroShares();
        _spendAllowance(owner_, msg.sender, shares);
        _burn(owner_, shares);
        _payOut(assets, receiver);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
        lastTotalAssets = totalAssets();
    }

    function redeem(uint256 shares, address receiver, address owner_) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        _accrue();
        assets = _convertToAssets(shares, false);
        if (assets == 0) revert ZeroAssets();
        _spendAllowance(owner_, msg.sender, shares);
        _burn(owner_, shares);
        _payOut(assets, receiver);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
        lastTotalAssets = totalAssets();
    }

    /// @dev Pays `assets` to `receiver`: idle first, then along `_queue` taking min(needed, supplied,
    /// market spare liquidity) from each market, withdrawing by shares when taking the whole position (to
    /// avoid dust). Reverts `InsufficientLiquidity()` if the markets still cannot cover the remainder.
    function _payOut(uint256 assets, address receiver) private {
        uint256 bal = idle();
        uint256 remaining = assets > bal ? assets - bal : 0;
        if (remaining > 0) {
            uint256 n = _queue.length;
            for (uint256 i; i < n && remaining > 0; ++i) {
                Id id = _queue[i];
                uint256 sup = supplied(id);
                if (sup == 0) continue;
                MarketParams memory mp = _marketParams[id];
                (uint128 totalSupplyAssets_,, uint128 totalBorrowAssets_,,,) = morpho.market(id);
                uint256 avail = totalSupplyAssets_ > totalBorrowAssets_
                    ? uint256(totalSupplyAssets_) - uint256(totalBorrowAssets_)
                    : 0;
                uint256 take = remaining < sup ? remaining : sup;
                if (take > avail) take = avail;
                if (take == 0) continue;
                uint256 got;
                if (take == sup) {
                    (uint256 supplyShares,,) = morpho.position(id, address(this));
                    (got,) = morpho.withdraw(mp, 0, supplyShares, address(this), address(this));
                } else {
                    (got,) = morpho.withdraw(mp, take, 0, address(this), address(this));
                }
                remaining -= got;
            }
            if (remaining > 0) revert InsufficientLiquidity();
        }
        _push(asset, receiver, assets);
    }

    // ---------------------------------------------------------------------
    // Market management
    // ---------------------------------------------------------------------
    function setMarket(MarketParams calldata mp, uint256 cap) external nonReentrant onlyOwner {
        if (mp.loanToken != asset) revert LoanTokenMismatch();
        Id id = _id(mp);
        (,,,, uint128 lastUpdate,) = morpho.market(id);
        if (lastUpdate == 0) revert MarketNotOnMorpho();
        if (!marketConfig[id].enabled) {
            _marketParams[id] = mp;
            _queue.push(id);
        }
        marketConfig[id] = MarketConfig({cap: cap, enabled: true});
        emit MarketSet(id, cap);
    }

    function removeMarket(Id id) external nonReentrant onlyOwner {
        if (!marketConfig[id].enabled) revert UnknownMarket();
        if (supplied(id) != 0) revert MarketInUse();
        uint256 n = _queue.length;
        for (uint256 i; i < n; ++i) {
            if (Id.unwrap(_queue[i]) == Id.unwrap(id)) {
                for (uint256 j = i; j + 1 < n; ++j) {
                    _queue[j] = _queue[j + 1];
                }
                _queue.pop();
                break;
            }
        }
        delete marketConfig[id];
        delete _marketParams[id];
        emit MarketRemoved(id);
    }

    function reallocate(Id from, Id to, uint256 assets) external nonReentrant onlyOwner {
        if (!marketConfig[from].enabled) revert UnknownMarket();
        if (!marketConfig[to].enabled) revert UnknownMarket();
        _accrue();
        uint256 supTo = supplied(to);
        if (supTo + assets > marketConfig[to].cap) revert CapExceeded();
        MarketParams memory mpFrom = _marketParams[from];
        MarketParams memory mpTo = _marketParams[to];
        morpho.withdraw(mpFrom, assets, 0, address(this), address(this));
        _approve(asset, address(morpho), assets);
        morpho.supply(mpTo, assets, 0, address(this), "");
        lastTotalAssets = totalAssets();
        emit Reallocated(from, to, assets);
    }

    function supplyQueue() external view returns (Id[] memory) {
        return _queue;
    }

    function withdrawQueue() external view returns (Id[] memory) {
        return _queue;
    }

    // ---------------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------------
    function setFee(uint96 bps, address recipient) external nonReentrant onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        _accrue();
        feeBps = bps;
        feeRecipient = recipient;
        emit FeeSet(bps, recipient);
    }

    /// @notice Accrues interest on every configured market and mints the vault's performance-fee shares.
    /// Callable by anyone (permissionless, like MetaMorpho's own `accrueInterest`).
    function accrue() external nonReentrant {
        _accrue();
    }

    function _accrue() private {
        uint256 n = _queue.length;
        for (uint256 i; i < n; ++i) {
            morpho.accrueInterest(_marketParams[_queue[i]]);
        }
        uint256 newTotal = totalAssets();
        uint256 last = lastTotalAssets;
        if (newTotal > last) {
            uint256 yield_ = newTotal - last;
            uint256 feeAssets = (yield_ * feeBps) / 10000;
            if (feeAssets > 0 && feeRecipient != address(0)) {
                uint256 feeShares = (feeAssets * (totalSupply + DECIMALS_OFFSET_SHARES))
                    / (newTotal - feeAssets + DECIMALS_OFFSET_ASSETS);
                _mint(feeRecipient, feeShares);
                emit FeeAccrued(feeAssets, feeShares);
            }
        }
        lastTotalAssets = newTotal;
    }

    function transferOwnership(address newOwner) external nonReentrant onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Low-level token helpers: tolerate a token returning no data; revert TransferFailed() on genuine
    // failure (a revert, or an explicit `false` return).
    // ---------------------------------------------------------------------
    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(TRANSFER_FROM_SELECTOR, from, address(this), amount));
        if (!_success(ok, ret)) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(TRANSFER_SELECTOR, to, amount));
        if (!_success(ok, ret)) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(APPROVE_SELECTOR, spender, amount));
        if (!_success(ok, ret)) revert TransferFailed();
    }

    function _success(bool ok, bytes memory ret) private pure returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length >= 32) return abi.decode(ret, (bool));
        return false;
    }

    function _staticBalanceOf(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(BALANCE_OF_SELECTOR, who));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev keccak256 of the struct's 160-byte memory layout, matching Morpho Blue's MarketParamsLib.id()
    /// bit-for-bit (same field order and types), so ids computed here match the real deployment.
    function _id(MarketParams memory mp) private pure returns (Id id) {
        assembly ("memory-safe") {
            id := keccak256(mp, 160)
        }
    }
}
