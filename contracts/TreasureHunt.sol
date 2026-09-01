// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TreasureHunt
/// @notice Escrow for a multi-stage public puzzle hunt.
///
///         Design goals, in priority order:
///
///         1. FRONT-RUN PROOF. The naive design ("submit the answer, get paid") loses the
///            prize to a mempool bot every time: the bot sees the answer in the pending
///            transaction, copies it, and outbids the solver on gas. This contract uses
///            commit-reveal, and critically the commitment is bound to msg.sender — so a
///            copied reveal is worthless to anyone but the original committer.
///
///         2. UNRUGGABLE. There is no owner withdrawal path. Once ether is committed to a
///            stage it can only ever leave via a correct reveal, or roll forward into a
///            later stage of the same hunt. The curator cannot take it back. Ever.
///
///         3. PUBLICLY VERIFIABLE. The answer hash for every stage is written on-chain when
///            the stage is created and can never be changed. That is the on-chain proof that
///            a solution existed from the start and was not invented after the fact — which
///            is the single accusation every treasure hunt has to survive.
///
///         Answers are hashed with sha256 rather than keccak256 purely for tooling ergonomics:
///         sha256 is a precompile here and is available natively in Node/Python/browsers, so
///         puzzle tooling needs no dependencies to compute a matching hash.
///
///         ANSWER NORMALIZATION (enforced off-chain, documented on-chain):
///         Answers are uppercase A-Z only, no spaces or punctuation.
///         "count the blocks" -> "COUNTTHEBLOCKS". Clients must normalize before hashing.
contract TreasureHunt {
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Stage {
        bytes32 answerHash; // sha256(normalized answer). Immutable once set.
        uint256 prize; // wei escrowed for this stage
        address solver; // address(0) until solved
        uint64 createdAt; // block number the stage was created
        uint64 solvedAt; // block number of the winning reveal
        bool exists;
    }

    struct Commitment {
        bytes32 hash; // sha256(answer, committer, salt)
        uint64 blockNumber; // block the commitment landed in
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice May create and fund stages. May NOT withdraw. Cannot alter a published hash.
    address public immutable curator;

    /// @notice Blocks that must elapse between commit and reveal. Prevents an observer from
    ///         bundling their own commit+reveal into the same block as a victim's reveal.
    uint64 public immutable revealDelay;

    /// @notice Blocks after which an unsolved stage's prize may be rolled into another stage.
    ///         This is an anti-dead-money valve, not a withdrawal path.
    uint64 public immutable rolloverAfter;

    uint256 public stageCount;

    mapping(uint256 => Stage) public stages;

    /// @dev stageId => committer => their latest commitment
    mapping(uint256 => mapping(address => Commitment)) public commitments;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event StageCreated(uint256 indexed stageId, bytes32 answerHash, uint256 prize);
    event StageFunded(uint256 indexed stageId, address indexed from, uint256 amount, uint256 newPrize);
    event Committed(uint256 indexed stageId, address indexed committer, bytes32 commitment);
    event Solved(uint256 indexed stageId, address indexed solver, uint256 prize);
    event RolledOver(uint256 indexed fromStageId, uint256 indexed toStageId, uint256 amount);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotCurator();
    error NoSuchStage();
    error AlreadySolved();
    error NoCommitment();
    error RevealTooEarly();
    error BadCommitment();
    error WrongAnswer();
    error NothingToRollover();
    error RolloverTooEarly();
    error SameStage();
    error EmptyHash();
    error TransferFailed();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param _revealDelay   Blocks between commit and reveal. 5-20 is sane on a fast chain.
    /// @param _rolloverAfter Blocks before an unsolved stage can roll forward. Set this long
    ///                       (months) — it exists so a genuinely unsolvable stage doesn't
    ///                       entomb the prize, not as an escape hatch.
    constructor(uint64 _revealDelay, uint64 _rolloverAfter) {
        curator = msg.sender;
        revealDelay = _revealDelay;
        rolloverAfter = _rolloverAfter;
    }

    modifier onlyCurator() {
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    // -----------------------------------------------------------------------
    // Stage lifecycle
    // -----------------------------------------------------------------------

    /// @notice Create a stage and fund it in one call. The answer hash is written now and is
    ///         immutable — this is the public commitment that a solution exists.
    /// @param answerHash sha256 of the normalized answer (uppercase A-Z, no separators).
    function createStage(bytes32 answerHash) external payable onlyCurator returns (uint256 stageId) {
        if (answerHash == bytes32(0)) revert EmptyHash();

        stageId = stageCount++;
        stages[stageId] = Stage({
            answerHash: answerHash,
            prize: msg.value,
            solver: address(0),
            createdAt: uint64(block.number),
            solvedAt: 0,
            exists: true
        });

        emit StageCreated(stageId, answerHash, msg.value);
    }

    /// @notice Add to a stage's prize. Deliberately open to anyone — third parties topping up
    ///         the pot is good for the hunt, and there is no path for funds to come back out
    ///         except to a solver.
    function fundStage(uint256 stageId) external payable {
        Stage storage s = stages[stageId];
        if (!s.exists) revert NoSuchStage();
        if (s.solver != address(0)) revert AlreadySolved();

        s.prize += msg.value;
        emit StageFunded(stageId, msg.sender, msg.value, s.prize);
    }

    // -----------------------------------------------------------------------
    // Commit / reveal
    // -----------------------------------------------------------------------

    /// @notice Step 1 of claiming. Publish a commitment that leaks nothing about the answer.
    /// @param commitment sha256(abi.encodePacked(answer, msg.sender, salt))
    ///
    /// @dev The commitment binds to msg.sender. An attacker who later watches your reveal
    ///      transaction learns the answer and the salt — but cannot use them, because their
    ///      own address produces a different commitment hash and they have no matching
    ///      commitment on record. To beat you they would have had to commit *before* you,
    ///      which requires already knowing the answer.
    ///
    ///      Re-committing overwrites your previous commitment and restarts your delay.
    function commit(uint256 stageId, bytes32 commitment) external {
        Stage storage s = stages[stageId];
        if (!s.exists) revert NoSuchStage();
        if (s.solver != address(0)) revert AlreadySolved();

        commitments[stageId][msg.sender] = Commitment({hash: commitment, blockNumber: uint64(block.number)});

        emit Committed(stageId, msg.sender, commitment);
    }

    /// @notice Step 2 of claiming. Reveal the answer and salt; the prize is paid immediately.
    /// @param answer The normalized answer (uppercase A-Z, no separators).
    /// @param salt   The same random salt used to build the commitment.
    function reveal(uint256 stageId, string calldata answer, bytes32 salt) external {
        Stage storage s = stages[stageId];
        if (!s.exists) revert NoSuchStage();
        if (s.solver != address(0)) revert AlreadySolved();

        Commitment memory c = commitments[stageId][msg.sender];
        if (c.hash == bytes32(0)) revert NoCommitment();
        if (block.number < uint256(c.blockNumber) + uint256(revealDelay)) revert RevealTooEarly();

        // The commitment must match this exact (answer, sender, salt) triple.
        bytes32 expected = sha256(abi.encodePacked(answer, msg.sender, salt));
        if (expected != c.hash) revert BadCommitment();

        // ...and the answer must actually be the answer.
        if (sha256(bytes(answer)) != s.answerHash) revert WrongAnswer();

        // Effects before interaction.
        uint256 prize = s.prize;
        s.prize = 0;
        s.solver = msg.sender;
        s.solvedAt = uint64(block.number);
        delete commitments[stageId][msg.sender];

        emit Solved(stageId, msg.sender, prize);

        if (prize > 0) {
            (bool ok,) = payable(msg.sender).call{value: prize}("");
            if (!ok) revert TransferFailed();
        }
    }

    // -----------------------------------------------------------------------
    // Rollover
    // -----------------------------------------------------------------------

    /// @notice Move an unsolved, stale stage's prize into another unsolved stage.
    ///         Not a withdrawal: funds can only ever move between stages of this hunt.
    ///         Callable by anyone once the stage is stale, so it isn't a curator privilege.
    function rollover(uint256 fromStageId, uint256 toStageId) external {
        if (fromStageId == toStageId) revert SameStage();

        Stage storage from = stages[fromStageId];
        Stage storage to = stages[toStageId];
        if (!from.exists || !to.exists) revert NoSuchStage();
        if (from.solver != address(0)) revert AlreadySolved();
        if (to.solver != address(0)) revert AlreadySolved();
        if (from.prize == 0) revert NothingToRollover();
        if (block.number < uint256(from.createdAt) + uint256(rolloverAfter)) revert RolloverTooEarly();

        uint256 amount = from.prize;
        from.prize = 0;
        to.prize += amount;

        emit RolledOver(fromStageId, toStageId, amount);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Everything a solver or a skeptic needs, in one call.
    function stageInfo(uint256 stageId)
        external
        view
        returns (bytes32 answerHash, uint256 prize, address solver, uint64 createdAt, uint64 solvedAt)
    {
        Stage storage s = stages[stageId];
        if (!s.exists) revert NoSuchStage();
        return (s.answerHash, s.prize, s.solver, s.createdAt, s.solvedAt);
    }

    /// @notice Block number from which `msg.sender` may reveal on a stage. 0 if not committed.
    function revealableAt(uint256 stageId, address committer) external view returns (uint256) {
        Commitment memory c = commitments[stageId][committer];
        if (c.hash == bytes32(0)) return 0;
        return uint256(c.blockNumber) + uint256(revealDelay);
    }

    /// @notice Total wei still escrowed across all unsolved stages.
    function totalEscrowed() external view returns (uint256 total) {
        uint256 n = stageCount;
        for (uint256 i = 0; i < n; ++i) {
            total += stages[i].prize;
        }
    }

    /// @dev Accept plain transfers as an untargeted donation to stage 0, if it exists and is
    ///      unsolved. Keeps "someone sent ETH to the contract" from becoming stuck value.
    receive() external payable {
        Stage storage s = stages[0];
        if (!s.exists || s.solver != address(0)) revert NoSuchStage();
        s.prize += msg.value;
        emit StageFunded(0, msg.sender, msg.value, s.prize);
    }
}
