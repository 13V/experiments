# The dividend leak

Robinhood stock tokens pay dividends to whoever holds the token on the day the issuer gets around
to it, split across every token that exists that day, after about 30% has been withheld. The holders
whose shares actually earned the cash are paid on a fraction. In
September 2026 Ford holders got 2% of their dividend and UPS holders got 20%. Everything below is
read from the public RPC; `scripts/dividend-leak.js` reproduces it with no dependencies.

## What is supposed to happen

A stock token never pays cash. When the underlying pays a dividend, Robinhood Assets (Jersey)
reinvests it and raises the token's ERC-8056 `uiMultiplier()`, so one token quietly becomes more
than one share. The Chainlink feed prices the raw token as `underlying × multiplier`, so on the
ex-date, when the underlying drops by the dividend, the token drops by the dividend too, and the
multiplier is what is meant to give it back.

## What actually happens

**1. The multiplier moves on or after the pay date, not the ex-date.** Every update on the chain
so far, with the ex-date and pay-date of the dividend it paid:

| Token | Ex-date | Pay date | Multiplier update (UTC) | Bump | Transaction |
|---|---|---|---|---|---|
| SGOV | 1 Jul | early Jul | 8 Jul 20:05, effective 20:14 | +0.0957% | `0x79292bc8…0efbfb` |
| SGOV | 3 Aug | 6 Aug | 7 Aug 15:00, effective 15:10 | +0.2021% | `0x94aaa4c5…02ebd` |
| SGOV | 1 Sep | 4 Sep | 31 Aug 23:50, effective 1 Sep 00:00 | +0.2114% | `0xf33317c3…5f4e7` |
| AAPL | 11 Aug | 14 Aug | 14 Aug 15:03, effective 15:12 | +0.0566% | `0x6d72ca59…adff35` |
| F | 11 Aug | 1 Sep | 2 Sep 15:00, effective 15:10 | +0.0146% | `0x17717969…c442e` |
| UPS | 17 Aug | 3 Sep | 4 Sep 15:00, effective 15:10 | +0.2209% | `0xc3a0a692…fba81bb` |

Ford's token dropped by its dividend on 11 August and got its raise on 2 September. For three
weeks the token was simply worth less, and nothing on the chain said a raise was coming:
`newUIMultiplier()` and `effectiveAt()` are only set ten minutes before the update. SGOV's
September update is the exception that matters: it landed at midnight on the ex-date, before the
pay date. The issuer can do it right, and did, once, for one ETF.

**2. The raise is spread over the supply at the update, but the cash came from the supply that
existed at the close before the ex-date.** Under T+1 that is the last moment a trade still settles
on the record date, so those are the shares that earned the dividend; a redemption on the ex-date
itself still gets paid to the issuer. The multiplier is one number for the whole contract, so every token gets the same
bump whether it existed on the record date or was minted the morning of the update. Rebuilding
supply from mint and burn events:

| | Supply at the close before the ex-date | Supply at the update | The holders who earned it were paid on |
|---|---|---|---|
| F (11 Aug → 2 Sep) | 73.96 tokens | 3,777.04 tokens | **1.96%** of their dividend cash |
| UPS (17 Aug → 4 Sep) | 424.96 tokens | 2,121.34 tokens | **20.0%** |

And the bumps match that rule to within about 1% once withholding is included:

```
bump = dividend / price × (1 − withholding) × supplyBeforeExDate / supplyAtUpdate

F:   0.15 / 14.30 × 0.70 × 0.0196 = 0.01438%   observed 0.01455%   implied withholding 29.2%
UPS: 1.64 / 104   × 0.70 × 0.2003 = 0.2211%    observed 0.2209%    implied withholding 30.0%
```

Two tokens, two record dates, two supply paths, one formula. The 30% is consistent across SGOV as
well (each monthly raise is 65-68% of the distribution), which is what US withholding on a Jersey
issuer looks like. Whether the issuer keeps it, remits it, or could reclaim some of it, the chain
does not say; it never reaches the token.

**3. The consequences fall in a predictable order.**

- Tokens minted between the ex-date and the update are paid a dividend they never earned:
  5,430 Ford tokens and about 3,450 UPS tokens in this round. The largest mints in both tokens'
  histories landed on the day of the update, before it. Whether that is demand, batch timing, or
  someone who has noticed, the chain does not say.
- Tokens burned in that window forfeit theirs. UPS supply fell from 425 to 5 in the week after its
  ex-date; those redemptions handed the receivable to the 2,121 tokens that existed on 4 September.
