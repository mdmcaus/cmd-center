// Unit tests for project discovery and Makefile target parsing.
// Uses a temporary fixture directory as REPO_ROOT so the tests do not depend on
// the real repo contents. Run: node test/unit.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (err) {
    console.error('  FAIL - ' + name);
    console.error('    ' + (err && err.message));
    process.exitCode = 1;
  }
}

// Build a throwaway fixture repo root.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcenter-unit-'));
process.env.REPO_ROOT = root;

function mkproject(name, makefile) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (makefile !== null) fs.writeFileSync(path.join(dir, 'Makefile'), makefile);
  return dir;
}

mkproject('alpha', '.PHONY: build test\n\nbuild: ## build the thing\n\techo build\n\ntest:\n\techo test\n');
mkproject('beta', 'all:\n\techo hi\n');
mkproject('no-makefile', null); // directory without a Makefile -> excluded
// A directory name that is also a dangerous object key. Project names come from
// the filesystem, so this is reachable by anyone who can make a directory.
mkproject('__proto__', 'build:\n\techo b\n\ntest:\n\techo t\n');
fs.writeFileSync(path.join(root, 'loose-file'), 'not a dir');

// Curated top-targets config for the fixture. 'nonexistent' should be dropped
// because alpha has no such target. Written before requiring the module, which
// reads TOP_TARGETS_FILE once at load time.
const topCfg = path.join(root, 'top-targets.json');
fs.writeFileSync(topCfg, JSON.stringify({ alpha: ['build', 'nonexistent'] }));
process.env.TOP_TARGETS_FILE = topCfg;

// Out-of-root fixture projects, reached through the extra-projects config rather
// than the REPO_ROOT scan. Pointed at a temp file so the real config is ignored.
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcenter-unit-outside-'));
const gamma = path.join(outsideRoot, 'gamma');
fs.mkdirSync(gamma, { recursive: true });
fs.writeFileSync(path.join(gamma, 'Makefile'), 'sync: ## sync it\n\techo sync\n');
const noMakefileOutside = path.join(outsideRoot, 'bare');
fs.mkdirSync(noMakefileOutside, { recursive: true });
// 'alpha' also exists in REPO_ROOT: the scanned one must win the name collision.
const shadowAlpha = path.join(outsideRoot, 'alpha');
fs.mkdirSync(shadowAlpha, { recursive: true });
fs.writeFileSync(path.join(shadowAlpha, 'Makefile'), 'evil:\n\techo evil\n');

const extraCfg = path.join(root, 'extra-projects.json');
fs.writeFileSync(
  extraCfg,
  JSON.stringify([
    gamma,
    shadowAlpha,
    noMakefileOutside, // no Makefile -> excluded
    path.join(outsideRoot, 'does-not-exist'), // missing -> excluded
    'relative/path', // not absolute -> excluded
    42, // not a string -> excluded
  ])
);
process.env.EXTRA_PROJECTS_FILE = extraCfg;

// Ignore-list config, also pointed at a temp file so the real one is untouched.
const ignoreCfg = path.join(root, 'ignored-projects.json');
process.env.IGNORED_PROJECTS_FILE = ignoreCfg;

// Require AFTER REPO_ROOT and TOP_TARGETS_FILE are set so the module picks them up.
const {
  listProjects,
  listAllProjects,
  listIgnoredProjects,
  setIgnoredProjects,
  resolveProject,
  setTopTargets,
  parseTargets,
} = require('../lib/projects');

test('listProjects attaches curated topTargets, filtered to existing targets', () => {
  const projects = listProjects(root);
  const alpha = projects.find((p) => p.name === 'alpha');
  const beta = projects.find((p) => p.name === 'beta');
  assert.deepStrictEqual(alpha.topTargets, ['build']); // 'nonexistent' dropped, order kept
  assert.deepStrictEqual(beta.topTargets, []); // no config entry
});

test('setTopTargets writes config, filters unknown names, and refreshes the cache', () => {
  // beta has only target "all". Order + filtering: keep 'all', drop 'ghost'.
  const saved = setTopTargets('beta', ['all', 'ghost'], root);
  assert.deepStrictEqual(saved, ['all']);
  // listProjects reflects it without a restart (cache was refreshed).
  const beta = listProjects(root).find((p) => p.name === 'beta');
  assert.deepStrictEqual(beta.topTargets, ['all']);
  // Persisted to disk.
  const onDisk = JSON.parse(fs.readFileSync(topCfg, 'utf8'));
  assert.deepStrictEqual(onDisk.beta, ['all']);
});

