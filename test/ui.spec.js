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
  // Descriptions are off by default, so the "## " text is not rendered inline;
  // it is still reachable as the button tooltip.
  await expect(page.locator('#targets')).not.toContainText('compile the widget');
  await expect(page.locator(TARGET_BTN).first()).toHaveAttribute(
    'title',
    'make build: compile the widget'
  );
  // Turning the toggle on renders it inline.
  await page.locator('#show-descs').check();
  await expect(page.locator('#targets')).toContainText('compile the widget');
});

test('target descriptions toggle hides and shows the ## text', async ({ page }) => {
  await page.locator('#project-list li', { hasText: 'widget' }).click();
  await page.locator('#targets button.targets-toggle').click(); // Show all

  // Default: off, so no .desc element is rendered at all.
  await expect(page.locator('#show-descs')).not.toBeChecked();
  await expect(page.locator('#targets button .desc')).toHaveCount(0);

  await page.locator('#show-descs').check();
  await expect(page.locator('#targets button .desc')).toHaveCount(1);
  await expect(page.locator('#targets button .desc')).toHaveText('compile the widget');

  await page.locator('#show-descs').uncheck();
  await expect(page.locator('#targets button .desc')).toHaveCount(0);

  // The preference survives a reload.
  await page.locator('#show-descs').check();
  await page.reload();
  await expect(page.locator('#show-descs')).toBeChecked();
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

test('manage-projects screen ignores a project and restores it', async ({ page }) => {
  await page.locator('#manage-projects').click();
  // Both fixture projects start visible; nothing is ignored.
  await expect(page.locator('#ignore-shown li')).toHaveCount(2);
  await expect(page.locator('#ignore-hidden')).toContainText('Nothing ignored');

  // Ignore 'gadget' and save: it leaves the sidebar.
  await page.locator('#ignore-shown li', { hasText: 'gadget' }).locator('button').click();
  await expect(page.locator('#ignore-hidden li')).toHaveCount(1);
  await page.locator('#ignore-save').click();
  await expect(page.locator('#project-list li')).toHaveCount(1);
  await expect(page.locator('#project-list')).not.toContainText('gadget');

  // Reopen: the ignored project is loaded back from the server, not lost.
  await page.locator('#manage-projects').click();
  await expect(page.locator('#ignore-hidden li', { hasText: 'gadget' })).toBeVisible();

  // Restore it and save: it comes back.
  await page.locator('#ignore-hidden li', { hasText: 'gadget' }).locator('button').click();
  await page.locator('#ignore-save').click();
  await expect(page.locator('#project-list li')).toHaveCount(2);
  await expect(page.locator('#project-list')).toContainText('gadget');
});

test('Cancel on the manage screen discards the change', async ({ page }) => {
  await page.locator('#manage-projects').click();
  await page.locator('#ignore-shown li', { hasText: 'widget' }).locator('button').click();
  await page.locator('#ignore-cancel').click();
  await expect(page.locator('#project-list li')).toHaveCount(2);
  await expect(page.locator('#project-list')).toContainText('widget');
});
