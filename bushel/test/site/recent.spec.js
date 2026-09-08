'use strict';
/**
 * Recent launches reads the chain directly rather than the built menu, so it is the one route that
 * can be wrong while every other page is right. What it has to get correct is the decoding: which
 * word of a log is the token, which is the pairing asset, and what a stranger's symbol() returns.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork, stubMenu } = require('./support/network.js');
const fixture = require('./fixtures/menu.json');

test.beforeEach(async ({ page }) => { stubNetwork(page); await stubMenu(page); });

test('a launch becomes a row', async ({ page }) => {
  await page.goto('/index.html#/recent');
  await expect(page.locator('#view tbody tr').first()).toBeVisible();
  await expect(page.locator('#view tbody tr')).toHaveCount(8);
});

test('the pairing asset is named from the menu, not left as an address', async ({ page }) => {
  await page.goto('/index.html#/recent');
  // The stub cycles the fixture's asset addresses through the logs, so every symbol should appear.
  for (const a of fixture.assets) {
    await expect(page.locator('#view tbody')).toContainText(a.symbol);
  }
});

test('each coin shows the ticker its own contract returns', async ({ page }) => {
  await page.goto('/index.html#/recent');
  // abiString('T..') from the stub — proof the string decoder ran rather than falling back to hex.
  await expect(page.locator('#view tbody tr').first()).toContainText(/^T/);
});

test('an unreadable chain says so instead of showing an empty table', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  await page.route((url) => /(robinhood|ordofi|publicnode)/i.test(url.host), (route) => route.abort());
  await page.goto('/index.html#/recent');
  await expect(page.locator('#view')).toContainText('Could not read recent launches');
  expect(errors).toEqual([]);
});
