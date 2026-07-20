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
fs.writeFileSync(path.join(root, 'loose-file'), 'not a dir');

// Require AFTER REPO_ROOT is set so the module picks it up.
const { listProjects, resolveProject, parseTargets } = require('../lib/projects');

test('listProjects finds only dirs with a Makefile', () => {
  const names = listProjects(root).map((p) => p.name);
  assert.deepStrictEqual(names, ['alpha', 'beta']);
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

// Cleanup.
process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  console.log('\n' + passed + ' unit assertions passed');
});
