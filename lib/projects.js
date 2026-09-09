// Project discovery and Makefile target parsing.
//
// A "project" is any immediate subdirectory of one of the REPO_ROOTS that contains
// a file named exactly "Makefile", plus any directory listed in config/extra-projects.json
// (for repos that live outside every root). The list of projects also serves as the
// security allowlist for the PTY endpoint: a project name is only ever accepted if
// it is present in this freshly-scanned list, so a client can never steer the
// terminal into an arbitrary directory.

const fs = require('fs');
const path = require('path');

// Roots scanned for projects, in precedence order: an earlier root wins a name
// collision, so a project can never be shadowed by one further down the list.
// REPO_ROOTS takes a colon-separated list; REPO_ROOT is still honoured as the
// single-root form.
const DEFAULT_REPO_ROOTS = ['/Users/michael/repo/claude', '/Users/michael/repo'];

const REPO_ROOTS = process.env.REPO_ROOTS
  ? process.env.REPO_ROOTS.split(':').map((entry) => entry.trim()).filter(Boolean)
  : process.env.REPO_ROOT
    ? [process.env.REPO_ROOT]
    : DEFAULT_REPO_ROOTS;

// The primary root, for callers that only deal in one.
const REPO_ROOT = REPO_ROOTS[0];

// Callers may pass a single root or several; normalise to a list either way.
function toRootList(roots) {
  if (roots === undefined || roots === null) return REPO_ROOTS;
  return Array.isArray(roots) ? roots : [roots];
}

// Optional curated "top targets" per project, keyed by project name. Lets a
// project surface a short list of its most-used targets before the full list.
const TOP_TARGETS_FILE =
  process.env.TOP_TARGETS_FILE || path.join(__dirname, '..', 'config', 'top-targets.json');

// Projects that live outside every scanned root, listed as absolute directory paths:
//   ["/Users/michael/repo/newonbrew"]
// Each still has to contain a Makefile to show up. Unlike the top-targets config
// this is read on every scan rather than cached, so the list stays as live as the
// directory scan itself.
const EXTRA_PROJECTS_FILE =
  process.env.EXTRA_PROJECTS_FILE || path.join(__dirname, '..', 'config', 'extra-projects.json');

// Load and cache the top-targets config. A missing or invalid file is not an
// error: it just means no project has a curated set.
let _topTargetsCache;
function loadTopTargets() {
  if (_topTargetsCache !== undefined) return _topTargetsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOP_TARGETS_FILE, 'utf8'));
    _topTargetsCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    _topTargetsCache = {};
  }
  return _topTargetsCache;
}

// Save a project's curated top-targets list to the config file.
// - The project must exist (be in the allowlist); returns null if not.
// - `list` is filtered to targets that actually exist in the project's Makefile,
//   de-duplicated, and kept in the given order.
// - An empty result removes the project's entry to keep the file tidy.
// The in-memory cache is refreshed so listProjects() reflects the change with no
// restart. Returns the saved (filtered) list.
function setTopTargets(name, list, roots = REPO_ROOTS) {
  const projectPath = resolveProject(name, roots);
  if (!projectPath) return null;

  const existing = new Set(readTargets(projectPath).map((t) => t.name));
  const seen = new Set();
  const filtered = (Array.isArray(list) ? list : []).filter((n) => {
    if (typeof n !== 'string' || !existing.has(n) || seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  // Read the current config fresh so we never drop other projects' entries.
  let config;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOP_TARGETS_FILE, 'utf8'));
    config = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    config = {};
  }

  if (filtered.length) {
    config[name] = filtered;
  } else {
    delete config[name];
  }

  fs.mkdirSync(path.dirname(TOP_TARGETS_FILE), { recursive: true });
  fs.writeFileSync(TOP_TARGETS_FILE, JSON.stringify(config, null, 2) + '\n');
  _topTargetsCache = config; // keep the cache in sync
  return filtered;
}

// Lines like "target:" or "target: deps ## description".
// Skip dotted specials (.PHONY, .DEFAULT, ...), pattern rules (containing %),
// and variable assignments.
const TARGET_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*:(?!=)/;
const DESC_RE = /##\s*(.+?)\s*$/;

