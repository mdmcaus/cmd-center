// Playwright UI tests. The webServer (see playwright.config.js) runs against
// test/fixture-root, which contains two projects: "gadget" and "widget"
// (widget has build/test targets), plus a directory with no Makefile that must
// not appear. The top-targets fixture (fixture-top-targets.json) gives "widget"
// a curated set of ["build"], so widget starts collapsed to just that.
const { test, expect } = require('@playwright/test');

// Target buttons excluding the Show all / Show top only footer toggle.
const TARGET_BTN = '#targets button:not(.targets-toggle)';

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

test('curated top targets show by default with a Show all toggle', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  // widget's curated set is ["build"], so only that button shows initially.
  await expect(page.locator(TARGET_BTN)).toHaveCount(1);
  await expect(page.locator(TARGET_BTN)).toHaveText(/make build/);
  await expect(page.locator('#targets')).not.toContainText('make test');
  await expect(page.locator('#targets button.targets-toggle')).toHaveText('Show all (2)');
});

test('Show all expands to the full sorted list, Show top only collapses', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await page.locator('#targets button.targets-toggle').click();
  // Full list, sorted: build then test.
  const labels = await page.locator(TARGET_BTN + ' > span:first-child').allTextContents();
  expect(labels).toEqual(['make build', 'make test']);
  await expect(page.locator('#targets button.targets-toggle')).toHaveText('Show top only');
  // Collapse back to the curated set.
  await page.locator('#targets button.targets-toggle').click();
  await expect(page.locator(TARGET_BTN)).toHaveCount(1);
  await expect(page.locator('#targets button.targets-toggle')).toHaveText('Show all (2)');
});

test('quick-run target buttons reflect the Makefile (full list)', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await page.locator('#targets button.targets-toggle').click(); // Show all
  await expect(page.locator(TARGET_BTN)).toHaveCount(2);
  await expect(page.locator('#targets')).toContainText('make build');
  await expect(page.locator('#targets')).toContainText('make test');
  await expect(page.locator('#targets')).toContainText('compile the widget');
});

test('project without a curated set shows all targets and no toggle', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'gadget' }).click();
  await expect(page.locator('#targets')).toContainText('all');
  await expect(page.locator('#targets button.targets-toggle')).toHaveCount(0);
});

test('toggle hides and shows the target panel', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await expect(page.locator('#targets')).toBeVisible();

  await page.locator('#show-targets').uncheck();
  await expect(page.locator('#targets')).toBeHidden();

  await page.locator('#show-targets').check();
  await expect(page.locator('#targets')).toBeVisible();
});

test('editing top targets via the UI persists and updates the panel', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  // Seeded curated set is [build].
  let labels = await page.locator(TARGET_BTN + ' > span:first-child').allTextContents();
  expect(labels).toEqual(['make build']);

  // Open the editor: build is at top, test is under More.
  await page.locator('#edit-targets').click();
  await expect(page.locator('#editor-overlay')).toBeVisible();
  await expect(page.locator('#editor-top li')).toHaveCount(1);
  await expect(page.locator('#editor-top li')).toContainText('build');

  // Add test to the top set, then save.
  await page.locator('#editor-more li', { hasText: 'test' }).getByTitle('Add to top').click();
  await expect(page.locator('#editor-top li')).toHaveCount(2);
  await page.locator('#editor-save').click();
  await expect(page.locator('#editor-overlay')).toBeHidden();

  // Panel now shows both, in the saved order.
  labels = await page.locator(TARGET_BTN + ' > span:first-child').allTextContents();
  expect(labels).toEqual(['make build', 'make test']);

  // Persisted: reload and confirm it is still build, test.
  await page.reload();
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  labels = await page.locator(TARGET_BTN + ' > span:first-child').allTextContents();
  expect(labels).toEqual(['make build', 'make test']);

  // Restore to [build] so later tests see the seeded state (single worker, serial).
  await page.locator('#edit-targets').click();
  await page.locator('#editor-top li', { hasText: 'test' }).getByTitle('Remove from top').click();
  await page.locator('#editor-save').click();
  await expect(page.locator('#editor-overlay')).toBeHidden();
  labels = await page.locator(TARGET_BTN + ' > span:first-child').allTextContents();
  expect(labels).toEqual(['make build']);
});

test('clicking a target button runs make in the terminal', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await expect(page.locator('#terminal .xterm')).toBeVisible();
  // "make build" is in the curated set, so it is visible without expanding.
  await page.locator(TARGET_BTN, { hasText: 'make build' }).click();
  // The fixture's build target echoes "building widget".
  await expect(page.locator('#terminal .xterm-rows')).toContainText('building widget', {
    timeout: 8000,
  });
});