test('setTopTargets preserves given order for multiple targets', () => {
  // alpha has build, test. Save in reverse order; it must persist that order.
  const saved = setTopTargets('alpha', ['test', 'build'], root);
  assert.deepStrictEqual(saved, ['test', 'build']);
  assert.deepStrictEqual(listProjects(root).find((p) => p.name === 'alpha').topTargets, ['test', 'build']);
});

test('setTopTargets with an empty list removes the project entry', () => {
  setTopTargets('beta', [], root);
  const onDisk = JSON.parse(fs.readFileSync(topCfg, 'utf8'));
  assert.ok(!('beta' in onDisk));
  assert.deepStrictEqual(listProjects(root).find((p) => p.name === 'beta').topTargets, []);
});

test('setTopTargets returns null for an unknown project', () => {
  assert.strictEqual(setTopTargets('does-not-exist', ['x'], root), null);
});

test('listProjects finds only dirs with a Makefile', () => {
  const names = listProjects(root).map((p) => p.name);
  assert.deepStrictEqual(names, ['__proto__', 'alpha', 'beta', 'gamma']); // gamma is out-of-root
});

test('listProjects includes configured out-of-root projects', () => {
  const gammaProject = listProjects(root).find((p) => p.name === 'gamma');
  assert.strictEqual(gammaProject.path, gamma);
  assert.deepStrictEqual(
    gammaProject.targets.map((t) => t.name),
    ['sync']
  );
  assert.strictEqual(gammaProject.targets[0].desc, 'sync it');
});

test('extra-projects entries that are not usable projects are skipped', () => {
  const names = listProjects(root).map((p) => p.name);
  assert.ok(!names.includes('bare')); // no Makefile
  assert.ok(!names.includes('does-not-exist')); // missing directory
  assert.ok(!names.includes('path')); // relative entry, never resolved
});

test('a scanned project wins a name collision with an extra project', () => {
  const alphaProjects = listProjects(root).filter((p) => p.name === 'alpha');
  assert.strictEqual(alphaProjects.length, 1); // not listed twice
  assert.strictEqual(alphaProjects[0].path, path.join(root, 'alpha'));
  assert.strictEqual(resolveProject('alpha', root), path.join(root, 'alpha'));
});

test('an out-of-root project resolves to its real path for the PTY cwd', () => {
  assert.strictEqual(resolveProject('gamma', root), gamma);
});

test('setTopTargets works for an out-of-root project', () => {
  assert.deepStrictEqual(setTopTargets('gamma', ['sync', 'ghost'], root), ['sync']);
  assert.deepStrictEqual(listProjects(root).find((p) => p.name === 'gamma').topTargets, ['sync']);
  setTopTargets('gamma', [], root); // leave the fixture config tidy
});

test('listProjects excludes dirs without a Makefile', () => {
  const names = listProjects(root).map((p) => p.name);
  assert.ok(!names.includes('no-makefile'));
});

test('parseTargets extracts target names and skips .PHONY', () => {
  const targets = parseTargets('.PHONY: build\nbuild:\n\techo x\ninstall:\n\techo y\n');
  assert.deepStrictEqual(
    targets.map((t) => t.name),
    ['build', 'install']
  );
});

test('parseTargets captures inline ## descriptions', () => {
  const targets = parseTargets('build: ## build the thing\n\techo x\n');
  assert.strictEqual(targets[0].name, 'build');
  assert.strictEqual(targets[0].desc, 'build the thing');
});

test('parseTargets de-duplicates and preserves order', () => {
  const targets = parseTargets('a:\nb:\na:\n');
  assert.deepStrictEqual(
    targets.map((t) => t.name),
    ['a', 'b']
  );
});

test('parseTargets ignores variable assignments and pattern rules', () => {
  const targets = parseTargets('PORT := 3000\n%.o: %.c\nreal:\n');
  assert.deepStrictEqual(
    targets.map((t) => t.name),
    ['real']
  );
});

test('project targets are parsed from the Makefile on disk', () => {
  const alpha = listProjects(root).find((p) => p.name === 'alpha');
  assert.deepStrictEqual(
    alpha.targets.map((t) => t.name),
    ['build', 'test']
  );
  assert.strictEqual(alpha.targets[0].desc, 'build the thing');
});

test('resolveProject returns path for a valid project', () => {
  assert.strictEqual(resolveProject('alpha', root), path.join(root, 'alpha'));
});

