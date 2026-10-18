// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
