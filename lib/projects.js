// Project discovery and Makefile target parsing.
//
// A "project" is any immediate subdirectory of one of the REPO_ROOTS that contains
// a file named exactly "Makefile", plus any directory listed in config/extra-projects.json
// (for repos that live outside every root), minus any name listed in
// config/ignored-projects.json. The list of projects also serves as the
// security allowlist for the PTY endpoint: a project name is only ever accepted if
// it is present in this freshly-scanned list, so a client can never steer the
// terminal into an arbitrary directory. Ignoring is therefore fail-closed: an
// ignored project is not just hidden from the sidebar, it is also refused a PTY.

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

// Project names to leave out of the list entirely, as a JSON array of names:
//   ["scratch-repo", "old-thing"]
// Like the extra-projects config this is read on every scan rather than cached,
// so toggling a project in the UI takes effect on the next rescan with no restart.
const IGNORED_PROJECTS_FILE =
  process.env.IGNORED_PROJECTS_FILE || path.join(__dirname, '..', 'config', 'ignored-projects.json');

// A project name has to be a single plain path segment: it is the key the PTY
// allowlist matches on, and it is used as a config key. Shared by the ignore
// config reader and writer so junk can never reach the file.
function isUsableProjectName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

// Read the ignore config into a Set of names. A missing or malformed file is not
// an error, it just means nothing is ignored.
function loadIgnoredNames() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(IGNORED_PROJECTS_FILE, 'utf8'));
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter(isUsableProjectName));
}

// The ignored names, sorted, for callers that want to show or edit the list.
function listIgnoredProjects() {
  return [...loadIgnoredNames()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

// Replace the ignore list. Entries are validated as usable project names,
// de-duplicated, and sorted; anything else is dropped. Names are NOT checked
// against the current scan, so ignoring survives a project being temporarily
// missing (an unmounted disk, a repo not yet cloned) instead of silently
// un-ignoring it. Returns the saved list.
function setIgnoredProjects(list) {
  const cleaned = [...new Set((Array.isArray(list) ? list : []).filter(isUsableProjectName))].sort(
    (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
  fs.mkdirSync(path.dirname(IGNORED_PROJECTS_FILE), { recursive: true });
  fs.writeFileSync(IGNORED_PROJECTS_FILE, JSON.stringify(cleaned, null, 2) + '\n');
  return cleaned;
}

// Parse the top-targets config into a Map keyed by project name.
//
// A Map rather than a plain object on purpose: project names come from directory
// names on disk, so a directory called "__proto__" or "constructor" would
// otherwise reach into the prototype chain on read and hit the __proto__ setter
// on write. Object.entries yields only own enumerable keys, and Map treats every
// key as inert data, so neither is possible here.
function parseTopTargets(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object') return new Map();
  return new Map(Object.entries(parsed));
}

// Load and cache the top-targets config. A missing or invalid file is not an
// error: it just means no project has a curated set.
let _topTargetsCache;
function loadTopTargets() {
  if (_topTargetsCache !== undefined) return _topTargetsCache;
  try {
    _topTargetsCache = parseTopTargets(fs.readFileSync(TOP_TARGETS_FILE, 'utf8'));
  } catch {
    _topTargetsCache = new Map();
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
    config = parseTopTargets(fs.readFileSync(TOP_TARGETS_FILE, 'utf8'));
  } catch {
    config = new Map();
  }

  if (filtered.length) {
    config.set(name, filtered);
  } else {
    config.delete(name);
  }

  // Object.fromEntries defines own properties rather than assigning them, so a
  // project named "__proto__" round-trips through the file as ordinary data.
  fs.mkdirSync(path.dirname(TOP_TARGETS_FILE), { recursive: true });
  fs.writeFileSync(
    TOP_TARGETS_FILE,
    JSON.stringify(Object.fromEntries(config), null, 2) + '\n'
  );
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
  const configured = loadTopTargets().get(name);
  const existing = new Set(targets.map((t) => t.name));
  const topTargets = Array.isArray(configured)
    ? configured.filter((target) => existing.has(target))
    : [];
  return { name, path: projectPath, targets, topTargets };
}

// Scan each root one level deep for directories containing a Makefile, then add
// any configured out-of-root project directories. Roots are scanned in order and
// the first one to claim a name keeps it, so precedence is predictable.
// Returns every discovered project, ignore list not applied.
function scanProjects(roots = REPO_ROOTS) {
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

// Every discovered project, each tagged with whether it is currently ignored.
// This is what the "manage projects" screen renders: it has to show the ignored
// ones too, or there would be no way to bring one back.
function listAllProjects(roots = REPO_ROOTS) {
  const ignored = loadIgnoredNames();
  return scanProjects(roots).map((p) => ({ ...p, ignored: ignored.has(p.name) }));
}

// The usable projects: discovered, minus ignored. This is the list the UI shows
// and the allowlist the PTY endpoint checks, so ignoring a project also takes
// away its terminal.
function listProjects(roots = REPO_ROOTS) {
  const ignored = loadIgnoredNames();
  return scanProjects(roots).filter((p) => !ignored.has(p.name));
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
  listAllProjects,
  listIgnoredProjects,
  setIgnoredProjects,
  getProject,
  resolveProject,
  setTopTargets,
  parseTargets,
  readTargets,
};