test('resolveProject rejects unknown project', () => {
  assert.strictEqual(resolveProject('does-not-exist', root), null);
});

test('resolveProject rejects path traversal attempts', () => {
  assert.strictEqual(resolveProject('../etc', root), null);
  assert.strictEqual(resolveProject('..', root), null);
  assert.strictEqual(resolveProject('alpha/../beta', root), null);
  assert.strictEqual(resolveProject('/etc', root), null);
});

// --- prototype-hostile project names ---
// The top-targets config is keyed by project name, so a project called
// "__proto__" must round-trip as ordinary data and must not reach the prototype
// chain. This is why that config is held in a Map rather than a plain object.

test('a project named __proto__ saves and reads back its top targets', () => {
  const saved = setTopTargets('__proto__', ['test'], root);
  assert.deepStrictEqual(saved, ['test']);
  const project = listProjects(root).find((p) => p.name === '__proto__');
  assert.deepStrictEqual(project.topTargets, ['test']);
  // Written to the file as a real key, not swallowed by the __proto__ setter.
  const onDisk = JSON.parse(fs.readFileSync(topCfg, 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ['__proto__', 'alpha']);
  // And nothing leaked onto the global prototype.
  assert.strictEqual({}.test, undefined);
  assert.strictEqual(setTopTargets('__proto__', [], root).length, 0);
});

test('a project named after an inherited property gets no curated set', () => {
  // 'constructor' is not in the config; reading it must yield [] rather than
  // Object.prototype.constructor.
  const dir = mkproject('constructor', 'only:\n\techo o\n');
  assert.ok(fs.existsSync(dir));
  const project = listProjects(root).find((p) => p.name === 'constructor');
  assert.deepStrictEqual(project.topTargets, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- ignore list ---
// These run last and leave the ignore config empty again, so they cannot affect
// the assertions above regardless of ordering.

test('setIgnoredProjects hides a project from listProjects', () => {
  setIgnoredProjects(['beta']);
  const names = listProjects(root).map((p) => p.name);
  assert.ok(names.includes('alpha'), 'alpha still listed');
  assert.ok(!names.includes('beta'), 'beta hidden');
  setIgnoredProjects([]);
});

test('an ignored project is refused a PTY cwd (allowlist is the same list)', () => {
  setIgnoredProjects(['beta']);
  assert.strictEqual(resolveProject('beta', root), null);
  setIgnoredProjects([]);
  assert.strictEqual(resolveProject('beta', root), path.join(root, 'beta'));
});

test('ignoring works for out-of-root projects too', () => {
  setIgnoredProjects(['gamma']);
  assert.ok(!listProjects(root).some((p) => p.name === 'gamma'));
  assert.strictEqual(resolveProject('gamma', root), null);
  setIgnoredProjects([]);
});

test('listAllProjects keeps ignored projects, flagged', () => {
  setIgnoredProjects(['beta']);
  const all = listAllProjects(root);
  const beta = all.find((p) => p.name === 'beta');
  const alpha = all.find((p) => p.name === 'alpha');
  assert.ok(beta, 'beta present in the full list');
  assert.strictEqual(beta.ignored, true);
  assert.strictEqual(alpha.ignored, false);
  setIgnoredProjects([]);
});

test('setIgnoredProjects drops junk, de-duplicates, and sorts', () => {
  const saved = setIgnoredProjects(['zeta', 'alpha', 'zeta', '..', '', 'a/b', 42, null, 'a\\b']);
  assert.deepStrictEqual(saved, ['alpha', 'zeta']);
  assert.deepStrictEqual(listIgnoredProjects(), ['alpha', 'zeta']);
  setIgnoredProjects([]);
});

test('a name can be ignored even when no such project exists', () => {
  // Ignoring must survive a project being temporarily missing, so the setter
  // does not validate against the current scan.
  const saved = setIgnoredProjects(['not-scanned-yet']);
  assert.deepStrictEqual(saved, ['not-scanned-yet']);
  setIgnoredProjects([]);
  assert.deepStrictEqual(listIgnoredProjects(), []);
});

test('a malformed ignore config is treated as nothing ignored', () => {
  fs.writeFileSync(ignoreCfg, 'not json at all');
  assert.deepStrictEqual(listIgnoredProjects(), []);
  assert.ok(listProjects(root).some((p) => p.name === 'beta'));
  setIgnoredProjects([]);
});

// Cleanup.
process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  console.log('\n' + passed + ' unit assertions passed');
});
