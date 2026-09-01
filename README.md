# Treasure Hunt

A multi-stage public puzzle hunt with a real, on-chain, publicly verifiable prize.

> There is money in this wallet. Anyone can check the balance.
> The answer is hidden in the chain. First to find it takes it.

Two things make this work rather than being another unclaimable jpeg:

1. **The prize is provable.** The contract's balance is public, and the hash of the answer is
   written on-chain before anyone starts. Nobody has to trust a word the team says.
2. **The winner actually gets paid.** Commit-reveal binds a claim to the claimant's address,
   so a bot that lifts the answer out of the mempool cannot spend it.

## Layout

```
contracts/TreasureHunt.sol   Prize escrow. Commit-reveal, no owner withdrawal path.
scripts/puzzle.js            Puzzle construction and solving toolkit. Zero dependencies.
scripts/test.js              25 tests, incl. the front-running suite.
```

```bash
node scripts/puzzle.js solve     # walk both stages as a solver would
node scripts/puzzle.js stage1    # emit the stage 1 artifacts
node scripts/test.js             # run everything
```

## Why the prize doesn't get stolen

The naive design — *submit the answer, get paid* — loses the prize every time. The winning
transaction sits in the mempool with the answer in plain sight; a bot copies it and outbids
the solver on gas. This has killed real hunts.

The fix is commit-reveal, with one detail doing all the work:

```solidity
commitment = sha256(abi.encodePacked(answer, msg.sender, salt))
```

The commitment is **bound to the committer's address**. An attacker who watches your reveal
learns the answer *and* the salt — and still cannot use them, because their address produces a
different commitment hash and they have no matching commitment on record. To beat you they
would have had to commit first, which requires already knowing the answer.

`revealDelay` blocks must pass between commit and reveal, so an observer can't bundle their own
commit and reveal into the same block as your reveal.

This is the property `scripts/test.js` spends most of its assertions on.

## Why the team can't rug it

- **No withdrawal function.** Funds leave only via a correct reveal, or roll forward into another
  unsolved stage of the same hunt. There is no path back to the curator.
- **The answer hash is immutable.** Written at stage creation, never updatable. This is the
  on-chain proof that a solution existed from the start — which is the accusation every hunt
  has to survive (*"it's unsolvable and they'll keep the money"*).
- **`rollover` is permissionless** and only fires after `rolloverAfter` blocks. It exists so a
  genuinely unsolvable stage doesn't entomb the prize forever, and it can only move money
  between stages.

## The puzzle design

The chain is the board. Every clue lives on-chain, which is thematic, permanently timestamped
(proving nothing was changed after the fact), and impossible to replicate off-chain.

**Stage 1 — The Ledger.** Prize: small ($500–1k). Its job is to prove the contract pays.

| Layer | Medium | Yields |
|---|---|---|
| A | Dust transfer **amounts** are ASCII codes, ordered by block time | `SECRET` |
| B | Vigenère ciphertext in the token's on-chain metadata, keyed by A | `COUNT THE BLOCKS` |

Readable in a block explorer with no tools. Falls in hours to a coordinated group — deliberately.
**Stage 1 must fall**, or nobody believes any of it is solvable.

**Stage 2 — Count the Blocks.** Prize: the main pot.

| Layer | Medium | Yields |
|---|---|---|
| A | Transfer **destination addresses** — first byte of each is an ASCII code | `LEDGER` |
| B | Vigenère ciphertext committed in the deployment calldata, keyed by A | `NOTHING IS HIDDEN ONLY UNREAD` |

The escalation is the point: stage 1 taught *amounts carry data*, stage 2 moves the signal to
*destinations* and makes the amounts uniform and meaningless. Later stages can assume that
literacy and get much harder.

### Three rules the design is built on

- **Layers, not one wall.** A monolithic puzzle either falls in an hour or never falls.
- **Verifiable progress.** `SECRET` being a real word tells solvers they cracked layer A before
  attempting layer B. Without that signal people quit and the hunt dies before it's won.
- **Publish the final answer's hash at launch.** It costs nothing and pre-empts the only
  accusation that can kill the project.

### Why the answer isn't the private key

A private key is 256 bits of entropy; a riddle has perhaps 30. "The key is hidden in this image"
is structurally unsafe — anything a human can reason out, a machine can enumerate. So the puzzle
yields a **phrase**, the contract holds only its **hash**, and the contract pays the solver.
Brute force gets you nothing without paying gas per guess.

## Answer normalization

Uppercase `A-Z` only. Everything else is stripped before hashing.

```
"count the blocks"  ->  "COUNTTHEBLOCKS"
```

This must be identical in the contract docs, the site, and the tooling, or solvers will produce
non-matching hashes and conclude the puzzle is broken.

## Deploying

```
constructor(uint64 revealDelay, uint64 rolloverAfter)
```

- `revealDelay` — 5–20 blocks on a fast chain.
- `rolloverAfter` — set this **long** (months). It's an anti-dead-money valve, not an escape hatch.

Then `createStage(answerHash)` with the prize as `msg.value`. Get hashes from
`node scripts/puzzle.js hash "<answer>"`.

`sha256` is used rather than `keccak256` purely for tooling ergonomics — it's a precompile in
Solidity and native in Node, so hashes computed here match the chain with zero dependencies.

## Status and caveats

- The contract is **unaudited**. Do not put real money in it before an audit.
- `grindVanity` in the toolkit is a **cost demonstration**, not a keypair generator. Use a real
  vanity address tool to produce stage 2's destinations.
- Puzzle answers are committed in `scripts/puzzle.js` in plaintext. Before any real launch,
  move them out of the repo — publish only the hashes.
- Legal structure is deliberately out of scope here. A prize contest with real money touches
  lottery and sweepstakes law; that needs counsel before launch, not after.
