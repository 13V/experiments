# What a coin can be priced in

Read from Robinhood Chain on 8 September 2026 — chain 4663, **Arbitrum Nitro**, ~0.101s blocks
(`web3_clientVersion` returns `nitro/…`; 100,000 blocks measured 10,089 seconds apart). Every number here comes from `scripts/pairs.js`,
which reads Robinhood's asset registry, asks the Pons V2 factory what it will accept as a pairing
asset, and then counts what launchers actually chose. Run it again and the counts will have moved;
run it against a different chain and it will tell you nothing, which is the point.

## The menu exists already

Pons V2's factory launches a coin against an arbitrary ERC-20: `launchToken(params, launchConfigId,
pairToken)`. The pair token has to be on an allowlist its owner controls — `approvedPairTokens`,
with terms set by `pairTokenEconomics` — and that allowlist is longer than anyone seems to use:

**57 pairing assets are live today**, on `approvedPairTokens`. Native ether is a 58th case: it is
*not* on that allowlist under any address — not the zero address, not WETH, not the usual sentinel —
yet it is the pairing asset for nearly a third of all launches, so `launchToken` special-cases it.
Native ether, USDG, 53 of Robinhood's 194 tokenized assets,
and two tokens from outside that registry entirely: **cbBTC** (Coinbase Wrapped BTC, 8 decimals) and
**TAO** (Bittensor). That last pair matters more than its trading volume: it is proof that the
allowlist is not confined to Robinhood's own tokens, and therefore that a token somebody else issues
can end up on it.

What is on the menu, by kind:

| | |
|---|---|
| Commodities | **GLD** (gold), **SLV** (silver), **USO** (oil), **cbBTC** |
| Bonds | **SGOV** (0–3 month treasuries) |
| Regional | **INDA** (India), **TSM**, **SKHY** (SK hynix), **NU**, **SHOP**, **BB** |
| Index | **SPY**, **QQQ** |
| Odd | **SPCX** (SpaceX), **GME**, **DJT**, **MSTR**, **WYFI**, **RDDT**, **HIMS** |
| The crowd | NVDA, TSLA, AAPL, META, GOOGL, AMZN, and twenty more |

## Almost nobody uses the interesting half

In the last 100,000 blocks — **2.8 hours**, because this is Arbitrum Nitro at 0.101 seconds a block
and not the two-second chain its own documentation implies — there were **7,496 launches** across 53
distinct pairing assets, a rate of about **64,000 a day**. The distribution is not close:

| pair asset | launches (2.8h) | share | per day |
|---|---:|---:|---:|
| NVDA | 4,205 | 56.1% | ~36,000 |
| native ether | 2,175 | 29.0% | ~18,600 |
| USDG | 436 | 5.8% | ~3,700 |
| SPCX | 131 | 1.7% | ~1,100 |
| AAPL | 62 | 0.8% | ~530 |
| SPY | 51 | 0.7% | ~440 |

*Read at 15:00 UTC on 8 September 2026.* **This rate moves, a lot.** A reading eight hours earlier
put the same chain at 3,520 launches in the same window size — half the volume — with ether and
NVIDIA nearly level at 39.5% and 43.3% instead of today's 29% and 56%. Neither reading is wrong;
the chain is simply this volatile, so nothing below should be quoted as a constant. `scripts/pairs.js`
re-reads it in about two minutes.

Five sixths of everything is ether or NVIDIA. And the assets that make this idea interesting stay
in the noise: **GLD 28 (~240 a day), cbBTC 14, SGOV 13, DJT 22, MSTR 17** — against NVIDIA's
thirty-six thousand. In this window **NU, SHOP, SLV and WYFI had no launches at all**.

So the constraint is not permission. Anyone can launch a coin priced in gold today, and a couple of
hundred people a day do — out of sixty-four thousand. What is missing is a place where that is the
*point* — where the menu is the product, the chart is denominated in the thing rather than in
dollars, and a coin's performance is measured against the barrel or the ounce it was paired with.

## The same button does not do the same thing

The factory opens a launch at a price set by a per-asset number, `pairTokenEconomics.phantomQuote`,
that its owner typed by hand. The curve is constant product against that virtual quote reserve, so
at t=0:

    price(pair units per token) = phantomQuote / tokensOnCurve
    opening valuation           = price x supply x (dollar price of one pair token)

Run that over the whole allowlist (`node scripts/opening.js`) and the identical one-click launch —
same supply, same curve, same fee — opens anywhere from **$3,179 (TTWO) to $7,016 (DELL)**, a
**2.21× spread**. Nothing about the assets explains it. It is entirely an artefact of when somebody
last thought about each row.

One structural fact falls out of the same data: across all 56 assets that have a row,
`graduationThreshold` is **exactly 2.5 × phantomQuote**. That single ratio is what lets native
ether — which has no row at all, despite being 29% of launches — be priced anyway: its graduation
threshold is carried in its own launch logs (4.2 ETH), and 4.2 / 2.5 gives the phantom quote the
factory must be using. `scripts/menu.js` measures the ratio rather than assuming it, and refuses to
derive anything if the assets with rows ever stop agreeing.

## The whole allowlist is tradeable — and finding that out took a retraction

Being approved is not the same as being tradeable, so `scripts/prices.js` reads each pairing asset's
own deepest pool on this chain. **Every one of the 57 has a market.** Depth varies by two orders of
magnitude, and seven assets sit under $100k, which is thin enough that a single trade moves the
price a launch is denominated in:

| depth of the asset's own market | assets |
|---|---|
| over $1M | USDG ($8.6M), ETH ($32M via WETH), SPY, NVDA, **GLD ($4.6M)**, **SGOV ($3.9M)**, AMC, **SPCX**, HIMS, AAPL, QQQ, GME, TSLA, MSTR |
| $100k–$1M | **USO ($849k)**, META, MSFT, DJT, GOOGL, AMD, PLTR, COIN, LLY, LULU, RBLX, **INDA**, **SLV ($376k)**, SHOP, IBM |
| under $100k — thin | WYFI ($99k), UPS ($95k), PFE ($81k), BB ($76k), NU ($73k), F ($53k), MRVL ($49k) |

An earlier version of this document said the opposite: that thirty assets had **no quoted market at
all**, silver and oil among them, and it concluded from that that the honest commodity story was
only gold, treasuries and wrapped bitcoin. That was wrong, and the cause is worth writing down.
DexScreener's `/latest/dex/tokens/` endpoint accepts a comma-separated list of addresses but **caps
its answer at thirty pairs regardless of how many were asked for** — a batch of thirty addresses
comes back covering thirteen of them. The assets it drops look exactly like assets with no pool. So
a script that batched twenty-five at a time read a truncated answer as a negative one and reported
two thirds of the menu as untradeable.

Both scripts now ask one address at a time, and the site refreshes through
`/latest/dex/pairs/<chain>/<ids>`, which does honour every id it is given.

The general lesson has now cost this repo three times: an empty result is not a negative answer.
It cost 12 wrongly-unapproved pair tokens when a failed batch `eth_call` was read as "not approved",
it cost a null launch rate when a head-block read raced propagation, and it cost this.

Prices span three orders of magnitude, from USDG at $1.00 to LLY at about $1,145. Any curve we
design has to make a launch against $404 gold feel like a launch against a dollar, or the menu is
decorative.

## What is not on the menu

Robinhood has tokenized 194 assets and **none of them is a soft commodity**. No coffee, no cocoa, no
wheat, no sugar, no uranium. The entire commodity exposure on this chain is gold, silver, oil and
wrapped bitcoin. A coin genuinely priced in coffee beans requires somebody to issue a coffee token
first, and then to get it onto an allowlist — which cbBTC and TAO show is possible, and which is a
conversation rather than a commit.

That is the honest shape of the opportunity: the mechanism is already there and the interesting end
of it is empty; the exotic end that does not exist yet needs an issuer, an honest story about what
backs it, and somebody's approval.

## What is deployed against this

`site/` — a front end over this factory, no contract of our own. It shows the menu with every asset
priced in dollars, labels the seven thin ones, and states what a launch against each opens at. It
exists to find out whether the empty half of the menu is empty because nobody wants it or because
nobody has made it the point.