- A holder through an ex-date loses the gross dividend on the ex-date and gets back the withheld,
  diluted bump weeks later. For Ford that was 1.05% out and 0.015% back. Annualised, with dilution
  like this, a UPS or Ford token trails its stock by 4-5% a year. Even with no dilution at all, every
  token trails its stock by 30% of its dividend yield.
- Anyone pricing the multiplier is pricing it wrong if they assume full, timely dividends: hdfi's
  yield tokens, PARE's dividend claims, Robinfolio's NAV between ex-date and update, and every
  Morpho and Longbow position whose collateral drops by a known amount on a known date with no
  offsetting credit.

## The next two

SPY and QQQ have not paid a dividend on-chain yet. Their multipliers are 1.0 with nothing
scheduled, and their supply is growing faster than anything above:

| | Supply now | A week ago | Six weeks ago | Next ex-date | Pay date | Dividend |
|---|---|---|---|---|---|---|
| SPY | 22,573 | 7,570 | 1,294 | 18 Sep 2026 | 30 Oct 2026 | $1.83 |
| QQQ | 5,213 | 1,752 | 798 | 21 Sep 2026 | 8 Oct 2026 | $0.69 |

SPY's window is six weeks. If the issuer keeps updating on pay date and supply keeps growing at
even a fraction of its current rate, the largest token on the chain will pay the holders who earn
its 18 September dividend a small fraction of 70% of it at the start of November. That is the moment to
have the tracker live and the trade on. `node scripts/dividend-leak.js SPY --forecast` watches it.

## What to build on it

**The tracker.** A page that, for every dividend on the chain, shows what record-date holders were
owed, what they were paid, where the rest went, and the transactions. A forward calendar with a
live dilution meter for SPY and QQQ. This is the script with a front end, a week of work, and it is
the press release for the two products below. Nobody else on the chain reads these events.

**Ex-date shorts in Locate.** The borrow side of Locate finally has a scheduled, structural reason
to exist. A token drops by the gross dividend on the ex-date and nothing on the chain gives that
back for weeks, if ever in full. So: borrow the stock through Locate at the close before the
ex-date, sell it, buy it back after the open, repay. The borrower owes no dividend, because a Morpho
loan is denominated in tokens and the multiplier is global: the lender's tokens get exactly the
same bump lent or not, so the lender is unharmed and the short keeps the whole drop. Edge per
ex-date: 0.28% on SPY, 1.0-1.6% on Ford and UPS. Cost: a day of borrow interest, two swaps (Arcus
quotes stock tokens at zero fee), and overnight noise. 17 September into 18 September on SPY, on
the deepest market Locate has, is the first live demonstration.

**A wrapper that does not leak.** An ERC-4626 vault per dividend-paying stock that holds the token
and is hedged flat across each ex-night, through Locate or an Arcus perp, and long otherwise. Its
NAV beats the raw token by the gross dividend every quarter and beats the stock's own total return
by whatever diluted bump arrives later. That is the honest version of "dividends unlocked", and it
is a yield product whose yield is precisely the leak: worth it on SPY ($1.83 against a few basis
points of hedging cost), marginal on AAPL, pointless on NVDA. Its shares are the kind of collateral
Longbow should want, because they do not step down on a schedule.

## What the issuer will probably do

Move every token to ex-date accrual, as SGOV's September update already did. That ends the
dilution. It does not end the withholding, so the token still steps down by 30% of every dividend
on the ex-date with no offset, the short still works at a third of the size, and the tracker still
has a number to show. If they also gross up or reclaim withholding, the leak closes and the tracker
becomes the thing that proved it.

## Reproduce

```bash
node scripts/dividend-leak.js F                                            # multiplier history and live state
node scripts/dividend-leak.js F   --ex 2026-08-11 --dividend 0.15 --price 14.3
node scripts/dividend-leak.js UPS --ex 2026-08-17 --dividend 1.64 --price 104
node scripts/dividend-leak.js SPY --forecast
```

Supply is rebuilt from `Transfer` events to and from the zero address, so no archive node is
needed. Dates are placed on the chain with a block clock measured from two real headers (Nitro
makes about ten blocks a second and `block.number` is Ethereum's, as the Stonk Packs README
explains), so timestamps are good to minutes, not seconds. Prices are the underlying's close on the
update day and are approximate; withholding is inferred, not documented. The entitled supply is
sampled at the close of the business day before the ex-date; sample it on the ex-date itself and
UPS reads 103 tokens instead of 425, because the redemptions had already started, and the formula
stops fitting. That the formula only fits at the T+1 cutoff is itself part of the evidence.
