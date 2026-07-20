const { defineConfig } = require('@playwright/test');

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
