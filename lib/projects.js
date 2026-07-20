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
    projects.push({
      name: entry.name,
      path: projectPath,
      targets: readTargets(projectPath),
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

module.exports = { REPO_ROOT, listProjects, resolveProject, parseTargets, readTargets };
