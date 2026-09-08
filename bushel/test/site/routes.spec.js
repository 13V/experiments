'use strict';
/**
 * Every route renders, and the two things that are allowed to be missing say so instead of
 * throwing. The whole site is one page with a hash router, so "the route rendered" means the view
 * has the heading that route owns — not that navigation happened.
 *
 * There is no #crumb any more — the page names its route in document.title instead, so these
 * assert that rather than a DOM node that no longer exists.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork, stubMenu } = require('./support/network.js');

const PAGES = [
  { hash: '#/menu', heading: 'What you can price a coin in', title: 'The menu — whatever.fun' },
  { hash: '#/new', heading: 'Launch a coin', title: 'Launch a coin — whatever.fun' },
  { hash: '#/recent', heading: 'Recent launches', title: 'Recent launches — whatever.fun' },
  { hash: '#/about', heading: 'How this works', title: 'How this works — whatever.fun' },
];

for (const page_ of PAGES) {
  test(`${page_.hash} renders without throwing`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
    stubNetwork(page);
    await stubMenu(page);

    await page.goto('/index.html' + page_.hash);
    await expect(page.locator('#view h1')).toHaveText(page_.heading);
    await expect(page).toHaveTitle(page_.title);
    expect(errors).toEqual([]);
  });
}

test('#/ renders the hero as home, with the second line in the serif voice', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubMenu(page);

  await page.goto('/index.html#/');
  await expect(page.locator('#view h1')).toContainText('Price a coin in');
  await expect(page.locator('#view h1 em')).toHaveText('Almost nobody does.');
  // The word between them is the product's claim and it is the one thing on the page that moves.
  await expect(page.locator('#view h1 .cycle')).toHaveText(/^(oil|gold|treasuries|silver|SpaceX|whatever)$/);
  await expect(page).toHaveTitle('whatever.fun — price a coin in a real thing');
  expect(errors).toEqual([]);
});

test('the home hero spread card is read from the menu, not hardcoded', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/');
  // The fixture has five assets, one (SLV) with no openingUsd, so four rows — cheapest to
  // dearest — rather than the eight a fuller menu would spread across.
  await expect(page.locator('.spread-card .sp-row')).toHaveCount(4);
  await expect(page.locator('.spread-card')).toContainText('GLD');
  await expect(page.locator('.spread-card')).toContainText('INDA');
});

test('a hash with no route and an unknown route both land on home', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/nonsense');
  await expect(page.locator('#view h1')).toContainText('Price a coin in');
  await page.goto('/index.html');
  await expect(page.locator('#view h1')).toContainText('Price a coin in');
});

test('with no menu built, the page says so and names the command', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubMenu(page, null);

  await page.goto('/index.html#/menu');
  await expect(page.locator('#view')).toContainText('scripts/menu.js');
  await expect(page.locator('#ticker')).toContainText('no menu built yet');
  expect(errors).toEqual([]);
});

test('with no menu built, home shows the notice rather than an invented spread', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);
  await stubMenu(page, null);

  await page.goto('/index.html#/');
  // The headline is static copy and still renders; only the data-backed card is replaced.
  await expect(page.locator('#view h1')).toContainText('Price a coin in');
  await expect(page.locator('.hero')).toContainText('scripts/menu.js');
  expect(errors).toEqual([]);
});

test('the search box is only on the route it filters', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/menu');
  await expect(page.locator('#search-slot')).toBeVisible();
  await page.goto('/index.html#/about');
  await expect(page.locator('#search-slot')).toBeHidden();
});

test('the cycling word holds still, and says the name, for a reader who asked for less motion', async ({ browser }) => {
  // prefers-reduced-motion is not a preference about decoration — a word that changes under you
  // mid-sentence is exactly what it is asking not to happen. "whatever" is the last word in the
  // cycle and the site's own name, so the headline still reads correctly frozen on it.
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/');
  await expect(page.locator('#view h1 .cycle')).toHaveText('whatever');
  await page.waitForTimeout(2600);                       // longer than one tick of the timer
  await expect(page.locator('#view h1 .cycle')).toHaveText('whatever');
  await ctx.close();
});

test('the ticker carries its set twice, so the marquee has no seam', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/menu');
  const tracks = page.locator('#ticker .tk-track');
  await expect(tracks).toHaveCount(2);
  // The copy exists to make the loop seamless, not to be read out a second time.
  await expect(tracks.nth(1)).toHaveAttribute('aria-hidden', 'true');
  const a = await tracks.nth(0).locator('.tk-item').count();
  const b = await tracks.nth(1).locator('.tk-item').count();
  expect(a).toBe(b);
  expect(a).toBeGreaterThan(0);
});
