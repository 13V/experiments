// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StonkPacks
/// @notice Booster packs with real tokenized stocks inside, for Robinhood Chain.
///
/// A pack is an ERC-721 (sealed, tradable). Opening it burns the pack and pays out
/// `pullsPerPack` random pulls. Each pull is a rarity tier worth a fixed USD amount,
/// paid in a random stock token from that tier, sized by the stock's Chainlink feed.
/// If the treasury is short of that stock, or its feed is off or stale, the pull pays the
/// same USD amount in the payment stablecoin instead, so an open never fails.
///
/// ---------------------------------------------------------------------------
/// FAIRNESS
/// ---------------------------------------------------------------------------
///
/// Buyers cannot cheat. A pack's outcome is keccak(seed_k, buyerSeed, packId, bh):
///   seed_k     the operator's pre-committed seed for pack k, secret until the pack opens;
///   buyerSeed  chosen by the buyer at purchase;
///   bh         blockhash(purchaseBlock + 1), unknown to everyone at purchase.
/// Nothing that can be changed after purchase is an input. The holder in particular is not:
/// a sealed pack can be traded and the prize follows it, but its outcome was fixed one block
/// after it was bought. Opens happen in a later transaction, so a contract buyer cannot
/// revert a bad pull.
///
/// The operator cannot cheat on odds. Seeds form a hash chain whose root is published at
/// deployment: seed_k must hash to seed_{k-1}, every seed is verified on-chain, and packs
/// are settled strictly in order. Sales only start once lockOdds() has frozen the tiers,
/// values, token lists, pulls per pack, fee cut and price feeds. After the lock a feed can
/// only be switched off, which makes that stock pay the same USD in cash.
///
/// The operator cannot withhold a win. The operator learns a pack's outcome as soon as bh
/// exists, before opening it. A pack not opened within OPEN_WINDOW can be refunded by anyone,
/// and when its seed is finally revealed (it must be, for the chain to move at all) the pack
/// is still paid every prize it rolled, using the hash recorded at refund time. Being late
/// costs the operator the price and the prizes; it never saves a prize. What remains is
/// abandonment: an operator who never reveals again freezes the game in public, and every
/// later pack is refunded.
///
/// On Arbitrum-family chains (Robinhood Chain included) `block.number` is the parent chain's
/// block number and blockhash is a value the sequencer produces. A sequencer that also knew
/// seed_k could bias a pack; the seed is secret from it. Chainlink VRF removes even that:
/// override `_entropy`, nothing else changes.
///
/// ---------------------------------------------------------------------------
/// SOLVENCY
/// ---------------------------------------------------------------------------
///
/// The operator supplies the stock inventory and may withdraw it. Pack revenue in the
/// payment token is escrowed until a pack opens or is refunded, and the owner can never
/// withdraw below escrow plus outstanding IOUs. Provable fairness covers the odds; solvency
/// of prizes is the operator's reputation, exactly as with any pack seller.
///
/// No transfer to a pack holder can ever revert an open or a refund. Regulated stock tokens
/// and stablecoins can refuse an address, revert, or return nonsense; when that happens the
/// pull degrades to cash, and if cash cannot be delivered either the holder is credited an
/// IOU and the game moves on. A holder can therefore never freeze the chain for everyone
/// else, and neither can a price feed or a stock token.
///
/// Residual risk, stated plainly: a refund later than 256 blocks after purchase finds no
/// block hash any more and the pack settles with a zero hash, an outcome the operator could
/// have computed in advance. Anyone can refund from the moment the window closes, and every
/// purchase records the hashes of pending packs, so this needs a game nobody is touching.
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
        uint8 feedDecimals;
    }

    enum Status {
        None,
        Sealed,
        Opened,
        Refunded
    }

    struct Pack {
        address payee; // the buyer; after a refund, whoever held the pack and receives the late prizes
        uint64 purchaseBlock;
        Status status;
        uint96 price; // what was paid; escrow, fee and refund all use this, never the current price
        bytes32 buyerSeed;
        bytes32 entropyHash; // blockhash(purchaseBlock + 1) once recorded; zero until then
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
    uint16 public constant MAX_FEE_BPS = 2500;
    address public feeRecipient;
    bool public oddsLocked; // freezes tiers, pulls per pack, the fee cut and the feeds; opens sales
    bool public paused; // stops new sales only; sealed packs are unaffected

    Tier[] private _tiers;
    uint256 public totalWeight;
    mapping(address => Feed) public feeds;
    AggregatorV3Interface public sequencerFeed;
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    /// @notice Packs must be opened within this many blocks of purchase. After that anyone
    ///         may refund them. Keeps `blockhash(purchaseBlock + 1)` retrievable (256 limit)
    ///         and stops an operator from sitting on a pack they can already see the outcome of.
    ///         Counted in whatever `block.number` means on the chain. On Robinhood Chain
    ///         (Arbitrum Nitro) that is the Ethereum block number, which ticks every ~12 s while
    ///         the chain itself makes ~10 blocks a second: a pack becomes openable 15-25 s after
    ///         purchase and this window is about 40 minutes. Use `packState`, never the RPC's
    ///         block height, to decide what to do with a pack.
    uint256 public constant OPEN_WINDOW = 200;

    /// @notice Head of the operator seed chain. Pack k is settled with seed_k where
    ///         keccak256(seed_k) == head at that moment; the head then becomes seed_k.
    bytes32 public chainHead;
    uint256 public revealed; // number of seeds consumed == last pack settled
    uint256 public chainEnd; // last pack id the committed chain can serve

    uint256 public packCount;
    mapping(uint256 => Pack) public packs;
    uint256 private _cursor = 1; // next pack whose entropy hash has not been looked at

    uint256 public escrowed; // payment tokens held for sealed packs
    uint256 public totalOwed; // IOUs issued when the treasury was short
    mapping(address => uint256) public owed;

    uint256 private _lock = 1;

    // -----------------------------------------------------------------------
    // Events / errors
    // -----------------------------------------------------------------------

    event Bought(uint256 indexed packId, address indexed buyer, bytes32 buyerSeed, uint256 price);
    event Opened(uint256 indexed packId, address indexed to, bytes32 randomness, bytes32 blockHash, bool late);
    event Pull(
        uint256 indexed packId,
        uint8 index,
        uint8 tier,
        address token,
        uint256 amount,
        uint64 usdCents,
        bool paidInCash
    );
    event Refunded(uint256 indexed packId, address indexed holder, uint256 amount);
    event Owed(uint256 indexed packId, address indexed who, uint256 amount);
    event OwedClaimed(address indexed who, uint256 amount);
    event OddsLocked();
    event PauseSet(bool paused);
    event TierSet(uint8 indexed index, uint32 weight, uint64 usdCents, address[] tokens);
    event FeedSet(address indexed token, address feed, uint32 heartbeat);
    event ChainExtended(bytes32 root, uint256 chainEnd);

    error NotOwner();
    error ZeroAddress();
    error NoSuchPack();
    error NotAuthorized();
    error BadReceiver();
    error OddsAreLocked();
    error NotLocked();
    error Paused();
    error ChainExhausted();
    error PacksPending();
    error NoTiers();
    error BadTier();
    error BadFeed();
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
    /// @param _chainLength  How many seeds the chain holds, i.e. how many packs it can serve.
    constructor(
        address _paymentToken,
        uint256 _packPrice,
        uint8 _pulls,
        uint16 _feeBps,
        address _feeRecipient,
        bytes32 _chainRoot,
        uint256 _chainLength
    ) {
        if (_paymentToken == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS || _pulls == 0 || _packPrice > type(uint96).max || _chainLength == 0) revert BadTier();
        owner = msg.sender;
        paymentToken = IERC20(_paymentToken);
        paymentDecimals = IERC20(_paymentToken).decimals();
        packPrice = _packPrice;
        pullsPerPack = _pulls;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        chainHead = _chainRoot;
        chainEnd = _chainLength;
        emit ChainExtended(_chainRoot, _chainLength);
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

    /// @notice One-way. Freezes the odds, values, token lists, pulls per pack, fee cut and
    ///         price feeds, and opens sales. Nothing can be bought before this.
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

    /// @notice Stops or resumes sales. Never touches packs already sold.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PauseSet(p);
    }

    /// @notice The recipient can always change. The cut is capped and frozen by lockOdds().
    function setFee(uint16 bps, address recipient) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert BadTier();
        if (recipient == address(0)) revert ZeroAddress();
        if (oddsLocked && bps != feeBps) revert OddsAreLocked();
        feeBps = bps;
        feeRecipient = recipient;
    }

    /// @notice Point a stock token at its Chainlink feed. The feed is exercised once here so a
    ///         dead address is rejected. After lockOdds() a feed can only be cleared, which
    ///         routes that stock's pulls to the cash fallback at full value.
    function setFeed(address token, address feed, uint32 heartbeat) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (oddsLocked && feed != address(0)) revert OddsAreLocked();
        uint8 tokenDec;
        uint8 feedDec;
        if (feed != address(0)) {
            if (feed.code.length == 0) revert BadFeed();
            (bool ok,,,) = _latestRound(AggregatorV3Interface(feed));
            if (!ok) revert BadFeed();
            feedDec = AggregatorV3Interface(feed).decimals();
            tokenDec = IERC20(token).decimals();
        }
        feeds[token] = Feed({feed: AggregatorV3Interface(feed), heartbeat: heartbeat, tokenDecimals: tokenDec, feedDecimals: feedDec});
        emit FeedSet(token, feed, heartbeat);
    }

    /// @notice Chainlink's sequencer-uptime feed for the chain, or zero for none. Same lock
    ///         rule as the price feeds: after lockOdds() it can only be cleared.
    function setSequencerFeed(address feed) external onlyOwner {
        if (oddsLocked && feed != address(0)) revert OddsAreLocked();
        if (feed != address(0)) {
            if (feed.code.length == 0) revert BadFeed();
            (bool ok,,,) = _latestRound(AggregatorV3Interface(feed));
            if (!ok) revert BadFeed();
        }
        sequencerFeed = AggregatorV3Interface(feed);
    }

    /// @notice Commit a new seed chain once every sold pack is settled. Serves `length` more
    ///         packs. Safe at any time nothing is pending: no outcome can depend on a root
    ///         committed before the pack it applies to is sold.
    function extendChain(bytes32 root, uint256 length) external onlyOwner {
        if (revealed != packCount) revert PacksPending();
        if (length == 0) revert BadTier();
        chainHead = root;
        chainEnd = packCount + length;
        emit ChainExtended(root, chainEnd);
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
        if (!oddsLocked) revert NotLocked();
        if (paused) revert Paused();
        if (packCount >= chainEnd) revert ChainExhausted();
        packId = ++packCount;
        uint256 price = packPrice;
        packs[packId] = Pack({
            payee: msg.sender,
            purchaseBlock: uint64(block.number),
            status: Status.Sealed,
            price: uint96(price),
            buyerSeed: buyerSeed,
            entropyHash: bytes32(0)
        });
        escrowed += price;
        _mint(msg.sender, packId);
        if (!paymentToken.transferFrom(msg.sender, address(this), price)) revert TransferFailed();
        emit Bought(packId, msg.sender, buyerSeed, price);
        _checkpointPending();
    }

    // -----------------------------------------------------------------------
    // Opening
    // -----------------------------------------------------------------------

    /// @notice Open pack `packId` with operator seed_k. Anyone may call; the seed proves itself.
    ///         The prize goes to whoever holds the sealed pack at open time, so sealed packs
    ///         can be traded or gifted; the outcome itself was fixed one block after purchase.
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
        p.payee = holder;
        escrowed -= price;
        _burn(packId);

        bytes32 bh = p.entropyHash;
        if (bh == bytes32(0)) bh = blockhash(uint256(p.purchaseBlock) + 1); // always available inside the window
        bytes32 randomness = _entropy(seed, p.buyerSeed, packId, bh);
        emit Opened(packId, holder, randomness, bh, false);

        // A fee that cannot be delivered simply stays in the treasury as free balance.
        uint256 fee = price * feeBps / 10_000;
        if (fee > 0) _trySend(paymentToken, feeRecipient, fee);

        _payout(holder, packId, randomness);
    }

    /// @dev Three independent sources: the operator's pre-committed seed, the buyer's seed,
    ///      and the hash of the block after purchase. Override to plug in a VRF.
    function _entropy(bytes32 seed, bytes32 buyerSeed, uint256 packId, bytes32 bh) internal view virtual returns (bytes32) {
        return keccak256(abi.encode(seed, buyerSeed, packId, bh));
    }

    function _payout(address to, uint256 packId, bytes32 randomness) private {
        uint8 n = pullsPerPack;
        for (uint8 i = 0; i < n; ++i) {
            _pull(to, packId, i, keccak256(abi.encode(randomness, i)));
        }
    }

    function _pull(address to, uint256 packId, uint8 index, bytes32 rand) private {
        uint8 tierIdx = _pickTier(uint256(rand));
        Tier storage t = _tiers[tierIdx];
        address token = t.tokens[uint256(keccak256(abi.encode(rand, "token"))) % t.tokens.length];

        (uint256 amount, bool ok) = quote(token, t.usdCents);
        if (ok && _balanceOf(token) >= amount && _trySend(IERC20(token), to, amount)) {
            emit Pull(packId, index, tierIdx, token, amount, t.usdCents, false);
            return;
        }

        // Cash fallback in the payment token, never touching escrow or existing IOUs.
        // If even that cannot be delivered, the holder is credited and the open still succeeds.
        uint256 cash = uint256(t.usdCents) * (10 ** paymentDecimals) / 100;
        if (!(_freeBalance() >= cash && _trySend(paymentToken, to, cash))) {
            owed[to] += cash;
            totalOwed += cash;
            emit Owed(packId, to, cash);
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
    ///         `ok` is false when there is no feed, the feed is stale or broken, or the
    ///         sequencer is down. A false here means the pull pays cash at full value.
    function quote(address token, uint64 usdCents) public view returns (uint256 amount, bool ok) {
        Feed storage f = feeds[token];
        if (address(f.feed) == address(0)) return (0, false);
        if (!_sequencerUp()) return (0, false);

        (bool live, int256 answer,, uint256 updatedAt) = _latestRound(f.feed);
        if (!live || answer <= 0 || updatedAt == 0) return (0, false);
        if (f.heartbeat != 0 && block.timestamp > updatedAt + f.heartbeat) return (0, false);

        // usd = cents / 100 ; tokens = usd / price ; scale to token decimals.
        amount = uint256(usdCents) * (10 ** f.tokenDecimals) * (10 ** f.feedDecimals) / (100 * uint256(answer));
        ok = amount > 0;
    }

    function _sequencerUp() private view returns (bool) {
        if (address(sequencerFeed) == address(0)) return true;
        (bool live, int256 answer, uint256 startedAt,) = _latestRound(sequencerFeed);
        if (!live || answer != 0) return false; // 0 == up
        return block.timestamp - startedAt > SEQUENCER_GRACE;
    }

    // -----------------------------------------------------------------------
    // Liveness: refunds and late settlement
    // -----------------------------------------------------------------------

    /// @notice Record blockhash(purchaseBlock + 1) for a sealed pack while the chain still has
    ///         it, so a late settlement uses the same hash a timely open would have. Anyone may
    ///         call; every purchase does it for the oldest pending packs.
    function checkpoint(uint256 packId) public {
        Pack storage p = packs[packId];
        if (p.status != Status.Sealed || p.entropyHash != bytes32(0)) return;
        uint256 b = uint256(p.purchaseBlock) + 1;
        if (block.number > b && block.number <= b + 256) p.entropyHash = blockhash(b);
    }

    function _checkpointPending() private {
        uint256 c = _cursor;
        uint256 last = packCount;
        for (uint256 i = 0; i < 3 && c <= last; ++i) {
            Pack storage p = packs[c];
            uint256 b = uint256(p.purchaseBlock) + 1;
            if (block.number <= b) break; // too new, and so is everything after it
            if (p.status == Status.Sealed && p.entropyHash == bytes32(0) && block.number <= b + 256) {
                p.entropyHash = blockhash(b);
            }
            ++c;
        }
        _cursor = c;
    }

    /// @notice A sealed pack older than OPEN_WINDOW blocks can be refunded by anyone. The
    ///         refund goes to the current holder, who also receives the pack's prizes when
    ///         its seed is revealed through `openLate`.
    function refundExpired(uint256 packId) external nonReentrant {
        Pack storage p = packs[packId];
        if (p.status != Status.Sealed) revert NotSealed();
        if (block.number <= uint256(p.purchaseBlock) + OPEN_WINDOW) revert WindowOpen();
        address holder = _owners[packId];
        uint256 price = p.price;
        p.status = Status.Refunded;
        p.payee = holder;
        if (p.entropyHash == bytes32(0)) p.entropyHash = blockhash(uint256(p.purchaseBlock) + 1); // zero if too late
        escrowed -= price;
        _burn(packId);
        if (!_trySend(paymentToken, holder, price)) {
            owed[holder] += price;
            totalOwed += price;
            emit Owed(packId, holder, price);
        }
        emit Refunded(packId, holder, price);
    }

    /// @notice Settle a refunded pack: reveal its seed, move the chain on, and pay the prizes
    ///         it rolled to whoever held it when it was refunded. No fee is taken; the price
    ///         already went back. Lateness never saves the operator a prize.
    function openLate(uint256 packId, bytes32 seed) external nonReentrant {
        Pack storage p = packs[packId];
        if (p.status != Status.Refunded) revert NotRefunded();
        if (packId != revealed + 1) revert OutOfOrder();
        if (keccak256(abi.encodePacked(seed)) != chainHead) revert BadSeed();
        chainHead = seed;
        revealed = packId;
        p.status = Status.Opened;
        address to = p.payee;
        bytes32 randomness = _entropy(seed, p.buyerSeed, packId, p.entropyHash);
        emit Opened(packId, to, randomness, p.entropyHash, true);
        _payout(to, packId, randomness);
    }

    /// @notice A pack's status and where it sits in its open window, on the contract's own
    ///         clock. `openable` is purely the time predicate: the pack still has to be next in
    ///         the seed chain (`packId == revealed + 1`) to actually open. Both flags are false
    ///         for anything that is not Sealed; a Refunded pack is waiting for `openLate`.
    function packState(uint256 packId) external view returns (Status status, bool openable, bool expired) {
        Pack storage p = packs[packId];
        status = p.status;
        if (status != Status.Sealed) return (status, false, false);
        uint256 purchase = uint256(p.purchaseBlock);
        expired = block.number > purchase + OPEN_WINDOW;
        openable = !expired && block.number > purchase + 1;
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
        uint256 bal = _balanceOf(address(paymentToken));
        uint256 reserved = escrowed + totalOwed;
        return bal > reserved ? bal - reserved : 0;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// @dev Reverting transfer, for paths where the recipient is the caller or the owner.
    function _send(IERC20 token, address to, uint256 amount) private {
        if (!_trySend(token, to, amount)) revert TransferFailed();
    }

    /// @dev A transfer that never reverts the caller. Bounded gas, return data read without
    ///      being copied, so a token that reverts, runs out of gas, returns nothing, returns
    ///      megabytes, or returns anything but `true` all count as "not delivered". A token that
    ///      moved the balance but answered something other than `true` is paid twice (cash on
    ///      top); that is the operator's risk and the reason to clear such a token's feed.
    function _trySend(IERC20 token, address to, uint256 amount) private returns (bool ok) {
        if (amount == 0) return true;
        if (address(token).code.length == 0) return false;
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, to, amount);
        uint256 size;
        bytes32 ret;
        assembly ("memory-safe") {
            ok := call(300000, token, 0, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            ret := mload(0)
        }
        if (!ok) return false;
        if (size == 0) return true;
        return size >= 32 && ret == bytes32(uint256(1));
    }

    /// @dev balanceOf that treats a broken, missing or return-bombing token as empty.
    function _balanceOf(address token) private view returns (uint256 bal) {
        bytes memory data = abi.encodeWithSelector(IERC20.balanceOf.selector, address(this));
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            ok := staticcall(100000, token, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            bal := mload(0)
        }
        if (!ok || size < 32) return 0;
    }

    /// @dev latestRoundData that never reverts the caller: a feed with no code, a reverting
    ///      feed, a starved feed or a short answer all come back as `ok == false`.
    function _latestRound(AggregatorV3Interface feed)
        private
        view
        returns (bool ok, int256 answer, uint256 startedAt, uint256 updatedAt)
    {
        bytes memory data = abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector);
        uint256 size;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(0x40, add(ptr, 160))
            ok := staticcall(200000, feed, add(data, 32), mload(data), ptr, 160)
            size := returndatasize()
            answer := mload(add(ptr, 32))
            startedAt := mload(add(ptr, 64))
            updatedAt := mload(add(ptr, 96))
        }
        if (!ok || size < 160) return (false, 0, 0, 0);
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
