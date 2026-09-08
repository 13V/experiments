#!/usr/bin/env node
'use strict';
/**
 * shots.js — photograph every route at desktop and phone width, and say what went wrong.
 *
 * This is not a test. It exists because the only way to know whether a page looks right is to look
 * at it, and the only way to look at it from here is to take the picture. Each route is loaded with
 * the network stubbed (see support/network.js), given a moment to settle, checked for anything the
 * page logged as an error, and written to test/shots/.
 *
 *   node test/site/shots.js              # all routes, both widths
 *   node test/site/shots.js menu new     # only these
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const { serve, DEFAULT_PORT } = require('./support/server.js');
const { stubNetwork } = require('./support/network.js');

const OUT = path.join(__dirname, '..', 'shots');
const ROUTES = ['menu', 'new', 'recent', 'about'];
const SIZES = [{ tag: 'desktop', width: 1440, height: 960 }, { tag: 'phone', width: 390, height: 844 }];

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const routes = want.length ? ROUTES.filter((r) => want.includes(r)) : ROUTES;

async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT, { recursive: true });

  const port = Number(process.env.PORT) || DEFAULT_PORT + 1;
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}/index.html`;

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  let bad = 0;
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2 });
    for (const route of routes) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
      const seen = stubNetwork(page);

      await page.goto(`${base}#/${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      const file = path.join(OUT, `${route}-${size.tag}.png`);
      await page.screenshot({ path: file, fullPage: true });

      const text = (await page.locator('#view').innerText().catch(() => '')).trim();
      const flag = errors.length ? ' ERRORS' : (text ? '' : ' EMPTY');
      if (flag) bad++;
      console.log(`${(route + '/' + size.tag).padEnd(20)} ${String(text.length).padStart(5)} chars  dex:${seen.dex} rpc:${seen.rpc}${flag}`);
      for (const e of errors.slice(0, 4)) console.log('    ! ' + e.split('\n')[0].slice(0, 160));
      for (const b of seen.blocked.slice(0, 3)) console.log('    - blocked ' + b.slice(0, 120));
      await page.close();
    }
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${routes.length * SIZES.length} shots in ${path.relative(process.cwd(), OUT)}${bad ? `, ${bad} with something to look at` : ''}`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
