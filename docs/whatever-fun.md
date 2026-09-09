# whatever.fun

Moved out to **[13V/whatever.fun](https://github.com/13V/whatever.fun)** on 9 September 2026, the
way manna moved to 13V/manna before it. Nothing of it is left in this repository; the note is here
so the trail does not go cold.

It started in here as "Bushel", a working title, and it is a launchpad for coins priced in real
things — gold, crude, treasuries, SpaceX — on Robinhood Chain, where the launch factory already
accepts 57 assets as the pairing asset for a new coin and almost nobody uses the interesting half
of that list.

What it is, at the point it moved:

- **Phase 0**: a front end over Pons V2's factory. No contract of ours is deployed and none is
  written. It launches through somebody else's code, takes no fee, and adds the part that is
  missing — a menu that prices every pairing asset in dollars, labels the ones whose own market is
  too thin to price against, and says what a launch against each actually opens at.
- **The finding that argues for building it properly**: the identical one-click launch opens
  anywhere from $3,179 to $7,016 depending only on which asset you pick — a 2.21x spread caused by
  a per-asset number somebody typed by hand and never revisited.
- **A competitor got there first.** anything.fun is the same product on the same chain, live since
  the small hours of 8 September 2026, running its own factory rather than the incumbent's. Eight
  launches in its first hour. See `docs/competition.md` in the project repo.

The research that led to it stays here: `docs/robinhood-chain-ideas.md`, `docs/pons-launch.md`,
`docs/pons-tech.md`.
