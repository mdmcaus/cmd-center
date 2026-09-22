// cmd-center server: serves the UI, lists projects with a Makefile, and exposes
// a real interactive PTY per project over a WebSocket.
//
// Security posture (this is a local-only tool that runs a shell as the current
// user, by design):
//   - binds to 127.0.0.1 only, never a public interface
//   - WebSocket connections must carry a same-origin Origin header
//   - the PTY cwd is only ever a directory from the scanned Makefile allowlist;
//     the client-supplied project name is validated, never used to build a path
//
// In Docker the first rule is enforced on the host side instead: the process
// binds 0.0.0.0 inside the container (a loopback listener there is unreachable
// through a published port) and compose publishes it to 127.0.0.1 only. See
// docker-deploy.md.

const express = require('express');
const helmet = require('helmet');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const {
  listProjects,
  listAllProjects,
  listIgnoredProjects,
  setIgnoredProjects,
  getProject,
  resolveProject,
  setTopTargets,
} = require('./lib/projects');

const PORT = Number(process.env.PORT) || 3200;
const HOST = process.env.HOST || '127.0.0.1';

// Extra origins the page may legitimately be served from, as a comma-separated
// list. Needed when the port the browser sees is not the port this process
// listens on, which is exactly what happens in Docker: the container listens on
// 3200 while compose may publish it on another host port, so the browser sends
// an Origin this server would otherwise reject and every terminal would 403.
//
// Empty by default, so with the variable unset the allow set is identical to
// what it has always been. Entries are trimmed and matched exactly; anything
// that is not a well-formed http(s) origin is dropped rather than trusted.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .filter((entry) => {
    try {
      const u = new URL(entry);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === entry;
    } catch {
      return false;
    }
  });

// The WebSocket origin matching each permitted http origin. A browser sends the
// page's http origin on the upgrade request, so these are only used to build the
// CSP connect-src list, not to widen the check itself.
function wsOrigin(httpOrigin) {
  return httpOrigin.replace(/^http/, 'ws');
}

// Accept a request only from this app's own page. Used for the WebSocket upgrade
// and for mutating API routes, so a malicious page the user visits cannot drive
// the terminal or rewrite config through the user's browser.
// The origins derived from this process's own listener. In Docker these are not
// the origins the browser actually uses: the container listens on 3200 while the
// page may be published on another port, so the derived set would accept an
// origin for a port nothing is served on. Harmless (a page cannot forge its own
// Origin) but wider than it needs to be, so ALLOWED_ORIGINS_ONLY drops them and
// trusts nothing but the explicit list. Off by default; compose turns it on.
const DERIVED_ORIGINS = [
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];

const ORIGINS_ONLY = process.env.ALLOWED_ORIGINS_ONLY === '1' && EXTRA_ORIGINS.length > 0;

const ALLOWED_ORIGINS = new Set(
  ORIGINS_ONLY ? EXTRA_ORIGINS : [...DERIVED_ORIGINS, ...EXTRA_ORIGINS]
);

function allowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

const app = express();

