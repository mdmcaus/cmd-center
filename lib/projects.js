// Project discovery and Makefile target parsing.
//
// A "project" is any immediate subdirectory of REPO_ROOT that contains a file
// named exactly "Makefile". The list of projects also serves as the security
// allowlist for the PTY endpoint: a project name is only ever accepted if it is
// present in this freshly-scanned list, so a client can never steer the terminal
// into an arbitrary directory.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.REPO_ROOT || '/Users/michael/repo/claude';

// Optional curated "top targets" per project, keyed by project name. Lets a
// project surface a short list of its most-used targets before the full list.
const TOP_TARGETS_FILE =
  process.env.TOP_TARGETS_FILE || path.join(__dirname, '..', 'config', 'top-targets.json');

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
function setTopTargets(name, list, root = REPO_ROOT) {
  const projectPath = resolveProject(name, root);
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

// Scan REPO_ROOT one level deep for directories containing a Makefile.
// Returns [{ name, path, targets }] sorted by name (case-insensitive).
function listProjects(root = REPO_ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(root, entry.name);
    let hasMakefile = false;
    try {
      hasMakefile = fs.statSync(path.join(projectPath, 'Makefile')).isFile();
    } catch {
      hasMakefile = false;
    }
    if (!hasMakefile) continue;
    const targets = readTargets(projectPath);
    // Curated top targets: only names that actually exist, in config order.
    const configured = loadTopTargets()[entry.name];
    const existing = new Set(targets.map((t) => t.name));
    const topTargets = Array.isArray(configured)
      ? configured.filter((name) => existing.has(name))
      : [];
    projects.push({
      name: entry.name,
      path: projectPath,
      targets,
      topTargets,
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return projects;
}

// Resolve a project name to its absolute path, but only if it is a valid,
// currently-existing project (present in the allowlist). Returns null otherwise.
// This is the single gate protecting the PTY cwd from arbitrary input.
function resolveProject(name, root = REPO_ROOT) {
  if (typeof name !== 'string' || name.length === 0) return null;
  // Reject anything that is not a plain directory name up front.
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
    return null;
  }
  const project = listProjects(root).find((p) => p.name === name);
  return project ? project.path : null;
}

// Return a single project object (same shape as listProjects entries) by name,
// or null if it is not a valid project.
function getProject(name, root = REPO_ROOT) {
  return listProjects(root).find((p) => p.name === name) || null;
}

module.exports = {
  REPO_ROOT,
  listProjects,
  getProject,
  resolveProject,
  setTopTargets,
  parseTargets,
  readTargets,
};
