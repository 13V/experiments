// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IBurnable} from "./interfaces/IERC20.sol";
import {ILocateVault} from "./interfaces/ILocateVault.sol";
import {IOracle} from "./interfaces/IOracle.sol";
import {IBuyer, ISeller} from "./interfaces/IAdapters.sol";
import {IPonsV2FeeEscrow} from "./interfaces/IPons.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title Manna
/// @notice The fee recipient of the MANNA coin and of every Storehouse (a LocateVault lending a Giant to the
/// shorts). Six mornings a week, from 12:00 UTC, anyone calls `dawn()`:
///
///   1. the coin's escrowed Pons fees are claimed (USDG);
///   2. each Storehouse's tithe (the 10% performance fee, minted to this contract as vault shares) is redeemed
///      and the Giant sold for USDG through the seller adapter, bounded by the Prophet's price;
///   3. the USDG is split: treasury, Joseph's Reserve (until it holds its target share of the Storehouses'
///      value), the charity slice held for Jubilee, and the rest buys MANNA through the buyer adapter;
///   4. the bought MANNA falls: a tip to the caller, a share to stakers (the staking pool simply grows, so
///      staked wallets gather automatically), and a share to Storehouse lenders weighted by how much of each
///      Giant is actually borrowed, pro rata by staked shares within a Storehouse.
///
/// Lenders gather their Manna with `gather`; what is not gathered within SPOIL_DAYS spoils and is burned at
/// the next settlement. A lender may switch on `autoStake` so gathering stakes for them instead. On Sundays
/// nothing falls and no dial turns. Every seventh Sunday `jubilee()` sends the charity slice.
contract Manna {
    // ---------------------------------------------------------------------------------------------------
    // Errors and events
    // ---------------------------------------------------------------------------------------------------

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error Reentrancy();
    error TransferFailed();
    error Sabbath();
    error NotYetDawn();
    error AlreadyFell();
    error TokenNotSet();
    error TokenAlreadySet();
    error UnknownStorehouse();
    error StorehouseExists();
    error StorehouseInactive();
    error NotFeeRecipient();
    error BadDial();
    error InsufficientShares();
    error InsufficientStake();
    error NothingToRestore();
    error NotJubileeYet();
    error NoCharity();
    error NoSeller();
    error RestoreCooldown();
    error AccumulatorOverflow();

    event Dawn(
        uint256 indexed day,
        address indexed caller,
        uint256 income,
        uint256 toTreasury,
        uint256 toReserve,
        uint256 toCharity,
        uint256 spent
    );
    event Fallen(uint256 indexed day, uint256 bought, uint256 tip, uint256 toStakers, uint256 toLenders);
    event Fell(uint256 indexed day, address indexed vault, uint256 amount, uint256 accPerShare);
    event TitheSold(address indexed vault, uint256 shares, uint256 assets, uint256 usdgOut);
    event TitheSaleFailed(address indexed vault, uint256 assets);
    event EscrowClaimed(uint256 amount);
    event BuyFailed(uint256 amount);
    event Entered(address indexed vault, address indexed user, uint256 assets, uint256 shares);
    event Left(address indexed vault, address indexed user, uint256 shares, uint256 assets);
    event Gathered(address indexed vault, address indexed user, uint256 fresh, uint256 spoiled, bool staked);
    event Staked(address indexed user, uint256 amount, uint256 shares);
    event Unstaked(address indexed user, uint256 shares, uint256 amount);
    event Burned(uint256 amount);
    event Restored(address indexed vault, uint256 usdgSpent, uint256 assetsDonated);
    event Jubilee(
        uint256 indexed day,
        address indexed charity,
        uint256 amount,
        uint256 fallen,
        uint256 gathered,
        uint256 spoiled,
        uint256 nextJubileeDay
    );
    event StorehouseAdded(address indexed vault, address indexed asset, address indexed oracle);
    event StorehouseActiveSet(address indexed vault, bool active);
    event StorehouseOracleSet(address indexed vault, address indexed oracle);
    event TokenSet(address indexed token, uint256 nextJubileeDay);
    event DialSet(Dial dial, uint256 maxBuy);
    event AddressesSet(address treasury, address charity, address buyer, address seller, address escrow);
    event ReserveReleased(uint256 amount);
    event AutoStakeSet(address indexed user, bool on);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------------------------------------------
    // Constants and types
    // ---------------------------------------------------------------------------------------------------

    uint256 public constant DAY = 86400;
    /// @notice Seconds after 00:00 UTC from which a day's dawn may be called: 12:00 UTC.
    uint256 public constant DAWN_SECONDS = 43200;
    uint256 public constant SPOIL_DAYS = 7;
    uint256 public constant JUBILEE_DAYS = 49;
    uint256 public constant BPS = 10000;
    uint256 private constant ACC = 1e18;
    uint256 private constant ORACLE_SCALE = 1e36;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The dials Sunday Service may turn (on any day but Sunday).
    struct Dial {
        uint16 treasuryBps; // of each dawn's income
        uint16 reserveBps; // of income, while the Reserve is below target
        uint16 charityBps; // of income, held until Jubilee
        uint16 reserveTargetBps; // Reserve target as a share of the Storehouses' value
        uint16 stakersBps; // of the fallen Manna (after the tip); the rest goes to lenders
        uint16 callerBps; // of the fallen Manna, to whoever called dawn
        uint16 buySlippageBps; // tolerated shortfall against the buyer's quote
        uint16 sellSlippageBps; // tolerated shortfall against the Prophet when selling a tithe
    }

    struct Checkpoint {
        uint64 day;
        uint192 acc;
    }

    struct Storehouse {
        ILocateVault vault;
        address asset;
        IOracle oracle;
        bool active;
        uint256 totalStaked; // vault shares staked by lenders through this contract
        uint256 accPerShare; // Manna per staked share, scaled by ACC, cumulative
        uint256 highWater; // highest vault share price seen, for Joseph's Reserve
        uint256 lastRestoreDay; // restore() runs at most once a day per Storehouse
        Checkpoint[] checkpoints; // accPerShare after each dawn that fed this Storehouse
    }

    struct Lender {
        uint256 shares;
        uint256 accAt; // accPerShare at the last settlement
        uint64 lastGatherDay;
    }

    // ---------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------

    address public owner;
    address public pendingOwner;

    address public immutable usdg;
    address public token;
    address public treasury;
    address public charity;
    IBuyer public buyer;
    ISeller public seller;
    IPonsV2FeeEscrow public escrow;

    Dial public dial;
    /// @notice The most USDG one dawn may spend on the buy; the remainder carries to the next.
    uint256 public maxBuy;

    Storehouse[] private _storehouses;
    mapping(address vault => uint256 indexPlusOne) private _indexOf;
    mapping(uint256 index => mapping(address user => Lender)) private _lenders;
    mapping(address user => bool) public autoStake;

    mapping(address user => uint256) public stakeShares;
    uint256 public totalStakeShares;
    /// @notice MANNA held for stakers; grows with every dawn, so a stake share is worth more over time.
    uint256 public stakedPool;
    /// @notice MANNA allotted to lenders and not yet gathered (or spoiled).
    uint256 public lenderPool;

    uint256 public lastDawnDay;
    /// @notice Joseph's Reserve, in USDG, held here.
    uint256 public reserve;
    /// @notice The charity slice accrued since the last Jubilee, in USDG, held here.
    uint256 public charityAccrued;
    /// @notice USDG earmarked for buying that the last dawn could not spend (cap, or a failed buy).
    uint256 public carry;
    uint256 public nextJubileeDay;
    uint256 public periodFallen;
    uint256 public periodGathered;
    uint256 public periodSpoiled;
    uint256 public totalFallen;
    uint256 public totalBurned;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------------------------------------------
    // Modifiers, construction, ownership
    // ---------------------------------------------------------------------------------------------------

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

    /// @dev No dial turns on a Sunday.
    modifier notSunday() {
        if (isSunday(today())) revert Sabbath();
        _;
    }

    constructor(address usdg_, address owner_, address treasury_) {
        if (usdg_ == address(0) || owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        owner = owner_;
        treasury = treasury_;
        dial = Dial({
            treasuryBps: 2000,
            reserveBps: 1000,
            charityBps: 500,
            reserveTargetBps: 1000,
            stakersBps: 7000,
            callerBps: 50,
            buySlippageBps: 500,
            sellSlippageBps: 300
        });
        maxBuy = 5_000e6;
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------------------------------------------
    // Calendar
    // ---------------------------------------------------------------------------------------------------

    function today() public view returns (uint256) {
        return block.timestamp / DAY;
    }

    /// @notice Day 0 (1 January 1970) was a Thursday, so a day index is a Sunday when (day + 4) % 7 == 0.
    function isSunday(uint256 day) public pure returns (bool) {
        return (day + 4) % 7 == 0;
    }

    /// @notice True when `dawn()` would run right now.
    function dawnOpen() public view returns (bool) {
        uint256 d = today();
        return token != address(0) && d > lastDawnDay && !isSunday(d) && block.timestamp % DAY >= DAWN_SECONDS;
    }

    /// @notice The earliest timestamp at which the next dawn may be called.
    function nextDawn() external view returns (uint256) {
        uint256 d = today();
        if (d <= lastDawnDay) {
            d = lastDawnDay + 1;
        } else if (block.timestamp % DAY >= DAWN_SECONDS) {
            if (!isSunday(d)) return block.timestamp;
            d += 1;
        }
        while (isSunday(d)) d += 1;
        return d * DAY + DAWN_SECONDS;
    }

    // ---------------------------------------------------------------------------------------------------
    // Owner configuration
    // ---------------------------------------------------------------------------------------------------

    /// @notice Names the coin, once. Starts the Jubilee clock: the first Jubilee is the first Sunday at least
    /// JUBILEE_DAYS from today.
    function setToken(address token_) external onlyOwner {
        if (token_ == address(0)) revert ZeroAddress();
        if (token != address(0)) revert TokenAlreadySet();
        token = token_;
        uint256 d = today() + JUBILEE_DAYS;
        while (!isSunday(d)) d += 1;
        nextJubileeDay = d;
        emit TokenSet(token_, d);
    }

    function setAddresses(address treasury_, address charity_, address buyer_, address seller_, address escrow_)
        external
        onlyOwner
        notSunday
    {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        charity = charity_;
        buyer = IBuyer(buyer_);
        seller = ISeller(seller_);
        escrow = IPonsV2FeeEscrow(escrow_);
        emit AddressesSet(treasury_, charity_, buyer_, seller_, escrow_);
    }

    function setDial(Dial calldata d, uint256 maxBuy_) external onlyOwner notSunday {
        if (uint256(d.treasuryBps) + d.reserveBps + d.charityBps > BPS) revert BadDial();
        if (d.stakersBps > BPS || d.callerBps > 1000 || d.buySlippageBps > BPS || d.sellSlippageBps > BPS) {
            revert BadDial();
        }
        if (d.reserveTargetBps > BPS) revert BadDial();
        dial = d;
        maxBuy = maxBuy_;
        emit DialSet(d, maxBuy_);
    }

    /// @notice Registers a Storehouse. The vault must already name this contract as its fee recipient.
    function addStorehouse(address vault, address oracle) external onlyOwner notSunday {
        if (vault == address(0) || oracle == address(0)) revert ZeroAddress();
        if (_indexOf[vault] != 0) revert StorehouseExists();
        if (ILocateVault(vault).feeRecipient() != address(this)) revert NotFeeRecipient();
        address asset = ILocateVault(vault).asset();
        if (asset == address(0)) revert ZeroAddress();
        _storehouses.push();
        Storehouse storage s = _storehouses[_storehouses.length - 1];
        s.vault = ILocateVault(vault);
        s.asset = asset;
        s.oracle = IOracle(oracle);
        s.active = true;
        s.highWater = _sharePrice(ILocateVault(vault));
        _indexOf[vault] = _storehouses.length;
        emit StorehouseAdded(vault, asset, oracle);
    }

    /// @notice Replaces the Prophet a Storehouse is valued by (weights, the Reserve target, sale bounds). The
    /// Morpho market's own oracle is immutable; this only changes how Manna reads the Giant's price.
    function setStorehouseOracle(address vault, address oracle) external onlyOwner notSunday {
        if (oracle == address(0)) revert ZeroAddress();
        _storehouses[_index(vault)].oracle = IOracle(oracle);
        emit StorehouseOracleSet(vault, oracle);
    }

    /// @notice An inactive Storehouse takes no new lenders and receives no Manna; lenders can still leave.
    function setStorehouseActive(address vault, bool active) external onlyOwner notSunday {
        _storehouses[_index(vault)].active = active;
        emit StorehouseActiveSet(vault, active);
    }

    /// @notice Lets `amount` of the Reserve become ordinary income at the next dawn.
    function releaseReserve(uint256 amount) external onlyOwner notSunday {
        if (amount > reserve) amount = reserve;
        reserve -= amount;
        emit ReserveReleased(amount);
    }

    // ---------------------------------------------------------------------------------------------------
    // Dawn
    // ---------------------------------------------------------------------------------------------------

    struct DawnVars {
        uint256 day;
        uint256 income;
        uint256 toTreasury;
        uint256 toReserve;
        uint256 toCharity;
        uint256 budget;
        uint256 spend;
        uint256 spent;
        uint256 bought;
        uint256 tip;
        uint256 toStakers;
        uint256 toLenders;
    }

    /// @notice Manna falls. Callable by anyone from 12:00 UTC, once a day, never on Sunday.
    function dawn() external nonReentrant {
        if (token == address(0)) revert TokenNotSet();
        DawnVars memory v;
        v.day = today();
        if (isSunday(v.day)) revert Sabbath();
        if (v.day <= lastDawnDay) revert AlreadyFell();
        if (block.timestamp % DAY < DAWN_SECONDS) revert NotYetDawn();
        lastDawnDay = v.day;

        // 1. The coin's own fees.
        if (address(escrow) != address(0)) {
            try escrow.claimToken(usdg) returns (uint256 claimed) {
                emit EscrowClaimed(claimed);
            } catch {}
        }

        // 2. The tithe.
        uint256 n = _storehouses.length;
        for (uint256 i; i < n; ++i) {
            _harvest(i);
        }

        // 3. The split.
        uint256 bal = _balance(usdg, address(this));
        uint256 held = reserve + charityAccrued + carry;
        v.income = bal > held ? bal - held : 0;
        Dial memory d = dial;
        v.toTreasury = (v.income * d.treasuryBps) / BPS;
        v.toReserve = (v.income * d.reserveBps) / BPS;
        uint256 target = reserveTarget();
        if (reserve + v.toReserve > target) v.toReserve = target > reserve ? target - reserve : 0;
        v.toCharity = (v.income * d.charityBps) / BPS;
        v.budget = v.income - v.toTreasury - v.toReserve - v.toCharity + carry;
        if (v.toTreasury > 0) _push(usdg, treasury, v.toTreasury);
        reserve += v.toReserve;
        charityAccrued += v.toCharity;

        // 4. The buy, capped by the dial and by the venue's depth (see IBuyer.maxSpend).
        v.spend = v.budget > maxBuy ? maxBuy : v.budget;
        if (v.spend > 0 && address(buyer) != address(0)) {
            uint256 cap = 0;
            try buyer.maxSpend() returns (uint256 m) {
                cap = m;
            } catch {}
            if (cap < v.spend) v.spend = cap;
            if (v.spend > 0) (v.spent, v.bought) = _buy(v.spend, d.buySlippageBps);
            else emit BuyFailed(0);
        }
        carry = v.budget - v.spent;

        // 5. The fall.
        if (v.bought > 0) {
            v.tip = (v.bought * d.callerBps) / BPS;
            if (v.tip > 0) _push(token, msg.sender, v.tip);
            uint256 rest = v.bought - v.tip;
            v.toStakers = (rest * d.stakersBps) / BPS;
            v.toLenders = rest - v.toStakers;
            (uint256[] memory w, uint256 total) = _weights();
            if (v.toLenders > 0) {
                uint256 left = total > 0 ? _allot(v.day, v.toLenders, w, total) : v.toLenders;
                v.toStakers += left;
                v.toLenders -= left;
            }
            if (v.toStakers > 0) {
                if (totalStakeShares > 0) {
                    stakedPool += v.toStakers;
                } else {
                    // Nobody staked: the stakers' share falls on the lenders, and what no one can gather burns.
                    uint256 left = total > 0 ? _allot(v.day, v.toStakers, w, total) : v.toStakers;
                    v.toLenders += v.toStakers - left;
                    v.toStakers = 0;
                    if (left > 0) _burn(left);
                }
            }
            periodFallen += v.bought;
            totalFallen += v.bought;
        }

        _emitDawn(v);
    }

    function _emitDawn(DawnVars memory v) private {
        emit Dawn(v.day, msg.sender, v.income, v.toTreasury, v.toReserve, v.toCharity, v.spent);
        emit Fallen(v.day, v.bought, v.tip, v.toStakers, v.toLenders);
    }

    /// @dev Redeems this contract's fee shares from Storehouse `i` and sells the Giant for USDG.
    function _harvest(uint256 i) private {
        Storehouse storage s = _storehouses[i];
        if (!s.active) return;
        ILocateVault vault = s.vault;
        try vault.accrue() {} catch {}

        uint256 bal = vault.balanceOf(address(this));
        uint256 fee = bal > s.totalStaked ? bal - s.totalStaked : 0;
        if (fee > 0) {
            uint256 can = vault.maxRedeem(address(this));
            if (can < fee) fee = can;
            if (fee > 0) {
                try vault.redeem(fee, address(this), address(this)) returns (uint256) {} catch {}
            }
        }

        uint256 have = _balance(s.asset, address(this));
        if (have > 0 && address(seller) != address(0)) {
            uint256 minOut = _usdgFor(s.oracle, have, dial.sellSlippageBps);
            if (minOut > 0) {
                _approve(s.asset, address(seller), have);
                try seller.sell(s.asset, have, minOut, address(this)) returns (uint256 got) {
                    emit TitheSold(address(vault), fee, have, got);
                } catch {
                    emit TitheSaleFailed(address(vault), have);
                }
                _approve(s.asset, address(seller), 0);
            }
        }

        uint256 sp = _sharePrice(vault);
        if (sp > s.highWater) s.highWater = sp;
    }

    /// @dev Buys MANNA with `amount` USDG through the buyer adapter, bounded by its own quote.
    function _buy(uint256 amount, uint256 slippageBps) private returns (uint256 spent, uint256 bought) {
        uint256 quote;
        try buyer.quoteBuy(amount) returns (uint256 q) {
            quote = q;
        } catch {}
        if (quote == 0) {
            emit BuyFailed(amount);
            return (0, 0);
        }
        uint256 minOut = (quote * (BPS - slippageBps)) / BPS;
        uint256 usdgBefore = _balance(usdg, address(this));
        uint256 tokenBefore = _balance(token, address(this));
        _approve(usdg, address(buyer), amount);
        try buyer.buy(amount, minOut, address(this)) returns (uint256) {
            uint256 usdgAfter = _balance(usdg, address(this));
            spent = usdgBefore > usdgAfter ? usdgBefore - usdgAfter : 0;
            bought = _balance(token, address(this)) - tokenBefore;
        } catch {
            emit BuyFailed(amount);
        }
        _approve(usdg, address(buyer), 0);
    }

    /// @dev Each active Storehouse's borrowed value in USDG, from its vault and its Prophet.
    function _weights() private view returns (uint256[] memory w, uint256 total) {
        uint256 n = _storehouses.length;
        w = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            Storehouse storage s = _storehouses[i];
            if (!s.active || s.totalStaked == 0) continue;
            uint256 usd = borrowedUsd(i);
            w[i] = usd;
            total += usd;
        }
    }

    /// @dev Splits `amount` across the Storehouses by weight; returns what could not be placed.
    function _allot(uint256 day, uint256 amount, uint256[] memory w, uint256 total) private returns (uint256 left) {
        left = amount;
        uint256 n = w.length;
        for (uint256 i; i < n; ++i) {
            if (w[i] == 0) continue;
            uint256 portion = FullMath.mulDiv(amount, w[i], total);
            if (portion == 0) continue;
            Storehouse storage s = _storehouses[i];
            s.accPerShare += FullMath.mulDiv(portion, ACC, s.totalStaked);
            if (s.accPerShare > type(uint192).max) revert AccumulatorOverflow();
            s.checkpoints.push(Checkpoint(uint64(day), uint192(s.accPerShare)));
            lenderPool += portion;
            left -= portion;
            emit Fell(day, address(s.vault), portion, s.accPerShare);
        }
    }

    // ---------------------------------------------------------------------------------------------------
    // Lenders
    // ---------------------------------------------------------------------------------------------------

    /// @notice Deposits `assets` of the Storehouse's Giant into its vault and stakes the shares here, in one
    /// transaction. Settles any Manna owed first.
    function enter(address vault, uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 i = _index(vault);
        Storehouse storage s = _storehouses[i];
        if (!s.active) revert StorehouseInactive();
        _settle(i, msg.sender);
        _pull(s.asset, msg.sender, assets);
        _approve(s.asset, vault, assets);
        shares = s.vault.deposit(assets, address(this));
        _lenders[i][msg.sender].shares += shares;
        s.totalStaked += shares;
        emit Entered(vault, msg.sender, assets, shares);
    }

    /// @notice Unstakes `shares` and redeems them from the vault to the caller. Reverts when the vault has
    /// no liquidity for it (everything is lent out); try a smaller amount or wait for repayments.
    function leave(address vault, uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        uint256 i = _index(vault);
        Storehouse storage s = _storehouses[i];
        _settle(i, msg.sender);
        Lender storage l = _lenders[i][msg.sender];
        if (l.shares < shares) revert InsufficientShares();
        l.shares -= shares;
        s.totalStaked -= shares;
        assets = s.vault.redeem(shares, msg.sender, address(this));
        emit Left(vault, msg.sender, shares, assets);
    }

    /// @notice Gathers the caller's Manna from one Storehouse.
    function gather(address vault) external nonReentrant returns (uint256 fresh, uint256 spoiled) {
        return _settle(_index(vault), msg.sender);
    }

    /// @notice Gathers from every Storehouse.
    function gatherAll() external nonReentrant returns (uint256 fresh, uint256 spoiled) {
        uint256 n = _storehouses.length;
        for (uint256 i; i < n; ++i) {
            (uint256 f, uint256 sp) = _settle(i, msg.sender);
            fresh += f;
            spoiled += sp;
        }
    }

    function setAutoStake(bool on) external {
        autoStake[msg.sender] = on;
        emit AutoStakeSet(msg.sender, on);
    }

    /// @dev Pays the lender what fell on their shares since the last settlement, burning the part that fell
    /// more than SPOIL_DAYS ago, and moves their marker to now.
    function _settle(uint256 i, address user) private returns (uint256 fresh, uint256 spoiled) {
        Storehouse storage s = _storehouses[i];
        Lender storage l = _lenders[i][user];
        uint256 acc = s.accPerShare;
        uint256 d = today();
        if (l.shares > 0 && acc > l.accAt) {
            uint256 earned = FullMath.mulDiv(l.shares, acc - l.accAt, ACC);
            uint256 cutoffAcc = l.accAt;
            if (d >= uint256(l.lastGatherDay) + SPOIL_DAYS) {
                uint256 a = _accAtDay(s, d - SPOIL_DAYS);
                if (a > cutoffAcc) cutoffAcc = a;
            }
            spoiled = FullMath.mulDiv(l.shares, cutoffAcc - l.accAt, ACC);
            fresh = earned - spoiled;
            lenderPool -= earned;
            if (spoiled > 0) {
                periodSpoiled += spoiled;
                _burn(spoiled);
            }
            if (fresh > 0) {
                periodGathered += fresh;
                if (autoStake[user]) _stakeFor(user, fresh);
                else _push(token, user, fresh);
            }
            emit Gathered(address(s.vault), user, fresh, spoiled, autoStake[user]);
        }
        l.accAt = acc;
        l.lastGatherDay = uint64(d);
    }

    /// @dev accPerShare after the last dawn on or before `day` (binary search over the checkpoints).
    function _accAtDay(Storehouse storage s, uint256 day) private view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = s.checkpoints.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (s.checkpoints[mid].day <= day) lo = mid + 1;
            else hi = mid;
        }
        return lo == 0 ? 0 : s.checkpoints[lo - 1].acc;
    }

    // ---------------------------------------------------------------------------------------------------
    // Stakers
    // ---------------------------------------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) revert TokenNotSet();
        _pull(token, msg.sender, amount);
        shares = _stakeFor(msg.sender, amount);
    }

    function unstake(uint256 shares) external nonReentrant returns (uint256 amount) {
        if (shares == 0) revert ZeroAmount();
        if (stakeShares[msg.sender] < shares) revert InsufficientStake();
        amount = FullMath.mulDiv(shares, stakedPool, totalStakeShares);
        stakeShares[msg.sender] -= shares;
        totalStakeShares -= shares;
        stakedPool -= amount;
        _push(token, msg.sender, amount);
        emit Unstaked(msg.sender, shares, amount);
    }

    /// @notice MANNA that `user`'s stake is worth right now.
    function stakedOf(address user) external view returns (uint256) {
        if (totalStakeShares == 0) return 0;
        return FullMath.mulDiv(stakeShares[user], stakedPool, totalStakeShares);
    }

    /// @notice MANNA sent here outside the dawn (a donation) goes to the stakers.
    function skim() external nonReentrant {
        if (token == address(0)) revert TokenNotSet();
        uint256 bal = _balance(token, address(this));
        uint256 accounted = stakedPool + lenderPool;
        if (bal > accounted && totalStakeShares > 0) stakedPool += bal - accounted;
    }

    function _stakeFor(address user, uint256 amount) private returns (uint256 shares) {
        shares = (totalStakeShares == 0 || stakedPool == 0) ? amount : FullMath.mulDiv(amount, totalStakeShares, stakedPool);
        stakeShares[user] += shares;
        totalStakeShares += shares;
        stakedPool += amount;
        emit Staked(user, amount, shares);
    }

    // ---------------------------------------------------------------------------------------------------
    // Joseph's Reserve and Jubilee
    // ---------------------------------------------------------------------------------------------------

    /// @notice If a Storehouse's share price sits below its high-water mark (bad debt in its market), buys the
    /// Giant with the Reserve and gives it to the vault, making the lenders whole up to the Storehouse's share
    /// of the Reserve (its share of the Storehouses' value), once a day, so one market cannot drain the
    /// backstop the others funded in a single call.
    function restore(address vault) external nonReentrant returns (uint256 usdgSpent, uint256 donated) {
        uint256 i = _index(vault);
        Storehouse storage s = _storehouses[i];
        if (address(seller) == address(0)) revert NoSeller();
        uint256 d = today();
        if (s.lastRestoreDay >= d) revert RestoreCooldown();
        uint256 sp = _sharePrice(s.vault);
        if (sp >= s.highWater || reserve == 0) revert NothingToRestore();
        uint256 unit = 10 ** s.vault.decimals();
        uint256 deficit = FullMath.mulDiv(s.highWater - sp, s.vault.totalSupply(), unit);
        uint256 p = s.oracle.price();
        uint256 needed = FullMath.mulDiv(deficit, ORACLE_SCALE, p);
        usdgSpent = restoreCap(i);
        if (needed < usdgSpent) usdgSpent = needed;
        if (usdgSpent == 0) revert NothingToRestore();
        s.lastRestoreDay = d;
        reserve -= usdgSpent;
        uint256 expected = FullMath.mulDiv(usdgSpent, p, ORACLE_SCALE);
        uint256 minOut = (expected * (BPS - dial.sellSlippageBps)) / BPS;
        _approve(usdg, address(seller), usdgSpent);
        donated = seller.buyToken(s.asset, usdgSpent, minOut, address(this));
        _approve(usdg, address(seller), 0);
        uint256 have = _balance(s.asset, address(this));
        if (have < donated) donated = have;
        _push(s.asset, vault, donated);
        emit Restored(vault, usdgSpent, donated);
    }

    /// @notice Every seventh Sunday: sends the charity slice and publishes the period.
    function jubilee() external nonReentrant {
        if (token == address(0)) revert TokenNotSet();
        uint256 d = today();
        if (d < nextJubileeDay) revert NotJubileeYet();
        if (charity == address(0)) revert NoCharity();
        uint256 amount = charityAccrued;
        charityAccrued = 0;
        if (amount > 0) _push(usdg, charity, amount);
        uint256 next = nextJubileeDay + JUBILEE_DAYS;
        while (next <= d) next += JUBILEE_DAYS;
        emit Jubilee(d, charity, amount, periodFallen, periodGathered, periodSpoiled, next);
        nextJubileeDay = next;
        periodFallen = 0;
        periodGathered = 0;
        periodSpoiled = 0;
    }

    // ---------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------

    function storehouseCount() external view returns (uint256) {
        return _storehouses.length;
    }

    function storehouseAt(uint256 i)
        external
        view
        returns (
            address vault,
            address asset,
            address oracle,
            bool active,
            uint256 totalStaked,
            uint256 accPerShare,
            uint256 highWater,
            uint256 checkpoints
        )
    {
        Storehouse storage s = _storehouses[i];
        return (
            address(s.vault),
            s.asset,
            address(s.oracle),
            s.active,
            s.totalStaked,
            s.accPerShare,
            s.highWater,
            s.checkpoints.length
        );
    }

    function storehouseIndex(address vault) external view returns (uint256) {
        return _index(vault);
    }

    /// @notice This contract's unredeemed fee shares in a Storehouse's vault: the tithe waiting for dawn.
    function feeShares(address vault) external view returns (uint256) {
        Storehouse storage s = _storehouses[_index(vault)];
        uint256 bal = s.vault.balanceOf(address(this));
        return bal > s.totalStaked ? bal - s.totalStaked : 0;
    }

    /// @notice A lender's staked shares and what a `gather` right now would pay and burn.
    function lenderOf(address vault, address user)
        external
        view
        returns (uint256 shares, uint256 fresh, uint256 spoiled, uint256 lastGatherDay)
    {
        uint256 i = _index(vault);
        Storehouse storage s = _storehouses[i];
        Lender storage l = _lenders[i][user];
        shares = l.shares;
        lastGatherDay = l.lastGatherDay;
        uint256 acc = s.accPerShare;
        if (l.shares > 0 && acc > l.accAt) {
            uint256 earned = FullMath.mulDiv(l.shares, acc - l.accAt, ACC);
            uint256 cutoffAcc = l.accAt;
            uint256 d = today();
            if (d >= uint256(l.lastGatherDay) + SPOIL_DAYS) {
                uint256 a = _accAtDay(s, d - SPOIL_DAYS);
                if (a > cutoffAcc) cutoffAcc = a;
            }
            spoiled = FullMath.mulDiv(l.shares, cutoffAcc - l.accAt, ACC);
            fresh = earned - spoiled;
        }
    }

    /// @notice The USDG value of everything the Storehouses hold, by their Prophets.
    function storehouseValueUsd() public view returns (uint256 total) {
        uint256 n = _storehouses.length;
        for (uint256 i; i < n; ++i) {
            Storehouse storage s = _storehouses[i];
            if (!s.active) continue;
            total += _usdgFor(s.oracle, s.vault.totalAssets(), 0);
        }
    }

    /// @notice The USDG value of what is borrowed out of Storehouse `i` right now.
    function borrowedUsd(uint256 i) public view returns (uint256) {
        Storehouse storage s = _storehouses[i];
        uint256 assets = s.vault.totalAssets();
        uint256 liq = s.vault.liquidity();
        uint256 borrowed = assets > liq ? assets - liq : 0;
        return _usdgFor(s.oracle, borrowed, 0);
    }

    function reserveTarget() public view returns (uint256) {
        return (storehouseValueUsd() * dial.reserveTargetBps) / BPS;
    }

    /// @notice The most one restore() may spend on Storehouse `i` today: the Reserve times the Storehouse's
    /// share of the Storehouses' value (all of it when nothing can be valued).
    function restoreCap(uint256 i) public view returns (uint256) {
        uint256 total = storehouseValueUsd();
        if (total == 0) return reserve;
        Storehouse storage s = _storehouses[i];
        uint256 mine = _usdgFor(s.oracle, s.vault.totalAssets(), 0);
        return FullMath.mulDiv(reserve, mine, total);
    }

    // ---------------------------------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------------------------------

    function _index(address vault) private view returns (uint256) {
        uint256 ip1 = _indexOf[vault];
        if (ip1 == 0) revert UnknownStorehouse();
        return ip1 - 1;
    }

    function _sharePrice(ILocateVault vault) private view returns (uint256) {
        return vault.convertToAssets(10 ** vault.decimals());
    }

    /// @dev `assets` of a Giant in raw USDG at the Prophet's price, less `haircutBps`; zero if the Prophet is
    /// unavailable, which callers treat as "do nothing".
    function _usdgFor(IOracle oracle, uint256 assets, uint256 haircutBps) private view returns (uint256) {
        if (assets == 0) return 0;
        try oracle.price() returns (uint256 p) {
            if (p == 0) return 0;
            uint256 usd = FullMath.mulDiv(assets, ORACLE_SCALE, p);
            return (usd * (BPS - haircutBps)) / BPS;
        } catch {
            return 0;
        }
    }

    function _burn(uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = token.call(abi.encodeWithSelector(IBurnable.burn.selector, amount));
        if (!ok) _push(token, DEAD, amount);
        totalBurned += amount;
        emit Burned(amount);
    }

    function _balance(address t, address who) private view returns (uint256) {
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSelector(0x70a08231, who));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }

    function _pull(address t, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address t, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address t, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = t.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || !(ret.length == 0 || abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