// Content-Security-Policy: everything is served from self and xterm needs an
// inline style for its DOM measuring; no external origins are permitted.
//
// Two directives differ from helmet's defaults, both required for a plain-http
// local tool:
//   - upgrade-insecure-requests is removed. Helmet enables it by default, but on
//     http://127.0.0.1 Safari honours it and tries to fetch styles.css / app.js /
//     the xterm assets over https, which fails (there is no TLS), leaving the page
//     unstyled with no scripts. Chrome exempts localhost; Safari does not.
//   - connect-src lists the ws:// origins explicitly so Safari allows the terminal
//     WebSocket ('self' alone is not reliably honoured for ws in Safari).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'connect-src': [...new Set(["'self'", ...[...ALLOWED_ORIGINS].map(wsOrigin)])],
        'img-src': ["'self'", 'data:'],
        'upgrade-insecure-requests': null,
      },
    },
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/health -> { ok: true }
// Deliberately does no work. The container healthcheck polls this every 30s, and
// pointing it at /api/projects instead would rescan every repo root on each poll.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// GET /api/projects -> [{ name, path, targets:[{name,desc}], topTargets:[...] }]
// Ignored projects are already filtered out; this is the list the sidebar shows.
app.get('/api/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

// The directory a project sits in, shortened for display: the full path is too
// long for a list row, and the parent is what actually distinguishes two
// same-named projects found under different roots.
function displayDir(projectPath) {
  const dir = path.dirname(projectPath);
  const home = os.homedir();
  return dir === home || dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
}

// GET /api/projects/all -> every discovered project, each with `ignored: bool`
// and a display-friendly `dir`. The manage-projects screen needs the ignored
// ones too, to offer them back.
app.get('/api/projects/all', (_req, res) => {
  const projects = listAllProjects().map((p) => ({ ...p, dir: displayDir(p.path) }));
  res.json({ projects, ignored: listIgnoredProjects() });
});

// PUT /api/ignored-projects  Body: { ignored: [name, ...] }
// Replaces the ignore list. Same-origin only, like every other mutating route.
app.put('/api/ignored-projects', (req, res) => {
  if (!allowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const list = req.body && req.body.ignored;
  if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) {
    return res.status(400).json({ error: 'ignored must be an array of strings' });
  }
  const saved = setIgnoredProjects(list);
  return res.json({ ignored: saved, projects: listAllProjects() });
});

// PUT /api/projects/:name/top-targets  Body: { topTargets: [name, ...] }
// Saves the project's curated top-target list (order preserved). Same-origin only.
app.put('/api/projects/:name/top-targets', (req, res) => {
  if (!allowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const list = req.body && req.body.topTargets;
  if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) {
    return res.status(400).json({ error: 'topTargets must be an array of strings' });
  }
  const saved = setTopTargets(req.params.name, list);
  if (saved === null) {
    return res.status(404).json({ error: 'unknown project' });
  }
  return res.json({ project: getProject(req.params.name) });
});

const server = http.createServer(app);

// --- WebSocket PTY endpoint: /pty?project=<name> ---

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/pty') {
    socket.destroy();
    return;
  }
  if (!allowedOrigin(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const cwd = resolveProject(url.searchParams.get('project'));
  if (!cwd) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, cwd);
  });
});

// The identity of the process that launched this server can leak stale USER /
// LOGNAME / HOME values into the environment (for example USER=root when the
// process actually runs as a normal user). The shell prompt and tools read those
// variables, so we rebuild them from the real account behind the current uid so
// the terminal matches the user's normal login shell.
// os.userInfo() throws ERR_SYSTEM_ERROR (uv_os_get_passwd ENOENT) when the
// effective uid has no passwd entry. That is not hypothetical: a container told
// to run as the host's uid has no matching account inside the image, and an
// unguarded call here would take down every terminal the user tries to open.
// Fall back to the environment, which is the best identity available.
function currentUser() {
  try {
    return os.userInfo(); // reflects the real effective uid
  } catch {
    return {
      username: process.env.USER || process.env.LOGNAME || 'user',
      homedir: process.env.HOME || '/',
      shell: process.env.SHELL || null,
    };
  }
}

function shellEnv() {
  const info = currentUser();
  const env = {
    ...process.env,
    USER: info.username,
    LOGNAME: info.username,
    HOME: info.homedir,
    SHELL: info.shell || process.env.SHELL || '/bin/bash',
    TERM: 'xterm-256color',
    CMD_CENTER: '1',
  };
  // Our own listener config must not leak into project shells: a project whose
  // Makefile says `PORT ?= 3000` would silently bind our 3200 instead.
  delete env.PORT;
  delete env.HOST;
  delete env.ALLOWED_ORIGINS;
  delete env.ALLOWED_ORIGINS_ONLY;
  return env;
}

wss.on('connection', (ws, _req, cwd) => {
  const env = shellEnv();
  const term = pty.spawn(env.SHELL, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize') {
      const cols = Math.max(1, Math.min(1000, Number(msg.cols) | 0));
      const rows = Math.max(1, Math.min(1000, Number(msg.rows) | 0));
      if (cols && rows) term.resize(cols, rows);
    }
  });

  ws.on('close', () => {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
});

// Export the app/server for tests; only listen when run directly.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`cmd-center listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { app, server, allowedOrigin, shellEnv, currentUser };
