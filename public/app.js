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
  const editBtn = document.getElementById('edit-targets');
  const editorOverlayEl = document.getElementById('editor-overlay');
  const editorTitleEl = document.getElementById('editor-title');
  const editorCountEl = document.getElementById('editor-count');
  const editorTopEl = document.getElementById('editor-top');
  const editorMoreEl = document.getElementById('editor-more');
  const editorSaveEl = document.getElementById('editor-save');
  const editorCancelEl = document.getElementById('editor-cancel');

  const SHOW_TARGETS_KEY = 'cmdcenter.showTargets';

  let projects = [];
  let active = null; // current project object
  let showAllTargets = false; // when a project has a curated set, whether it is expanded
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

  // Build one quick-run button for a target object { name, desc }.
  function makeTargetButton(t) {
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
    return btn;
  }

  function makeToggleButton(text, expand) {
    const btn = document.createElement('button');
    btn.className = 'targets-toggle';
    btn.textContent = text;
    btn.addEventListener('click', function () {
      showAllTargets = expand;
      renderTargets();
    });
    return btn;
  }

  function renderTargets() {
    targetsEl.innerHTML = '';
    if (!active || !showTargetsEl.checked) {
      targetsPanelEl.hidden = true;
      return;
    }
    targetsPanelEl.hidden = false;

    // Full list, sorted alphabetically (matches the project list).
    const fullList = (active.targets || [])
      .slice()
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    if (!fullList.length) {
      const none = document.createElement('span');
      none.className = 'none';
      none.textContent = 'No make targets detected.';
      targetsEl.appendChild(none);
      return;
    }

    // Curated top targets (config order), only those that exist. Empty for most projects.
    const byName = {};
    for (const t of fullList) byName[t.name] = t;
    const curated = (active.topTargets || []).map(function (name) {
      return byName[name];
    }).filter(Boolean);

    if (curated.length && !showAllTargets) {
      for (const t of curated) targetsEl.appendChild(makeTargetButton(t));
      targetsEl.appendChild(makeToggleButton('Show all (' + fullList.length + ')', true));
    } else {
      for (const t of fullList) targetsEl.appendChild(makeTargetButton(t));
      if (curated.length) {
        targetsEl.appendChild(makeToggleButton('Show top only', false));
      }
    }
  }

  function runTarget(name) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data: 'make ' + name + '\n' }));
      if (term) term.focus();
    }
  }

  // --- top-targets editor ---
  const RECOMMENDED = 10;
  let editTop = []; // ordered target names chosen as "top"
  let editMore = []; // remaining target names, alphabetical

  function allTargetNames() {
    return (active && active.targets ? active.targets : [])
      .map(function (t) {
        return t.name;
      })
      .sort(function (a, b) {
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
      });
  }

  function openEditor() {
    if (!active) return;
    const all = allTargetNames();
    const current = (active.topTargets || []).filter(function (n) {
      return all.indexOf(n) !== -1;
    });
    editTop = current.slice();
    editMore = all.filter(function (n) {
      return editTop.indexOf(n) === -1;
    });
    editorTitleEl.textContent = 'Top targets: ' + active.name;
    renderEditor();
    editorOverlayEl.hidden = false;
  }

  function closeEditor() {
    editorOverlayEl.hidden = true;
  }

  function editRow(name, controls) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'editor-name';
    label.textContent = name;
    li.appendChild(label);
    const actions = document.createElement('span');
    actions.className = 'editor-row-actions';
    for (const c of controls) actions.appendChild(c);
    li.appendChild(actions);
    return li;
  }

  function iconBtn(text, title, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    if (disabled) b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderEditor() {
    editorTopEl.innerHTML = '';
    editorMoreEl.innerHTML = '';

    editTop.forEach(function (name, i) {
      const up = iconBtn('↑', 'Move up', function () {
        editTop.splice(i - 1, 0, editTop.splice(i, 1)[0]);
        renderEditor();
      }, i === 0);
      const down = iconBtn('↓', 'Move down', function () {
        editTop.splice(i + 1, 0, editTop.splice(i, 1)[0]);
        renderEditor();
      }, i === editTop.length - 1);
      const remove = iconBtn('✕', 'Remove from top', function () {
        editTop.splice(i, 1);
        editMore.push(name);
        editMore.sort(function (a, b) {
          return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
        renderEditor();
      });
      editorTopEl.appendChild(editRow(name, [up, down, remove]));
    });

    editMore.forEach(function (name) {
      const add = iconBtn('+', 'Add to top', function () {
        editMore = editMore.filter(function (n) {
          return n !== name;
        });
        editTop.push(name);
        renderEditor();
      });
      editorMoreEl.appendChild(editRow(name, [add]));
    });

    editorCountEl.textContent = editTop.length + ' selected';
    editorCountEl.classList.toggle('over', editTop.length > RECOMMENDED);
  }

  async function saveEditor() {
    if (!active) return;
    editorSaveEl.disabled = true;
    try {
      const res = await fetch('api/projects/' + encodeURIComponent(active.name) + '/top-targets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topTargets: editTop }),
      });
      if (!res.ok) throw new Error('save failed (' + res.status + ')');
      const data = await res.json();
      // Update local state so the panel reflects the saved set immediately.
      active.topTargets = data.project.topTargets;
      const idx = projects.findIndex(function (p) {
        return p.name === active.name;
      });
      if (idx !== -1) projects[idx] = data.project;
      showAllTargets = false;
      renderTargets();
      closeEditor();
    } catch (err) {
      editorCountEl.textContent = String(err.message || 'save failed');
      editorCountEl.classList.add('over');
    } finally {
      editorSaveEl.disabled = false;
    }
  }

  editBtn.addEventListener('click', openEditor);
  editorSaveEl.addEventListener('click', saveEditor);
  editorCancelEl.addEventListener('click', closeEditor);
  editorOverlayEl.addEventListener('click', function (e) {
    if (e.target === editorOverlayEl) closeEditor();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !editorOverlayEl.hidden) closeEditor();
  });

  // --- terminal / websocket ---
  function selectProject(p) {
    active = p;
    showAllTargets = false; // each project starts collapsed to its curated set
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
