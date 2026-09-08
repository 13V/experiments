'use strict';
const { defineConfig, devices } = require('@playwright/test');
const { DEFAULT_PORT } = require('./support/server.js');

const port = Number(process.env.PORT) || DEFAULT_PORT;
const baseURL = `http://127.0.0.1:${port}`;

// A sandbox points this at a chromium already on disk rather than one `playwright install` fetched.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

module.exports = defineConfig({
  testDir: '.',
  timeout: 30000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    launchOptions: executablePath
      ? { executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
      : {},
  },
  webServer: {
    command: `node ${JSON.stringify(require.resolve('./support/server.js'))}`,
    url: `${baseURL}/index.html`,
    env: { PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
});
