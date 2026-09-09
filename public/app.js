// cmd-center frontend: list projects, and on selection open an xterm terminal
// wired to a per-project PTY over a WebSocket.

(function () {
  'use strict';

  const listEl = document.getElementById('project-list');
  const countEl = document.getElementById('project-count');
  const refreshBtn = document.getElementById('refresh');
  const showTargetsEl = document.getElementById('show-targets');
  const showDescsEl = document.getElementById('show-descs');
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
  const manageBtn = document.getElementById('manage-projects');
  const ignoreOverlayEl = document.getElementById('ignore-overlay');
  const ignoreCountEl = document.getElementById('ignore-count');
  const ignoreShownEl = document.getElementById('ignore-shown');
  const ignoreHiddenEl = document.getElementById('ignore-hidden');
  const ignoreSaveEl = document.getElementById('ignore-save');
  const ignoreCancelEl = document.getElementById('ignore-cancel');

  const SHOW_TARGETS_KEY = 'cmdcenter.showTargets';
  const SHOW_DESCS_KEY = 'cmdcenter.showDescs';

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

  // Descriptions come from "## text" comments on Makefile target lines. Most
  // projects have none, but a fully documented Makefile makes the panel very
  // tall, so this is off by default; the text stays available as a tooltip.
  const savedDescs = localStorage.getItem(SHOW_DESCS_KEY);
  if (savedDescs !== null) showDescsEl.checked = savedDescs === 'true';

  showDescsEl.addEventListener('change', function () {
    localStorage.setItem(SHOW_DESCS_KEY, String(showDescsEl.checked));
    renderTargets();
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
    if (t.desc && showDescsEl.checked) {
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
    if (e.key !== 'Escape') return;
    if (!editorOverlayEl.hidden) closeEditor();
    if (!ignoreOverlayEl.hidden) closeManage();
  });

  // --- manage projects (ignore list) ---
  // Ignoring is stored server-side as a list of project names in
  // config/ignored-projects.json, not in localStorage: the same list is what the
  // server filters the PTY allowlist by, so it has to live with the server.
  let allProjects = []; // every discovered project, ignored ones included
  let editIgnored = new Set(); // working copy, committed on Save

  async function openManage() {
    ignoreShownEl.innerHTML = '';
    ignoreHiddenEl.innerHTML = '';
    ignoreCountEl.classList.remove('over');
    ignoreCountEl.textContent = 'loading…';
    ignoreOverlayEl.hidden = false;
    try {
      const res = await fetch('api/projects/all');
      if (!res.ok) throw new Error('could not load projects (' + res.status + ')');
      const data = await res.json();
      allProjects = data.projects || [];
      editIgnored = new Set(
        allProjects.filter(function (p) {
          return p.ignored;
        }).map(function (p) {
          return p.name;
        })
      );
      // Names ignored while their project is missing from the scan: keep them so
      // saving does not silently drop the entry and un-ignore the project later.
      for (const name of data.ignored || []) editIgnored.add(name);
      renderManage();
    } catch (err) {
      ignoreCountEl.textContent = String(err.message || 'load failed');
      ignoreCountEl.classList.add('over');
    }
  }

  function closeManage() {
    ignoreOverlayEl.hidden = true;
  }

  // One row: name, its path underneath, and the button that flips its state.
  function manageRow(name, subtitle, control) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'editor-row-text';
    const label = document.createElement('span');
    label.className = 'editor-name';
    label.textContent = name;
    text.appendChild(label);
    if (subtitle) {
      const sub = document.createElement('span');
      sub.className = 'editor-sub';
      sub.textContent = subtitle;
      sub.title = subtitle;
      text.appendChild(sub);
    }
    li.appendChild(text);
    const actions = document.createElement('span');
    actions.className = 'editor-row-actions';
    actions.appendChild(control);
    li.appendChild(actions);
    return li;
  }

  function renderManage() {
    ignoreShownEl.innerHTML = '';
    ignoreHiddenEl.innerHTML = '';

    const byName = {};
    for (const p of allProjects) byName[p.name] = p;

    const shown = allProjects.filter(function (p) {
      return !editIgnored.has(p.name);
    });
    // Ignored names that no longer match a discovered project still belong here,
    // otherwise there is no way to see or undo them.
    const hidden = [...editIgnored].sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });

    for (const p of shown) {
      const hide = iconBtn('✕', 'Ignore ' + p.name, function () {
        editIgnored.add(p.name);
        renderManage();
      });
      ignoreShownEl.appendChild(manageRow(p.name, p.dir || p.path, hide));
    }
    if (!shown.length) {
      const none = document.createElement('li');
      none.className = 'empty';
      none.textContent = 'Every project is ignored.';
      ignoreShownEl.appendChild(none);
    }

    for (const name of hidden) {
      const restore = iconBtn('+', 'Show ' + name, function () {
        editIgnored.delete(name);
        renderManage();
      });
      const known = byName[name];
      const row = manageRow(name, known ? known.dir || known.path : 'not currently found', restore);
      row.classList.add('is-ignored');
      ignoreHiddenEl.appendChild(row);
    }
    if (!hidden.length) {
      const none = document.createElement('li');
      none.className = 'empty';
      none.textContent = 'Nothing ignored.';
      ignoreHiddenEl.appendChild(none);
    }

    ignoreCountEl.classList.remove('over');
    ignoreCountEl.textContent = shown.length + ' shown, ' + hidden.length + ' ignored';
  }

  async function saveManage() {
    ignoreSaveEl.disabled = true;
    try {
      const res = await fetch('api/ignored-projects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ignored: [...editIgnored] }),
      });
      if (!res.ok) throw new Error('save failed (' + res.status + ')');
      closeManage();
      await loadProjects();
      // The open project may have just been ignored; it no longer has a PTY, so
      // drop back to the empty state rather than leaving a dead terminal up.
      if (active && !projects.some(function (p) { return p.name === active.name; })) {
        closeActiveProject();
      }
    } catch (err) {
      ignoreCountEl.textContent = String(err.message || 'save failed');
      ignoreCountEl.classList.add('over');
    } finally {
      ignoreSaveEl.disabled = false;
    }
  }

  manageBtn.addEventListener('click', openManage);
  ignoreSaveEl.addEventListener('click', saveManage);
  ignoreCancelEl.addEventListener('click', closeManage);
  ignoreOverlayEl.addEventListener('click', function (e) {
    if (e.target === ignoreOverlayEl) closeManage();
  });

  // --- terminal / websocket ---
  function closeActiveProject() {
    active = null;
    teardownTerminal();
    renderProjectList();
    renderTargets();
    currentProjectEl.textContent = 'Select a project';
    currentPathEl.textContent = '';
    emptyStateEl.style.display = '';
  }

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
