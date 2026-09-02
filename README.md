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

---

# Stonk Packs

Booster packs with real tokenized stocks inside, for Robinhood Chain.

> $20 in USDG. Five pulls. Most are a dollar of Ford. One in two thousand packs holds a whole share of Eli Lilly.

A pack is an ERC-721 you can hold, trade or gift sealed. Opening it burns the pack and pays
five random pulls straight into the holder's wallet as Robinhood stock tokens, sized by each
stock's Chainlink feed. Sealed packs sell at 3am on a Sunday because the chain never closes.

```
contracts/StonkPacks.sol       The pack contract. ERC-721 packs, odds table, seed chain, feeds, escrow, IOUs.
contracts/test/PackMocks.sol   Test doubles only.
scripts/packs/odds.js          Odds table, expected value, seed-chain generator, and a byte-exact
                               mirror of the contract's randomness so anyone can verify any pack.
scripts/packs/operator.js      The bot that reveals seeds in order, refunds and skips expired packs.
scripts/packs/test.js          81 integration tests against the compiled contract in a real EVM.
```

```bash
node scripts/packs/odds.js rtp          # the table and its return to player
node scripts/packs/odds.js chain 10000  # operator secret + the root you deploy with
node scripts/packs/test.js              # 81 passed, 0 failed
```

## The odds

| Tier | Chance per pull | Value | Paid in |
|---|---|---|---|
| Common | 72% | $1 | F, AMC, BB, SOFI, RIVN, SNAP, CCL, HIMS, SOUN, RCAT |
| Uncommon | 20% | $3 | AAPL, MSFT, GOOGL, AMZN, META, COIN, INTC, AMD, NFLX, RBLX |
| Rare | 6% | $12 | NVDA, TSLA, PLTR, MSTR, SPCX, GME, GLD, TTWO |
| Epic | 1.8% | $50 | COST, ASML, NET, AVGO, UNH |
| Legendary | 0.19% | $200 | CELH, LULU, IREN, WULF, GLXY, RKLB |
| Mythic | 0.01% | $1,163 | LLY, one whole share |

Expected payout is $17.18 on a $20 pack, an 85.9% return to player, with 10% of each opened
pack going to `feeRecipient`. Point that at a fee distributor and the pack coin pays its
holders. The table is a constructor-time choice and can be locked forever with `lockOdds()`.

## Why nobody can cheat

**Buyers.** A pull is `keccak(operatorSeed, buyerSeed, packId, holder, blockhash(purchaseBlock + 1))`.
The buyer picks their seed before the operator seed is known, the operator seed is fixed before
the buyer's is known, and the block hash exists after both. The open is a separate transaction
by a different party, so a contract buyer has nothing to revert.

**The operator.** Seeds form a hash chain, `seed_k = keccak(seed_{k+1})`, whose root is published
at deployment. Pack k can only be opened with the one seed that hashes to the current head, and
packs open strictly in order, so the operator cannot pick outcomes, skip a pack they can see the
result of, or reorder buyers. Once the odds are locked, `odds.js verify` recomputes any pack from
public inputs and the test suite proves the mirror matches the chain pull for pull.

**Liveness.** An operator who stops revealing freezes the game in public. Any pack unopened for
200 blocks becomes refundable by anyone, the refund goes to the holder in full with no fee,
and the pack's seed is then consumed by `skip` so the chain moves on. Stalling costs the sale
and is visible on-chain.

Chainlink lists VRF v2.5 for Robinhood Chain. Moving to it is a two-step open, a request in
`open` and the payout in the fulfil callback, and it removes the operator entirely. The hash
chain ships first because every property above is testable end to end today without a network.

## Degraded modes, all tested

- Treasury is out of a stock: the pull pays the same USD in the payment token.
- Treasury is out of cash too: the pull becomes an IOU, claimable the moment funds arrive,
  and the owner can never withdraw below escrow plus IOUs.
- A stock's feed is stale, or paused around a corporate action: cash instead of a stale price.
- The L2 sequencer is down or just restarted: cash, per the Chainlink sequencer-feed pattern.
- The owner changes the pack price: sealed packs keep the price they paid for fee, escrow and refund.

## Deploying on Robinhood Chain

Chain id 4663, gas in ETH. Payment token is USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`,
6 decimals. Stock tokens are 18 decimals and the canonical list, with addresses, comes from
`https://api.robinhood.com/rhj/assets`; `node scripts/packs/odds.js tiers` prints the `setTier`
calls for the default table with live addresses. Feed proxy addresses and heartbeats are on
Chainlink's Robinhood Chain price feeds page. Read them from there; do not hardcode.

1. `node scripts/packs/odds.js chain 10000`. Keep the secret offline. Deploy with the root.
2. `setTier` for each tier, `setFeed` for every token with its heartbeat, `setSequencerFeed`,
   then `lockOdds()`. Publish the root and the locked table.
3. Buy inventory on the DEX or via RFQ and transfer it to the contract. Thin-float stocks in the
   Legendary tier are the ones nobody can buy on-chain, which is the point.
4. Run the operator: `RPC_URL=... PACKS_ADDRESS=... OPERATOR_KEY=... PACK_SECRET=... node scripts/packs/operator.js`.
   Opening is permissionless; the key just pays gas.

Stock token amounts are raw units. The feed already includes the corporate-action multiplier,
so `usd / feedPrice` is the right number of tokens without touching `uiMultiplier()`.

## Caveats

- **Unaudited.** The suite is thorough about the properties it tests. It is not an audit.
- Provable fairness covers the odds. Prize solvency is the operator's inventory and reputation,
  the same as any pack seller. Cash and IOU fallbacks exist so an open never fails.
- On Arbitrum-style chains `block.number` tracks the parent chain and `blockhash` is a
  chain-provided pseudo-random value. It is one of three entropy sources here, not the only one.
- Loot boxes containing securities are a regulated shape in most jurisdictions. That is out of
  scope of this repo and was parked deliberately.
