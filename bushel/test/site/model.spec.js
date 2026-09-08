'use strict';
/**
 * The hero's 3D figure, and — mostly — what happens when it cannot be shown.
 *
 * The model is 750KB of somebody else's scene rendered through 640KB of WebGL library. Plenty of
 * visitors will never see it: no WebGL, a metered connection, a failed fetch, a reader who asked
 * for less motion. The contract these tests defend is that none of them ever gets a hole in the
 * page — app.js draws the SVG mascot into the slot first, and model.js only takes it away once it
 * genuinely has something better to put there.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork, stubMenu } = require('./support/network.js');

const figure = (page) => page.locator('.stage-figure');

test('the slot is drawn with the SVG mascot in it, before anything 3D happens', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/');
  await expect(figure(page)).toBeAttached();
  await expect(figure(page).locator('svg.mascot')).toBeAttached();
});

test('the model replaces the drawing when it loads, and only then', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/');
  await expect(figure(page)).toHaveClass(/has-model/, { timeout: 40000 });
  await expect(figure(page).locator('canvas.model-canvas')).toBeVisible();
  // The switch is the class, not deletion: the drawing is still in the DOM, just not shown.
  await expect(figure(page).locator('svg.mascot')).toBeAttached();
  await expect(figure(page).locator('svg.mascot')).toBeHidden();
});

test('a model that will not load leaves the drawing exactly where it was', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.route('**/models/*.glb', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  await page.goto('/index.html#/');
  await page.waitForTimeout(3500);
  await expect(figure(page)).not.toHaveClass(/has-model/);
  await expect(figure(page).locator('svg.mascot')).toBeVisible();
  expect(errors).toEqual([]);            // a missing model is not an error the visitor should see
});

test('the credit the licence requires is on the page', async ({ page }) => {
  stubNetwork(page);
  await stubMenu(page);
  await page.goto('/index.html#/');
  const credit = page.locator('.foot-credit');
  await expect(credit).toContainText('Cloud Station');
  await expect(credit).toContainText('Alexa Kruckenberg');
  await expect(credit).toContainText('CC BY 4.0');
  await expect(credit.locator('a[href*="creativecommons.org"]')).toHaveCount(1);
});
