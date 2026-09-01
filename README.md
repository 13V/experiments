# Treasure Hunt

A multi-stage public puzzle hunt with a real, on-chain, publicly verifiable prize.

> There is money in this wallet. Anyone can check the balance.
> The key is already on the chain, in plain sight. First to see it takes it.

Two properties make this a hunt rather than another unclaimable jpeg:

1. **The prize is provable.** The escrow balance is public, and the address the puzzle
   terminates in is written on-chain before anyone starts. Nobody has to trust the team.
2. **The winner actually gets paid.** The claim signature commits to the winner's own
   payout address, so a bot that lifts it out of the mempool can only rebroadcast it and
   pay gas to hand the money to the winner.

## Layout

```
contracts/TreasureHunt.sol   Prize escrow. Signature-bound claims, no withdrawal path.
scripts/keccak.js            keccak256. Node has SHA3-256, which is NOT the same thing.
scripts/secp256k1.js         Curve, addresses, RFC 6979 signing, ecrecover.
scripts/puzzle.js            Hunt construction, solving, and claim building.
scripts/test.js              50 unit tests. Zero dependencies.
scripts/evm-test.js          32 integration tests against the real compiled contract.
```

```bash
node scripts/test.js         # 50 passed, 0 failed
node scripts/puzzle.js solve # walk both stages, then claim, as a solver would
node scripts/puzzle.js newkey

# Integration tests need a compiler and an EVM:
npm install --no-save solc@0.8.28 @ethereumjs/vm@8.1.1 @ethereumjs/common@4.4.0 @ethereumjs/util@9.1.0
node scripts/evm-test.js     # 32 passed, 0 failed
```

Everything shipping is dependency-free. keccak256 and secp256k1 are implemented here
from scratch and pinned to published vectors — `keccak256("") = c5d2...a470`, private key
`0x…01` → `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` — because a subtly wrong curve
derives a `puzzleSigner` nobody can ever sign for, and entombs the prize while producing
an on-chain proof that it was solvable.

## Why the prize doesn't get stolen

The naive design — *submit the answer, get paid* — loses the prize every time. The winning
transaction sits in the mempool with the answer in plain sight; a bot copies it and outbids
the solver on gas. This is not hypothetical: it is how Bitcoin puzzle transactions #66 and
#69 were taken from the people who solved them.

The fix is that **the puzzle terminates in a private key, not a phrase**, and the solver
signs a digest containing their own payout address:

```solidity
sha256(abi.encodePacked(stageId, recipient, address(this), block.chainid))
```

A validator, sequencer, RPC operator or copying bot who lifts that transaction can do
exactly one thing with it: rebroadcast it, and pay gas to send the money to the rightful
winner. The recipient is *inside* the signed message. There is nothing to redirect.

`scripts/evm-test.js` runs that attack against the real compiled bytecode in a real EVM:
the hijack reverts with `BadSignature()`, and the same attacker relaying the transaction
verbatim succeeds and pays the winner.

This replaces an earlier commit-reveal design, which worked but was strictly worse on four
axes at once:

| | commit-reveal | signature-bound |
|---|---|---|
| Front-running | solved | solved |
| Transactions to claim | two | one |
| Reveal window to be griefed in | yes | none |
| Offline brute force | **the commitment is a free, permanent, unlimited-rate oracle against ~30 bits** | 256-bit key, nothing to grind |

That last row is the one that mattered. Brain wallets holding more entropy than any English
passphrase get drained within minutes of funding.

## The one design rule

**The secret must be discovered, never guessed.** Every byte of the key is published
on-chain from day one. The puzzle is working out *where* those bytes are and *in what
order*. Difficulty lives in the reading, never in the guessing.

This rules out the whole classical-cipher family — Vigenère, substitution, rail fence,
acrostics. A current frontier model solves all of them instantly from a screenshot, so they
cost a solver nothing and cost the hunt its entire middle game. An earlier draft of this
repo was built on a Vigenère and it was dead on arrival. What survives is work that no
amount of cleverness shortcuts: reading a lot of chain data and noticing structure in it.

