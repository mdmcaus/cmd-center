// Black-box security + smoke tests against a live server instance.
// Boots the server on a throwaway port with a fixture REPO_ROOT, then asserts:
//   - the PTY WebSocket rejects a foreign Origin (403)
//   - the PTY WebSocket rejects an unknown / traversal project (404)
//   - a valid project opens a working PTY (echo round-trips)
//   - the server binds to 127.0.0.1 (loopback only)
// Run: node test/security.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = 3399;
const HOST = '127.0.0.1';

// Fixture repo root with a single valid project (two targets).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcenter-sec-'));
fs.mkdirSync(path.join(root, 'demo'));
fs.writeFileSync(path.join(root, 'demo', 'Makefile'), 'hello:\n\techo hi\n\nworld:\n\techo w\n');

// Temp top-targets config so the real config is never touched by the endpoint tests.
const topCfg = path.join(root, 'top-targets.json');

process.env.REPO_ROOT = root;
process.env.PORT = String(PORT);
process.env.HOST = HOST;
process.env.TOP_TARGETS_FILE = topCfg;
// Empty extra-projects config: the fixture root is the whole allowlist, so the
// real out-of-root projects can never leak into these tests.
const extraCfg = path.join(root, 'extra-projects.json');
fs.writeFileSync(extraCfg, '[]');
process.env.EXTRA_PROJECTS_FILE = extraCfg;
// Temp ignore config, likewise, so these tests never write the real one.
const ignoreCfg = path.join(root, 'ignored-projects.json');
fs.writeFileSync(ignoreCfg, '[]');
process.env.IGNORED_PROJECTS_FILE = ignoreCfg;

const { server, shellEnv } = require('../server');

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

function putTopTargets(name, topTargets, origin) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ topTargets });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request(
      { host: HOST, port: PORT, method: 'PUT', path: `/api/projects/${encodeURIComponent(name)}/top-targets`, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function putIgnored(body, origin) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request(
      { host: HOST, port: PORT, method: 'PUT', path: '/api/ignored-projects', headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getProjects() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://${HOST}:${PORT}/api/projects`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d).projects || []));
      })
      .on('error', reject);
  });
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
  // The server's own listener config must never reach a project shell: a
  // Makefile saying `PORT ?= 3000` would otherwise bind this server's port.
  {
    const env = shellEnv();
    record(
      'shellEnv strips PORT / HOST',
      env.PORT === undefined && env.HOST === undefined,
      JSON.stringify({ PORT: env.PORT, HOST: env.HOST })
    );
  }

  // shellEnv must always produce a usable identity. os.userInfo() throws for a
  // uid with no passwd entry, and an unguarded call would break every terminal.
  {
    const env = shellEnv();
    const ok = ['USER', 'HOME', 'SHELL'].every(
      (k) => typeof env[k] === 'string' && env[k].length > 0
    );
    record(
      'shellEnv yields USER / HOME / SHELL',
      ok,
      JSON.stringify({ USER: env.USER, HOME: env.HOME, SHELL: env.SHELL })
    );
  }

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

  // 8. PUT top-targets from a foreign Origin is rejected (403).
  {
    const r = await putTopTargets('demo', ['hello'], 'http://evil.example.com');
    record('PUT top-targets foreign Origin rejected (403)', r.status === 403, JSON.stringify(r));
  }

  // 9. PUT for an unknown project is rejected (404).
  {
    const r = await putTopTargets('nope', ['hello'], goodOrigin);
    record('PUT top-targets unknown project rejected (404)', r.status === 404, JSON.stringify(r));
  }

  // 10. Valid PUT persists, filters unknown names, and preserves order.
  {
    const r = await putTopTargets('demo', ['world', 'ghost', 'hello'], goodOrigin);
    const projects = await getProjects();
    const demo = projects.find((p) => p.name === 'demo');
    const ok =
      r.status === 200 &&
      demo &&
      JSON.stringify(demo.topTargets) === JSON.stringify(['world', 'hello']);
    record('PUT top-targets persists, filters unknown, keeps order', ok, JSON.stringify({ status: r.status, top: demo && demo.topTargets }));
  }

  // 11. The ignore list is a mutating route: foreign Origin must be refused.
  {
    const r = await putIgnored({ ignored: ['demo'] }, 'http://evil.example.com');
    const still = await getProjects();
    const ok = r.status === 403 && still.some((p) => p.name === 'demo');
    record('PUT ignored-projects foreign Origin rejected (403)', ok, JSON.stringify({ status: r.status }));
  }

  // 12. Body must be an array of strings.
  {
    const r = await putIgnored({ ignored: 'demo' }, goodOrigin);
    record('PUT ignored-projects rejects non-array body (400)', r.status === 400, JSON.stringify(r));
  }

  // 13. Ignoring a project removes it from the list AND takes away its PTY.
  //     This is the important one: the list is the allowlist, so ignoring has to
  //     fail closed rather than merely hiding the project in the sidebar.
  {
    const put = await putIgnored({ ignored: ['demo'] }, goodOrigin);
    const after = await getProjects();
    const ws = connect('demo', goodOrigin);
    const r = await outcome(ws);
    ws.terminate();
    const ok =
      put.status === 200 &&
      !after.some((p) => p.name === 'demo') &&
      r.opened === false &&
      r.status === 404;
    record('ignored project is hidden and refused a PTY (404)', ok, JSON.stringify({ put: put.status, listed: after.map((p) => p.name), ws: r }));
  }

  // 14. Un-ignoring restores both the listing and the terminal.
  {
    await putIgnored({ ignored: [] }, goodOrigin);
    const after = await getProjects();
    const ws = connect('demo', goodOrigin);
    const r = await outcome(ws);
    ws.terminate();
    const ok = after.some((p) => p.name === 'demo') && r.opened === true;
    record('un-ignoring restores the project and its PTY', ok, JSON.stringify({ listed: after.map((p) => p.name), ws: r }));
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
