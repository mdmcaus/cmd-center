const { defineConfig, devices } = require('@playwright/test');

// The UI tests run against a dedicated server instance on port 3301 with a
// fixture REPO_ROOT, launched by Playwright itself so the suite is self-contained.
const PORT = 3301;

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // Run against both engines. WebKit (Safari) is included because a plain-http
  // local server plus a default CSP behaves differently there (see the CSP note
  // in server.js), so Safari-specific regressions must be caught here.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/api/projects`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      REPO_ROOT: require('path').join(__dirname, 'test', 'fixture-root'),
    },
  },
  reporter: [['list']],
});
