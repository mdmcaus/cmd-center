// Black-box security + smoke tests against a live server instance.
// Boots the server on a throwaway port with a fixture REPO_ROOT, then asserts:
//   - the PTY WebSocket rejects a foreign Origin (403)
//   - the PTY WebSocket rejects an unknown / traversal project (404)
//   - a valid project opens a working PTY (echo round-trips)
//   - the server binds to 127.0.0.1 (loopback only)
// Run: node test/security.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = 3399;
const HOST = '127.0.0.1';

// Fixture repo root with a single valid project.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcenter-sec-'));
fs.mkdirSync(path.join(root, 'demo'));
fs.writeFileSync(path.join(root, 'demo', 'Makefile'), 'hello:\n\techo hi\n');

process.env.REPO_ROOT = root;
process.env.PORT = String(PORT);
process.env.HOST = HOST;

const { server } = require('../server');

let passed = 0;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) passed++;
}

function connect(project, origin) {
  const url = `ws://${HOST}:${PORT}/pty?project=${encodeURIComponent(project)}`;
  const headers = {};
  if (origin !== undefined) headers.Origin = origin;
  return new WebSocket(url, { headers });
}

// Wait for a ws to either open or fail; resolve with {opened, status}.
function outcome(ws) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    ws.on('open', () => finish({ opened: true }));
    ws.on('unexpected-response', (_req, res) => finish({ opened: false, status: res.statusCode }));
    ws.on('error', () => finish({ opened: false, status: 0 }));
  });
}

async function run() {
  const goodOrigin = `http://${HOST}:${PORT}`;

  // 1. Foreign Origin is rejected with 403.
  {
    const ws = connect('demo', 'http://evil.example.com');
    const r = await outcome(ws);
    ws.terminate();
    record('foreign Origin rejected (403)', r.opened === false && r.status === 403, JSON.stringify(r));
  }

  // 2. Missing Origin is rejected (browsers always send one for ws).
  {
    const ws = connect('demo', undefined);
    const r = await outcome(ws);
    ws.terminate();
    record('missing Origin rejected', r.opened === false && r.status === 403, JSON.stringify(r));
  }

  // 3. Unknown project is rejected with 404.
  {
    const ws = connect('does-not-exist', goodOrigin);
    const r = await outcome(ws);
    ws.terminate();
    record('unknown project rejected (404)', r.opened === false && r.status === 404, JSON.stringify(r));
  }

  // 4. Path traversal project is rejected.
  {
    const ws = connect('../../etc', goodOrigin);
    const r = await outcome(ws);
    ws.terminate();
    record('traversal project rejected', r.opened === false && r.status === 404, JSON.stringify(r));
  }

  // 5. Valid project + good Origin opens a working PTY (echo round-trips).
  {
    const ws = connect('demo', goodOrigin);
    const r = await outcome(ws);
    let echoed = false;
    if (r.opened) {
      echoed = await new Promise((resolve) => {
        let buf = '';
        const timer = setTimeout(() => resolve(false), 4000);
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'output') buf += msg.data;
          } catch (e) {
            /* ignore */
          }
          if (buf.includes('CMDCENTER_ECHO_OK')) {
            clearTimeout(timer);
            resolve(true);
          }
        });
        ws.send(JSON.stringify({ type: 'input', data: 'echo CMDCENTER_ECHO_OK\n' }));
      });
    }
    ws.terminate();
    record('valid project opens working PTY', r.opened === true && echoed, 'opened=' + r.opened + ' echoed=' + echoed);
  }

  // 6. HTTP API is reachable on loopback and returns the fixture project.
  {
    const body = await new Promise((resolve, reject) => {
      http
        .get(`http://${HOST}:${PORT}/api/projects`, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        })
        .on('error', reject);
    });
    const parsed = JSON.parse(body);
    const names = (parsed.projects || []).map((p) => p.name);
    record('API lists fixture project on 127.0.0.1', names.includes('demo'), JSON.stringify(names));
  }

  // 7. Server is bound to loopback, not 0.0.0.0.
  {
    const addr = server.address();
    record('server bound to loopback', addr && addr.address === '127.0.0.1', JSON.stringify(addr));
  }
}

// Start listening, then run the checks.
server.listen(PORT, HOST, async () => {
  try {
    await run();
  } catch (err) {
    console.error('test harness error:', err);
    process.exitCode = 1;
  } finally {
    for (const r of results) {
      console.log((r.ok ? '  ok   - ' : '  FAIL - ') + r.name + (r.ok ? '' : '  [' + r.detail + ']'));
      if (!r.ok) process.exitCode = 1;
    }
    console.log('\n' + passed + '/' + results.length + ' security checks passed');
    server.close();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
    // node-pty keeps the loop alive briefly; force a clean exit.
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
});
