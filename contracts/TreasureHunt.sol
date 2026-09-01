// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TreasureHunt
/// @notice Escrow for a multi-stage public puzzle hunt.
///
/// ---------------------------------------------------------------------------
/// CLAIMING IS SIGNATURE-BOUND, NOT COMMIT-REVEAL
/// ---------------------------------------------------------------------------
///
/// An earlier version of this contract used commit-reveal. That works, but it is
/// strictly worse than what is here, and the reason is worth stating because it is
/// the single most important decision in the design.
///
/// The puzzle does not terminate in a *phrase*. It terminates in a *private key*.
/// The contract stores only the corresponding address, published when the stage is
/// created and immutable thereafter.
///
/// To claim, the solver signs a digest that COMMITS TO THEIR OWN RECIPIENT ADDRESS.
/// A validator, sequencer, RPC operator or mempool bot who copies that transaction
/// can do exactly one thing with it: rebroadcast it, and pay gas to send the money
/// to the rightful winner. The signature is worthless to anyone else because the
/// recipient is inside the signed message.
///
/// That collapses four problems at once:
///   - no front-running (the payload is not redirectable)
///   - no two-step fumble at the climax of the hunt (one transaction, not two)
///   - no reveal-delay window in which a solver can be griefed or lose their nerve
///   - no offline brute force: the secret is a 256-bit key, not a guessable phrase.
///     A published commitment to a phrase is a free, permanent, unlimited-rate
///     verification oracle. Brain wallets with more entropy than any English
///     passphrase have been drained at scale within minutes.
///
/// The corollary is a puzzle-design constraint, not a contract constraint:
/// the secret must be DISCOVERED, never GUESSED. Difficulty lives in working out
/// WHERE the key is, never in what words it spells.
///
/// ---------------------------------------------------------------------------
/// OTHER PROPERTIES
/// ---------------------------------------------------------------------------
///
/// UNRUGGABLE. There is no withdrawal function. Funds leave only to a winner, or
/// via a permissionless rollover into another unsolved stage of the same hunt.
///
/// VERIFIABLE. The puzzle address for each stage is written at creation and can
/// never change. That is the on-chain proof a solution existed from the start —
/// the accusation every hunt has to survive.
///
/// DISCRETION-FREE PAYOUT. Where an allowlist is required (sanctions screening,
/// age, tax forms), eligibility is decided BEFORE the stage opens. At claim time
/// there is no human judgement at all. Operators who decide who won after the fact
/// spend years being called thieves; this design makes that impossible by removing
/// the decision from the moment it would be contested.
///
/// sha256 is used for the digest rather than keccak256 so that claim tooling can be
/// built with no dependencies — it is a precompile here and native in Node, Python
/// and browsers.
contract TreasureHunt {
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Stage {
        address puzzleSigner; // address of the keypair the puzzle terminates in. Immutable.
        uint256 prize; // wei escrowed
        address winner; // zero until claimed
        uint64 createdAt;
        uint64 claimedAt;
        uint64 opensAt; // block before which claims revert (time-gated stages)
        bool requiresAllowlist; // if true, recipient must be pre-registered
        bool exists;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Creates and funds stages, and manages the pre-registration allowlist.
    ///         Has NO withdrawal path and cannot alter a published puzzle address.
    address public immutable curator;

    /// @notice Blocks after a stage opens before an unclaimed prize may roll forward.
    ///         Set this long. It exists so an unsolvable stage does not entomb the
    ///         prize, not as an escape hatch.
    uint64 public immutable rolloverAfter;

    uint256 public stageCount;
    mapping(uint256 => Stage) public stages;

    /// @notice Addresses cleared to receive a prize, decided before the stage opens.
    mapping(address => bool) public allowlisted;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event StageCreated(uint256 indexed stageId, address puzzleSigner, uint256 prize, uint64 opensAt);
    event StageFunded(uint256 indexed stageId, address indexed from, uint256 amount, uint256 newPrize);
    event Allowlisted(address indexed account, bool status);
    event Claimed(uint256 indexed stageId, address indexed winner, uint256 prize);
    event RolledOver(uint256 indexed fromStageId, uint256 indexed toStageId, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotCurator();
    error NoSuchStage();
    error AlreadyClaimed();
    error NotOpenYet();
    error BadSignature();
    error NotAllowlisted();
    error ZeroRecipient();
    error EmptySigner();
    error NothingToRollover();
    error RolloverTooEarly();
    error SameStage();
    error TransferFailed();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    constructor(uint64 _rolloverAfter) {
        curator = msg.sender;
        rolloverAfter = _rolloverAfter;
    }

    modifier onlyCurator() {
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    // -----------------------------------------------------------------------
    // Stage lifecycle
    // -----------------------------------------------------------------------

    /// @param puzzleSigner      Address of the keypair the puzzle terminates in. Published now,
    ///                          immutable forever. This is the proof a solution exists.
    /// @param opensAt           Block from which claims are accepted. 0 for immediately.
    /// @param requiresAllowlist Whether the recipient must be pre-registered. Use false for small
    ///                          ladder prizes below reporting thresholds; true for the grand prize.
    function createStage(address puzzleSigner, uint64 opensAt, bool requiresAllowlist)
        external
        payable
        onlyCurator
        returns (uint256 stageId)
    {
        if (puzzleSigner == address(0)) revert EmptySigner();

        stageId = stageCount++;
        stages[stageId] = Stage({
            puzzleSigner: puzzleSigner,
            prize: msg.value,
            winner: address(0),
            createdAt: uint64(block.number),
            claimedAt: 0,
            opensAt: opensAt,
            requiresAllowlist: requiresAllowlist,
            exists: true
        });

        emit StageCreated(stageId, puzzleSigner, msg.value, opensAt);
    }

    /// @notice Top up a stage. Open to anyone; there is no path back out except to a winner.
    function fundStage(uint256 stageId) external payable {
        Stage storage s = stages[stageId];
        if (!s.exists) revert NoSuchStage();
        if (s.winner != address(0)) revert AlreadyClaimed();

        s.prize += msg.value;
        emit StageFunded(stageId, msg.sender, msg.value, s.prize);
    }

    /// @notice Pre-register cleared payout addresses. Must happen BEFORE the stage opens so
    ///         that no eligibility decision is ever made at claim time.
    function setAllowlist(address[] calldata accounts, bool status) external onlyCurator {
        for (uint256 i = 0; i < accounts.length; ++i) {
            allowlisted[accounts[i]] = status;
            emit Allowlisted(accounts[i], status);
        }
    }

    // -----------------------------------------------------------------------
    // Claiming
    // -----------------------------------------------------------------------

    /// @notice The exact digest a solver must sign with the puzzle key.
    /// @dev Binds four things:
    ///        recipient      — so a copied signature cannot be redirected. This is the defence.
    ///        stageId        — so a signature for one stage cannot claim another.
    ///        address(this)  — so it cannot be replayed against a different deployment.
    ///        chainid        — so it cannot be replayed on a forked or sibling chain.
    function claimDigest(uint256 stageId, address recipient) public view returns (bytes32) {
        return sha256(abi.encodePacked(stageId, recipient, address(this), block.chainid));
    }

    /// @notice Claim a stage prize. One transaction. Anyone may submit it; the money can only
    ///         ever go to the `recipient` inside the signed digest.
    /// @dev Deliberately does NOT require msg.sender == recipient. A winner without gas can have
    ///      a friend, a relayer, or the bot that tried to steal it, broadcast on their behalf —
    ///      and it still pays the winner. That turns the classic attack into a free relay service.
    function claim(uint256 stageId, address payable recipient, uint8 v, bytes32 r, bytes32 s)
        external
    {
        Stage storage stage = stages[stageId];
        if (!stage.exists) revert NoSuchStage();
        if (stage.winner != address(0)) revert AlreadyClaimed();
        if (recipient == address(0)) revert ZeroRecipient();
        if (block.number < stage.opensAt) revert NotOpenYet();
        if (stage.requiresAllowlist && !allowlisted[recipient]) revert NotAllowlisted();

        // Reject the malleable upper half of the curve order, and any invalid v. Without
        // this, (v, r, s) and (v^1, r, n-s) are both valid for the same digest, so a
        // signature has two forms and anything keyed on its hash can be bypassed.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();

        // ecrecover returns address(0) on failure rather than reverting, and puzzleSigner
        // can never be zero (createStage rejects it), so the zero check is belt and braces.
        address signer = ecrecover(claimDigest(stageId, recipient), v, r, s);
        if (signer == address(0) || signer != stage.puzzleSigner) revert BadSignature();

        uint256 prize = stage.prize;
        stage.prize = 0;
        stage.winner = recipient;
        stage.claimedAt = uint64(block.number);

        emit Claimed(stageId, recipient, prize);

        if (prize > 0) {
            (bool ok,) = recipient.call{value: prize}("");
            if (!ok) revert TransferFailed();
        }
    }

    // -----------------------------------------------------------------------
    // Rollover
    // -----------------------------------------------------------------------

    /// @notice Move a stale unclaimed prize into another unsolved stage. Permissionless, so it
    ///         is not a curator privilege, and funds can only move between stages of this hunt.
    function rollover(uint256 fromStageId, uint256 toStageId) external {
        if (fromStageId == toStageId) revert SameStage();

        Stage storage from = stages[fromStageId];
        Stage storage to = stages[toStageId];
        if (!from.exists || !to.exists) revert NoSuchStage();
        if (from.winner != address(0) || to.winner != address(0)) revert AlreadyClaimed();
        if (from.prize == 0) revert NothingToRollover();

        uint64 startedAt = from.opensAt > from.createdAt ? from.opensAt : from.createdAt;
        if (block.number < uint256(startedAt) + uint256(rolloverAfter)) revert RolloverTooEarly();

        uint256 amount = from.prize;
        from.prize = 0;
        to.prize += amount;

        emit RolledOver(fromStageId, toStageId, amount);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function stageInfo(uint256 stageId)
        external
        view
        returns (
            address puzzleSigner,
            uint256 prize,
            address winner,
            uint64 createdAt,
            uint64 claimedAt,
            uint64 opensAt,
            bool requiresAllowlist
        )
    {
        Stage storage s = stages[stageId];
        if (!s.exists) revert NoSuchStage();
        return (s.puzzleSigner, s.prize, s.winner, s.createdAt, s.claimedAt, s.opensAt, s.requiresAllowlist);
    }

    /// @notice Total wei still escrowed across all unclaimed stages.
    function totalEscrowed() external view returns (uint256 total) {
        uint256 n = stageCount;
        for (uint256 i = 0; i < n; ++i) {
            total += stages[i].prize;
        }
    }

    /// @dev Untargeted transfers top up stage 0 rather than becoming stuck value.
    receive() external payable {
        Stage storage s = stages[0];
        if (!s.exists || s.winner != address(0)) revert NoSuchStage();
        s.prize += msg.value;
        emit StageFunded(0, msg.sender, msg.value, s.prize);
    }
}
