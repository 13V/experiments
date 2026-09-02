// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StonkPacks
/// @notice Booster packs with real tokenized stocks inside, for Robinhood Chain.
///
/// A pack is an ERC-721 (sealed, tradable). Opening it burns the pack and pays out
/// `pullsPerPack` random pulls. Each pull is a rarity tier worth a fixed USD amount,
/// paid in a random stock token from that tier, sized by the stock's Chainlink feed.
/// If the treasury is short of that stock, or its feed is paused, the pull pays the
/// same USD amount in the payment stablecoin instead, so an open never fails.
///
/// ---------------------------------------------------------------------------
/// FAIRNESS
/// ---------------------------------------------------------------------------
///
/// Buyers cannot cheat. The outcome depends on a seed the buyer supplies at purchase,
/// an operator seed that is secret until the pack is opened, and the hash of the
/// block after the purchase. None of those can be chosen with knowledge of the others,
/// and the open happens in a later transaction, so a contract buyer cannot revert a
/// bad pull.
///
/// The operator cannot cheat on odds. Operator seeds form a hash chain whose root is
/// published at deployment: seed_k must hash to seed_{k-1}. Every seed is verified
/// on-chain, packs are opened strictly in order, and the odds table can be locked
/// forever. What remains is liveness: an operator who stops revealing freezes the
/// game in public, and every stuck pack becomes refundable by anyone after
/// OPEN_WINDOW blocks. Stalling is visible and costs the sale.
///
/// If a verifiable randomness service is available on the chain, replace the hash
/// chain by overriding `_entropy`. Nothing else changes.
///
/// On Arbitrum-style chains `block.number` follows the parent chain and `blockhash`
/// is a chain-provided pseudo-random value. That is fine here: it is one of three
/// independent entropy sources, not the only one.
///
/// ---------------------------------------------------------------------------
/// SOLVENCY
/// ---------------------------------------------------------------------------
///
/// The operator supplies the stock inventory and may withdraw it. Pack revenue in
/// the payment token is escrowed until a pack opens or is refunded, and the owner
/// can never withdraw below escrow plus outstanding IOUs. Provable fairness covers
/// the odds; solvency of prizes is the operator's reputation, exactly as with any
/// pack seller.
///
/// UNAUDITED. Loot boxes containing securities are a regulated shape in most places.
contract StonkPacks {
    // -----------------------------------------------------------------------
    // Minimal ERC-721 (sealed packs)
    // -----------------------------------------------------------------------

    string public constant name = "Stonk Packs";
    string public constant symbol = "PACK";
    string public baseURI;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; // 165, 721, 721Metadata
    }

    function balanceOf(address who) external view returns (uint256) {
        if (who == address(0)) revert ZeroAddress();
        return _balances[who];
    }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _owners[tokenId];
        if (o == address(0)) revert NoSuchPack();
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return string(abi.encodePacked(baseURI, _toString(tokenId)));
    }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !_operatorApprovals[o][msg.sender]) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address op, bool approved) external {
        _operatorApprovals[msg.sender][op] = approved;
        emit ApprovalForAll(msg.sender, op, approved);
    }

    function isApprovedForAll(address o, address op) external view returns (bool) {
        return _operatorApprovals[o][op];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address o = ownerOf(tokenId);
        if (o != from) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != o && msg.sender != _tokenApprovals[tokenId] && !_operatorApprovals[o][msg.sender]) {
            revert NotAuthorized();
        }
        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    function _mint(address to, uint256 tokenId) internal {
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId) internal {
        address o = _owners[tokenId];
        delete _tokenApprovals[tokenId];
        _balances[o] -= 1;
        delete _owners[tokenId];
        emit Transfer(o, address(0), tokenId);
    }

    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 r) {
            if (r != IERC721Receiver.onERC721Received.selector) revert BadReceiver();
        } catch {
            revert BadReceiver();
        }
    }

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Tier {
        uint32 weight; // relative probability
        uint64 usdCents; // value of one pull from this tier
        address[] tokens; // stock tokens this tier can pay out
    }

    struct Feed {
        AggregatorV3Interface feed;
        uint32 heartbeat; // seconds; a price older than this is stale
        uint8 tokenDecimals;
    }

    enum Status {
        None,
        Sealed,
        Opened,
        Refunded
    }

    struct Pack {
        address buyer;
        uint64 purchaseBlock;
        Status status;
        uint96 price; // what was paid; escrow, fee and refund all use this, never the current price
        bytes32 buyerSeed;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    address public owner;
    IERC20 public immutable paymentToken;
    uint8 public immutable paymentDecimals;

    uint256 public packPrice; // in payment token units
    uint8 public pullsPerPack;
    uint16 public feeBps; // share of each opened pack's price sent to feeRecipient
    address public feeRecipient;
    bool public oddsLocked;

    Tier[] private _tiers;
    uint256 public totalWeight;
    mapping(address => Feed) public feeds;
    AggregatorV3Interface public sequencerFeed;
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    /// @notice Packs must be opened within this many blocks of purchase. After that anyone
    ///         may refund them. Keeps `blockhash(purchaseBlock + 1)` retrievable (256 limit)
    ///         and stops an operator from stalling a pack they can already see the outcome of.
    uint256 public constant OPEN_WINDOW = 200;

    /// @notice Head of the operator seed chain. Pack k is opened with seed_k where
    ///         keccak256(seed_k) == head at that moment; the head then becomes seed_k.
    bytes32 public chainHead;
    uint256 public revealed; // number of seeds consumed == last pack processed

    uint256 public packCount;
    mapping(uint256 => Pack) public packs;

    uint256 public escrowed; // payment tokens held for sealed packs
    uint256 public totalOwed; // IOUs issued when the treasury was short
    mapping(address => uint256) public owed;

    uint256 private _lock = 1;

    // -----------------------------------------------------------------------
    // Events / errors
    // -----------------------------------------------------------------------

    event Bought(uint256 indexed packId, address indexed buyer, bytes32 buyerSeed, uint256 price);
    event Opened(uint256 indexed packId, address indexed buyer, bytes32 randomness);
    event Pull(
        uint256 indexed packId,
        uint8 index,
        uint8 tier,
        address token,
        uint256 amount,
        uint64 usdCents,
        bool paidInCash
    );
    event Refunded(uint256 indexed packId, address indexed buyer, uint256 amount);
    event Skipped(uint256 indexed packId);
    event OwedClaimed(address indexed who, uint256 amount);
    event OddsLocked();
    event TierSet(uint8 indexed index, uint32 weight, uint64 usdCents, address[] tokens);
    event FeedSet(address indexed token, address feed, uint32 heartbeat);

    error NotOwner();
    error ZeroAddress();
    error NoSuchPack();
    error NotAuthorized();
    error BadReceiver();
    error OddsAreLocked();
    error NoTiers();
    error BadTier();
    error NotSealed();
    error OutOfOrder();
    error BadSeed();
    error TooEarly();
    error WindowClosed();
    error WindowOpen();
    error NotRefunded();
    error InsufficientFree();
    error NothingOwed();
    error Reentrancy();
    error TransferFailed();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param _paymentToken Stablecoin packs are sold in (USDG on Robinhood Chain).
    /// @param _packPrice    Price per pack in payment token units.
    /// @param _pulls        Pulls per pack.
    /// @param _feeBps       Share of each opened pack's price paid to `_feeRecipient`.
    /// @param _chainRoot    keccak256(seed_1). Publish this with the deployment.
    constructor(
        address _paymentToken,
        uint256 _packPrice,
        uint8 _pulls,
        uint16 _feeBps,
        address _feeRecipient,
        bytes32 _chainRoot
    ) {
        if (_paymentToken == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > 10_000 || _pulls == 0 || _packPrice > type(uint96).max) revert BadTier();
        owner = msg.sender;
        paymentToken = IERC20(_paymentToken);
        paymentDecimals = IERC20(_paymentToken).decimals();
        packPrice = _packPrice;
        pullsPerPack = _pulls;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        chainHead = _chainRoot;
    }

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

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    function setTier(uint8 index, uint32 weight, uint64 usdCents, address[] calldata tokens) external onlyOwner {
        if (oddsLocked) revert OddsAreLocked();
        if (weight == 0 || usdCents == 0 || tokens.length == 0) revert BadTier();
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroAddress();
        }
        if (index > _tiers.length) revert BadTier();
        if (index == _tiers.length) {
            _tiers.push();
        } else {
            totalWeight -= _tiers[index].weight;
        }
        Tier storage t = _tiers[index];
        t.weight = weight;
        t.usdCents = usdCents;
        t.tokens = tokens;
        totalWeight += weight;
        emit TierSet(index, weight, usdCents, tokens);
    }

    /// @notice One-way. After this the odds, values and token lists can never change.
    function lockOdds() external onlyOwner {
        if (_tiers.length == 0) revert NoTiers();
        oddsLocked = true;
        emit OddsLocked();
    }

    function setPullsPerPack(uint8 pulls) external onlyOwner {
        if (oddsLocked) revert OddsAreLocked();
        if (pulls == 0) revert BadTier();
        pullsPerPack = pulls;
    }

    function setPrice(uint256 price) external onlyOwner {
        if (price > type(uint96).max) revert BadTier();
        packPrice = price;
    }

    function setFee(uint16 bps, address recipient) external onlyOwner {
        if (bps > 10_000) revert BadTier();
        if (recipient == address(0)) revert ZeroAddress();
        feeBps = bps;
        feeRecipient = recipient;
    }

    function setFeed(address token, address feed, uint32 heartbeat) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        feeds[token] = Feed({
            feed: AggregatorV3Interface(feed),
            heartbeat: heartbeat,
            tokenDecimals: feed == address(0) ? 0 : IERC20(token).decimals()
        });
        emit FeedSet(token, feed, heartbeat);
    }

    function setSequencerFeed(address feed) external onlyOwner {
        sequencerFeed = AggregatorV3Interface(feed);
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        baseURI = uri;
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        owner = to;
    }

    /// @notice Withdraw inventory or revenue. Payment tokens can never be withdrawn below
    ///         what is escrowed for sealed packs plus what is owed on IOUs.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(paymentToken)) {
            uint256 bal = paymentToken.balanceOf(address(this));
            if (bal < amount || bal - amount < escrowed + totalOwed) revert InsufficientFree();
        }
        _send(IERC20(token), to, amount);
    }

    // -----------------------------------------------------------------------
    // Buying
    // -----------------------------------------------------------------------

    /// @notice Buy one sealed pack. `buyerSeed` should be random bytes from the buyer's side.
    function buy(bytes32 buyerSeed) external nonReentrant returns (uint256 packId) {
        if (_tiers.length == 0) revert NoTiers();
        packId = ++packCount;
        uint256 price = packPrice;
        packs[packId] = Pack({
            buyer: msg.sender,
            purchaseBlock: uint64(block.number),
            status: Status.Sealed,
            price: uint96(price),
            buyerSeed: buyerSeed
        });
        escrowed += price;
        _mint(msg.sender, packId);
        if (!paymentToken.transferFrom(msg.sender, address(this), price)) revert TransferFailed();
        emit Bought(packId, msg.sender, buyerSeed, price);
    }

    // -----------------------------------------------------------------------
    // Opening
    // -----------------------------------------------------------------------

    /// @notice Open pack `packId` with operator seed_k. Anyone may call; the seed proves itself.
    ///         The prize goes to whoever holds the sealed pack at open time, so sealed packs
    ///         can be traded or gifted.
    function open(uint256 packId, bytes32 seed) external nonReentrant {
        Pack storage p = packs[packId];
        if (p.status != Status.Sealed) revert NotSealed();
        if (packId != revealed + 1) revert OutOfOrder();
        if (keccak256(abi.encodePacked(seed)) != chainHead) revert BadSeed();
        if (block.number <= uint256(p.purchaseBlock) + 1) revert TooEarly();
        if (block.number > uint256(p.purchaseBlock) + OPEN_WINDOW) revert WindowClosed();

        address holder = _owners[packId];

        // Effects first.
        uint256 price = p.price;
        chainHead = seed;
        revealed = packId;
        p.status = Status.Opened;
        escrowed -= price;
        _burn(packId);

        bytes32 randomness = _entropy(seed, p, packId, holder);
        emit Opened(packId, holder, randomness);

        uint256 fee = price * feeBps / 10_000;
        if (fee > 0) _send(paymentToken, feeRecipient, fee);

        uint8 n = pullsPerPack;
        for (uint8 i = 0; i < n; ++i) {
            _pull(holder, packId, i, keccak256(abi.encode(randomness, i)));
        }
    }

    /// @dev Three independent sources: the operator's pre-committed seed, the buyer's seed,
    ///      and the hash of the block after purchase. Override to plug in a VRF.
    function _entropy(bytes32 seed, Pack storage p, uint256 packId, address holder)
        internal
        view
        virtual
        returns (bytes32)
    {
        bytes32 bh = blockhash(uint256(p.purchaseBlock) + 1);
        return keccak256(abi.encode(seed, p.buyerSeed, packId, holder, bh));
    }

    function _pull(address to, uint256 packId, uint8 index, bytes32 rand) private {
        uint8 tierIdx = _pickTier(uint256(rand));
        Tier storage t = _tiers[tierIdx];
        address token = t.tokens[uint256(keccak256(abi.encode(rand, "token"))) % t.tokens.length];

        (uint256 amount, bool ok) = quote(token, t.usdCents);
        if (ok && IERC20(token).balanceOf(address(this)) >= amount) {
            _send(IERC20(token), to, amount);
            emit Pull(packId, index, tierIdx, token, amount, t.usdCents, false);
            return;
        }

        // Cash fallback in the payment token, never touching escrow or existing IOUs.
        uint256 cash = uint256(t.usdCents) * (10 ** paymentDecimals) / 100;
        uint256 free = _freeBalance();
        if (free >= cash) {
            _send(paymentToken, to, cash);
        } else {
            owed[to] += cash;
            totalOwed += cash;
        }
        emit Pull(packId, index, tierIdx, address(paymentToken), cash, t.usdCents, true);
    }

    function _pickTier(uint256 rand) private view returns (uint8) {
        uint256 roll = rand % totalWeight;
        uint256 acc;
        uint256 n = _tiers.length;
        for (uint256 i = 0; i < n; ++i) {
            acc += _tiers[i].weight;
            if (roll < acc) return uint8(i);
        }
        return uint8(n - 1); // unreachable when weights sum to totalWeight
    }

    /// @notice How many raw units of `token` are worth `usdCents` right now, per its feed.
    ///         `ok` is false when there is no feed, the feed is stale, or the sequencer is down.
    function quote(address token, uint64 usdCents) public view returns (uint256 amount, bool ok) {
        Feed storage f = feeds[token];
        if (address(f.feed) == address(0)) return (0, false);
        if (!_sequencerUp()) return (0, false);

        (, int256 answer,, uint256 updatedAt,) = f.feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0) return (0, false);
        if (f.heartbeat != 0 && block.timestamp > updatedAt + f.heartbeat) return (0, false);

        uint8 feedDec = f.feed.decimals();
        // usd = cents / 100 ; tokens = usd / price ; scale to token decimals.
        amount = uint256(usdCents) * (10 ** f.tokenDecimals) * (10 ** feedDec) / (100 * uint256(answer));
        ok = amount > 0;
    }

    function _sequencerUp() private view returns (bool) {
        if (address(sequencerFeed) == address(0)) return true;
        (, int256 answer, uint256 startedAt,,) = sequencerFeed.latestRoundData();
        if (answer != 0) return false; // 0 == up
        return block.timestamp - startedAt > SEQUENCER_GRACE;
    }

    // -----------------------------------------------------------------------
    // Liveness: refunds and chain skips
    // -----------------------------------------------------------------------

    /// @notice A sealed pack older than OPEN_WINDOW blocks can be refunded by anyone.
    ///         The refund always goes to the current holder of the pack.
    function refundExpired(uint256 packId) external nonReentrant {
        Pack storage p = packs[packId];
        if (p.status != Status.Sealed) revert NotSealed();
        if (block.number <= uint256(p.purchaseBlock) + OPEN_WINDOW) revert WindowOpen();
        address holder = _owners[packId];
        uint256 price = p.price;
        p.status = Status.Refunded;
        escrowed -= price;
        _burn(packId);
        _send(paymentToken, holder, price);
        emit Refunded(packId, holder, price);
    }

    /// @notice Consume the seed of a refunded pack so the chain can move on.
    function skip(uint256 packId, bytes32 seed) external {
        Pack storage p = packs[packId];
        if (p.status != Status.Refunded) revert NotRefunded();
        if (packId != revealed + 1) revert OutOfOrder();
        if (keccak256(abi.encodePacked(seed)) != chainHead) revert BadSeed();
        chainHead = seed;
        revealed = packId;
        emit Skipped(packId);
    }

    /// @notice Collect an IOU, in full or in part, from whatever the treasury holds beyond
    ///         escrow. IOUs are paid first-come, first-served.
    function claimOwed() external nonReentrant {
        uint256 amt = owed[msg.sender];
        if (amt == 0) revert NothingOwed();
        uint256 bal = paymentToken.balanceOf(address(this));
        uint256 available = bal > escrowed ? bal - escrowed : 0;
        if (available < amt) amt = available;
        if (amt == 0) revert InsufficientFree();
        owed[msg.sender] -= amt;
        totalOwed -= amt;
        _send(paymentToken, msg.sender, amt);
        emit OwedClaimed(msg.sender, amt);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tier(uint8 index) external view returns (uint32 weight, uint64 usdCents, address[] memory tokens) {
        Tier storage t = _tiers[index];
        return (t.weight, t.usdCents, t.tokens);
    }

    /// @notice Expected payout of one pack in USD cents, from the odds table alone.
    function expectedValueCents() external view returns (uint256 ev) {
        uint256 n = _tiers.length;
        for (uint256 i = 0; i < n; ++i) {
            ev += uint256(_tiers[i].weight) * _tiers[i].usdCents;
        }
        ev = ev * pullsPerPack / totalWeight;
    }

    /// @notice Payment tokens not reserved for sealed packs or outstanding IOUs.
    function freeBalance() external view returns (uint256) {
        return _freeBalance();
    }

    function _freeBalance() private view returns (uint256) {
        uint256 bal = paymentToken.balanceOf(address(this));
        uint256 reserved = escrowed + totalOwed;
        return bal > reserved ? bal - reserved : 0;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _send(IERC20 token, address to, uint256 amount) private {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        for (uint256 i = len; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(b);
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
