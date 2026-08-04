const { defineConfig, devices } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The UI tests run against a dedicated server instance on port 3301 with a
// fixture REPO_ROOT, launched by Playwright itself so the suite is self-contained.
const PORT = 3301;

// Seed a disposable top-targets config so the editor test can write to it without
// touching the committed config. Seeded here (at config-eval time, before the
// webServer starts) so the file exists the moment the server first reads and
// caches it. It lives in the OS temp dir, NOT test-results/, because Playwright
// wipes its output dir at the start of every run. widget starts collapsed to
// ["build"].
const TOP_TARGETS_TMP = path.join(os.tmpdir(), 'cmdc-ui-top-targets.json');
fs.writeFileSync(TOP_TARGETS_TMP, JSON.stringify({ widget: ['build'] }, null, 2) + '\n');

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  // The editor test writes to the shared config file; run serially so writes
  // from one browser/test cannot race a read in another.
  workers: 1,
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
      TOP_TARGETS_FILE: TOP_TARGETS_TMP,
    },
  },
  reporter: [['list']],
});
