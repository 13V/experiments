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
  await expect(page.locator('#view h1')).toContainText('You can price a coin in oil.');
  await expect(page.locator('#view h1 em')).toHaveText('Almost nobody does.');
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
  await expect(page.locator('#view h1')).toContainText('You can price a coin in oil.');
  await page.goto('/index.html');
  await expect(page.locator('#view h1')).toContainText('You can price a coin in oil.');
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
  await expect(page.locator('#view h1')).toContainText('You can price a coin in oil.');
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
