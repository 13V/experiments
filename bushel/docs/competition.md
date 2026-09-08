# Somebody else is building this

Read 8 September 2026, from anything.fun's own public API and from chain.

**anything.fun is the same product, on the same chain, and it is live.** Its own meta description:
"A launchpad for unexpected pairs on Robinhood Chain. Explore quote assets, save ideas, and launch
tokens with your wallet." That is this repository's thesis, shipped by somebody else.

This document exists because the README used to say the interesting half of the pairing-asset
allowlist was empty *because nobody had made it the point*. That is no longer true, and a plan built
on it would be built on a fact that expired.

## What they have

| | |
|---|---|
| `GET /api/health` | `{"status":"ok","siteMode":"full","storage":"sqlite","chainId":4663,"launchReady":true}` |
| Their factory | `0xB3D111350643CDc2eE710A078cb23aD700644c11` — **their own**, not Pons V2's `0x7ed598…` |
| Confirmed launches | **8** |
| When | all of them on 8 September 2026, between **01:58 and 02:50 UTC** |
| Catalogue | 8 confirmed + 9 seeded "example" markets |
| Pairs used | `zzec` ×2, `nvda` ×2, `usdg` ×2, `gme`, `chump`, `pons`, `paper`, `oil`, `dram`, `gold`, `pepe`, and one `custom-4663-0x…` |
| Charts | GMGN (`gmgn.cc/kline/robinhood/`) |
| Liquidity at graduation | burned to `0x…dEaD`, 100%, creator fees off |

Confirmed independently on chain rather than taken from their own API: their factory address holds
**11,514 bytes of bytecode** — a real deployed contract, not a proxy stub — and emitted **9 events in
the last 25 hours, the earliest at 01:25 UTC on 8 September 2026**. Two sources, one story.

So: they are roughly **one hour of launches old**. Eight tokens, in a fifty-two minute window, on a
chain doing sixty-four thousand launches a day. They are not an incumbent. They are a competitor who
shipped first.

## What they got right that we have not

1. **They run their own contracts.** We are a front end over Pons V2 — their fee, their curve, their
   audit status, their hand-typed opening prices. anything.fun deployed a factory. That is the whole
   difference between taking a cut and not, and between fixing the 2.21× spread and only describing
   it.
2. **They are wrapping the exotics.** Their pair list includes `oil`, `gold`, `paper`, `dram`,
   `chump` and a `custom-4663-…` address, and their API labels instruments
   `custodial-wrapped-crypto` with `trust: "community"`. The coffee-bean question this project put
   off, they answered — by wrapping things themselves and labelling the trust level.
3. **They have a backend.** Saved drafts, wallet challenge/verify, token icons, a market catalogue.
   Ours is a static directory and a JSON file.

## What we have that they do not

1. **The numbers are real and they are checkable.** Every figure on our site is read from chain by a
   script in this repository that anyone can re-run. Their catalogue is nine examples and eight
   launches served from a sqlite file.
2. **The spread argument.** The identical launch opens between $3,179 and $7,016 on the incumbent
   depending only on which asset you pick. We measured it, we can reproduce it, and it is the front
   page. Nothing on their site addresses it.
3. **The honesty flags.** We label the seven assets whose own market is under $100k, because a coin
   priced in something one trade can move is a different product from a coin priced in gold. Their
   "trust: community" label is the same instinct, applied to a different risk.

## What this changes

The bet is no longer "will anyone want this". Somebody funded and shipped it, which is weak evidence
that they think the answer is yes, and eight launches in an hour is not yet evidence either way about
whether the market agrees.

The bet is now **"can this be done better"**, and the honest answer to that is the same as it was:
not while we are a front end over somebody else's factory with somebody else's hand-typed prices.
Phase 0 was always meant to answer whether to write the Solidity. A competitor deploying their own
factory on day one is an argument for doing it, and for doing it with the thing they have not done —
an opening price that is derived rather than typed, so that the same launch means the same thing
whichever asset it is paired against.

None of the above is a reason to hurry. It is a reason to be specific.
