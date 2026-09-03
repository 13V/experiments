# Prompt: move Stonk Packs into its own repository

Paste everything below this line into a fresh Claude Code session. The only placeholder is `<NEW_SITE_URL>`, and only if the site is moving off stonk-packs.vercel.app.

---

You are moving the Stonk Packs project out of the shared experiments repo into its own repository. Do it in one pass, verify, push, and report. Ask nothing until the end.

## Source
- GitHub `13V/experiments`, branch `claude/token-launch-industry-ideas-ayfwur`, at or after commit `863e4ef`.
- Clone it read-only into a temporary directory. Never push to it.

## Destination
- `https://github.com/13V/stonk-pack` (private, already exists). It holds a single "Initial commit" with only a placeholder `README.md` on `main`. Clone it, put the code straight on `main`, and let the copied Stonk Packs README replace that placeholder. No pull request.
- Site URL stays `https://stonk-packs.vercel.app` unless `<NEW_SITE_URL>` is given, in which case replace it everywhere it appears (index.html head tags, og.html, share.js, config.js, README).

## What to move, exact paths, same layout
```
contracts/StonkPacks.sol
contracts/test/PackMocks.sol
scripts/keccak.js            shared helper, required by scripts/packs/*
scripts/secp256k1.js         required by scripts/packs/operator.js
scripts/packs/odds.js
scripts/packs/operator.js
scripts/packs/test.js
scripts/deploy-site.py
scripts/make-og.js
scripts/make-icons.js
site/                        all of it: index.html, style.css, app.js, fx.js, share.js, feed.js,
                             lib.js, config.js, og.html, og.png, manifest.json,
                             logos/ (40 png), fonts/ (4 woff2 + 2 licence txt), icons/ (3 png)
.gitignore
README.md                    only from the line `# Stonk Packs` to the end of the file;
                             that section becomes the entire README of the new repo
```
Do not move `contracts/TreasureHunt.sol`, `scripts/puzzle.js`, `scripts/test.js`, `scripts/evm-test.js`, or the Treasure Hunt half of the README. Do not copy `node_modules/`, `.claude/`, `__pycache__/`, or anything untracked. Expect about 72 tracked files afterwards.

## History
A fresh initial commit is fine. Its message must cite the source repo, branch and commit hash. Spend no more than a few minutes on anything fancier.

## Fix-ups after the copy
1. `README.md` now starts at `# Stonk Packs`. In its layout block, keep the paths, add one line each for `scripts/keccak.js` and `scripts/secp256k1.js`, and replace every `13V/experiments` link with `13V/stonk-pack`. Every technical fact stays exactly as written (chain id 4663, USDG address, the `block.number` notes, the test count).
2. `site/config.js`: set `github` to `https://github.com/13V/stonk-pack`. Leave `contract`, `deployBlock` and `chainRoot` empty unless values are provided. Leave `social.*` empty unless provided.
3. Add a `package.json` (`"private": true`, no dependencies) with devDependencies pinned to what `scripts/packs/test.js` documents in its header: `solc@0.8.28`, `@ethereumjs/vm@8.1.1`, `@ethereumjs/common@4.4.0`, `@ethereumjs/util@9.1.0`, `@ethereumjs/block@5.3.0`, plus `playwright@1.55.0`; and scripts: `test` = `node scripts/packs/test.js`, `odds` = `node scripts/packs/odds.js rtp`, `og` = `node scripts/make-og.js`, `icons` = `node scripts/make-icons.js`, `serve` = `python3 -m http.server 8787 --directory site`. Commit the lockfile npm produces.
4. `.gitignore` must contain `node_modules/`, `__pycache__/` and `.claude/worktrees/`.
5. `scripts/deploy-site.py` deploys `site/` to Vercel with plain Python: `VERCEL_TOKEN=... VERCEL_TEAM_ID=... python3 scripts/deploy-site.py`. Keep it unchanged. Set `VERCEL_PROJECT` only if a new Vercel project is wanted. Do not run it unless a token is provided in the environment, and never write a token into a file.

## Secrets
The Vercel token, the Dune key, the Helius key and the operator `PACK_SECRET` are never in the repo. If any secret-looking string turns up in the files you copy, stop and report it before pushing.

## Verify before pushing
- `npm install` then `npm test`: expect `127 passed, 0 failed` and the "no warnings" line.
- `npm run odds` prints the table with EV $17.18 per pack and 85.9% return to player.
- Serve `site/` and drive it in headless Chromium with Playwright (if the browsers are preinstalled, set `PLAYWRIGHT_BROWSERS_PATH` and do not run `playwright install`): click "Rip a demo pack", wait for `#stage-result:not([hidden])` (up to 90 s), assert zero console errors, no horizontal overflow at 390 px wide, and that `document.fonts.check('800 20px "Bricolage Grotesque"')` is true after `document.fonts.ready`.
- `git status` clean; `git ls-files | wc -l` about 72 plus `package.json` and the lockfile.

Push, then report: repo URL, branch, commit hash, the test line, the Playwright result, and anything you could not do.
