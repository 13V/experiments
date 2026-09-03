#!/usr/bin/env node
/**
 * Render site/icons/icon-192.png, icon-512.png, and apple-touch-icon.png
 * from the same mark as the inline SVG favicon in site/index.html <head>
 * (a paper square, an ink frame, and an ink chart line), each flattened
 * onto a solid paper background with enough padding for maskable use.
 *
 *   NODE_PATH=/path/to/node_modules node scripts/make-icons.js
 *
 * Playwright is not a dependency of the site; it is only needed to
 * re-render these icons after changing the mark. Point PW_CHROMIUM at a
 * chrome binary if the default download location is not where yours lives.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'site', 'icons');
const EXECUTABLE = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Same colors and shapes as the favicon's inline SVG (see site/index.html
// <head>): paper background, ink frame, ink chart line, in a 64x64 box.
const PAPER = '#f4efe4';
const INK = '#141311';

function markSvg(size) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">` +
    `<rect width="64" height="64" fill="${PAPER}"/>` +
    `<rect x="8" y="8" width="48" height="48" fill="none" stroke="${INK}" stroke-width="5"/>` +
    `<path d="M16 42 L28 28 L36 34 L48 20" stroke="${INK}" stroke-width="5" fill="none"/>` +
    `</svg>`
  );
}

function markDataUri(size) {
  return 'data:image/svg+xml;base64,' + Buffer.from(markSvg(size)).toString('base64');
}

// name, output size, and the fraction of the canvas the mark scales to
// (centered). The two manifest icons use a small fraction so the ink frame
// stays well inside the ~80%-diameter safe circle that OS launchers crop
// maskable icons to; the apple-touch-icon uses a larger fraction since iOS
// only rounds its corners and never masks it into an arbitrary shape.
const ICONS = [
  { name: 'icon-192.png', size: 192, markFraction: 0.5 },
  { name: 'icon-512.png', size: 512, markFraction: 0.5 },
  { name: 'apple-touch-icon.png', size: 180, markFraction: 0.7 },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const launch = { args: ['--force-color-profile=srgb'] };
  if (fs.existsSync(EXECUTABLE)) launch.executablePath = EXECUTABLE;
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');

    for (const { name, size, markFraction } of ICONS) {
      const markSize = Math.round(size * markFraction);
      const offset = Math.round((size - markSize) / 2);
      const dataUrl = await page.evaluate(
        async ({ size, markSize, offset, paper, dataUri }) => {
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = dataUri;
          });
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = paper;
          ctx.fillRect(0, 0, size, size);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, offset, offset, markSize, markSize);
          return canvas.toDataURL('image/png');
        },
        { size, markSize, offset, paper: PAPER, dataUri: markDataUri(markSize) }
      );
      const outPath = path.join(OUT_DIR, name);
      fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`wrote ${path.relative(ROOT, outPath)} (${fs.statSync(outPath).size} bytes, ${size}x${size})`);
    }
    if (errors.length) console.warn('page reported:', errors.join('\n'));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
