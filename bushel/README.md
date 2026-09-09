# whatever.fun

A launchpad for coins priced in real things.

Every memecoin on every chain is priced in the same two things: the chain's own token, or a dollar.
Robinhood Chain is the first place where that does not have to be true — it has tokenized gold,
silver, oil, treasuries, India, SpaceX and two hundred other assets, and its launch factory already
accepts them as the pairing asset for a new coin. So a coin can be priced in ounces. Its chart can
be denominated in barrels. Its performance can be measured against the thing it was paired with
rather than against the dollar, and those are different questions with different answers.

Almost nobody does it. On a reading taken at 15:00 UTC on 8 September 2026, this chain was running
about **64,000 launches a day** — it is Arbitrum Nitro at a tenth of a second a block, so a
100,000-block window is 2.8 hours — and 56% of them were priced against NVIDIA, 29% against ether,
6% against USDG. Gold got about 240 a day. Silver got none at all that afternoon.

That rate is not a constant: a reading eight hours earlier put the same chain at half the volume
and a different split. Treat every count here as a timestamped observation, and re-run the tools
rather than quoting them.

That is the gap this is aimed at: not access — anyone can already launch a coin priced in gold — but
a place where it is the point.

> **Status: Phase 0.** No contract of ours is deployed and none is written. `site/` is a front end
> over the incumbent's factory: it launches through Pons V2, takes no fee, and adds the part that
> is missing — a menu that prices every pairing asset in dollars, says how deep each one's own
> market is, and shows what a launch against it actually opens at.
>
> **We are not alone in this any more.** [anything.fun](https://anything.fun) is the same product on
> the same chain, live since the small hours of 8 September 2026, and it runs its own factory rather
> than the incumbent's. `docs/competition.md` has what they have, what we have, and what it changes.
> The short version: Phase 0 was meant to answer whether to write the Solidity, and a competitor
> deploying their own factory on day one is an argument for yes.

## What is established

Read from chain on 8 September 2026; `node scripts/pairs.js` and `node scripts/menu.js` reproduce
all of it.

- **57 pairing assets are live**: native ether, USDG, 53 of Robinhood's 194 tokenized assets, and
  two tokens from outside that registry — **cbBTC** (8 decimals) and **TAO**. That last fact is the
  important one: the allowlist is not confined to Robinhood's own tokens, so a token somebody else
  issues can end up on it.
- **The same launch is not the same launch.** The factory's opening price for a pair is set by a
  per-asset number an operator typed by hand (`pairTokenEconomics.phantomQuote`) and has not
  revisited. Priced in dollars, the identical one-click launch opens anywhere from **$3,179 to
  $7,016** — a 2.21× spread that nothing about the assets explains. `node scripts/opening.js` shows
  the arithmetic; it is the clearest argument for building this properly.
- **The interesting end is empty.** In one 2.8-hour window: GLD 28, cbBTC 14, SGOV 13, INDA and
  SLV and WYFI none at all — while NVIDIA took 4,205.
- **All 57 have a market, but seven are thin.** An earlier reading here said thirty assets had no
  market at all, silver and oil among them. That was wrong: DexScreener's multi-token endpoint caps
  its answer at thirty pairs however many addresses you ask for, and the script read a truncated
  answer as a negative one. Every asset trades; seven sit under $100k of their own depth, which is
  shallow enough that one trade moves the price a launch is denominated in, and the site labels
  those rather than hiding them.
- **No soft commodities exist here.** Nothing in Robinhood's 194 is coffee, cocoa, wheat, sugar or
  uranium. A coin genuinely priced in coffee needs somebody to issue the coffee token first, and to
  have an honest answer for what stands behind it. That question is open, and it is the one worth
  getting right rather than fast.

`docs/pair-assets.md` is the long version, with the tables.

## Running it

```
node scripts/menu.js                   # build site/data/menu.json, which the site reads
node scripts/pairs.js                  # the menu, and what launchers actually chose
node scripts/prices.js                 # each pairing asset's price and its own market's depth
node scripts/opening.js                # what the same launch opens at, priced in each asset
node scripts/lint.js                   # every script parses, every config is JSON

npm run serve                          # serve site/ on http://127.0.0.1:4174
node test/launch.test.js               # the seam between site/app.js and site/launch.js
npx playwright test -c test/site/playwright.config.js    # 16 browser tests
node test/site/shots.js                # photograph every route, desktop and phone
```

Everything read-only, no key, no dependency: Robinhood's registry is one HTTP call and the rest is
`eth_call` and `eth_getLogs` against the endpoints in `config/addresses.json`, rotated because the
official one rate-limits hard. `scripts/chain.js`, `scripts/keccak.js`, `scripts/secp256k1.js` and
`scripts/devnet.js` are carried over from [13V/manna](https://github.com/13V/manna), same author,
same style, MIT.

## Layout

| Path | What |
|---|---|
| `site/` | The front end: plain files, five routes, no build step of its own |
| `site/app.js` | The shell — menu table, launch form, recent launches, live prices |
| `site/launch.js` | Launch calldata: encode, validate, preflight, send. Verified byte-identical against real launches |
| `site/model.js` | The hero's animated model — loaded late, off by default on a metered line, and never at the cost of a hole in the page |
| `site/vendor/` | A pre-built, tree-shaken three.js + GLTFLoader. Somebody else's code; see below |
| `site/models/` | The hero model, compressed. CC BY 4.0 — the credit is in the footer |
| `scripts/menu.js` | Builds `site/data/menu.json`: identity, market, launch terms and demand per asset |
| `scripts/pairs.js` | What a coin can be priced in on this chain, and what anyone actually chose |
| `scripts/prices.js` | Each pairing asset's dollar price and the depth of its own market |
| `scripts/opening.js` | What the same launch opens at against each asset — the spread argument |
| `scripts/devnet.js` | An in-memory JSON-RPC chain on `@ethereumjs/vm`, for local work |
| `scripts/chain.js` | Dependency-free JSON-RPC client: ABI encode/decode, signing, receipts |
| `test/` | The browser suite, the launch seam test, and the screenshot pass |
| `config/addresses.json` | Chain id, RPC endpoints, USDG, WETH, the Pons factory and its friends |
| `docs/pair-assets.md` | The pairing-asset research, with its numbers and how they were read |
| `docs/competition.md` | anything.fun: what a live competitor on this chain has, and what it changes |

## The one dependency, and the one credit

The hero has an animated 3D scene in it, which needs a renderer, which is the only third-party code
in this repository. `site/vendor/three-gltf.min.js` is [three.js](https://threejs.org) (MIT) with
`GLTFLoader` and the meshopt decoder, tree-shaken to just what `site/model.js` imports — 640KB,
about 166KB over the wire once a server gzips it. It is vendored rather than fetched from a CDN, for
the same reason the two fonts are: a page that cannot draw itself when somebody else's host is slow
is not a serious instrument. It was built with:

```
npm i three esbuild
esbuild entry.js --bundle --format=esm --minify --outfile=site/vendor/three-gltf.min.js
```

where `entry.js` re-exports the dozen symbols `site/model.js` uses. That is a build step, but it is
one that produced a checked-in artefact once — there is still nothing to run to serve this site.

The model is also where the site's colours come from. Its textures are near-black terrain, deep
aubergine, mid violet and a hot magenta, and those are sampled by area rather than picked by eye —
`#2A074D`, `#6A359F`, `#B123B1`, `#C671E2` are all straight out of it. The page is the ground that
scene sits on, so it shares its palette or the model looks like a stock image on a stranger's site.

**The model is “Cloud Station” by [Alexa Kruckenberg](https://sketchfab.com/AlexaKruckenberg),
licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)**
([source](https://sketchfab.com/3d-models/cloud-station-26f81b24d83441ba88c7e80a52adbaaf)). The
licence requires attribution, so the credit is in the footer of every page, at the top of
`site/model.js`, and here. If the model is ever swapped, the credit goes with it. A test asserts
the footer credit is present, because a licence term that only survives while nobody edits the
footer is not being honoured.

It ships at 751KB, down from the original 4.4MB, via `gltf-transform`: dedupe, prune, resample the
animation, WebP textures at quality 80, resize to 1024, then meshopt. The 147-channel animation and
all four skins survive that intact — checked, because "the file got smaller" and "the file still
animates" are different claims.

## What this does not do

It does not run our own contracts. A launch made here is a Pons V2 launch: their factory, their
curve, their 0.0005 ETH fee, their audit status, and their per-asset opening price with all the
inconsistency described above. Nothing here can fix that, and nothing here pretends to.

## The name

whatever.fun, because that is the claim: whatever you can name and this chain can price, a coin can
be paired with. The working title was Bushel — a unit of grain, eight gallons of it, which is how
wheat and corn have been sold for six hundred years — and the directory is still called that.

The site's own headline is the whole product in two lines: *You can price a coin in oil. Almost
nobody does.*
