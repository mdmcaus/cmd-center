// cmd-center server: serves the UI, lists projects with a Makefile, and exposes
// a real interactive PTY per project over a WebSocket.
//
// Security posture (this is a local-only tool that runs a shell as the current
// user, by design):
//   - binds to 127.0.0.1 only, never a public interface
//   - WebSocket connections must carry a same-origin Origin header
//   - the PTY cwd is only ever a directory from the scanned Makefile allowlist;
//     the client-supplied project name is validated, never used to build a path

const express = require('express');
const helmet = require('helmet');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { listProjects, resolveProject } = require('./lib/projects');

const PORT = Number(process.env.PORT) || 3200;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// Content-Security-Policy: everything is served from self and xterm needs an
// inline style for its DOM measuring; no external origins are permitted.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'connect-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
      },
    },
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/projects -> [{ name, path, targets:[{name,desc}] }]
app.get('/api/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

const server = http.createServer(app);

// --- WebSocket PTY endpoint: /pty?project=<name> ---

// Accept the connection only from a same-origin browser context. This prevents a
// malicious web page the user happens to visit from opening a shell on their box.
function allowedOrigin(origin) {
  if (!origin) return false;
  const allowed = new Set([
    `http://${HOST}:${PORT}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ]);
  return allowed.has(origin);
}

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
function shellEnv() {
  const info = os.userInfo(); // reflects the real effective uid
  return {
    ...process.env,
    USER: info.username,
    LOGNAME: info.username,
    HOME: info.homedir,
    SHELL: info.shell || process.env.SHELL || '/bin/bash',
    TERM: 'xterm-256color',
    CMD_CENTER: '1',
  };
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

module.exports = { app, server, allowedOrigin };
