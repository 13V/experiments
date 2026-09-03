#!/usr/bin/env node
/**
 * Render site/og.html to site/og.png, the 1200x630 image link previews show.
 *
 *   NODE_PATH=/path/to/node_modules node scripts/make-og.js
 *
 * Playwright is not a dependency of the site; it is only needed to re-render this
 * one file after editing og.html. Point PW_CHROMIUM at a chrome binary if the
 * default download location is not where yours lives.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'site', 'og.html');
const OUT = path.join(ROOT, 'site', 'og.png');
const EXECUTABLE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}`);
  const launch = { args: ['--font-render-hinting=none', '--force-color-profile=srgb'] };
  if (fs.existsSync(EXECUTABLE)) launch.executablePath = EXECUTABLE;
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('file://' + SRC, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: OUT, type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
    if (errors.length) console.warn('page reported:', errors.join('\n'));
    console.log(`wrote ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
