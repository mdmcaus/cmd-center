// cmd-center frontend: list projects, and on selection open an xterm terminal
// wired to a per-project PTY over a WebSocket.

(function () {
  'use strict';

  const listEl = document.getElementById('project-list');
  const countEl = document.getElementById('project-count');
  const refreshBtn = document.getElementById('refresh');
  const showTargetsEl = document.getElementById('show-targets');
  const targetsEl = document.getElementById('targets');
  const targetsPanelEl = document.getElementById('targets-panel');
  const currentProjectEl = document.getElementById('current-project');
  const currentPathEl = document.getElementById('current-path');
  const terminalEl = document.getElementById('terminal');
  const emptyStateEl = document.getElementById('empty-state');

  const SHOW_TARGETS_KEY = 'cmdcenter.showTargets';

  let projects = [];
  let active = null; // current project object
  let term = null;
  let fitAddon = null;
  let socket = null;

  // --- settings toggle (persisted) ---
  const savedShow = localStorage.getItem(SHOW_TARGETS_KEY);
  if (savedShow !== null) showTargetsEl.checked = savedShow === 'true';

  showTargetsEl.addEventListener('change', function () {
    localStorage.setItem(SHOW_TARGETS_KEY, String(showTargetsEl.checked));
    renderTargets();
    // The terminal width changes when the panel shows/hides, so reflow xterm.
    sendResize();
  });

  // --- project list ---
  async function loadProjects() {
    try {
      const res = await fetch('api/projects');
      const data = await res.json();
      projects = data.projects || [];
    } catch (err) {
      projects = [];
    }
    renderProjectList();
  }

  function renderProjectList() {
    listEl.innerHTML = '';
    for (const p of projects) {
      const li = document.createElement('li');
      li.dataset.name = p.name;
      if (active && active.name === p.name) li.classList.add('active');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;
      li.appendChild(nameSpan);

      if (p.targets && p.targets.length) {
        const badge = document.createElement('span');
        badge.className = 'count';
        badge.textContent = String(p.targets.length);
        badge.title = p.targets.length + ' make targets';
        li.appendChild(badge);
      }

      li.addEventListener('click', function () {
        selectProject(p);
      });
      listEl.appendChild(li);
    }
    countEl.textContent = projects.length + ' project' + (projects.length === 1 ? '' : 's');
  }

  // --- target buttons ---
  function renderTargets() {
    targetsEl.innerHTML = '';
    if (!active || !showTargetsEl.checked) {
      targetsPanelEl.hidden = true;
      return;
    }
    targetsPanelEl.hidden = false;
    const targets = active.targets || [];
    if (!targets.length) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = 'No make targets detected.';
      targetsEl.appendChild(none);
      return;
    }
    for (const t of targets) {
      const btn = document.createElement('button');
      btn.title = t.desc ? 'make ' + t.name + ': ' + t.desc : 'make ' + t.name;
      const label = document.createElement('span');
      label.textContent = 'make ' + t.name;
      btn.appendChild(label);
      if (t.desc) {
        const d = document.createElement('span');
        d.className = 'desc';
        d.textContent = t.desc;
        btn.appendChild(d);
      }
      btn.addEventListener('click', function () {
        runTarget(t.name);
      });
      targetsEl.appendChild(btn);
    }
  }

  function runTarget(name) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data: 'make ' + name + '\n' }));
      if (term) term.focus();
    }
  }

  // --- terminal / websocket ---
  function selectProject(p) {
    active = p;
    renderProjectList();
    renderTargets();
    currentProjectEl.textContent = p.name;
    currentPathEl.textContent = p.path;
    emptyStateEl.style.display = 'none';
    openTerminal(p);
  }

  function teardownTerminal() {
    if (socket) {
      try {
        socket.close();
      } catch (e) {
        /* noop */
      }
      socket = null;
    }
    if (term) {
      term.dispose();
      term = null;
    }
    terminalEl.innerHTML = '';
  }

  function openTerminal(p) {
    teardownTerminal();

    term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#16161e', foreground: '#c0caf5' },
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalEl);
    fitAddon.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = proto + '://' + location.host + '/pty?project=' + encodeURIComponent(p.name);
    socket = new WebSocket(url);

    socket.addEventListener('open', function () {
      sendResize();
      term.focus();
    });

    socket.addEventListener('message', function (ev) {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        term.write('\r\n\x1b[90m[process exited' + (msg.code ? ' with code ' + msg.code : '') + ']\x1b[0m\r\n');
      }
    });

    socket.addEventListener('close', function () {
      if (term) term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    });

    term.onData(function (data) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data: data }));
      }
    });
  }

  function sendResize() {
    if (!term || !fitAddon || !socket || socket.readyState !== WebSocket.OPEN) return;
    fitAddon.fit();
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }

  let resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendResize, 100);
  });

  refreshBtn.addEventListener('click', loadProjects);

  // init
  renderTargets();
  loadProjects();
})();
