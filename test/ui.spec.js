// Playwright UI tests. The webServer (see playwright.config.js) runs against
// test/fixture-root, which contains two projects: "gadget" and "widget"
// (widget has build/test targets), plus a directory with no Makefile that must
// not appear.
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('lists only projects that have a Makefile', async ({ page }) => {
  const items = page.locator('#project-list li');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#project-list')).toContainText('gadget');
  await expect(page.locator('#project-list')).toContainText('widget');
  await expect(page.locator('#project-list')).not.toContainText('plain-dir');
});

test('selecting a project opens a terminal showing its shell prompt', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await expect(page.locator('#current-project')).toHaveText('widget');
  await expect(page.locator('#current-path')).toContainText('widget');
  // xterm renders into the #terminal container.
  await expect(page.locator('#terminal .xterm')).toBeVisible();
  // The terminal should receive PTY output (a prompt) within a few seconds.
  await expect(page.locator('#terminal .xterm-rows')).not.toBeEmpty({ timeout: 8000 });
});

test('quick-run target buttons appear and reflect the Makefile', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  const targets = page.locator('#targets button');
  await expect(targets).toHaveCount(2);
  await expect(page.locator('#targets')).toContainText('make build');
  await expect(page.locator('#targets')).toContainText('make test');
  await expect(page.locator('#targets')).toContainText('compile the widget');
});

test('toggle hides and shows the target buttons', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await expect(page.locator('#targets')).toBeVisible();

  await page.locator('#show-targets').uncheck();
  await expect(page.locator('#targets')).toBeHidden();

  await page.locator('#show-targets').check();
  await expect(page.locator('#targets')).toBeVisible();
});

test('clicking a target button runs make in the terminal', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await expect(page.locator('#terminal .xterm')).toBeVisible();
  await page.locator('#targets button', { hasText: 'make build' }).click();
  // The fixture's build target echoes "building widget".
  await expect(page.locator('#terminal .xterm-rows')).toContainText('building widget', {
    timeout: 8000,
  });
});

test('projects with no detected targets show a message', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'gadget' }).click();
  await expect(page.locator('#targets')).toContainText('all');
});
