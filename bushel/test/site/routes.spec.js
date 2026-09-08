'use strict';
/**
 * Every route renders, and the two things that are allowed to be missing say so instead of
 * throwing. The whole site is one page with a hash router, so "the route rendered" means the view
 * has the heading that route owns — not that navigation happened.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork, stubMenu } = require('./support/network.js');

const PAGES = [
  { hash: '#/menu', heading: 'What you can price a coin in', crumb: 'The menu' },
  { hash: '#/new', heading: 'Launch a coin', crumb: 'Launch a coin' },
  { hash: '#/recent', heading: 'Recent launches', crumb: 'Recent launches' },
  { hash: '#/about', heading: 'How this works', crumb: 'How this works' },
];

for (const page_ of PAGES) {
  test(`${page_.hash} renders without throwing`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
    stubNetwork(page);
    await stubMenu(page);

    await page.goto('/index.html' + page_.hash);
    await expect(page.locator('#view h1')).toHaveText(page_.heading);
    await expect(page.locator('#crumb')).toHaveText(page_.crumb);
    expect(errors).toEqual([]);
  });
}

test('an unknown route falls back to the menu rather than an empty page', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/nonsense');
  await expect(page.locator('#view h1')).toHaveText('What you can price a coin in');
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

test('the search box is only on the route it filters', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/menu');
  await expect(page.locator('#search-slot')).toBeVisible();
  await page.goto('/index.html#/about');
  await expect(page.locator('#search-slot')).toBeHidden();
});