// Parse make targets from Makefile text. Returns [{ name, desc }], de-duplicated,
// preserving first-seen order.
function parseTargets(makefileText) {
  const seen = new Set();
  const targets = [];
  for (const rawLine of makefileText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = line.match(TARGET_RE);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith('.')) continue; // .PHONY, .DEFAULT, etc.
    if (name.includes('%')) continue; // pattern rule
    if (seen.has(name)) continue;
    seen.add(name);
    const descMatch = line.match(DESC_RE);
    targets.push({ name, desc: descMatch ? descMatch[1] : '' });
  }
  return targets;
}

// Read and parse the Makefile for a project directory. Returns [] on any read error.
function readTargets(projectPath) {
  try {
    const text = fs.readFileSync(path.join(projectPath, 'Makefile'), 'utf8');
    return parseTargets(text);
  } catch {
    return [];
  }
}

// Read the extra-projects config: absolute directory paths for projects that
// live outside every scanned root. A missing or malformed file is not an error, it just
// means there are none. Non-absolute entries are dropped so a relative path can
// never be resolved against whatever cwd the server happens to have.
function loadExtraProjectPaths() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(EXTRA_PROJECTS_FILE, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => typeof entry === 'string' && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
}

// Build the project object for one directory, or null if it is not a project
// (no Makefile). Shared by the root scan and the extra-projects list.
function describeProject(name, projectPath) {
  let hasMakefile = false;
  try {
    hasMakefile = fs.statSync(path.join(projectPath, 'Makefile')).isFile();
  } catch {
    hasMakefile = false;
  }
  if (!hasMakefile) return null;
  const targets = readTargets(projectPath);
  // Curated top targets: only names that actually exist, in config order.
  const configured = loadTopTargets()[name];
  const existing = new Set(targets.map((t) => t.name));
  const topTargets = Array.isArray(configured)
    ? configured.filter((target) => existing.has(target))
    : [];
  return { name, path: projectPath, targets, topTargets };
}

// Scan each root one level deep for directories containing a Makefile, then add
// any configured out-of-root project directories. Roots are scanned in order and
// the first one to claim a name keeps it, so precedence is predictable.
// Returns [{ name, path, targets, topTargets }] sorted by name (case-insensitive).
function listProjects(roots = REPO_ROOTS) {
  const projects = [];
  const seen = new Set();

  for (const root of toRootList(roots)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue; // an earlier root already claimed this name
      const project = describeProject(entry.name, path.join(root, entry.name));
      if (!project) continue;
      projects.push(project);
      seen.add(project.name);
    }
  }

  // Projects outside the scanned roots. The directory's base name is the project
  // name, and names are what resolveProject() matches on, so anything that is not
  // a usable single path segment is skipped. A scanned project always wins a name
  // collision: config must not be able to redirect an existing project elsewhere.
  for (const dir of loadExtraProjectPaths()) {
    const name = path.basename(dir);
    if (!name || name === '.' || name === '..' || seen.has(name)) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const project = describeProject(name, dir);
    if (!project) continue;
    projects.push(project);
    seen.add(name);
  }

  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return projects;
}

// Resolve a project name to its absolute path, but only if it is a valid,
// currently-existing project (present in the allowlist). Returns null otherwise.
// This is the single gate protecting the PTY cwd from arbitrary input.
function resolveProject(name, roots = REPO_ROOTS) {
  if (typeof name !== 'string' || name.length === 0) return null;
  // Reject anything that is not a plain directory name up front.
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
    return null;
  }
  const project = listProjects(roots).find((p) => p.name === name);
  return project ? project.path : null;
}

// Return a single project object (same shape as listProjects entries) by name,
// or null if it is not a valid project.
function getProject(name, roots = REPO_ROOTS) {
  return listProjects(roots).find((p) => p.name === name) || null;
}

module.exports = {
  REPO_ROOT,
  REPO_ROOTS,
  listProjects,
  getProject,
  resolveProject,
  setTopTargets,
  parseTargets,
  readTargets,
};
