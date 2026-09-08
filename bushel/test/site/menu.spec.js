'use strict';
/**
 * The menu table is the product, so these assert the two claims it makes that a launcher acts on:
 * an asset with no market on this chain is labelled rather than quietly listed, and the row you
 * click is the pair the launch form opens with.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork, stubMenu } = require('./support/network.js');
const fixture = require('./fixtures/menu.json');

const rowFor = (page, symbol) => page.locator('.mkt-table tbody tr', { hasText: symbol }).first();

// The fixture marks SLV as having no market; DexScreener has to agree, or the page is right to
// stop labelling it and these assertions are testing the stub rather than the site.
const DARK = fixture.assets.filter((a) => !a.tradeable).map((a) => a.address);

test.beforeEach(async ({ page }) => { stubNetwork(page, { noMarket: DARK }); await stubMenu(page); });

test('every asset on the menu gets a row', async ({ page }) => {
  await page.goto('/index.html#/menu');
  await expect(page.locator('.mkt-table tbody tr')).toHaveCount(fixture.assets.length);
});

test('an asset with no quoted market is labelled, not hidden', async ({ page }) => {
  await page.goto('/index.html#/menu');
  // SLV is approved as a pairing asset and no pool on this chain quotes it.
  const slv = rowFor(page, 'SLV');
  await expect(slv).toContainText('no market');
  await expect(slv.locator('td.num').first()).toHaveText('—');
  await expect(slv).not.toHaveClass(/clickable/);
});

test('an asset under $100k of its own liquidity is called thin', async ({ page }) => {
  const wyfi = fixture.assets.find((a) => a.symbol === 'WYFI');
  stubNetwork(page, { noMarket: DARK, liquidity: { [wyfi.address]: 42_000 } });
  await page.goto('/index.html#/menu');
  await expect(rowFor(page, 'WYFI')).toContainText('thin');
});

test('an asset that has since got deep enough stops being called thin', async ({ page }) => {
  // The fixture calls WYFI thin; the live read says it has a million dollars behind it now. As with
  // the no-market badge, the read is the newer fact and the label has to follow it.
  await page.goto('/index.html#/menu');
  await expect(rowFor(page, 'WYFI')).not.toContainText('thin');
});

test('the search filters the table', async ({ page }) => {
  await page.goto('/index.html#/menu');
  await page.locator('#search-slot input').fill('gold');
  await expect(page.locator('.mkt-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.mkt-table tbody tr')).toContainText('GLD');
  await page.locator('#search-slot input').fill('');
  await expect(page.locator('.mkt-table tbody tr')).toHaveCount(fixture.assets.length);
});

test('a search that matches nothing empties the table without throwing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  await page.goto('/index.html#/menu');
  await page.locator('#search-slot input').fill('zzzzz');
  await expect(page.locator('.mkt-table tbody tr')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('clicking a tradeable row opens the launch form on that pair', async ({ page }) => {
  await page.goto('/index.html#/menu');
  await rowFor(page, 'SGOV').click();
  await expect(page.locator('#view h1')).toHaveText('Launch a coin');
  await expect(page.locator('#view')).toContainText('SGOV');
});

test('the opening spread is stated, because it is the argument', async ({ page }) => {
  await page.goto('/index.html#/menu');
  await expect(page.locator('#view')).toContainText('1.69×');
});

test('an asset that has since acquired a market stops being labelled as having none', async ({ page }) => {
  // Same fixture, but this time the live read does quote SLV — routes resolve last-registered-first,
  // so this registration wins over the beforeEach one. The menu is a build-time snapshot and
  // the read is now, so the row has to follow the read — a price beside a "no market" badge is the
  // page contradicting itself.
  stubNetwork(page, { noMarket: [] });
  await page.goto('/index.html#/menu');
  const slv = rowFor(page, 'SLV');
  await expect(slv.locator('td.num').first()).not.toHaveText('—');
  await expect(slv).not.toContainText('no market');
  await expect(slv).toHaveClass(/clickable/);
  // and its opening valuation is computed rather than left blank
  await expect(slv.locator('td.num').nth(2)).not.toHaveText('—');
});

test('a launch that names no pairing asset starts on gold, not on ether', async ({ page }) => {
  // Ether is the deepest market and sorts first; it is also the one asset on the menu that is not
  // a real thing, which is the whole argument this site makes.
  await page.goto('/index.html#/new');
  await expect(page.locator('.ticket')).toContainText('GLD');
});