## The stages

**Stage 1 — The Ledger.** Prize: small. Its only job is to prove the contract pays.

The puzzle wallet makes 32 dust transfers. `amount = (key byte + 256) / 1e7`, so every
amount lands between `0.0000256` and `0.0000511` — uniform width, none of them zero, and
the only variation is in the last three digits. Subtract 256 from each, read in block
order, and you have 32 bytes. Readable in any block explorer with no tools.

**Stage 1 must fall**, quickly and visibly, or nobody believes any of it is solvable.

**Stage 2 — The Split.** Prize: the main pot. The key is XOR-split three ways.

| Share | Where | Cost |
|---|---|---|
| A | Published in the clear at launch, in the deployment calldata | Free, and worthless alone |
| B | Last byte of each of 32 crafted destination addresses | Stage 1 taught *amounts* carry data; here the amounts are uniform and meaningless. The signal moved. |
| C | Released by drand timelock at a pre-announced block | Nobody can finish early |

XOR splitting is not "hard to reverse" — it is information-theoretically empty. Two of the
three shares tell you exactly as much as zero of them, which is what keeps the stage alive
after the first share is found and posted publicly. The timelocked share means the grand
prize is a fair start for everyone who did the work, not a prize for whoever scraped fastest.

## Why the team can't rug it

- **No withdrawal function.** Not a disabled one — there is no `withdraw`, `sweep`,
  `rescue`, or `emergency` anything, and the test suite asserts on the compiled ABI that
  none has appeared. Funds leave only to a winner, or roll forward into another unsolved
  stage.
- **`puzzleSigner` is immutable.** Written at stage creation, never updatable, and a zero
  signer is refused outright — otherwise a curator could create an unsolvable stage and
  blame the puzzle. This is the on-chain proof that a solution existed from the start,
  which is the accusation every hunt has to survive.
- **`rollover` is permissionless** and only fires after `rolloverAfter` blocks. It exists
  so a genuinely unsolvable stage doesn't entomb the money, and it can only move funds
  between stages of the same hunt.
- **Payout is discretion-free.** Where an allowlist is required, eligibility is decided
  *before* the stage opens. At claim time there is no human judgement at all. Operators who
  decide who won after the fact spend years being called thieves.

## Deploying

```
constructor(uint64 rolloverAfter)
createStage(address puzzleSigner, uint64 opensAt, bool requiresAllowlist) payable
```

- `rolloverAfter` — set this **long** (months). Anti-dead-money valve, not an escape hatch.
- `opensAt` — the block claims start being accepted. `0` for immediately.
- `requiresAllowlist` — `false` for small ladder prizes, `true` for the grand prize.

Generate a key with `node scripts/puzzle.js newkey`, hide it in the chain, and pass only the
address to `createStage`. Compile with `evmVersion: cancun` (or drop to `shanghai` if you're
targeting a chain that hasn't forked — the contract itself doesn't care).

## Status and caveats

- The contract is **unaudited**. Do not put real money in it before an audit. The tests
  here are thorough about the properties they test; they are not a substitute.
- **The demo keys in `scripts/puzzle.js` are deterministic** and derivable by anyone reading
  the file. They exist so the tests and docs are reproducible. Launching with one would hand
  the prize to the first person who runs `node scripts/puzzle.js`. Use `newkey`.
- The key-hiding transactions have to actually be broadcast. Nothing here does that — it
  builds and verifies the artifacts, it does not touch a network.
- Legal structure is deliberately out of scope in this repo. A prize contest with real
  money touches lottery and sweepstakes law in most places, and the bind is sharper than it
  looks: giving token holders any advantage in winning supplies consideration and converts
  a skill contest into a lottery, while giving them a pro-rata share of the pot is about the
  cleanest security fact pattern there is. That needs counsel before launch, not after.
