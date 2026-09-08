# This directory is a staging copy of whatever.fun

The project was called Bushel while it was a working title; it is now **whatever.fun**, and the
directory keeps the old name only because that is what it is called on disk.

It is developed as its own git repository, the way [manna](https://github.com/13V/manna) was before
it moved out of here. Its own repo — `13V/whatever-fun`, **private** — does not exist yet, because
the GitHub App this session authenticates as cannot create repositories (`403 Resource not
accessible by integration` on `POST /user/repos`).

So this is a copy, kept here so an ephemeral container cannot lose it:

- **The working tree** is everything else in this directory, at the project's `HEAD`.
- **`bushel.bundle`** is the full repository — every commit, with its message. Several of those
  messages carry the reasoning behind corrections that are not obvious from the diff, so the bundle
  is worth more than the tree. Restore it with:

  ```
  git clone bushel.bundle whatever-fun && cd whatever-fun && git remote remove origin
  ```

To finish the move: create the private repository on GitHub, then

```
git clone path/to/bushel.bundle whatever-fun
cd whatever-fun
git remote set-url origin https://github.com/13V/<repo>
git push -u origin main
```

and delete this directory from `13V/experiments`.

## What is in it

A launchpad for coins priced in real things — gold, crude, treasuries — on Robinhood Chain. Phase 0:
a front end over Pons V2's factory, no contract of our own, four routes plus a landing, 24 browser
tests, and a launch module verified byte-identical against real historical launch transactions.

`docs/competition.md` is the thing to read first. anything.fun is the same product on the same
chain, it went live this morning, and it runs its own factory rather than the incumbent's.
