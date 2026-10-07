/* ===========================================================================
 * Migrate Studio
 *
 * Point it at a folder of SAS programs, load a rule book, and fix the programs
 * in place with a version behind every change.
 *
 * The shape of the app is the same three-column shell as the rest of the
 * Migration tools: the programs on the left, the selected program in the
 * middle, and what you need while looking at it on the right. What is
 * different is where the data lives. There is no server and no metadata file —
 * the source of truth is the folder you picked, read through the File System
 * Access API, and the fixes are held in memory until you Save them back.
 *
 * That choice drives three things worth knowing before reading further:
 *
 *   1. Everything is asynchronous at the edges. Reading a program, writing one
 *      back and picking a folder all return promises, and the browser can
 *      revoke the folder permission between two of them. Every write path
 *      re-checks permission rather than assuming the grant from the picker
 *      still holds.
 *
 *   2. History is local. A fix history that only exists in this browser is
 *      worth less than a Git log, but it is worth a great deal more than
 *      nothing, and it costs no infrastructure. Versions are kept in memory for
 *      the session and mirrored to localStorage, keyed by folder and file name,
 *      so closing the tab does not lose the record of what was changed.
 *
 *   3. Nothing is written until you ask. Apply Fix changes the in-memory copy
 *      and makes sure a Migrate Studio output folder is available when the browser
 *      can create it. Save writes the fixed programs to disk. The two are
 *      separate so a rule book can be tried against a study and thrown away.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }
  function on(el, event, handler) { if (el) el.addEventListener(event, handler); }
  function esc(text) { return window.MigDiff.escapeHtml(text); }
  function attr(text) { return esc(text).replace(/"/g, '&quot;'); }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function ago(iso) {
    var then = new Date(iso).getTime();
    if (!then) return '';
    var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  function stamp() { return new Date().toISOString(); }

  function timestampYYYYMMDDHHMM() {
    var d = new Date();
    function z(n) { return String(n).padStart(2, '0'); }
    return String(d.getFullYear()) + z(d.getMonth() + 1) + z(d.getDate()) +
      '_' + z(d.getHours()) + z(d.getMinutes());
  }

  /* ---------------------------------------------------------------------
   * State
   *
   * `programs` is the whole model. Each entry carries the file handle (when
   * the browser gave us one), the original text as read from disk, the fixed
   * text if a rule book has been run, and the versions produced along the way.
   * ------------------------------------------------------------------ */

  var state = {
    dirHandle: null,        // FileSystemDirectoryHandle, or null in fallback mode
    folderName: '',
    folderPath: '',
    writable: false,        // did the browser give us write access?
    programs: [],
    selected: -1,
    checked: {},            // file name -> true, for multi-select Apply Fix
    rules: null,            // as MigRules.parse returns it
    rulesBytes: null,       // the workbook as read, so Export Rules round-trips
    mcRules: null,          // as MigMcRules.parse returns it
    mcUnavailable: '',
    mcLoading: false,
    ruleSource: 'mc',
    osFamily: 'LINUX',
    pathRoot: '',
    tocCaseMap: {},
    dirIndex: {},
    findings: [],
    tab: 'rules',
    historySubtab: 'runs',
    runHistory: [],
    runHistoryError: '',
    runHistoryLoading: false,
    runHistoryToken: 0,
    historyPending: false,
    historyOpenCards: null,
    historyProgramQuery: '',
    backupIndex: null,
    lastBackupInfo: null,
    identity: {
      userId: '',
      userKey: '',
      source: 'unknown',
      host: '',
      os: '',
      sessionId: '',
      resolvedAt: ''
    },
    identityReady: null,
    authorPrompted: false,
    dirty: false,
    author: { name: '', email: '' },
    label: 'Migration Name'
  };

  var legacyBrand = 'Port' + 'Fix';
  var legacyStorePrefix = 'port' + 'fix.v1.';
  var legacyDirHandleKey = 'port' + 'fix_program_folder';
  var legacyRulesName = legacyBrand + '_Rules.xlsx';
  var rulesNameRe = new RegExp('^(Migrate_Studio|' + legacyBrand + ')_Rules\\.xlsx$', 'i');
  var STORE_PREFIX = 'migratestudio.v1.';
  var ORIGINAL_BACKUP_FOLDER = '_migrate_original';
  /* Shown on the About screen. Bump both with each release and add a matching
     section at the top of CHANGELOG.md. */
  var APP_VERSION = 'v0.3 Beta';
  var APP_BUILD = '2026.09.21';
  var RELEASE_NOTES_FILE = 'CHANGELOG.md';
  var RUN_HISTORY_KEY = STORE_PREFIX + 'runhistory';
  var HISTORY_TEXT_MAX = 400;
  var DIR_HANDLE_KEY = 'migratestudio_program_folder';
  var HANDLE_DB = legacyStorePrefix + 'handles';
  var HANDLE_STORE = 'handles';
  var pendingReconnect = null;
  var legacyOutputFolderFound = false;
  var legacyOutputNoticeShown = false;

  (function migrateLegacyKeys() {
    try {
      if (window.localStorage.getItem(STORE_PREFIX + '__migrated')) return;
      Object.keys(window.localStorage).forEach(function (key) {
        if (key.indexOf(legacyStorePrefix) !== 0) return;
        window.localStorage.setItem(
          STORE_PREFIX + key.slice(legacyStorePrefix.length),
          window.localStorage.getItem(key)
        );
      });
      window.localStorage.setItem(STORE_PREFIX + '__migrated', '1');
    } catch (e) { /* old browser storage is best-effort only */ }
  })();

  /* ---------------------------------------------------------------------
   * Persistence
   *
   * localStorage is best-effort throughout: a private window, a browser set to
   * block site data, or a quota that a large program blows past all throw, and
   * none of them are a reason to stop working. Every read and write is wrapped.
   * ------------------------------------------------------------------ */

  function storeKey() {
    return STORE_PREFIX + 'history.' + (state.folderName || 'unknown');
  }

  function loadPrefs() {
    try {
      var raw = window.localStorage.getItem(STORE_PREFIX + 'prefs');
      if (!raw) return;
      var prefs = JSON.parse(raw);
      if (prefs.author) state.author = prefs.author;
      if (prefs.label) state.label = prefs.label;
      if (prefs.ruleSource === 'legacy' || prefs.ruleSource === 'mc' || prefs.ruleSource === 'jm') {
        state.ruleSource = prefs.ruleSource === 'jm' ? 'mc' : prefs.ruleSource;
      }
      if (prefs.osFamily === 'LINUX' || prefs.osFamily === 'WINDOWS') {
        state.osFamily = prefs.osFamily;
      }
      if (typeof prefs.pathRoot === 'string') state.pathRoot = prefs.pathRoot;
    } catch (e) { /* no prefs is a fine starting point */ }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(STORE_PREFIX + 'prefs', JSON.stringify({
        author: state.author,
        label: state.label,
        ruleSource: state.ruleSource,
        osFamily: state.osFamily,
        pathRoot: state.pathRoot
      }));
    } catch (e) { /* not fatal */ }
  }

  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(storeKey());
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveHistory() {
    var out = {};
    state.programs.forEach(function (p) {
      if (p.versions && p.versions.length) out[p.name] = p.versions;
    });
    try {
      window.localStorage.setItem(storeKey(), JSON.stringify(out));
    } catch (e) {
      /* Usually quota: the versions hold whole program texts. Drop the oldest
         body from every program and try once more before giving up quietly. */
      try {
        Object.keys(out).forEach(function (name) {
          out[name].slice(3).forEach(function (v) { delete v.text; });
        });
        window.localStorage.setItem(storeKey(), JSON.stringify(out));
      } catch (e2) { /* history stays in memory for this session only */ }
    }
  }

  function readLocalRuns() {
    try {
      var raw = window.localStorage.getItem(RUN_HISTORY_KEY);
      if (!raw) return [];
      var book = JSON.parse(raw);
      var runs = Array.isArray(book) ? book
        : (book && Array.isArray(book.runs) ? book.runs : []);
      return runs.map(function (run) {
        return Object.assign({}, run, { local: true });
      });
    } catch (e) { return []; }
  }

  function writeLocalRuns(runs) {
    var book = {
      schema: 'migrate-studio/history',
      version: 1,
      runs: (runs || []).slice(-50).map(function (run) {
        var copy = Object.assign({}, run);
        delete copy.local;
        return copy;
      })
    };
    try {
      window.localStorage.setItem(RUN_HISTORY_KEY, JSON.stringify(book));
    } catch (e) {
      try {
        book.runs.slice(0, -10).forEach(function (run) {
          (run.programs || []).forEach(function (program) {
            delete program.details;
          });
        });
        window.localStorage.setItem(RUN_HISTORY_KEY, JSON.stringify(book));
      } catch (e2) { /* local run history is best-effort */ }
    }
  }

  function appendLocalRun(run) {
    var runs = readLocalRuns().filter(function (item) {
      return item.runId !== run.runId;
    });
    runs.push(run);
    writeLocalRuns(runs);
  }

  function idbAvailable() {
    return typeof window.indexedDB !== 'undefined';
  }

  function idbReq(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function openHandleDb() {
    if (!idbAvailable()) return Promise.reject(new Error('IndexedDB is not available'));
    return new Promise(function (resolve, reject) {
      var request = window.indexedDB.open(HANDLE_DB, 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function withHandleStore(mode, work) {
    return openHandleDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(HANDLE_STORE, mode);
        var store = tx.objectStore(HANDLE_STORE);
        var result;
        tx.oncomplete = function () { db.close(); resolve(result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error); };
        result = work(store);
      });
    });
  }

  function saveDirectoryHandle(handle) {
    return withHandleStore('readwrite', function (store) {
      return idbReq(store.put(handle, DIR_HANDLE_KEY));
    });
  }

  function loadDirectoryHandle(key) {
    return withHandleStore('readonly', function (store) {
      return idbReq(store.get(key || DIR_HANDLE_KEY));
    }).then(function (handle) {
      if (handle || (key && key !== DIR_HANDLE_KEY)) return handle;
      return withHandleStore('readonly', function (store) {
        return idbReq(store.get(legacyDirHandleKey));
      });
    });
  }

  function forgetDirectoryHandle() {
    return withHandleStore('readwrite', function (store) {
      return idbReq(store.delete(DIR_HANDLE_KEY));
    }).catch(function () { /* forgetting is best-effort */ });
  }

  function postJson(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
      cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    });
  }

  function saveCurrentSelection(handle) {
    if (!window.location.protocol.match(/^https?:$/)) return Promise.resolve();
    return postJson('api/current-selection', {
      program_folder: handle.name,
      handle_key: DIR_HANDLE_KEY,
      selected_at: stamp()
    });
  }

  function closeServerSession() {
    if (!window.location.protocol.match(/^https?:$/)) return Promise.resolve();
    return fetch('/api/logout', {
      method: 'POST',
      cache: 'no-store',
      keepalive: true
    });
  }

  function resolveIdentity() {
    if (!window.location.protocol.match(/^https?:$/)) {
      return Promise.resolve(deviceIdentity());
    }
    return fetch('api/whoami', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (who) {
        if (!who || !who.userId) return deviceIdentity();
        return {
          userId: who.userId,
          userKey: who.userKey || String(who.userId).toLowerCase(),
          source: 'os',
          host: who.host || '',
          os: who.os || '',
          sessionId: who.sessionId || '',
          resolvedAt: stamp()
        };
      })
      .catch(function () { return deviceIdentity(); });
  }

  function deviceIdentity() {
    var key = STORE_PREFIX + 'deviceid';
    var id = '';
    try { id = window.localStorage.getItem(key) || ''; } catch (e) { /* private mode */ }
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : String(Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      try { window.localStorage.setItem(key, id); } catch (e) { /* not fatal */ }
    }
    return {
      userId: 'device-' + id,
      userKey: 'device-' + id,
      source: 'device',
      host: '',
      os: '',
      sessionId: id,
      resolvedAt: stamp()
    };
  }

  function readCurrentSelection() {
    if (!hasFsApi || !window.location.protocol.match(/^https?:$/)) {
      return Promise.resolve(null);
    }
    return fetch('current_selections.json?ts=' + Date.now(), {
      cache: 'no-store'
    }).then(function (response) {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    }).catch(function () { return null; });
  }

  /* ---------------------------------------------------------------------
   * Toast and dialogs
   * ------------------------------------------------------------------ */

  var toastTimer = null;

  function toast(message, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    /* The class carries the fade, and it only animates if it lands on a frame
       after the element is no longer [hidden]. */
    window.requestAnimationFrame(function () { el.classList.add('show'); });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.classList.remove('show');
      window.setTimeout(function () { el.hidden = true; }, 220);
    }, 4200);
  }

  function confirmDialog(title, body, okLabel) {
    return new Promise(function (resolve) {
      var dialog = $('confirmDialog');
      $('confirmTitle').textContent = title;
      $('confirmBody').textContent = body;
      $('confirmOk').textContent = okLabel || 'Continue';
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        dialog.removeEventListener('close', onClose);
        resolve(value);
      }
      function onClose() { done(dialog.returnValue === 'ok'); }
      dialog.addEventListener('close', onClose);
      dialog.querySelector('form').onsubmit = function () {
        dialog.returnValue = 'ok';
      };
      dialog.returnValue = '';
      dialog.showModal();
    });
  }

  /* Small Markdown renderer for CHANGELOG.md only: headings, bullet lists,
     paragraphs, fenced code, rules, and inline code / bold / links. Everything
     is escaped first, so the file cannot inject markup. */
  function renderReleaseNotes(markdown) {
    function inline(text) {
      return esc(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }
    var html = [];
    var para = [];
    var list = null;
    var code = null;
    function flush() {
      if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
      if (list) { html.push('<ul>' + list.map(function (item) {
        return '<li>' + inline(item) + '</li>'; }).join('') + '</ul>'); list = null; }
    }
    String(markdown || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
      if (code) {
        if (/^```/.test(line)) { html.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
        else code.push(line);
        return;
      }
      var m;
      if (/^```/.test(line)) { flush(); code = []; }
      else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flush();
        if (m[1].length === 1) return;
        var level = m[1].length + 1;
        html.push('<h' + level + '>' + inline(m[2]) + '</h' + level + '>');
      }
      else if (/^\s*[-*]\s+/.test(line)) {
        if (para.length) flush();
        list = list || [];
        list.push(line.replace(/^\s*[-*]\s+/, ''));
      }
      else if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); html.push('<hr>'); }
      else if (!line.trim()) flush();
      else if (list) list[list.length - 1] += ' ' + line.trim();
      else para.push(line.trim());
    });
    if (code) html.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
    flush();
    return html.join('\n');
  }

  var releaseNotesLoaded = false;

  function showAbout() {
    $('aboutVersion').textContent = APP_VERSION;
    $('aboutBuild').textContent = 'Build ' + APP_BUILD;
    $('aboutDialog').showModal();
  }

  function showReleaseNotes() {
    var body = $('releaseNotesBody');
    $('releaseNotesVersion').textContent = APP_VERSION + ' \u00b7 ' + APP_BUILD;
    $('releaseNotesDialog').showModal();
    body.scrollTop = 0;
    if (releaseNotesLoaded) return;

    if (!window.location.protocol.match(/^https?:$/)) {
      body.innerHTML = '<p class="release-notes-status">Release notes are in ' +
        '<code>' + esc(RELEASE_NOTES_FILE) + '</code> in the Migrate Studio ' +
        'folder. Start the app with <code>python migrate_studio.py</code> to ' +
        'read them here.</p>';
      return;
    }
    fetch(RELEASE_NOTES_FILE + '?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(function (text) {
        body.innerHTML = renderReleaseNotes(text);
        releaseNotesLoaded = true;
      })
      .catch(function (error) {
        body.innerHTML = '<p class="release-notes-status">Could not load ' +
          '<code>' + esc(RELEASE_NOTES_FILE) + '</code> (' +
          esc(error.message) + ').</p>';
      });
  }

  /* Every dialog closes on its Cancel button the same way. */
  document.addEventListener('click', function (event) {
    var close = event.target.closest('[data-close]');
    if (!close) return;
    var dialog = close.closest('dialog');
    if (dialog) { dialog.returnValue = ''; dialog.close(); }
  });

  /* ---------------------------------------------------------------------
   * The folder
   * ------------------------------------------------------------------ */

  var hasFsApi = typeof window.showDirectoryPicker === 'function';

  function pickFolder() {
    if (hasFsApi) return pickFolderModern();
    $('folderInput').click();
    return Promise.resolve();
  }

  function pickFolderModern() {
    return window.showDirectoryPicker({ id: 'migratestudio', mode: 'readwrite' })
      .then(function (handle) {
        state.dirHandle = handle;
        state.folderName = handle.name;
        state.folderPath = (handle && handle._path) || '';
        pendingReconnect = null;
        return saveDirectoryHandle(handle)
          .then(function () { return saveCurrentSelection(handle); })
          .catch(function () {
            toast('Migrate Studio opened the folder, but could not remember it for next time.',
                  'warn');
          })
          .then(function () { return handle; });
      })
      .then(function (handle) {
        return ensureWritable(handle);
      })
      .then(function (granted) {
        state.writable = granted;
        showFsBanner(!granted);
        return readFolder();
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return;
        toast('Could not open that folder: ' + error.message, 'err');
      });
  }

  function restoreLastFolder() {
    return readCurrentSelection().then(function (selection) {
      var handleKey = selection && selection.handle_key;
      return loadDirectoryHandle(handleKey || DIR_HANDLE_KEY).then(function (handle) {
        if (!handle) return false;
        var folderName = (selection && selection.program_folder) || handle.name;
        if (!handle.queryPermission) return false;
        return handle.queryPermission({ mode: 'readwrite' })
          .then(function (status) {
            if (status === 'granted') {
              state.dirHandle = handle;
              state.folderName = folderName;
              state.folderPath = (handle && handle._path) || '';
              state.writable = true;
              pendingReconnect = null;
              showFsBanner(false);
              return readFolder().then(function () { return true; });
            }
            pendingReconnect = { handle: handle, folderName: folderName };
            showReconnect(folderName);
            return true;
          });
      }).catch(function () { return false; });
    });
  }

  function showReconnect(folderName) {
    $('modeBanner').hidden = false;
    $('modeBannerText').textContent =
      'Migrate Studio remembers ' + folderName + '. Reconnect it to continue.';
    $('btnReconnectFolder').hidden = false;
    $('btnReconnectFolder').textContent = 'Reconnect ' + folderName;
    $('btnDismissBanner').hidden = false;
  }

  function reconnectLastFolder() {
    if (!pendingReconnect || !pendingReconnect.handle) return;
    var handle = pendingReconnect.handle;
    var folderName = pendingReconnect.folderName || handle.name;
    handle.requestPermission({ mode: 'readwrite' })
      .then(function (status) {
        if (status !== 'granted') {
          toast('Migrate Studio still needs permission to reconnect ' + folderName + '.',
                'warn');
          return;
        }
        state.dirHandle = handle;
        state.folderName = folderName;
        state.folderPath = (handle && handle._path) || '';
        state.writable = true;
        pendingReconnect = null;
        $('btnReconnectFolder').hidden = true;
        showFsBanner(false);
        return readFolder();
      })
      .catch(function (error) {
        toast('Could not reconnect the folder: ' + error.message, 'err');
      });
  }

  function showOpeningState() {
    pendingReconnect = null;
    $('btnReconnectFolder').hidden = true;
    $('btnDismissBanner').hidden = false;
    $('modeBanner').hidden = false;
    $('modeBannerText').textContent = hasFsApi
      ? 'Press Folder to choose a folder of SAS programs. A Migrate_Studio_Rules.xlsx ' +
        'in that folder loads with it. Apply Fix updates the checked programs in place, ' +
        'after copying each one to a _migrate_original folder beside it.'
      : 'This browser can read a folder but not write back to it. Press Folder ' +
        'to choose one in Chrome or Edge so Apply Fix can update programs in place.';
  }

  /* Chromium can hand back a directory handle whose write permission still
     needs a prompt, and it can revoke it later. Ask, do not assume. */
  function ensureWritable(handle) {
    if (!handle || !handle.queryPermission) return Promise.resolve(false);
    return handle.queryPermission({ mode: 'readwrite' })
      .then(function (status) {
        if (status === 'granted') return true;
        return handle.requestPermission({ mode: 'readwrite' })
          .then(function (next) { return next === 'granted'; });
      })
      .catch(function () { return false; });
  }

  function decodeProgramFile(file) {
    return file.arrayBuffer().then(function (buffer) {
      return new TextDecoder('windows-1252').decode(buffer);
    });
  }

  function detectEol(text) {
    var crlf = (String(text || '').match(/\r\n/g) || []).length;
    var lf = (String(text || '').match(/\n/g) || []).length;
    return crlf && crlf >= (lf - crlf) ? '\r\n' : '\n';
  }

  function outputProgramText(program) {
    var text = String(program && program.fixed != null ? program.fixed : '');
    return program && program.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  }

  window.MigrateStudioIO = {
    detectEol: detectEol,
    outputProgramText: outputProgramText
  };

  function detailStats(hits) {
    var stat = { changed: 0, added: 0, removed: 0, total: 0 };
    (hits || []).forEach(function (hit) {
      var details = hit && hit.details;
      if (details && details.length) {
        details.forEach(function (detail) {
          var type = String(detail && detail.type || '').toLowerCase();
          if (type === 'add' || type === 'added') stat.added++;
          else if (type === 'delete' || type === 'deleted' ||
                   type === 'del' || type === 'removed') stat.removed++;
          else stat.changed++;
        });
      } else if (hit && hit.count > 0) {
        stat.changed += hit.count;
      }
    });
    stat.total += stat.changed + stat.added + stat.removed;
    return stat;
  }

  function detailTotal(hits) {
    return detailStats(hits).total;
  }

  window.MigrateStudioChangeLedger = {
    detailStats: detailStats,
    detailTotal: detailTotal
  };

  var CP1252_HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  function encodeProgramText(text) {
    if (window.MigMcRules && window.MigMcRules.helpers &&
        window.MigMcRules.helpers.encodeProgramText) {
      return window.MigMcRules.helpers.encodeProgramText(text);
    }
    var src = String(text == null ? '' : text);
    var out = new Uint8Array(src.length);
    for (var i = 0; i < src.length; i++) {
      var code = src.charCodeAt(i);
      out[i] = code < 0x100 ? code
        : (CP1252_HIGH[code] != null ? CP1252_HIGH[code] : 0x3F);
    }
    return out;
  }

  function cleanRelPath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  function isOutputFolderName(name) {
    var clean = cleanRelPath(name).toLowerCase();
    return clean === 'migrate_output' ||
      clean === 'migrate_studio' ||
      clean === ORIGINAL_BACKUP_FOLDER ||
      clean === legacyBrand.toLowerCase();
  }

  function isInsideOutputFolder(path) {
    return cleanRelPath(path).split('/').some(isOutputFolderName);
  }

  function relDir(path) {
    var clean = cleanRelPath(path);
    var at = clean.lastIndexOf('/');
    return at < 0 ? '' : clean.slice(0, at);
  }

  function addDirIndex(path, names) {
    state.dirIndex[cleanRelPath(path).toLowerCase()] = names.slice().sort(function (a, b) {
      return a.localeCompare(b);
    });
  }

  function indexedListDir(path) {
    var key = cleanRelPath(path).toLowerCase();
    var direct = state.dirIndex[key];
    if (direct) return direct;
    var root = cleanRelPath(state.pathRoot || '').toLowerCase();
    if (root && key.indexOf(root + '/') === 0) {
      return state.dirIndex[key.slice(root.length + 1)] || null;
    }
    return null;
  }

  function configuredTocLookup() {
    var names = state.mcRules && state.mcRules.parameters && state.mcRules.parameters.TOC_FILENAMES;
    if (typeof names === 'string') names = names.trim().split(/\s+/);
    if (!Array.isArray(names)) names = ['study_toc.xlsx', 'toc.xlsx'];
    var lookup = {};
    names.forEach(function (name) {
      var lower = String(name || '').trim().toLowerCase();
      if (lower) lookup[lower] = true;
    });
    return lookup;
  }

  function recordTocCase(name) {
    var lower = String(name || '').toLowerCase();
    if (!lower) return;
    var configured = configuredTocLookup();
    if (configured[lower] && !state.tocCaseMap[lower]) {
      state.tocCaseMap[lower] = name;
    }
  }

  function rebuildFolderFacts(entries) {
    state.tocCaseMap = {};
    state.dirIndex = {};
    entries.dirs.forEach(function (dir) { addDirIndex(dir.path, dir.names); });
    entries.files.slice().sort(function (a, b) {
      return a.relPath.localeCompare(b.relPath);
    }).forEach(function (entry) {
      recordTocCase(entry.handle.name);
    });
  }

  function shouldSkipDiscoveredPath(path) {
    return isInsideOutputFolder(path);
  }

  function readFolder() {
    setLoading('Reading ' + state.folderName + '…');
    state.backupIndex = null;
    var entries = { files: [], dirs: [], rulesEntry: null };

    function walk(handle, relPath) {
      var dir = { path: relPath, names: [] };
      entries.dirs.push(dir);
      var iterator = handle.values();

      function step() {
        return iterator.next().then(function (result) {
          if (result.done) return;
          var entry = result.value;
          var childPath = cleanRelPath([relPath, entry.name].filter(Boolean).join('/'));
          if (shouldSkipDiscoveredPath(childPath)) return step();
          dir.names.push(entry.name);
          if (entry.kind === 'directory') {
            return walk(entry, childPath).then(step);
          }
          if (entry.kind === 'file') {
            entries.files.push({
              handle: entry,
              parentHandle: handle,
              relPath: childPath,
              dirRelPath: relPath
            });
            if (!entries.rulesEntry && rulesNameRe.test(entry.name) && !relPath) {
              entries.rulesEntry = entry;
            }
          }
          return step();
        });
      }
      return step();
    }

    return walk(state.dirHandle, '').then(function () {
      rebuildFolderFacts(entries);
      var sasFiles = entries.files.filter(function (entry) {
        return /\.sas$/i.test(entry.handle.name);
      });
      sasFiles.sort(function (a, b) { return a.relPath.localeCompare(b.relPath); });
      return Promise.all(sasFiles.map(function (entry) {
        return entry.handle.getFile().then(function (file) {
          return decodeProgramFile(file).then(function (text) {
            return {
              name: entry.relPath,
              relPath: entry.relPath,
              dirRelPath: entry.dirRelPath,
              handle: entry.handle,
              parentHandle: entry.parentHandle,
              size: file.size,
              modified: file.lastModified,
              eol: detectEol(text),
              original: text,
              fixed: null,
              hits: [],
              fixCount: 0,
              versions: []
            };
          });
        });
      })).then(function (programs) {
        return readBackupIndex(programs).then(function (index) {
          if (!index.size) return 0;
          return loadRunHistory().then(function (history) {
            state.runHistory = history.runs;
            return restorePriorRun(programs, index, history.runs);
          });
        }).catch(function () { return 0; })
          .then(function (restored) {
            adoptPrograms(programs, restored);
            return restored;
          });
      }).then(function () {
        /* A rule book sitting beside the programs is the common case, so load
           it without making anybody go through the menu for it. */
        if (entries.rulesEntry) {
          return entries.rulesEntry.getFile()
            .then(function (file) { return readRulesFile(file); })
            .catch(function () { /* an unreadable rule book is not fatal */ });
        }
      });
    }).catch(function (error) {
      setLoading(null);
      toast('Could not read that folder: ' + error.message, 'err');
    });
  }

  /* Fallback for browsers without the File System Access API — Firefox and
     Safari today. <input webkitdirectory> gives file contents but no way to
     write back, so the app runs read-only and Save becomes a download. */
  function readFolderFallback(fileList) {
    var allFiles = Array.prototype.slice.call(fileList);
    state.backupIndex = null;
    state.tocCaseMap = {};
    state.dirIndex = {};

    allFiles.forEach(function (file) {
      var rel = cleanRelPath(file.webkitRelativePath || file.name);
      var parts = rel.split('/');
      if (parts.length > 1) parts.shift();
      var projectRel = parts.join('/') || file.name;
      var pathParts = projectRel.split('/').filter(Boolean);
      for (var i = 0; i < pathParts.length; i++) {
        var parent = pathParts.slice(0, i).join('/');
        var child = pathParts[i];
        var key = parent.toLowerCase();
        if (!state.dirIndex[key]) state.dirIndex[key] = [];
        if (state.dirIndex[key].indexOf(child) === -1) {
          state.dirIndex[key].push(child);
        }
      }
      recordTocCase(file.name);
    });

    var files = allFiles.filter(function (f) {
      var rel = cleanRelPath(f.webkitRelativePath || f.name);
      return /\.sas$/i.test(f.name) && !shouldSkipDiscoveredPath(rel);
    });
    var rulesFile = allFiles.filter(function (f) {
      var rel = cleanRelPath(f.webkitRelativePath || f.name);
      return rulesNameRe.test(f.name) && !shouldSkipDiscoveredPath(rel);
    })[0];

    if (!files.length && !rulesFile) {
      toast('No .sas programs in that folder.', 'warn');
      return;
    }

    var root = (files[0] || rulesFile).webkitRelativePath || '';
    state.dirHandle = null;
    state.folderName = root.split('/')[0] || 'folder';
    state.folderPath = '';
    state.writable = false;
    showFsBanner(true);

    setLoading('Reading ' + state.folderName + '…');
    files.sort(function (a, b) {
      return cleanRelPath(a.webkitRelativePath || a.name)
        .localeCompare(cleanRelPath(b.webkitRelativePath || b.name));
    });

    Promise.all(files.map(function (file) {
      return decodeProgramFile(file).then(function (text) {
        var rel = cleanRelPath(file.webkitRelativePath || file.name);
        var parts = rel.split('/');
        if (parts.length > 1) parts.shift();
        var projectRel = parts.join('/') || file.name;
        return {
          name: projectRel,
          relPath: projectRel,
          dirRelPath: relDir(projectRel),
          handle: null,
          size: file.size,
          modified: file.lastModified,
          eol: detectEol(text),
          original: text,
          fixed: null,
          hits: [],
          fixCount: 0,
          versions: []
        };
      });
    })).then(function (programs) {
      adoptPrograms(programs);
      if (rulesFile) return readRulesFile(rulesFile);
    });
  }

  /** Install a freshly-read set of programs and re-attach their saved history. */
  function adoptPrograms(programs, restored) {
    var saved = loadHistory();
    programs.forEach(function (p) {
      var versions = saved[p.name];
      if (versions && versions.length) {
        p.versions = versions;
        /* The newest version is the state the program was left in, so restore
           it rather than showing an unfixed program with a history behind it. */
        var latest = versions[0];
        if (latest && typeof latest.text === 'string') {
          p.fixed = latest.text;
          p.hits = latest.hits || [];
          p.fixCount = detailTotal(p.hits) || latest.total || 0;
        }
      }
    });

    state.programs = programs;
    state.checked = {};
    state.selected = programs.length ? 0 : -1;
    state.dirty = false;
    refreshFindings();

    setLoading(null);
    $('appFrame').hidden = false;
    $('folderPath').hidden = false;
    $('folderPath').textContent = state.folderName +
      (state.writable ? '' : '  (read-only)');
    $('modeBanner').hidden = true;

    var selected = current();
    var ready = selected && selected.original == null
      ? ensureRestoredOriginal(selected) : Promise.resolve();
    ready.then(function () {
      setLoading(null);
      renderAll();
      toast(plural(programs.length, 'program') + ' loaded from ' +
            state.folderName +
            (restored ? ' · ' + plural(restored, 'program') +
              ' restored from history' : '') + '.');
    });
  }

  function showFsBanner(show) {
    var banner = $('fsBanner');
    if (!show) { banner.hidden = true; return; }
    $('fsBannerText').textContent = hasFsApi
      ? 'Migrate Studio could not get write access to that folder. Apply Fix needs write access to update programs in place.'
      : 'This browser cannot write back to a folder. Apply Fix needs Chrome or Edge write access to update programs in place.';
    var steps = $('fsBannerSteps');
    if (!hasFsApi) {
      steps.hidden = false;
      steps.innerHTML =
        '<li>Open Migrate Studio in Chrome or Edge to write fixed programs in place</li>';
    } else {
      steps.hidden = true;
    }
    banner.hidden = false;
  }

  function showJmBanner() {
    var banner = $('mcBanner');
    if (!banner) return;
    var show = state.ruleSource === 'mc' && !!state.mcUnavailable && !state.mcRules;
    banner.hidden = !show;
    if (!show) return;
    $('mcBannerText').textContent = 'MC pack unavailable: ' + state.mcUnavailable;
  }

  function renderApplyState() {
    var ready = !!activeBook() && !state.mcLoading;
    ['btnApplyFix', 'btnApplyFixTab'].forEach(function (id) {
      if ($(id)) $(id).disabled = !ready;
    });
    if ($('btnApplyFixThis')) $('btnApplyFixThis').disabled = !ready || !current();
  }

  function setLoading(message) {
    var el = $('loadState');
    if (!message) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<span class="status-spinner" aria-hidden="true"></span> ' +
                   esc(message);
  }

  /* ---------------------------------------------------------------------
   * The rule book
   * ------------------------------------------------------------------ */

  function readRulesFile(file) {
    return file.arrayBuffer().then(function (buffer) {
      var bytes8 = new Uint8Array(buffer);
      var workbook = window.MigExcel.read(bytes8);
      state.rulesBytes = bytes8;
      state.rules = window.MigRules.parse(workbook, file.name);
      /* A rule book arriving changes more than the Rules tab: Apply Fix stops
         being disabled, the rail footer counts rules, and the right rail knows
         how many are ready to run. */
      renderAll();
      var rows = state.rules.rules.reduce(function (seen, rule) {
        seen[rule.row] = seen[rule.row] || { executable: false, selected: false };
        seen[rule.row].executable = seen[rule.row].executable || (rule.executable && rule.enabled);
        seen[rule.row].selected = seen[rule.row].selected || !!rule.selected;
        return seen;
      }, {});
      var rowList = Object.keys(rows).map(function (key) { return rows[key]; });
      toast(plural(rowList.length, 'rule') + ' loaded from ' + file.name +
            ' · ' + rowList.filter(function (r) { return r.selected; }).length +
            ' selected to apply.');
    }).catch(function (error) {
      toast('Could not read that rule book: ' + error.message, 'err');
    });
  }

  function readJmPackFile(file) {
    return file.text().then(function (text) {
      var spec = JSON.parse(text);
      return fetchHousePack().then(function (housePack) {
        state.mcRules = window.MigMcRules.parse(spec, file.name || 'migration_rules.json', housePack);
        state.mcUnavailable = '';
        state.mcLoading = false;
        state.ruleSource = 'mc';
        savePrefs();
        refreshFindings();
        renderAll();
        var counts = ruleCounts();
        toast(plural(counts.total, 'MC rule') + ' loaded from ' +
              (file.name || 'migration_rules.json') + ' · ' +
              counts.selected + ' selected to apply.');
      });
    }).catch(function (error) {
      state.mcUnavailable = error.message;
      state.mcLoading = false;
      renderAll();
      toast('Could not read that MC pack: ' + error.message, 'err');
    });
  }

  function fetchHousePack() {
    if (!window.location.protocol.match(/^https?:$/)) return Promise.resolve(null);
    return fetch('rules/migrate_studio_rules.json', { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return null; });
  }

  function loadJmPack() {
    if (state.mcRules) return Promise.resolve();
    if (!window.location.protocol.match(/^https?:$/)) {
      state.mcUnavailable = 'Open over http://localhost or use Import Pack.';
      state.mcLoading = false;
      return Promise.resolve();
    }
    state.mcLoading = true;
    renderApplyState();
    return Promise.all([
      fetch('rules/migration_rules.json', { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('rules/migration_rules.json -> ' + response.status);
          return response.json();
        }),
      fetchHousePack()
    ])
      .then(function (packs) {
        state.mcRules = window.MigMcRules.parse(packs[0], 'migration_rules.json', packs[1]);
        if (!packs[1]) {
          state.mcRules.warnings.push('rules/migrate_studio_rules.json was not loaded; house rules are unavailable.');
        }
        state.mcUnavailable = '';
        state.mcLoading = false;
        refreshFindings();
        renderAll();
      })
      .catch(function (error) {
        state.mcUnavailable = error.message;
        state.mcLoading = false;
        renderAll();
      });
  }

  /**
   * Load the rule book that sits beside index.html.
   *
   * When Migrate Studio is served by migrate_studio.py, Migrate_Studio_Rules.xlsx in the tool's own
   * folder is the house rule book and should be there before anybody picks a
   * folder — choosing which fixes to run is the first thing you do, and it
   * should not be gated on choosing programs first.
   *
   * Off a file:// page fetch is blocked, and there is nothing to report: the
   * Rules tab already says how to load one by hand. So this fails silently by
   * design, which is why it does not go through the error path.
   */
  function loadRulesBeside() {
    if (state.rules) return Promise.resolve();
    if (!window.location.protocol.match(/^https?:$/)) return Promise.resolve();

    function fetchRules(name) {
      return fetch(name, { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error(String(response.status));
          return response.blob();
        })
        .then(function (blob) {
          var file = new File([blob], name);
          return readRulesFile(file);
        });
    }

    return fetchRules('rules/Migrate_Studio_Rules.xlsx')
      .catch(function () { return fetchRules(legacyRulesName); })
      .catch(function () { /* no rule book beside the page; that is fine */ });
  }

  function activeBook() {
    if (state.ruleSource === 'mc') {
      return state.mcRules;
    }
    return state.rules;
  }

  function activeBookName(book) {
    if (!book) return 'no rule book';
    if (book.kind === 'mc') {
      return (book.source || 'migration_rules.json') +
        (book.macroVersion ? ' v' + book.macroVersion : '');
    }
    return book.source || 'rules/Migrate_Studio_Rules.xlsx';
  }

  function mcContextFor(program) {
    function date9(date) {
      var months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      return String(date.getDate()).padStart(2, '0') +
        months[date.getMonth()] + date.getFullYear();
    }
    return {
      osFamily: state.osFamily,
      programPath: program.relPath || program.name,
      programDir: program.dirRelPath != null ? program.dirRelPath : relDir(program.name),
      sep: '/',
      tocCaseMap: state.tocCaseMap,
      listDir: indexedListDir,
      pathRoot: state.pathRoot,
      folderName: state.folderName,
      operator: state.author.name || state.identity.userId || '',
      runDate: date9(new Date())
    };
  }

  function exportRules() {
    if (!state.rules) {
      toast('No rule book loaded yet — use Import Rules first.', 'warn');
      return;
    }
    /* Round-trip the workbook as read when we still have the bytes, so a rule
       book with formatting or extra sheets comes back out intact. Otherwise
       rebuild it from what was parsed. */
    var blob;
    if (state.rulesBytes) {
      blob = new Blob([state.rulesBytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
    } else {
      /* MigExcel takes the header row as a column list, not as the first data
         row — that is what carries the width and the frozen header. */
      var sheets = state.rules.sheetNames.map(function (name) {
        var sheet = state.rules.sheets[name];
        return {
          name: name,
          columns: sheet.headers.map(function (header, i) {
            var widest = sheet.rows.reduce(function (max, row) {
              return Math.max(max, String(row[i] == null ? '' : row[i]).length);
            }, String(header).length);
            return { header: header, width: widest + 2 };
          }),
          rows: sheet.rows
        };
      });
      blob = new Blob([window.MigExcel.write(sheets)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
    }
    download(blob, 'Migrate_Studio_Rules_' + timestampYYYYMMDDHHMM() + '.xlsx');
  }

  /* ---------------------------------------------------------------------
   * Applying fixes
   * ------------------------------------------------------------------ */

  function applyFixTo(program) {
    var book = activeBook();
    if (!book) {
      toast('Load the MC pack or Migrate_Studio_Rules.xlsx first.', 'warn');
      return null;
    }
    if (!selectedRuleCount()) {
      toast('No rules are selected. Tick the ones to apply on the Rules tab.',
            'warn');
      return null;
    }

    /* Fixes stack: a second run works from the already-fixed text, which is
       what "apply another rule book" means. The original is never touched. */
    var base = program.fixed != null ? program.fixed : program.original;
    var result = book.kind === 'mc'
      ? window.MigMcRules.apply(book, base, program.name, mcContextFor(program))
      : window.MigRules.apply(book, base, program.name);

    if (!result.total) {
      /* Zero matches can mean either "these rules never applied" or "these
         rules already rewrote the current fixed copy." Probe the original so a
         different rule book that truly misses still gets the old message. */
      toast(alreadyApplied(book, program)
              ? 'Apply Fix already applied.'
              : 'No rule matched ' + program.name + '.',
            'warn');
      return null;
    }

    program.fixed = result.text;
    if (result.rename) {
      program.pendingRename = Object.assign({}, result.rename, {
        fromRelPath: program.relPath || program.name
      });
    }
    /* result.hits may include linked logic findings (for example L-032) in
       addition to selectable rule IDs; preserve each hit under its own ID. */
    program.hits = mergeHits(program.hits, result.hits);
    program.fixCount = detailTotal(program.hits);

    var version = {
      id: 'v' + (program.versions.length + 1),
      at: stamp(),
      author: state.author.name || '',
      rules: activeBookName(book),
      total: program.fixCount,
      applied: result.total,
      hits: program.hits.slice(),
      text: result.text
    };
    if (result.rename) {
      version.renamedFrom = result.rename.from || fileNameOf(program);
      version.renamedTo = result.rename.to || '';
    }
    program.versions.unshift(version);

    state.dirty = true;
    return {
      versionId: version.id,
      applied: result.total,
      hits: result.hits,
      rename: result.rename || null
    };
  }

  function alreadyApplied(book, program) {
    if (program.fixed == null) return false;
    var probe = book.kind === 'mc'
      ? window.MigMcRules.apply(book, program.original, program.name,
                                mcContextFor(program))
      : window.MigRules.apply(book, program.original, program.name);
    return probe.total > 0;
  }

  function programRelPath(program) {
    return cleanRelPath(program && (program.relPath || program.name));
  }

  function programDirRelPath(program) {
    return cleanRelPath(program && program.dirRelPath != null
      ? program.dirRelPath : relDir(programRelPath(program)));
  }

  function groupProgramsByDirectory(programs) {
    var byDir = {};
    (programs || []).forEach(function (program) {
      var name = fileNameOf(program);
      if (!/\.sas$/i.test(name || '')) return;
      var dir = programDirRelPath(program);
      if (!byDir[dir]) byDir[dir] = [];
      byDir[dir].push(program);
    });
    return Object.keys(byDir).sort().map(function (dir) {
      byDir[dir].sort(function (a, b) {
        return fileNameOf(a).localeCompare(fileNameOf(b));
      });
      return { dirRelPath: dir, programs: byDir[dir] };
    });
  }

  function backupRelPathFor(program) {
    var dir = programDirRelPath(program);
    return cleanRelPath([dir, ORIGINAL_BACKUP_FOLDER, fileNameOf(program)]
      .filter(Boolean).join('/'));
  }

  function backupFilesFor(index, dir) {
    if (!index) return null;
    if (typeof index.get === 'function') return index.get(dir) || null;
    var files = index[dir];
    if (!files && dir === '') files = index[''];
    return files && typeof files.has === 'function' ? files :
      new Set(files || []);
  }

  function backupFolderLabels(programs) {
    return groupProgramsByDirectory(programs || []).map(function (group) {
      return group.dirRelPath || '(root)';
    });
  }

  function backupToastText(backup) {
    if (backup && backup.datesPreserved) {
      return 'Originals copied to ' + ORIGINAL_BACKUP_FOLDER +
        ' with their original modified dates.';
    }
    if (backup && backup.dateFailed && backup.dateFailed.length) {
      return 'Originals copied to ' + ORIGINAL_BACKUP_FOLDER + '; ' +
        backup.dateFailed.length + ' file(s) could not keep their original modified date.';
    }
    return 'Originals copied to ' + ORIGINAL_BACKUP_FOLDER +
      '; original modified dates could not be kept because the folder was copied in browser mode.';
  }

  function backupRequestDirectories(programs) {
    return groupProgramsByDirectory(programs || []).map(function (group) {
      return {
        folder: group.dirRelPath,
        files: group.programs.map(fileNameOf)
      };
    });
  }

  function backupFingerprint(programs) {
    var out = {};
    groupProgramsByDirectory(programs || []).forEach(function (group) {
      out[group.dirRelPath] = group.programs.map(function (program) {
        return {
          name: fileNameOf(program),
          size: program.size || 0,
          lastModified: program.modified || 0
        };
      });
    });
    return out;
  }

  function resolveBackupRootToken() {
    if (!window.location.protocol.match(/^https?:$/)) {
      return Promise.resolve({ resolved: false, reason: 'unresolved' });
    }
    return postJson('api/backup/resolve', {
      folderName: state.folderName || '',
      fingerprint: backupFingerprint(state.programs)
    }).then(function (result) {
      if (result && result.resolved && result.rootToken) return result;
      return {
        resolved: false,
        reason: (result && result.reason) || 'unresolved'
      };
    }).catch(function (error) {
      return {
        resolved: false,
        reason: (error && error.message) || 'resolve-error'
      };
    });
  }

  function backupInfo(mode, preserved, resolution, extra) {
    extra = extra || {};
    return {
      mode: mode,
      datesPreserved: !!preserved,
      resolution: resolution || (preserved ? 'search' : 'unresolved'),
      dateFailed: extra.dateFailed || [],
      stamped: !!extra.stamped,
      stampMode: extra.stampMode || ''
    };
  }

  function ensureBackupIndexMap() {
    if (state.backupIndex && typeof state.backupIndex.get === 'function') {
      return state.backupIndex;
    }
    var map = new Map();
    var index = state.backupIndex || {};
    Object.keys(index).forEach(function (dir) {
      map.set(dir, new Set(index[dir] || []));
    });
    state.backupIndex = map;
    return map;
  }

  function historyRunTouchesProgram(run, program) {
    var want = programRelPath(program);
    if (!want) return false;
    return ((run && run.programs) || []).concat((run && run.targetedPrograms) || [])
      .some(function (item) {
        return cleanRelPath(item && (item.relPath || item.name)) === want;
      });
  }

  function historyInPlaceApplied(program, runs) {
    var root = String(state.folderName || '');
    var applied = false;
    (runs || []).slice().sort(function (a, b) {
      return String(a.appliedAt || '').localeCompare(String(b.appliedAt || '')) ||
        String(a.runId || '').localeCompare(String(b.runId || ''));
    }).forEach(function (run) {
      if (String(run.rootFolder || '') !== root) return;
      if (!historyRunTouchesProgram(run, program)) return;
      if (run.action === 'apply-fix-in-place') applied = true;
      else if (run.action === 'revert-in-place') applied = false;
    });
    return applied;
  }

  var HISTORY_TYPE = { Added: 'add', Deleted: 'delete', Modified: 'change' };

  function liveRunRowsFor(program, runs) {
    var want = programRelPath(program);
    var rows = [];
    var matching = (runs || []).slice().sort(function (a, b) {
      return String(a.appliedAt || '').localeCompare(String(b.appliedAt || '')) ||
        String(a.runId || '').localeCompare(String(b.runId || ''));
    }).filter(function (run) {
      return String(run.rootFolder || '') === String(state.folderName || '');
    });
    if (!state.folderPath) {
      matching.forEach(function (run) {
        if (run.rootPath) state.folderPath = run.rootPath;
      });
    }
    matching.forEach(function (run) {
      if (String(run.rootFolder || '') !== String(state.folderName || '')) return;
      if (!historyRunTouchesProgram(run, program)) return;
      if (run.action === 'revert-in-place') {
        rows = [];
        return;
      }
      if (run.action !== 'apply-fix-in-place') return;
      (run.programs || []).forEach(function (row) {
        if (cleanRelPath(row.relPath || row.name) === want) {
          rows.push({ run: run, row: row });
        }
      });
    });
    return rows;
  }

  function hitsFromHistoryRows(rows) {
    var byId = {};
    (rows || []).forEach(function (item) {
      var row = item.row || {};
      (row.rules || []).forEach(function (id) {
        var meta = (row.ruleMeta && row.ruleMeta[id]) || {};
        var hit = byId[id] || (byId[id] = {
          key: id,
          id: id,
          name: meta.name || '',
          category: meta.category || '',
          severity: meta.severity || '',
          count: 0,
          details: []
        });
        hit.count += (row.ruleCounts && row.ruleCounts[id]) || 0;
      });
      (row.details || []).forEach(function (detail) {
        var hit = byId[detail.ruleId];
        if (!hit) return;
        hit.details.push({
          type: HISTORY_TYPE[detail.type] || 'change',
          originalLine: detail.originalLine,
          fixedLine: detail.fixedLine,
          before: detail.before,
          after: detail.after
        });
      });
    });
    return Object.keys(byId).sort().map(function (id) { return byId[id]; });
  }

  function restorePriorRun(programs, backupIndex, runs) {
    var restored = 0;
    (programs || []).forEach(function (program) {
      if (program.versions && program.versions.length) return;
      var rows = liveRunRowsFor(program, runs);
      if (!rows.length) return;
      var set = backupFilesFor(backupIndex, programDirRelPath(program));
      var backupName = fileNameOf(program);
      if ((!set || !set.has(backupName)) && rows.length) {
        var renamed = rows.map(function (item) {
          return item.row.renamed_from || item.row.renamedFrom || '';
        }).filter(Boolean).pop();
        if (renamed && set && set.has(renamed)) backupName = renamed;
      }
      if (!set || !set.has(backupName)) return;
      program.hits = hitsFromHistoryRows(rows);
      program.fixCount = detailTotal(program.hits);
      program.fixed = program.original;
      program.original = null;
      program.originalBackupName = backupName;
      program.fromHistory = {
        runs: rows.map(function (item) { return item.run.runId; }),
        applications: rows.reduce(function (sum, item) {
          return sum + (item.row.applications || 0);
        }, 0),
        lines: rows.reduce(function (sum, item) {
          return sum + (item.row.lines || 0);
        }, 0),
        stats: detailStats(program.hits)
      };
      restored++;
    });
    return restored;
  }

  function ensureRestoredOriginal(program) {
    if (!program || program.original != null) return Promise.resolve();
    return originalBackupFile(program)
      .then(decodeProgramFile)
      .then(function (text) { program.original = text; })
      .catch(function (error) {
        program.original = program.fixed;
        toast('Original backup unreadable for ' + program.name + ': ' +
              error.message, 'warn');
      });
  }

  function inPlaceApplied(program, backupIndex, runs) {
    var index = backupIndex || state.backupIndex;
    var dir = programDirRelPath(program);
    var name = fileNameOf(program);
    var set = backupFilesFor(index, dir);
    if (set && typeof set.has === 'function' && set.has(name)) return true;
    if (historyInPlaceApplied(program, runs || state.runHistory || [])) return true;
    return program && program.fixed != null &&
      (program.versions || []).some(function (version) {
        return version && !version.reverted;
      });
  }

  function partitionTargets(targets, backupIndex, runs) {
    var out = { applied: [], pending: [] };
    (targets || []).forEach(function (program) {
      out[inPlaceApplied(program, backupIndex, runs) ? 'applied' : 'pending'].push(program);
    });
    return out;
  }

  function notFound(error) {
    return error && (error.name === 'NotFoundError' || error.code === 8);
  }

  function readBackupIndex(programs) {
    if (state.backupIndex) return Promise.resolve(state.backupIndex);
    if (!state.dirHandle) {
      state.backupIndex = new Map();
      return Promise.resolve(state.backupIndex);
    }
    var found = new Map();
    var cache = new Map();
    return groupProgramsByDirectory(programs || state.programs).reduce(function (chain, group) {
      return chain.then(function () {
        return backupHandleFor(group.dirRelPath, false, cache).then(function (backupDir) {
          if (!backupDir) return;
          var names = new Set();
          var iterator = backupDir.values();
          function step() {
            return iterator.next().then(function (result) {
              if (result.done) return;
              var entry = result.value;
              if (entry.kind === 'file' && /\.sas$/i.test(entry.name)) {
                names.add(entry.name);
              }
              return step();
            });
          }
          return step().then(function () {
            found.set(group.dirRelPath, names);
          });
        });
      });
    }, Promise.resolve()).then(function () {
      state.backupIndex = found;
      return found;
    });
  }

  function requireWritableFolder() {
    if (!state.dirHandle) {
      toast('This browser can read the folder but not write to it. Apply Fix needs write access to update the programs in place.', 'warn');
      showFsBanner(true);
      return Promise.resolve(false);
    }
    return ensureWritable(state.dirHandle).then(function (granted) {
      state.writable = granted;
      showFsBanner(!granted);
      if (!granted) {
        toast('This browser can read the folder but not write to it. Apply Fix needs write access to update the programs in place.', 'warn');
      }
      return granted;
    });
  }

  function directoryHandleFor(dirRelPath, opts) {
    var clean = cleanRelPath(dirRelPath);
    var cache = opts && opts.cache;
    if (!clean) return Promise.resolve(state.dirHandle);
    if (cache && cache.has(clean)) return Promise.resolve(cache.get(clean));
    return clean.split('/').filter(Boolean).reduce(function (chain, part) {
      return chain.then(function (dir) {
        return dir.getDirectoryHandle(part, { create: false });
      });
    }, Promise.resolve(state.dirHandle)).then(function (dir) {
      if (cache) cache.set(clean, dir);
      return dir;
    });
  }

  function backupHandleFor(dirRelPath, create, cache) {
    return directoryHandleFor(dirRelPath, { cache: cache })
      .then(function (dir) {
        return dir.getDirectoryHandle(ORIGINAL_BACKUP_FOLDER, { create: !!create });
      })
      .catch(function (error) {
        if (!create && notFound(error)) return null;
        throw error;
      });
  }

  function fileHandleAt(root, relPath, create) {
    var parts = cleanRelPath(relPath).split('/').filter(Boolean);
    var name = parts.pop() || relPath;
    return parts.reduce(function (chain, part) {
      return chain.then(function (dir) {
        return dir.getDirectoryHandle(part, { create: !!create });
      });
    }, Promise.resolve(root)).then(function (dir) {
      return dir.getFileHandle(name, { create: !!create });
    });
  }

  function parentDirectoryAt(root, relPath) {
    var parts = cleanRelPath(relPath).split('/').filter(Boolean);
    parts.pop();
    return parts.reduce(function (chain, part) {
      return chain.then(function (dir) {
        return dir.getDirectoryHandle(part, { create: false });
      });
    }, Promise.resolve(root));
  }

  function writeDataToHandle(handle, data) {
    return handle.createWritable().then(function (writer) {
      return writer.write(data)
        .then(function () { return writer.close(); })
        .catch(function (error) {
          return writer.close().catch(function () { /* best effort */ })
            .then(function () { throw error; });
        });
    });
  }

  function writeInPlace(program) {
    if (program && program.pendingRename && state.dirHandle) {
      return writeRenamedInPlace(program);
    }
    if (!program || !program.handle) {
      return Promise.reject(new Error('No writable file handle for ' +
        ((program && program.name) || 'program') + '.'));
    }
    return writeDataToHandle(program.handle, encodeProgramText(outputProgramText(program)));
  }

  function writeRenamedInPlace(program) {
    var rename = program.pendingRename;
    var fromRel = cleanRelPath(rename.fromRelPath || program.relPath || program.name);
    var dir = programDirRelPath(program);
    var toName = cleanRelPath(rename.to || '');
    if (!toName || toName.indexOf('/') !== -1) {
      return Promise.reject(new Error('Invalid output name for rename.'));
    }
    var toRel = cleanRelPath([dir, toName].filter(Boolean).join('/'));
    var newHandle;
    return parentDirectoryAt(state.dirHandle, fromRel)
      .then(function (parent) {
        return parent.getFileHandle(toName, { create: true }).then(function (handle) {
          newHandle = handle;
          return writeDataToHandle(handle, encodeProgramText(outputProgramText(program)));
        }).then(function () {
          return parent.removeEntry(fileNameOf({ relPath: fromRel }));
        });
      })
      .then(function () {
        program.handle = newHandle;
        program.renamedFrom = fromRel;
        program.name = toRel;
        program.relPath = toRel;
        program.dirRelPath = dir;
        program.outputName = toRel;
        delete program.pendingRename;
        return program;
      });
  }


  function originalTimeEntry(program) {
    return {
      folder: programDirRelPath(program),
      name: fileNameOf(program),
      lastModified: Number(program && program.modified || 0),
      size: Number(program && program.size || 0)
    };
  }

  function writeOriginalTimesSidecar(backupDir, programs) {
    var entries = (programs || []).map(originalTimeEntry).filter(function (entry) {
      return !!entry.name;
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    return backupDir.getFileHandle('_original_times.json', { create: true })
      .then(function (handle) {
        return writeDataToHandle(handle, JSON.stringify({
          schema: 'migrate-studio/original-times',
          version: 1,
          writtenAt: new Date().toISOString(),
          entries: entries
        }, null, 2) + '\n');
      });
  }

  function backupStampEntries(programs) {
    return (programs || []).map(originalTimeEntry).filter(function (entry) {
      return !!entry.name && entry.lastModified > 0;
    });
  }

  function stampOriginalBackups(rootToken, programs) {
    if (!rootToken || !window.location.protocol.match(/^https?:$/)) {
      return Promise.resolve(null);
    }
    return postJson('api/backup/stamp', {
      rootToken: rootToken,
      entries: backupStampEntries(programs)
    }).catch(function (error) {
      return { ok: false, error: (error && error.message) || 'stamp failed' };
    });
  }

  function applyBackupStampResult(result, stamp) {
    if (!stamp) return result;
    result.stamped = !!stamp.ok;
    result.stampMode = stamp.ok ? 'server-stamp' : 'server-stamp-failed';
    result.dateFailed = (stamp.dateFailed || result.dateFailed || []).slice();
    result.datesPreserved = !!stamp.ok && !result.dateFailed.length;
    if (stamp.error && result.resolution) {
      result.resolution += '; stamp failed: ' + stamp.error;
    }
    state.lastBackupInfo = backupInfo(result.mode, result.datesPreserved,
      result.resolution, {
        dateFailed: result.dateFailed,
        stamped: result.stamped,
        stampMode: result.stampMode
      });
    return result;
  }

  function browserBackupFile(backupDir, program, index) {
    var name = fileNameOf(program);
    var dir = programDirRelPath(program);
    var set = backupFilesFor(index, dir);
    if (!set) {
      set = new Set();
      index.set(dir, set);
    }
    if (set.has(name)) return Promise.resolve('skipped');
    return backupDir.getFileHandle(name, { create: false })
      .then(function () {
        set.add(name);
        return 'skipped';
      })
      .catch(function (error) {
        if (!notFound(error)) throw error;
        if (!program.handle) {
          throw new Error('No source handle for ' + program.name + '.');
        }
        return program.handle.getFile()
          .then(function (file) {
            return backupDir.getFileHandle(name, { create: true })
              .then(function (backupFile) {
                return writeDataToHandle(backupFile, file);
              });
          })
          .then(function (writeResult) {
            set.add(name);
            return {
              status: 'copied',
              datePreserved: !!(writeResult && writeResult.datePreserved === true)
            };
          });
      });
  }

  function ensureOriginalBackupInBrowser(resolution, programs, rootToken) {
    var groups = groupProgramsByDirectory(programs);
    var index = ensureBackupIndexMap();
    var cache = new Map();
    var copied = 0;
    var skipped = 0;
    var dateFailed = [];
    return groups.reduce(function (chain, group) {
      return chain.then(function () {
        return backupHandleFor(group.dirRelPath, true, cache).then(function (backupDir) {
          return writeOriginalTimesSidecar(backupDir, group.programs)
            .then(function () {
              return group.programs.reduce(function (programChain, program) {
                return programChain.then(function () {
                  return browserBackupFile(backupDir, program, index)
                    .then(function (outcome) {
                      var status = outcome && outcome.status || outcome;
                      if (status === 'copied') copied++;
                      else skipped++;
                      if (outcome && outcome.datePreserved === false) {
                        dateFailed.push({
                          folder: group.dirRelPath || '',
                          name: fileNameOf(program)
                        });
                      }
                    })
                    .catch(function (error) {
                      error.programName = (group.dirRelPath || '(root)') + '/' +
                        fileNameOf(program);
                      throw error;
                    });
                });
              }, Promise.resolve());
            });
        });
      });
    }, Promise.resolve()).then(function () {
      state.lastBackupInfo = backupInfo('browser', !dateFailed.length,
        resolution || 'unresolved', { dateFailed: dateFailed });
      return {
        directories: groups.length,
        copied: copied,
        skipped: skipped,
        mode: 'browser',
        datesPreserved: !dateFailed.length,
        resolution: state.lastBackupInfo.resolution,
        dateFailed: dateFailed,
        stamped: false,
        stampMode: 'browser'
      };
    }).then(function (result) {
      if (!rootToken) return result;
      return stampOriginalBackups(rootToken, programs)
        .then(function (stamp) { return applyBackupStampResult(result, stamp); });
    });
  }

  function ensureOriginalBackup(programs) {
    var directories = backupRequestDirectories(programs);
    setLoading('Backing up originals…');
    return resolveBackupRootToken().then(function (resolved) {
      if (!resolved || !resolved.resolved || !resolved.rootToken) {
        return ensureOriginalBackupInBrowser((resolved && resolved.reason) || 'unresolved',
          programs, resolved && resolved.rootToken);
      }
      if (resolved && resolved.path) state.folderPath = resolved.path;
      return postJson('api/backup/originals', {
        rootToken: resolved.rootToken,
        directories: directories
      }).then(function (response) {
        if (!response || response.ok === false ||
            (response.failed && response.failed.length)) {
          var failed = response && response.failed && response.failed[0];
          var label = failed
            ? ((failed.folder || '(root)') + '/' + (failed.name || 'program'))
            : 'a program';
          var error = new Error((failed && failed.error) || 'backup failed');
          error.programName = label;
          throw error;
        }
        state.backupIndex = response.index || {};
        state.lastBackupInfo = backupInfo('server-copy2',
          response.datesPreserved !== false, resolved.resolution || 'search', {
            dateFailed: response.dateFailed || [],
            stamped: true,
            stampMode: 'os-' + (response.copyMethod || 'copy2')
          });
        return {
          directories: directories.length,
          copied: response.copied || 0,
          skipped: response.skipped || 0,
          mode: 'server-copy2',
          datesPreserved: state.lastBackupInfo.datesPreserved,
          resolution: state.lastBackupInfo.resolution,
          dateFailed: state.lastBackupInfo.dateFailed,
          stamped: state.lastBackupInfo.stamped,
          stampMode: state.lastBackupInfo.stampMode
        };
      });
    });
  }

  function originalBackupFile(program) {
    return backupHandleFor(programDirRelPath(program), false, new Map())
      .then(function (backupDir) {
        if (!backupDir) throw new Error('No original backup for ' + program.name + '.');
        return backupDir.getFileHandle(program.originalBackupName || fileNameOf(program),
          { create: false });
      })
      .then(function (handle) { return handle.getFile(); });
  }

  function deleteOriginalBackup(program) {
    return backupHandleFor(programDirRelPath(program), false, new Map())
      .then(function (backupDir) {
        if (!backupDir) return;
        return backupDir.removeEntry(program.originalBackupName || fileNameOf(program));
      })
      .then(function () { state.backupIndex = null; })
      .catch(function (error) {
        if (!notFound(error)) throw error;
      });
  }

  /* Two runs of the same rule book should read as one rule with a bigger
     count, not two entries in the Rules-applied list. */
  function mergeHits(existing, incoming) {
    var byId = {};
    var out = [];
    (existing || []).forEach(function (hit) {
      var copy = Object.assign({}, hit, {
        details: (hit.details || []).slice()
      });
      byId[hit.id] = copy;
      out.push(copy);
    });
    (incoming || []).forEach(function (hit) {
      if (byId[hit.id]) {
        byId[hit.id].count += hit.count;
        byId[hit.id].details = (byId[hit.id].details || [])
          .concat(hit.details || []);
      } else {
        byId[hit.id] = Object.assign({}, hit, {
          details: (hit.details || []).slice()
        });
        out.push(byId[hit.id]);
      }
    });
    return out;
  }

  function applyFixToSelection() {
    var targets = checkedPrograms();
    if (!targets.length) {
      var current = state.programs[state.selected];
      if (!current) { toast('No Programs selected on left panel.', 'warn'); return; }
      targets = [current];
    }
    var book = activeBook();
    if (!book) {
      toast('Load the MC pack or Migrate_Studio_Rules.xlsx first.', 'warn');
      return;
    }
    if (!selectedRuleCount()) {
      toast('No rules are selected. Tick the ones to apply on the Rules tab.',
            'warn');
      return;
    }

    return promptForAuthorOnce()
      .then(requireWritableFolder)
      .then(function (writable) {
        if (!writable) return null;
        return readBackupIndex(targets);
      })
      .then(function (backupIndex) {
        if (!backupIndex) return null;
        return loadRunHistory().then(function (history) {
          return {
            backupIndex: backupIndex,
            runs: (history && history.runs) || []
          };
        });
      })
      .then(function (context) {
        if (!context) return null;
        var partition = partitionTargets(targets, context.backupIndex, context.runs);
        if (!partition.pending.length) {
          toast('Fix has already been applied, no further updates made.', 'warn');
          return null;
        }
        return partition;
      })
      .then(function (partition) {
        if (!partition) return null;
        return ensureOriginalBackup(targets)
          .then(function (backup) {
            setLoading(null);
            if (!backup) return null;
            return {
              backup: backup,
              applied: partition.applied,
              pending: partition.pending
            };
          })
          .catch(function (error) {
            setLoading(null);
            toast('Could not back up ' + (error.programName || 'a program') +
                  ' — no fixes were applied.', 'err');
            showFsBanner(true);
            return null;
          });
      })
      .then(function (ready) {
        if (!ready) return null;
        var changed = 0;
        var touched = 0;
        var written = 0;
        var runPrograms = [];
        return ready.pending.reduce(function (chain, p) {
          return chain.then(function () {
            var before = p.fixCount;
            var outcome = applyFixTo(p);
            if (!outcome) return;
            return writeInPlace(p).catch(function (error) {
              error.programName = p.name;
              throw error;
            }).then(function () {
              touched++;
              written++;
              changed += (p.fixCount - before);
              runPrograms.push(runProgramRecord(p, outcome));
            });
          });
        }, Promise.resolve()).then(function () {
          refreshFindings();
          if (touched) {
            saveHistory();
            state.dirty = false;
            renderSaveState();
            return recordRun(ready.pending.length, runPrograms, ready.pending);
          }
        }).then(function () {
          renderAll();
          if (!touched) return;
          setTab('compare');
          if (ready.applied.length) {
            toast(ready.applied.length + ' already fixed and skipped. ' +
                  plural(touched, 'program') + ' updated. ' +
                  backupToastText(ready.backup));
          } else {
            toast(plural(changed, 'fix', 'fixes') + ' applied across ' +
                  plural(touched, 'program') + '. ' +
                  backupToastText(ready.backup));
          }
        }).catch(function (error) {
          refreshFindings();
          saveHistory();
          renderAll();
          toast('Could not write ' + ((error && error.programName) || 'a program') +
                ' in place. ' + plural(written, 'program') +
                ' already written.', 'err');
        });
      });
  }

  function revertProgram() {
    var program = state.programs[state.selected];
    if (!program || program.fixed == null) return;
    confirmDialog(
      'Revert ' + program.name + '?',
      'The live program is restored from ' + ORIGINAL_BACKUP_FOLDER + ', and ' +
      'that backup marker is removed so Apply Fix can run again.',
      'Revert'
    ).then(function (ok) {
      if (!ok) return;
      return requireWritableFolder().then(function (writable) {
        if (!writable) return;
        return originalBackupFile(program)
          .then(function (file) {
            return decodeProgramFile(file).then(function (text) {
              return writeDataToHandle(program.handle, file).then(function () {
                return text;
              });
            });
          })
          .then(function (text) {
            return deleteOriginalBackup(program).then(function () { return text; });
          })
          .then(function (text) {
            program.versions.unshift({
              id: 'v' + (program.versions.length + 1),
              at: stamp(),
              author: state.author.name || '',
              rules: '—',
              total: 0,
              applied: 0,
              reverted: true,
              hits: [],
              text: text
            });
            program.fixed = null;
            program.hits = [];
            program.fixCount = 0;
            state.dirty = false;
            saveHistory();
            return recordProgramAction('revert-in-place', program).then(function () {
              renderAll();
              toast(program.name + ' reverted to the original.');
            });
          })
          .catch(function (error) {
            toast('Could not revert ' + program.name + ': ' + error.message, 'err');
          });
      });
    });
  }

  function restoreVersion(program, version) {
    var restoredHits = (version.hits || []).slice();
    var restoredTotal = detailTotal(restoredHits) || version.total || 0;
    program.versions.unshift({
      id: 'v' + (program.versions.length + 1),
      at: stamp(),
      author: state.author.name || '',
      rules: version.rules || '—',
      total: restoredTotal,
      applied: 0,
      restoredFrom: version.id,
      hits: restoredHits,
      text: version.text
    });
    program.fixed = version.text;
    program.hits = restoredHits.slice();
    program.fixCount = restoredTotal;
    state.dirty = true;
    saveHistory();
    function done() {
      renderAll();
      toast('Restored ' + version.id + ' of ' + program.name + '.');
    }
    if (!state.dirHandle) {
      done();
      return;
    }
    return ensureWritable(state.dirHandle).then(function (granted) {
      state.writable = granted;
      showFsBanner(!granted);
      if (!granted) {
        toast('Restored on screen only. Write access was declined.', 'warn');
        renderAll();
        return;
      }
      return writeInPlace(program).then(function () {
        state.dirty = false;
        saveHistory();
        done();
      });
    }).catch(function (error) {
      toast('Could not write the restored program: ' + error.message, 'err');
      renderAll();
    });
  }

  /* ---------------------------------------------------------------------
   * Writing back
   * ------------------------------------------------------------------ */

  function ensureOutputDirectory() {
    if (!state.dirHandle) return Promise.resolve(null);
    return ensureWritable(state.dirHandle).then(function (granted) {
      state.writable = granted;
      showFsBanner(!granted);
      if (!granted) return null;
      return state.dirHandle.getDirectoryHandle('Migrate_Studio', { create: true })
        .then(function (outDir) {
          return state.dirHandle.getDirectoryHandle(legacyBrand)
            .then(function () { legacyOutputFolderFound = true; return outDir; })
            .catch(function () { return outDir; });
        });
    });
  }

  function save() {
    var fixed = state.programs.filter(function (p) { return p.fixed != null; });
    if (!fixed.length) {
      toast('Nothing to save — no fixes applied yet.', 'warn');
      return;
    }

    if (!state.dirHandle) {
      toast('This folder is read-only, so Save is a download instead.', 'warn');
      downloadFixed();
      return;
    }

    ensureWritable(state.dirHandle).then(function (granted) {
      state.writable = granted;
      showFsBanner(!granted);
      if (!granted) {
        toast('Write access was declined — downloading the fixed programs ' +
              'instead.', 'warn');
        downloadFixed();
        return;
      }

      return fixed.reduce(function (chain, p) {
        return chain.then(function () {
          return writeInPlace(p);
        });
      }, Promise.resolve())
        .then(function () {
          state.dirty = false;
          renderSaveState();
          toast(plural(fixed.length, 'program') + ' saved in place.');
        });
    }).catch(function (error) {
      toast('Could not write the fixed programs: ' + error.message, 'err');
    });
  }

  function outputFileHandle(root, relPath) {
    var parts = cleanRelPath(relPath).split('/').filter(Boolean);
    var name = parts.pop() || relPath;
    return parts.reduce(function (chain, part) {
      return chain.then(function (dir) {
        return dir.getDirectoryHandle(part, { create: true });
      });
    }, Promise.resolve(root)).then(function (dir) {
      return dir.getFileHandle(name, { create: true });
    });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function downloadFixed() {
    var fixed = state.programs.filter(function (p) { return p.fixed != null; });
    if (!fixed.length) {
      toast('Nothing to download — no fixes applied yet.', 'warn');
      return;
    }

    var files = {};
    fixed.forEach(function (p) {
      files[p.name] = encodeProgramText(outputProgramText(p));
    });

    try {
      var zipped = window.fflate.zipSync(files, { level: 6 });
      download(new Blob([zipped], { type: 'application/zip' }),
               (state.folderName || 'migrate-studio') + '_Migrate_Studio.zip');
    } catch (error) {
      toast('Could not build the zip: ' + error.message, 'err');
    }
  }

  function changeTypeLabel(type) {
    return type === 'add' ? 'Added' : type === 'delete' ? 'Deleted' : 'Modified';
  }

  function clip(value) {
    var text = value == null ? '' : String(value);
    return text.length > HISTORY_TEXT_MAX
      ? text.slice(0, HISTORY_TEXT_MAX) + '...' : text;
  }

  function folderKey(program) {
    var dir = cleanRelPath(program && program.dirRelPath != null
      ? program.dirRelPath : relDir((program && (program.relPath || program.name)) || ''));
    return dir || '(root)';
  }

  function runProgramRecord(program, outcome) {
    var details = [];
    var ruleIds = {};
    var ruleCounts = {};
    var ruleMeta = {};
    (outcome.hits || []).forEach(function (hit) {
      if (!hit || !hit.id || !(hit.count > 0)) return;
      ruleIds[hit.id] = true;
      ruleCounts[hit.id] = (ruleCounts[hit.id] || 0) + hit.count;
      ruleMeta[hit.id] = {
        name: hit.name || '',
        category: hit.category || '',
        severity: hit.severity || ''
      };
      (hit.details || []).forEach(function (d) {
        details.push({
          ruleId: hit.id,
          ruleName: hit.name || '',
          category: hit.category || '',
          severity: hit.severity || '',
          type: changeTypeLabel(d.type),
          originalLine: d.originalLine == null ? null : d.originalLine,
          fixedLine: d.fixedLine == null ? null : d.fixedLine,
          before: clip(d.before),
          after: clip(d.after)
        });
      });
    });
    return {
      name: program.name,
      relPath: program.relPath || program.name,
      renamed_from: outcome.rename && outcome.rename.from || '',
      renamed_to: outcome.rename && outcome.rename.to || '',
      outputName: program.outputName || program.name,
      folder: folderKey(program),
      versionId: outcome.versionId,
      applications: outcome.applied,
      lines: details.length,
      rules: Object.keys(ruleIds).sort(),
      ruleCounts: ruleCounts,
      ruleMeta: ruleMeta,
      details: details
    };
  }

  function makeRunId(date) {
    var compact = date.toISOString().replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    var hex = Math.floor(Math.random() * 0x1000000).toString(16)
      .padStart(6, '0');
    return compact + '-' + hex;
  }

  function localTimestamp(date) {
    function z(n) { return String(n).padStart(2, '0'); }
    return date.getFullYear() + '-' + z(date.getMonth() + 1) + '-' +
      z(date.getDate()) + ' ' + z(date.getHours()) + ':' + z(date.getMinutes());
  }

  function buildRunRecord(targeted, runPrograms, targetPrograms) {
    var now = new Date();
    var byRule = {};
    var folders = {};
    var targetedPrograms = (targetPrograms || []).map(function (program) {
      var folder = folderKey(program);
      folders[folder] = true;
      return {
        name: program.name,
        relPath: program.relPath || program.name,
        folder: folder
      };
    });
    var totals = {
      programsTargeted: targeted,
      programsUpdated: runPrograms.length,
      ruleApplications: 0,
      linesChanged: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      distinctRules: 0
    };

    runPrograms.forEach(function (program) {
      folders[program.folder || '(root)'] = true;
      totals.ruleApplications += program.applications || 0;
      totals.linesChanged += program.lines || 0;
      (program.details || []).forEach(function (detail) {
        if (detail.type === 'Added') totals.added++;
        else if (detail.type === 'Deleted') totals.deleted++;
        else totals.modified++;
        if (!byRule[detail.ruleId]) {
          byRule[detail.ruleId] = {
            id: detail.ruleId,
            name: detail.ruleName || '',
            category: detail.category || '',
            severity: detail.severity || '',
            programs: {},
            applications: 0,
            lines: 0
          };
        }
        byRule[detail.ruleId].programs[program.name] = true;
        byRule[detail.ruleId].lines++;
      });
      program.rules.forEach(function (id) {
        if (!byRule[id]) {
          byRule[id] = {
            id: id,
            name: '',
            category: '',
            severity: '',
            programs: {},
            applications: 0,
            lines: 0
          };
        }
        byRule[id].programs[program.name] = true;
        byRule[id].applications += (program.ruleCounts && program.ruleCounts[id]) || 0;
      });
    });

    var rules = Object.keys(byRule).sort().map(function (id) {
      var rule = byRule[id];
      return {
        id: rule.id,
        name: rule.name,
        category: rule.category,
        severity: rule.severity,
        programs: Object.keys(rule.programs).length,
        applications: rule.applications,
        lines: rule.lines
      };
    });
    totals.distinctRules = rules.length;

    return {
      runId: makeRunId(now),
      action: 'apply-fix-in-place',
      backupFolders: backupFolderLabels(state.programs.length ? state.programs : targetPrograms),
      backupMode: (state.lastBackupInfo && state.lastBackupInfo.mode) || '',
      backupDatesPreserved: !!(state.lastBackupInfo && state.lastBackupInfo.datesPreserved),
      backupResolution: (state.lastBackupInfo && state.lastBackupInfo.resolution) || '',
      backupStamped: !!(state.lastBackupInfo && state.lastBackupInfo.stamped),
      backupStampMode: (state.lastBackupInfo && state.lastBackupInfo.stampMode) || '',
      dateFailed: (state.lastBackupInfo && state.lastBackupInfo.dateFailed) || [],
      inPlace: true,
      appliedAt: now.toISOString(),
      appliedAtLocal: localTimestamp(now),
      timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
      user: {
        id: state.identity.userId || '',
        key: state.identity.userKey || '',
        source: state.identity.source || 'unknown',
        host: state.identity.host || '',
        name: state.author.name || '',
        email: state.author.email || ''
      },
      sessionId: state.identity.sessionId || '',
      client: {
        userAgent: navigator.userAgent || '',
        writable: !!state.writable
      },
      migrationLabel: state.label || '',
      rootFolder: state.folderName || '',
      rootPath: state.folderPath || '',
      pathRoot: state.pathRoot || '',
      folders: Object.keys(folders).sort(),
      targetedPrograms: targetedPrograms,
      ruleSource: state.ruleSource,
      ruleBook: activeBookName(activeBook()),
      osFamily: state.osFamily,
      rulesSelected: selectedRuleCount(),
      totals: totals,
      rules: rules,
      programs: runPrograms
    };
  }

  function recordRun(targeted, runPrograms, targetPrograms) {
    if (!runPrograms || !runPrograms.length) return Promise.resolve();
    return (state.identityReady || Promise.resolve()).then(function () {
      return recordHistoryRun(buildRunRecord(targeted, runPrograms, targetPrograms));
    });
  }

  function buildProgramActionRecord(action, program) {
    var now = new Date();
    var folder = folderKey(program);
    var row = {
      name: program.name,
      relPath: program.relPath || program.name,
      folder: folder,
      versionId: (program.versions[0] && program.versions[0].id) || '',
      applications: 0,
      lines: 0,
      rules: [],
      ruleCounts: {},
      ruleMeta: {},
      details: []
    };
    return {
      runId: makeRunId(now),
      action: action,
      backupFolders: backupFolderLabels([program]),
      inPlace: true,
      appliedAt: now.toISOString(),
      appliedAtLocal: localTimestamp(now),
      timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '',
      user: {
        id: state.identity.userId || '',
        key: state.identity.userKey || '',
        source: state.identity.source || 'unknown',
        host: state.identity.host || '',
        name: state.author.name || '',
        email: state.author.email || ''
      },
      sessionId: state.identity.sessionId || '',
      client: {
        userAgent: navigator.userAgent || '',
        writable: !!state.writable
      },
      migrationLabel: state.label || '',
      rootFolder: state.folderName || '',
      rootPath: state.folderPath || '',
      pathRoot: state.pathRoot || '',
      folders: [folder],
      targetedPrograms: [{
        name: program.name,
        relPath: program.relPath || program.name,
        folder: folder
      }],
      ruleSource: state.ruleSource,
      ruleBook: activeBookName(activeBook()),
      osFamily: state.osFamily,
      rulesSelected: selectedRuleCount(),
      totals: {
        programsTargeted: 1,
        programsUpdated: 0,
        ruleApplications: 0,
        linesChanged: 0,
        added: 0,
        modified: 0,
        deleted: 0,
        distinctRules: 0
      },
      rules: [],
      programs: [row]
    };
  }

  function recordHistoryRun(run) {
    appendLocalRun(run);
    if (!window.location.protocol.match(/^https?:$/)) {
      state.runHistory = mergeRuns([], readLocalRuns());
      return Promise.resolve();
    }
    return postJson('api/history', run)
      .then(function () {
        state.runHistory = [];
        state.runHistoryError = '';
      })
      .catch(function () {
        state.historyPending = true;
        toast('The run could not be written to history.json -- it is recorded in this browser only.', 'warn');
      });
  }

  function recordProgramAction(action, program) {
    return (state.identityReady || Promise.resolve()).then(function () {
      return recordHistoryRun(buildProgramActionRecord(action, program));
    });
  }

  function summaryWorkbookTitle() {
    return 'Migrate Studio | Update Summary | ' +
      (state.folderPath || state.folderName || '(folder not selected)');
  }

  function downloadSummaryUpdates() {
    var fixed = state.programs.filter(function (p) {
      return p.fixed != null && p.hits && p.hits.some(function (hit) {
        return hit && hit.count > 0;
      });
    });

    if (!fixed.length) {
      toast('No updates to summarize — apply fixes first.', 'warn');
      return;
    }

    var detailRows = [];
    var byRule = {};
    var byProgram = {};
    var distinctIds = {};
    var totalUpdates = 0;
    var totalLines = 0;
    var legacyTrace = false;
    var S = window.MigExcel.STYLE;

    function inputNameFor(program) {
      var latest = program.versions && program.versions[0] || {};
      if (program.renamedFrom) return program.renamedFrom;
      if (latest.renamedFrom) {
        return cleanRelPath([program.dirRelPath, latest.renamedFrom].filter(Boolean).join('/'));
      }
      return program.name;
    }

    function outputNameFor(program) {
      return program.outputName || program.name;
    }

    fixed.forEach(function (program) {
      var inputName = inputNameFor(program);
      var outputName = outputNameFor(program);
      var programStats = byProgram[inputName] || {
        outputName: outputName,
        ids: {}, updates: 0, lines: 0
      };
      programStats.outputName = outputName;

      (program.hits || []).forEach(function (hit) {
        if (!hit || !hit.id || !(hit.count > 0)) return;

        var details = hit.details || [];
        if (!details.length) legacyTrace = true;
        distinctIds[hit.id] = true;
        totalUpdates += hit.count;
        totalLines += details.length;
        programStats.ids[hit.id] = true;
        programStats.updates += hit.count;
        programStats.lines += details.length;

        if (!byRule[hit.id]) {
          byRule[hit.id] = {
            id: hit.id,
            name: hit.name || '',
            description: hit.description || '',
            programs: {},
            updates: 0,
            lines: 0
          };
        }
        if (!byRule[hit.id].description && hit.description) {
          byRule[hit.id].description = hit.description;
        }
        byRule[hit.id].programs[program.name] = true;
        byRule[hit.id].updates += hit.count;
        byRule[hit.id].lines += details.length;

        details.forEach(function (detail) {
          var type = detail.type === 'add' ? 'Added'
            : detail.type === 'delete' ? 'Deleted' : 'Modified';
          detailRows.push([
            inputName,
            outputName,
            hit.id,
            hit.name || '',
            hit.category || '',
            hit.severity || '',
            type,
            detail.originalLine == null ? '' : detail.originalLine,
            detail.fixedLine == null ? '' : detail.fixedLine,
            detail.before == null ? '' : String(detail.before),
            detail.after == null ? '' : String(detail.after)
          ]);
        });
      });

      byProgram[inputName] = programStats;
    });

    /* The Summary worksheet is intentionally organized as three independent
       sections instead of one mixed table. This keeps the management-level
       totals, rule-level counts, and program-level counts easy to scan while
       the Detail worksheet remains the line-by-line audit trail. */
    var summaryRows = [];
    var kinds = [];
    function put(kind, cells) {
      summaryRows.push(cells);
      kinds.push(kind);
    }

    put('section', ['Overall Summary', '', '', '', '']);
    put('subhead', ['Metric', 'Count', '', '', '']);
    put('metric', ['Programs Updated', fixed.length, '', '', '']);
    put('metric', ['Distinct Rules Applied', Object.keys(distinctIds).length, '', '', '']);
    put('metric', ['Total Rule Applications', totalUpdates, '', '', '']);
    put('metric', ['Total Lines Changed', totalLines, '', '', '']);
    put('spacer', ['', '', '', '', '']);

    put('section', ['Summary by Rule', '', '', '', '']);
    put('subhead', ['Rule ID', 'Rule Name', 'Programs Affected',
      'Rule Applications', 'Lines Changed']);

    Object.keys(byRule).sort().forEach(function (id) {
      var item = byRule[id];
      put('data', [
        item.id,
        item.name,
        Object.keys(item.programs).length,
        item.updates,
        item.lines
      ]);
    });

    put('spacer', ['', '', '', '', '']);
    put('section', ['Summary by Program', '', '', '', '']);
    put('subhead', ['Program', 'Output Name', 'Distinct Rules Applied',
      'Rule Applications', 'Lines Changed']);

    Object.keys(byProgram)
      .sort(function (a, b) { return a.localeCompare(b); })
      .forEach(function (name) {
        var item = byProgram[name];
        put('data', [
          name,
          item.outputName || name,
          Object.keys(item.ids).length,
          item.updates,
          item.lines
        ]);
      });

    function summaryStyle(rowIndex, colIndex) {
      switch (kinds[rowIndex]) {
        case 'section': return S.SECTION;
        case 'subhead': return S.LABEL;
        case 'metric': return colIndex === 0 ? S.LABEL : S.NUM;
        case 'data': return colIndex === 0 || colIndex === 1 ? S.BODY : S.NUM;
        default: return S.BODY;
      }
    }

    /* Rules reference sheet.

       Rule ID and Short Title come from the hits, so this lists the rules that
       were actually applied rather than the whole rule book. Description is
       looked up by id: the Rules sheet first, then the Logic Changes sheet and
       the built-in logic findings for L-### ids (MigRules.ruleDescriptions),
       then any description the hit itself carried. A row is never left blank. */
    var ruleDescriptions = window.MigRules.ruleDescriptions(state.rules);

    var rulesRows = Object.keys(byRule).sort().map(function (id) {
      var item = byRule[id];
      var description = ruleDescriptions[id] || item.description ||
        'No description found in ' +
        ((state.rules && state.rules.source) || 'the rule book') + '.';
      return [item.id, item.name, description];
    });

    var rulesColumns = [
      { header: 'Rule ID', width: 12 },
      { header: 'Short Title', width: 40 },
      { header: 'Description', width: 52 }
    ];
    rulesColumns[2].style = S.MONO;

    detailRows.sort(function (a, b) {
      var programOrder = String(a[0]).localeCompare(String(b[0]));
      if (programOrder) return programOrder;
      var aLine = a[7] === '' ? (a[8] === '' ? Number.MAX_SAFE_INTEGER : a[8]) : a[7];
      var bLine = b[7] === '' ? (b[8] === '' ? Number.MAX_SAFE_INTEGER : b[8]) : b[7];
      if (aLine !== bLine) return aLine - bLine;
      return String(a[1]).localeCompare(String(b[1]));
    });

    var summaryColumns = [
      { header: summaryWorkbookTitle(), width: 70 },
      { header: '', width: 42 },
      { header: '', width: 20 },
      { header: '', width: 20 },
      { header: '', width: 16 }
    ];

    var detailColumns = [
      { header: 'Program', width: 28 },
      { header: 'Output Name', width: 28 },
      { header: 'Rule ID', width: 12 },
      { header: 'Rule Name', width: 36 },
      { header: 'Category', width: 24 },
      { header: 'Risk', width: 14 },
      { header: 'Change Type', width: 14 },
      { header: 'Original Line', width: 14 },
      { header: 'Fixed Line', width: 12 },
      { header: 'Original Text', width: 52 },
      { header: 'Fixed Text', width: 52 }
    ];

    var D = {
      PROGRAM: 0, OUTPUT: 1, RULE: 2, NAME: 3, CAT: 4, RISK: 5, TYPE: 6,
      OLINE: 7, FLINE: 8, OTEXT: 9, FTEXT: 10
    };

    detailColumns[D.OLINE].style = S.NUM;
    detailColumns[D.FLINE].style = S.NUM;
    detailColumns[D.OTEXT].style = S.MONO;
    detailColumns[D.FTEXT].style = S.MONO;

    function detailStyle(rowIndex, colIndex, value) {
      if (colIndex === D.TYPE) {
        return value === 'Added' ? S.ADD
          : value === 'Deleted' ? S.DEL : S.MOD;
      }
      if (colIndex === D.RISK) {
        var risk = String(value).toLowerCase();
        if (risk.indexOf('high') === 0) return S.DEL;
        if (risk.indexOf('med') === 0) return S.MOD;
        if (risk.indexOf('low') === 0) return S.ADD;
      }
      return null;
    }

    try {
      var bytesOut = window.MigExcel.write([
        {
          name: 'Summary',
          columns: summaryColumns,
          rows: summaryRows,
          autofilter: false,
          frozen: false,
          zebra: false,
          merges: ['A1:E1'],
          headerHeight: 28,
          styleFor: summaryStyle
        },
        {
          name: 'Detail',
          columns: detailColumns,
          rows: detailRows,
          headerHeight: 26,
          styleFor: detailStyle,
          rowHeight: function () { return 30; }
        },
        { name: 'Rules', columns: rulesColumns, rows: rulesRows }
      ]);
      download(new Blob([bytesOut], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }), 'Migrate_Studio_Summary_Updates_' + timestampYYYYMMDDHHMM() + '.xlsx');

      if (legacyTrace) {
        toast('Summary downloaded. Some saved history predates line-level tracking; ' +
              're-apply those fixes for complete Detail rows.', 'warn');
      } else {
        toast('Summary Updates workbook downloaded.');
      }
    } catch (error) {
      toast('Could not build the Summary Updates workbook: ' + error.message, 'err');
    }
  }

  function downloadFixedProgram(program) {
    if (!program || program.fixed == null) {
      toast('Apply a fix before downloading the Migrate Studio copy.', 'warn');
      return;
    }

    var files = {};
    files[program.name] = encodeProgramText(outputProgramText(program));
    try {
      var zipped = window.fflate.zipSync(files, { level: 6 });
      download(new Blob([zipped], { type: 'application/zip' }),
               program.name.replace(/\.sas$/i, '') + '_Migrate_Studio.zip');
    } catch (error) {
      toast('Could not build the zip: ' + error.message, 'err');
    }
  }

  /* ---------------------------------------------------------------------
   * Rendering — left rail
   * ------------------------------------------------------------------ */

  function fileNameOf(program) {
    var clean = cleanRelPath(program.relPath || program.name || program.file || '');
    if (!clean && program.file) clean = cleanRelPath(program.file);
    var at = clean.lastIndexOf('/');
    return at < 0 ? clean : clean.slice(at + 1);
  }

  function programHaystack(program) {
    var dir = cleanRelPath(program.dirRelPath != null
      ? program.dirRelPath : relDir(program.relPath || program.name));
    var file = fileNameOf(program);
    return (dir ? dir + '/' + file : file).toLowerCase();
  }

  function normalizeQuery(text) {
    return String(text == null ? '' : text)
      .replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function matchesTerm(hay, term) {
    if (!term) return true;
    if (term.length > 1 && term.charAt(term.length - 1) === '/') {
      var segment = term.slice(0, -1);
      return ('/' + hay).indexOf('/' + segment + '/') !== -1;
    }
    return hay.indexOf(term) !== -1;
  }

  function matchesQuery(hay, query) {
    hay = normalizeQuery(hay);
    query = normalizeQuery(query);
    if (!query) return true;
    if (matchesTerm(hay, query)) return true;
    var terms = query.split(' ');
    if (terms.length < 2) return false;
    return terms.every(function (term) { return matchesTerm(hay, term); });
  }

  function highlightInto(el, text, query) {
    el.textContent = '';
    query = normalizeQuery(query);
    var terms = query ? [query].concat(query.split(' ')) : [];
    var low = String(text).toLowerCase();
    var at = -1;
    var hit = '';
    terms.forEach(function (term) {
      term = String(term || '').replace(/\/$/, '');
      if (!term || term.length < 2 || at !== -1) return;
      var found = low.indexOf(term);
      if (found !== -1) {
        at = found;
        hit = term;
      }
    });
    if (at === -1) {
      el.textContent = text;
      return;
    }
    el.appendChild(document.createTextNode(text.slice(0, at)));
    var mark = document.createElement('span');
    mark.className = 'rail-hit';
    mark.textContent = text.slice(at, at + hit.length);
    el.appendChild(mark);
    el.appendChild(document.createTextNode(text.slice(at + hit.length)));
  }

  window.MigrateStudioRailSearch = {
    fileNameOf: fileNameOf,
    programHaystack: programHaystack,
    normalizeQuery: normalizeQuery,
    matchesQuery: matchesQuery
  };

  function visiblePrograms() {
    var query = normalizeQuery($('programFilter').value);
    if (!query) return state.programs.slice();
    return state.programs.filter(function (p) {
      return matchesQuery(programHaystack(p), query);
    });
  }

  function checkedPrograms() {
    return state.programs.filter(function (p) { return state.checked[p.name]; });
  }

  function renderRail() {
    var tree = $('railTree');
    var list = visiblePrograms();
    tree.innerHTML = '';

    if (!state.programs.length) {
      tree.innerHTML = '<div class="rail-empty">' +
        'No folder open yet.<br>Press <strong>Folder</strong> to choose one.' +
        '</div>';
    } else if (!list.length) {
      tree.innerHTML = '<div class="rail-empty">No folder or program matches ' +
        '<strong>' + esc(normalizeQuery($('programFilter').value)) + '</strong>.</div>';
    } else {
      var frag = document.createDocumentFragment();
      list.forEach(function (program) {
        frag.appendChild(railItem(program));
      });
      tree.appendChild(frag);
    }

    $('statPrograms').textContent = state.programs.length;
    $('statFixed').textContent = state.programs.filter(function (p) {
      return p.fixed != null;
    }).length;
    /* The rail counts what will run, not what the book holds — a consolidated
       rule book has far more in it than any one migration applies. */
    var book = activeBook();
    $('statRules').textContent = book
      ? (ruleCounts().selected + '/' + ruleCounts().total) : 0;
  }

  function railItem(program) {
    var index = state.programs.indexOf(program);

    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'rail-item' + (index === state.selected ? ' is-selected' : '');

    var tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'rail-check';
    tick.checked = !!state.checked[program.name];
    tick.title = 'Select for Apply Fix';
    tick.addEventListener('click', function (event) {
      event.stopPropagation();
      state.checked[program.name] = tick.checked;
      if (!tick.checked) delete state.checked[program.name];
      renderSelectAll();
    });

    var dot = document.createElement('span');
    dot.className = 'rail-dot' + (program.fixed == null ? ' warning' : '');
    dot.title = program.fixed == null ? 'Not fixed yet' : 'Fixed';

    var body = document.createElement('span');
    body.className = 'rail-item-body';
    var query = normalizeQuery($('programFilter').value);

    var name = document.createElement('span');
    name.className = 'rail-number';
    highlightInto(name, fileNameOf(program), query);
    body.appendChild(name);

    var folder = cleanRelPath(program.dirRelPath != null
      ? program.dirRelPath : relDir(program.relPath || program.name));
    if (folder) {
      var where = document.createElement('span');
      where.className = 'rail-program';
      highlightInto(where, folder + '/', query);
      body.appendChild(where);
    }
    item.title = program.relPath || program.name;

    var count = document.createElement('span');
    count.className = 'rail-count' + (program.fixCount ? ' has-fixes' : '');
    count.textContent = program.fixCount;
    count.title = program.fixCount
      ? plural(program.fixCount, 'change') +
        (program.fromHistory ? ' (from history.json, ' +
          plural(program.fromHistory.runs.length, 'run') + ')' : ' applied')
      : 'No updates applied';

    item.appendChild(tick);
    item.appendChild(dot);
    item.appendChild(body);
    item.appendChild(count);

    item.addEventListener('click', function () {
      state.selected = index;
      if (program.original == null) {
        setLoading('Loading original of ' + program.name + '…');
        ensureRestoredOriginal(program).then(function () {
          setLoading(null);
          setTab('compare');
          renderAll();
        });
        return;
      }
      renderAll();
    });
    return item;
  }

  function renderSelectAll() {
    var button = $('btnSelectAll');
    var list = visiblePrograms();
    var all = list.length > 0 && list.every(function (p) {
      return state.checked[p.name];
    });
    button.setAttribute('aria-pressed', all ? 'true' : 'false');
    button.textContent = all ? 'Deselect All' : 'Select All';
    button.title = all ? 'Deselect all programs' : 'Select all programs';
  }

  /* ---------------------------------------------------------------------
   * Rendering — centre
   * ------------------------------------------------------------------ */

  function current() {
    return state.selected >= 0 ? state.programs[state.selected] : null;
  }

  function renderHead() {
    var program = current();
    $('workEyebrow').textContent = 'Migration SAS Programs';
    $('workTitle').textContent = program ? program.name : '—';

    var meta = $('workMeta');
    meta.innerHTML = '';
    if (!program) return;

    [
      state.folderName || 'no folder',
      bytes(program.size),
      plural(window.MigDiff.splitLines(program.original).length, 'line'),
      program.fixed == null ? 'not fixed' : plural(program.fixCount, 'update')
    ].forEach(function (text) {
      var chip = document.createElement('span');
      chip.className = 'chip mono';
      chip.textContent = text;
      meta.appendChild(chip);
    });

    renderApplyState();
    $('btnRevertProgram').disabled = !program || program.fixed == null;
  }

  /* -- Rules tab -----------------------------------------------------------
   * A read-only view of the rule book with one thing you can change: whether a
   * rule runs. Four columns, because those are the four a person needs to
   * decide that — the ID to talk about it by, the short title to recognise it,
   * the category to group it, and the description to judge it. Everything else
   * the workbook carries is in the row's tooltip and on the rule itself.
   *
   * One line per workbook row. A row that produced several variants shows as
   * one line whose tick governs all of them, because "apply R-002" is the
   * decision somebody actually makes — not "apply variant 2 of R-002".
   */

  function ruleRows() {
    /* Group the parsed rules back into workbook rows, in book order. */
    var order = [];
    var byRow = {};
    var book = activeBook();
    (book ? book.rules : []).forEach(function (rule) {
      var key = rule.row;
      if (!byRow[key]) { byRow[key] = []; order.push(key); }
      byRow[key].push(rule);
    });
    return order.map(function (key) {
      var group = byRow[key];
      return {
        row: key,
        rules: group,
        first: group[0],
        executable: group.some(function (r) { return r.executable && r.enabled; }),
        selected: group.some(function (r) { return r.selected; }),
        needsParameters: group.every(function (r) {
          return !r.executable || r.needsParameters;
        }) && group.some(function (r) { return r.needsParameters; })
      };
    });
  }

  function visibleRuleRows() {
    var query = ($('ruleFilter').value || '').trim().toLowerCase();
    var rows = ruleRows();
    if (!query) return rows;
    return rows.filter(function (entry) {
      var rule = entry.first;
      return [rule.id, rule.pack, rule.name, rule.category, rule.description]
        .join(' ').toLowerCase().indexOf(query) !== -1;
    });
  }

  function renderRules() {
    var status = $('rulesStatus');
    var head = $('rulesGridHead');
    var body = $('rulesGridBody');

    head.innerHTML = '';
    body.innerHTML = '';
    if ($('ruleSource')) $('ruleSource').value = state.ruleSource;
    if ($('osFamily')) $('osFamily').value = state.osFamily;
    if ($('pathRoot')) $('pathRoot').value = state.pathRoot;

    var book = activeBook();
    if (!book) {
      $('rulesPath').textContent = state.ruleSource === 'mc'
        ? 'rules/migration_rules.json' : 'rules/Migrate_Studio_Rules.xlsx';
      status.className = 'strip-status';
      status.textContent =
        state.ruleSource === 'mc' && state.mcUnavailable
          ? 'MC pack unavailable: ' + state.mcUnavailable
          : 'No rule book loaded. Use Import Pack for MC rules or Import Rules for the workbook.';
      return;
    }

    $('rulesPath').textContent = activeBookName(book) +
      (book.rulesSheet ? '  ·  ' + book.rulesSheet + ' sheet' : '');

    var rows = visibleRuleRows();
    var all = ruleRows();
    var selectable = all.filter(function (e) { return e.executable; });
    var ticked = selectable.filter(function (e) { return e.selected; });

    status.className = 'strip-status';
    status.textContent =
      plural(all.length, 'rule') + ' · ' +
      ticked.length + ' of ' + selectable.length + ' selected to apply' +
      (all.length - selectable.length
        ? ' · ' + (all.length - selectable.length) + ' documentation only'
        : '');
    if (book.kind === 'mc' && state.mcUnavailable) {
      status.className = 'strip-status warn';
      status.textContent += ' · MC auto-load note: ' + state.mcUnavailable;
    }
    if (book.warnings.length) {
      status.className = 'strip-status warn';
      status.textContent += ' · ' + book.warnings[0];
    }

    /* -- header ---------------------------------------------------------- */
    var tr = document.createElement('tr');

    var thSelect = document.createElement('th');
    thSelect.className = 'c-select';
    var selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'grid-select-link';
    var allOn = selectable.length > 0 && ticked.length === selectable.length;
    selectAll.textContent = allOn ? 'None' : 'All';
    selectAll.title = allOn
      ? 'Clear every rule' : 'Select every rule that can run';
    selectAll.addEventListener('click', function () {
      selectable.forEach(function (entry) {
        entry.rules.forEach(function (rule) {
          if (rule.executable && rule.enabled) rule.selected = !allOn;
        });
      });
      renderRules();
      renderContext();
      renderSaveState();
    });
    thSelect.appendChild(selectAll);
    tr.appendChild(thSelect);

    var thOrder = document.createElement('th');
    thOrder.className = 'c-order';
    thOrder.textContent = '#';
    tr.appendChild(thOrder);

    var display = book.display || window.MigRules.DISPLAY;
    var labels = book.displayLabels || window.MigRules.DISPLAY_LABELS;
    display.forEach(function (field) {
      var th = document.createElement('th');
      th.className = 'c-' + field;
      th.textContent = labels[field] || field;
      tr.appendChild(th);
    });
    head.appendChild(tr);

    /* -- body ------------------------------------------------------------ */
    if (!rows.length) {
      var empty = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = display.length + 2;
      cell.className = 'grid-empty';
      cell.textContent = all.length
        ? 'No rule matches that filter.'
        : 'The rule book has no rules on its Rules sheet.';
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }

    rows.forEach(function (entry) {
      body.appendChild(ruleRow(entry));
    });
  }

  function ruleRow(entry) {
    var rule = entry.first;
    var line = document.createElement('tr');
    /* Deliberately no is-selected class: the row grid tints a selected row,
       and since most rules are ticked by default that would make the table
       mostly violet and the tick — the thing being read — the only part that
       is not. The unticked rows are what should stand out. */
    if (!entry.executable) line.className = 'rule-off';
    line.title = ruleTooltip(entry);

    /* select */
    var tdSelect = document.createElement('td');
    tdSelect.className = 'c-select';
    var tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'row-select';
    tick.checked = entry.selected;
    tick.disabled = !entry.executable;
    tick.setAttribute('aria-label', 'Apply ' + rule.id);
    tick.addEventListener('change', function () {
      entry.rules.forEach(function (r) {
        if (r.executable && r.enabled) r.selected = tick.checked;
      });
      renderRules();
      renderContext();
    });
    tdSelect.appendChild(tick);
    line.appendChild(tdSelect);

    /* order */
    var tdOrder = document.createElement('td');
    tdOrder.className = 'c-order';
    tdOrder.innerHTML = '<span class="order-cell">' + entry.row + '</span>';
    line.appendChild(tdOrder);

    /* the four display columns */
    var book = activeBook() || {};
    var display = book.display || window.MigRules.DISPLAY;
    display.forEach(function (field) {
      var td = document.createElement('td');
      td.className = 'c-' + field + (field === 'id' ? ' cell-code' : ' cell-wrap');

      if (field === 'id') {
        td.innerHTML = '<span class="rule-id">' + esc(rule.id) + '</span>' +
          (entry.rules.length > 1
            ? '<span class="rule-variants mono" title="' +
              plural(entry.rules.length, 'variant') +
              '">×' + entry.rules.length + '</span>'
            : '') +
          (entry.needsParameters
            ? '<span class="rule-flag" title="Needs a parameter value">!</span>'
            : '');
      } else {
        var value = field === 'name' ? rule.name
          : field === 'pack' ? rule.pack
          : field === 'category' ? rule.category
          : rule.description;
        td.textContent = value || '';
        if (field === 'name') td.className += ' cell-strong';
      }
      line.appendChild(td);
    });

    return line;
  }

  /* Everything the four columns leave out, on hover — how the rule matches,
     what it needs, what it is scoped to, and why it cannot run when it can't. */
  function ruleTooltip(entry) {
    var rule = entry.first;
    var parts = [];
    if (!entry.executable) {
      parts.push(rule.note || 'Documentation only — no Before pattern.');
    } else if (rule.mode === 'insert') {
      /* An insertion has no pattern, so "matches as" would be the wrong word
         for it — what it does is add a line, once. */
      parts.push('Inserts a line into the startup block, once' +
        (entry.rules.length > 1
          ? ' · ' + plural(entry.rules.length, 'variant') : ''));
    } else {
      parts.push('Matches as ' + rule.mode +
        (entry.rules.length > 1
          ? ' · ' + plural(entry.rules.length, 'variant') : ''));
    }
    if (rule.axis) parts.push('Axis: ' + rule.axis);
    if (rule.automatability) parts.push('Automatability: ' + rule.automatability);
    if (rule.severity) parts.push('Risk if wrong: ' + rule.severity);
    if (rule.occurrences) parts.push('Occurrences: ' + rule.occurrences);
    if (rule.conflict) parts.push('Conflict status: ' + rule.conflict);
    if (rule.conditions) parts.push('Conditions: ' + rule.conditions);
    if (rule.scope) parts.push('Scope: ' + rule.scope);
    if (entry.needsParameters) {
      var needed = {};
      entry.rules.forEach(function (r) {
        (r.parameters || []).forEach(function (n) { needed[n] = true; });
      });
      parts.push('Needs a value for ' + Object.keys(needed).map(function (n) {
        return '{' + n + '}';
      }).join(', '));
    }
    if (rule.error) parts.push('Error: ' + rule.error);
    return parts.join('\n');
  }

  /* Counts are quoted in workbook rows everywhere, never in the variant-level
     rules the parser produces. "R-002" is one rule to the person who wrote the
     book and to the person choosing what to run; that it compiles into two
     patterns is an implementation detail, and letting it leak turns 33 rules
     into 48 in the status line and nowhere else. */

  function ruleCounts() {
    var rows = ruleRows();
    return {
      total: rows.length,
      selectable: rows.filter(function (e) { return e.executable; }).length,
      selected: rows.filter(function (e) { return e.selected; }).length
    };
  }

  /** How many rules are ticked, for the badges and the rail footer. */
  function selectedRuleCount() {
    return activeBook() ? ruleCounts().selected : 0;
  }

  function refreshFindings() {
    var book = activeBook();
    if (!book || book.kind !== 'mc') {
      state.findings = [];
      state.programs.forEach(function (p) { p.findings = []; });
      return;
    }
    state.programs.forEach(function (program) {
      var text = program.fixed != null ? program.fixed : program.original;
      program.findings = window.MigMcRules.scan(book, text, program.name, mcContextFor(program));
    });
    state.findings = window.MigMcRules.inventory(book, state.programs, {
      osFamily: state.osFamily,
      listDir: indexedListDir,
      tocCaseMap: state.tocCaseMap
    });
  }

  function allFindingsFor(program) {
    var rows = [];
    if (program && program.findings) rows = rows.concat(program.findings);
    rows = rows.concat(state.findings || []);
    return rows.filter(function (row) {
      return !program || !row.pgm_path ||
        row.pgm_path === (program.relPath || program.name) ||
        row.pgm_name === program.name ||
        row.line_num === 0;
    });
  }

  function renderFindings() {
    var program = current();
    var status = $('findingsStatus');
    var body = $('findingsGridBody');
    if (!status || !body) return;
    body.innerHTML = '';

    var book = activeBook();
    if (!book || book.kind !== 'mc') {
      status.className = 'strip-status';
      status.textContent = 'Findings are available when the MC pack is active.';
      body.innerHTML = '<tr><td class="grid-empty" colspan="7">Switch to MC pack to scan findings.</td></tr>';
      return;
    }

    var rows = allFindingsFor(program).sort(function (a, b) {
      var pathOrder = String(a.pgm_path || '').localeCompare(String(b.pgm_path || ''));
      if (pathOrder) return pathOrder;
      if ((a.line_num || 0) !== (b.line_num || 0)) return (a.line_num || 0) - (b.line_num || 0);
      return String(a.rule_id || '').localeCompare(String(b.rule_id || ''));
    });
    status.className = 'strip-status';
    status.textContent = rows.length
      ? plural(rows.length, 'finding') + ' in scope for ' + (program ? program.name : 'this folder')
      : 'No MC findings in scope.';
    if (!state.pathRoot) {
      status.textContent += ' F1/F2 are evaluated against the picked folder only.';
    }

    if (!rows.length) {
      body.innerHTML = '<tr><td class="grid-empty" colspan="7">No findings to show.</td></tr>';
      return;
    }

    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      [
        row.rule_id || '',
        row.rule_name || '',
        row.category || '',
        row.pgm_path || row.pgm_name || '',
        row.line_num || 0,
        row.criteria || '',
        row.line_text || ''
      ].forEach(function (value, index) {
        var td = document.createElement('td');
        td.className = index === 4 ? 'c-line cell-code' :
          index >= 5 ? 'cell-wrap' : (index === 0 ? 'c-id cell-code' : 'cell-wrap');
        td.textContent = String(value);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function downloadFindings() {
    refreshFindings();
    var rows = [];
    state.programs.forEach(function (program) {
      rows = rows.concat(program.findings || []);
    });
    rows = rows.concat(state.findings || []);
    if (!rows.length) {
      toast('No MC findings to download.', 'warn');
      return;
    }

    var S = window.MigExcel.STYLE;
    var detailRows = rows.filter(function (r) { return r.rule_id !== 'S7'; }).map(function (r) {
      return [r.category, r.rule_id, r.rule_name, r.rule_desc, r.criteria,
        r.pgm_name, r.pgm_path, r.line_num, r.line_text];
    });
    var ruleRowsOut = ((activeBook() && activeBook().rules) || []).map(function (r) {
      return [r.pack || '', r.category, r.id, r.name, r.description, r.axis || '', r.conditions || ''];
    });
    var summary = {};
    rows.forEach(function (r) {
      var key = (r.pgm_path || r.pgm_name || '') + '|' + r.rule_id;
      summary[key] = summary[key] || [r.pgm_path || r.pgm_name || '', r.rule_id, r.rule_name, 0];
      summary[key][3] += 1;
    });
    var updateRows = [];
    state.programs.forEach(function (program) {
      (program.hits || []).forEach(function (hit) {
        (hit.details || []).forEach(function (detail) {
          updateRows.push([hit.id, hit.updateDesc || hit.name || '', program.name, program.relPath || program.name,
            detail.fixedLine || detail.originalLine || '', detail.before || '', detail.after || '']);
        });
      });
    });
    var globTreatmentRows = [
      ['S7', 'Not evaluated - SASAUTOS is not visible to the browser. Run the CLI for S7.']
    ];
    var bytesOut = window.MigExcel.write([
      {
        name: 'Migration Check Details',
        columns: [
          { header: 'Category', width: 24 }, { header: 'Rule ID', width: 10 },
          { header: 'Rule Name', width: 34 }, { header: 'Rule Description', width: 52 },
          { header: 'Criteria', width: 52 }, { header: 'Program Name', width: 28 },
          { header: 'Program Path', width: 44 }, { header: 'Line Number', width: 12 },
          { header: 'Line Text', width: 64, style: S.MONO }
        ],
        rows: detailRows
      },
      {
        name: 'Global Macro Details',
        columns: [{ header: 'Rule ID', width: 10 }, { header: 'Details', width: 60 }],
        rows: globTreatmentRows
      },
      {
        name: 'Rules List',
        columns: [
          { header: 'Pack', width: 20 }, { header: 'Category', width: 24 }, { header: 'Rule ID', width: 10 },
          { header: 'Rule Name', width: 34 }, { header: 'Rule Description', width: 52 },
          { header: 'MC Special Rule', width: 24 }, { header: 'Criteria', width: 52 }
        ],
        rows: ruleRowsOut
      },
      {
        name: 'Migration Check Summary',
        columns: [
          { header: 'Program Path', width: 44 }, { header: 'Rule ID', width: 10 },
          { header: 'Rule Name', width: 34 }, { header: 'Findings', width: 10 }
        ],
        rows: Object.keys(summary).sort().map(function (key) { return summary[key]; })
      },
      {
        name: 'Update Details',
        columns: [
          { header: 'Rule ID', width: 10 }, { header: 'Update Description', width: 34 },
          { header: 'Program Name', width: 28 }, { header: 'Program Path', width: 44 },
          { header: 'Line Number', width: 12 }, { header: 'Original Text', width: 52 },
          { header: 'Updated Text', width: 52 }
        ],
        rows: updateRows
      },
      {
        name: 'Report Information',
        columns: [{ header: 'Field', width: 28 }, { header: 'Value', width: 56 }],
        rows: [
          ['Rule source', activeBookName(activeBook())],
          ['OS family', state.osFamily],
          ['Path root', state.pathRoot || '(picked folder only)'],
          ['Programs scanned', state.programs.length],
          ['Generated', new Date().toISOString()]
        ]
      }
    ]);
    download(new Blob([bytesOut], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), 'MC_Migration_Findings_' + timestampYYYYMMDDHHMM() + '.xlsx');
    toast('MC findings workbook downloaded.');
  }


  /* -- Fixed SAS tab ------------------------------------------------------ */

  function renderFixed() {
    var program = current();
    var status = $('fixedStatus');
    var code = $('fixedCode');

    if (!program) {
      $('fixedPath').textContent = '—';
      status.className = 'strip-status';
      status.textContent = 'No program selected.';
      code.innerHTML = '';
      return;
    }

    $('fixedPath').textContent = (state.folderName ? state.folderName + '/' : '') +
      program.name;

    if (program.fixed == null) {
      status.className = 'strip-status warn';
      status.textContent = 'No fix applied yet — showing the original program. ' +
        'Press Apply Fix to run the rule book.';
      code.innerHTML = window.MigDiff.colour(program.original);
    } else {
      status.className = 'strip-status';
      status.textContent = plural(program.fixCount, 'update') + ' from ' +
        plural(program.hits.length, 'rule') + ' · ' +
        plural(window.MigDiff.splitLines(program.fixed).length, 'line');
      code.innerHTML = window.MigDiff.colour(program.fixed);
    }

    /* Line numbers wider than the default gutter need the class that widens
       it, or the code sits on top of them. */
    var lines = window.MigDiff.splitLines(program.fixed != null
      ? program.fixed : program.original).length;
    var view = $('fixedCodeView');
    view.classList.toggle('is-mega-lines', lines >= 10000);
    view.style.setProperty('--sas-line-digits', String(lines).length);
  }

  /* -- Fix Compare tab ---------------------------------------------------- */

  function setCompareMessage(message, level) {
    var status = $('compareStatus');
    status.className = 'strip-status cmp-status' + (level ? ' ' + level : '');
    $('btnPrevModified').hidden = true;
    $('btnNextModified').hidden = true;
    $('cmpModifiedLabel').textContent = '';
    $('cmpOtherCounts').textContent = message || '';
  }

  function renderCompare() {
    var program = current();
    var status = $('compareStatus');
    var left = $('cmpLeft');
    var right = $('cmpRight');
    var picker = $('cmpVersion');

    if (!program) {
      $('comparePath').textContent = '—';
      setCompareMessage('No program selected.');
      left.innerHTML = '';
      right.innerHTML = '';
      $('cmpCounts').textContent = '';
      picker.innerHTML = '';
      return;
    }

    $('comparePath').textContent = program.name;

    /* What the right-hand pane shows: the current fixed copy by default, or
       any recorded version. The left pane is always the original as read from
       disk — the question this tab answers is "what did the fix do to my
       program", and that has one fixed reference point. */
    var options = [{ id: 'current', label: 'Current fixed copy' }].concat(
      program.versions.map(function (v) {
        return { id: v.id, label: v.id + ' · ' + ago(v.at) };
      }));
    var chosen = picker.value || 'current';
    picker.innerHTML = options.map(function (o) {
      return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>';
    }).join('');
    picker.value = options.some(function (o) { return o.id === chosen; })
      ? chosen : 'current';

    var rightText = program.fixed;
    var rightTag = 'current';
    var version = null;
    if (picker.value !== 'current') {
      version = program.versions.filter(function (v) {
        return v.id === picker.value;
      })[0];
      if (version && typeof version.text === 'string') {
        rightText = version.text;
        rightTag = version.id;
      }
    }

    if (rightText == null) {
      setCompareMessage('No fix applied yet — there is nothing to compare ' +
        'the original against.', 'warn');
      left.innerHTML = window.MigDiff.colour(program.original != null
        ? program.original : program.fixed);
      right.innerHTML = '';
      $('cmpLeftTag').textContent = 'as read';
      $('cmpRightTag').textContent = '—';
      $('cmpCounts').textContent = '';
      return;
    }

    var leftText = program.original != null ? program.original : (program.fixed || '');
    var rows = window.MigDiff.align(leftText, rightText);
    var hitsForRight = picker.value === 'current'
      ? program.hits : ((version && version.hits) || []);
    var stat = detailStats(hitsForRight);
    var changesOnly = $('cmpChangesOnly').checked;
    if (changesOnly) rows = contextOnly(rows, 3);

    status.className = 'strip-status cmp-status';
    $('cmpOtherCounts').textContent =
      '· ' + stat.added + ' added · ' + stat.removed + ' deleted';
    var key = [program.name, picker.value, changesOnly, stat.changed,
               program.fixCount].join('|');
    if (key !== compareKey) {
      compareKey = key;
      compareCursor = -1;
    }
    $('btnPrevModified').hidden = stat.changed < 2;
    $('btnNextModified').hidden = stat.changed < 2;
    $('cmpLeftTag').textContent = 'as read';
    $('cmpRightTag').textContent = rightTag;
    $('cmpCounts').textContent =
      plural(program.fixCount, 'update') + ' from ' +
      plural(program.hits.length, 'rule');

    var digits = String(Math.max(
      window.MigDiff.splitLines(leftText).length,
      window.MigDiff.splitLines(rightText).length)).length;

    left.innerHTML = paneHtml(rows, 'left', digits);
    right.innerHTML = paneHtml(rows, 'right', digits);
    syncScroll($('cmpLeftView'), $('cmpRightView'));
    markCurrentModified();
    updateModifiedLabel(stat.changed);
  }

  /** Keep changed rows plus `pad` lines of context either side. */
  function contextOnly(rows, pad) {
    var keep = new Array(rows.length);
    rows.forEach(function (row, i) {
      if (row.kind === 'same') return;
      for (var j = Math.max(0, i - pad); j <= Math.min(rows.length - 1, i + pad); j++) {
        keep[j] = true;
      }
    });
    var out = [];
    var skipping = false;
    rows.forEach(function (row, i) {
      if (keep[i]) { out.push(row); skipping = false; }
      else if (!skipping) {
        out.push({ kind: 'gap', left: null, right: null,
                   leftNo: null, rightNo: null });
        skipping = true;
      }
    });
    return out;
  }

  function paneHtml(rows, side, digits) {
    var pad = window.MigDiff.pad;
    return rows.map(function (row) {
      if (row.kind === 'gap') {
        return '<span class="dl-row is-gap">' +
               '<span class="diff-mark" aria-hidden="true"></span>' +
               '<span class="ln">' + pad('⋯', digits) + '</span></span>';
      }

      var text = side === 'left' ? row.left : row.right;
      var no = side === 'left' ? row.leftNo : row.rightNo;
      var cls = 'dl-row';
      var mark = '';

      /* Fix Compare follows the familiar source-control convention: a changed
         line is the old/deleted line on the Original side and the new/added
         line on the Fixed side. True one-sided additions/deletions keep an
         empty filler row opposite them so line alignment is preserved. */
      if (row.kind === 'change') {
        if (side === 'left') {
          cls += ' is-del is-modified';
          mark = '−';
        } else {
          cls += ' is-add is-modified';
          mark = '+';
        }
      } else if (row.kind === 'del') {
        if (side === 'left') {
          cls += ' is-del';
          mark = '−';
        } else {
          cls += ' is-gap';
        }
      } else if (row.kind === 'add') {
        if (side === 'left') {
          cls += ' is-gap';
        } else {
          cls += ' is-add';
          mark = '+';
        }
      }

      var marker = '<span class="diff-mark" aria-hidden="true">' + mark + '</span>';
      var gutter = '<span class="ln">' + (no == null ? pad('', digits)
        : pad(no, digits)) + '</span>';

      var payload = '';
      if (text != null) {
        if (row.kind === 'change' && typeof window.MigDiff.wordDiff === 'function') {
          var words = window.MigDiff.wordDiff(row.left, row.right);
          payload = side === 'left' ? words.leftHtml : words.rightHtml;
        } else {
          payload = window.MigDiff.colourLine(text);
        }
      }

      return '<span class="' + cls + '">' + marker + gutter + payload + '</span>';
    /* No newline between rows: each row is display:block and supplies its own
       line break. Joining with one too would double-space the whole pane and
       throw the two sides out of step with each other. */
    }).join('');
  }

  /* The two panes are the same number of screen rows by construction, so
     mirroring scrollTop keeps a change on the same line in both. */
  var scrollBound = false;
  var compareCursor = -1;
  var compareKey = '';

  function syncScroll(a, b) {
    if (scrollBound) return;
    scrollBound = true;
    var lock = false;
    function mirror(from, to) {
      return function () {
        if (lock) return;
        lock = true;
        to.scrollTop = from.scrollTop;
        to.scrollLeft = from.scrollLeft;
        window.requestAnimationFrame(function () { lock = false; });
      };
    }
    a.addEventListener('scroll', mirror(a, b));
    b.addEventListener('scroll', mirror(b, a));
  }

  function modifiedRows(paneId) {
    return Array.prototype.slice.call(
      document.querySelectorAll('#' + paneId + ' .dl-row.is-modified'));
  }

  function updateModifiedLabel(total) {
    var label = $('cmpModifiedLabel');
    if (!label) return;
    var text = (compareCursor >= 0 && total > 1)
      ? (compareCursor + 1) + ' of ' + total + ' modified'
      : total + ' modified';

    /* Single modification: no Prev/Next buttons, so the count itself is the
       way to get there. Only offer the link if a rendered row actually
       exists; stat.changed comes from rule details, not the diff. */
    var canJump = total === 1 && modifiedRows('cmpRight').length > 0;
    var link = label.querySelector('.cmp-jump-link');

    if (canJump) {
      if (link) {
        link.textContent = text;
      } else {
        label.innerHTML = '<button type="button" class="cmp-jump-link" ' +
          'title="Scroll to the modified line">' + esc(text) + '</button>';
      }
    } else {
      label.textContent = text;
    }
  }

  function markCurrentModified() {
    var right = modifiedRows('cmpRight');
    var left = modifiedRows('cmpLeft');
    right.concat(left).forEach(function (row) {
      row.classList.remove('is-current');
    });
    if (compareCursor < 0 || compareCursor >= right.length) return;
    if (right[compareCursor]) right[compareCursor].classList.add('is-current');
    if (left[compareCursor]) left[compareCursor].classList.add('is-current');
  }

  function centreInView(view, row) {
    var viewRect = view.getBoundingClientRect();
    var rowRect = row.getBoundingClientRect();
    var delta = (rowRect.top - viewRect.top) -
                (view.clientHeight - rowRect.height) / 2;
    var smooth = !window.matchMedia ||
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    view.scrollTo({
      top: Math.max(0, view.scrollTop + delta),
      behavior: smooth ? 'smooth' : 'auto'
    });
  }

  function jumpToModified(step) {
    var rows = modifiedRows('cmpRight');
    if (!rows.length) return;
    compareCursor = compareCursor < 0
      ? (step > 0 ? 0 : rows.length - 1)
      : (compareCursor + step + rows.length) % rows.length;
    markCurrentModified();
    updateModifiedLabel(rows.length);
    centreInView($('cmpRightView'), rows[compareCursor]);
  }

  /* -- History tab -------------------------------------------------------- */

  function mergeRuns(fileRuns, localRuns) {
    var out = [];
    var seen = {};
    (fileRuns || []).forEach(function (run) {
      if (!run || !run.runId || seen[run.runId]) return;
      seen[run.runId] = true;
      out.push(Object.assign({}, run, { local: false }));
    });
    (localRuns || []).forEach(function (run) {
      if (!run || !run.runId || seen[run.runId]) return;
      seen[run.runId] = true;
      out.push(Object.assign({}, run, { local: true }));
    });
    out.sort(function (a, b) {
      return String(b.appliedAt || '').localeCompare(String(a.appliedAt || ''));
    });
    return out;
  }

  function loadRunHistory() {
    var local = readLocalRuns();
    if (!window.location.protocol.match(/^https?:$/)) {
      return Promise.resolve({ runs: mergeRuns([], local), error: '' });
    }
    return fetch('history.json?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (response.status === 404) return { runs: [] };
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (book) {
        return { runs: mergeRuns((book && book.runs) || [], local), error: '' };
      })
      .catch(function () {
        return {
          runs: mergeRuns([], local),
          error: 'history.json could not be read. Showing browser-only runs.'
        };
      });
  }

  function setHistorySubtab(name) {
    state.historySubtab = name || 'runs';
    Array.prototype.forEach.call(
      document.querySelectorAll('#historySubTabs .seg-btn'), function (button) {
        var on = button.dataset.subtab === state.historySubtab;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    Array.prototype.forEach.call(
      document.querySelectorAll('.history-sub'), function (panel) {
        panel.hidden = panel.dataset.subtab !== state.historySubtab;
      });
  }

  function renderRunHistory() {
    if (state.tab !== 'history') return;
    setHistorySubtab(state.historySubtab || 'runs');
    if (state.historySubtab !== 'runs') return;
    var panel = $('runHistoryPanel');
    var token = ++state.runHistoryToken;
    state.runHistoryLoading = true;
    $('runHistoryStatus').textContent = 'Loading migration history...';
    panel.innerHTML = '<div class="history-empty">Loading migration history...</div>';
    loadRunHistory().then(function (result) {
      if (token !== state.runHistoryToken) return;
      state.runHistoryLoading = false;
      state.runHistory = result.runs || [];
      state.runHistoryError = result.error || '';
      renderRunHistoryLoaded();
    });
  }

  function renderRunHistoryLoaded() {
    var panel = $('runHistoryPanel');
    var status = $('runHistoryStatus');
    var runs = state.runHistory || [];
    syncHistoryUserOptions(runs);
    syncHistoryFolderOptions(runs);
    if (state.runHistoryError) {
      status.textContent = state.runHistoryError;
    } else {
      status.textContent = (runs.length
        ? plural(runs.length, 'Apply Fix run') : 'No migration history yet') +
        ' · ' + identityLabel();
    }
    if (!runs.length) {
      panel.innerHTML =
        '<div class="history-empty">' +
        (state.runHistoryError
          ? esc(state.runHistoryError)
          : 'No fixes have been applied yet. Every Apply Fix records a run here.') +
        '</div>';
      return;
    }

    var filtered = filterRunHistory(runs);
    var model = aggregateRunHistory(filtered);
    if (!model.runs.length) {
      panel.innerHTML = '<div class="history-empty">' +
        esc(emptyRunHistoryMessage(runs.length)) + '</div>';
      return;
    }
    panel.innerHTML = dashboardHtml(model);
    renderFolderGroups(panel.querySelector('.history-folder-groups'), model);
    applyHistoryProgramSearch();
  }

  /* The card label is the folder the run was applied to - the same value the
     run chart puts on its x axis. program.folder is the program's sub-path
     inside that folder and is '(root)' whenever programs sit directly in the
     picked folder, so it cannot carry the card label. */
  function historyFolderName(run, program) {
    var named = String((run && run.rootFolder) || '').trim();
    if (named) return named;
    var listed = ((run && run.folders) || []).filter(function (value) {
      return value && value !== '(root)';
    });
    if (listed.length) return listed.join(', ');
    var sub = program && program.folder;
    return (sub && sub !== '(root)') ? sub : '(root)';
  }

  function filterRunHistory(runs) {
    var query = String($('runHistorySearch').value || '').trim().toLowerCase();
    var folder = $('runHistoryFolder').value || '';
    var userFilter = historyControlValue('runHistoryUser', '@me');
    var me = String(state.identity.userKey || '');
    return (runs || []).filter(function (run) {
      if (userFilter === '') return true;
      var key = userKeyOf(run);
      if (userFilter === '@me') return !!me && key === me;
      if (userFilter === '@none') return !key;
      return key === userFilter;
    }).map(function (run) {
      var programs = (run.programs || []).map(function (program) {
        var name = String(program.name || '');
        var historyFolder = historyFolderName(run, program);
        var details = (program.details || []).filter(function (detail) {
          if (!query) return true;
          return (name + ' ' + detail.ruleId + ' ' + detail.ruleName)
            .toLowerCase().indexOf(query) !== -1;
        });
        var programMatches = !query || name.toLowerCase().indexOf(query) !== -1 ||
          (program.rules || []).join(' ').toLowerCase().indexOf(query) !== -1;
        if (query && !programMatches && !details.length) return null;
        if (folder && historyFolder !== folder) return null;
        return Object.assign({}, program, {
          details: query && !programMatches ? details : (program.details || [])
        });
      }).filter(Boolean);
      if (!programs.length) return null;
      var targeted = (run.targetedPrograms || []).filter(function (program) {
        if (folder && historyFolderName(run, program) !== folder) return false;
        if (!query) return true;
        return String(program.name || '').toLowerCase().indexOf(query) !== -1 ||
          programs.some(function (updated) { return updated.name === program.name; });
      });
      return Object.assign({}, run, {
        programs: programs,
        targetedPrograms: targeted
      });
    }).filter(Boolean);
  }

  function emptyRunHistoryMessage(total) {
    var userFilter = historyControlValue('runHistoryUser', '@me');
    if (userFilter === '@me') {
      return 'No runs recorded for ' + identityLabel() + ' yet. ' +
        plural(total, 'run') + ' from other users or from before user tracking ' +
        'are hidden by the current filter - switch to All users to see them.';
    }
    if (userFilter === '@none') {
      return 'No unattributed runs match the current filters.';
    }
    if (userFilter) {
      return 'No runs recorded for ' + selectedHistoryUserLabel() +
        ' match the current filters.';
    }
    return 'No history row matches those filters.';
  }

  function syncHistoryUserOptions(runs) {
    var select = $('runHistoryUser');
    if (!select) return;
    var current = select.value;
    if (current == null) current = '@me';
    var users = {};
    var unattributed = false;
    (runs || []).forEach(function (run) {
      var key = userKeyOf(run);
      if (!key) {
        unattributed = true;
        return;
      }
      if (!users[key]) users[key] = displayUser(run.user);
    });
    var values = Object.keys(users).sort(function (a, b) {
      return String(users[a]).localeCompare(String(users[b]));
    });
    select.innerHTML =
      '<option value="@me">My runs</option>' +
      '<option value="">All users</option>' +
      values.map(function (key) {
        return '<option value="' + esc(key) + '">' + esc(users[key]) + '</option>';
      }).join('') +
      (unattributed ? '<option value="@none">(unattributed)</option>' : '');
    var allowed = ['@me', ''].concat(values);
    if (unattributed) allowed.push('@none');
    select.value = allowed.indexOf(current) !== -1 ? current : '@me';
  }

  function syncHistoryFolderOptions(runs) {
    var select = $('runHistoryFolder');
    var current = select.value || '';
    var folders = {};
    (runs || []).forEach(function (run) {
      var programs = run.programs || [];
      if (!programs.length) {
        folders[historyFolderName(run, null)] = true;
        return;
      }
      programs.forEach(function (program) {
        folders[historyFolderName(run, program)] = true;
      });
    });
    var values = Object.keys(folders).sort();
    select.innerHTML = '<option value="">All folders</option>' +
      values.map(function (folder) {
        return '<option value="' + esc(folder) + '">' + esc(folder) + '</option>';
      }).join('');
    select.value = values.indexOf(current) !== -1 ? current : '';
  }

  function aggregateRunHistory(runs) {
    var byFolder = {};
    var allPrograms = {};
    var allTargeted = {};
    var allRuns = {};
    var byRule = {};
    var totals = {
      applications: 0, lines: 0, added: 0, modified: 0, deleted: 0
    };

    function folderModel(folder) {
      if (!byFolder[folder]) {
        byFolder[folder] = {
          folder: folder,
          runs: 0,
          programs: {},
          updatedPrograms: {},
          applications: 0,
          lines: 0,
          added: 0,
          modified: 0,
          deleted: 0,
          runIds: {},
          byRule: {},
          byProgram: {},
          firstAt: '',
          lastAt: '',
          users: {}
        };
      }
      return byFolder[folder];
    }

    (runs || []).forEach(function (run) {
      var user = displayUser(run.user);
      ((run.targetedPrograms && run.targetedPrograms.length)
        ? run.targetedPrograms : (run.programs || [])).forEach(function (program) {
        var f = folderModel(historyFolderName(run, program));
        f.programs[program.name] = true;
        allTargeted[program.name] = true;
      });
      (run.programs || []).forEach(function (program) {
        var folder = historyFolderName(run, program);
        var f = folderModel(folder);
        f.runIds[run.runId] = true;
        f.updatedPrograms[program.name] = true;
        f.applications += program.applications || 0;
        f.lines += program.lines || 0;
        f.users[user] = true;
        if (!f.lastAt || String(run.appliedAt) > f.lastAt) f.lastAt = run.appliedAt;
        if (!f.firstAt || String(run.appliedAt) < f.firstAt) f.firstAt = run.appliedAt;
        allPrograms[program.name] = true;
        totals.applications += program.applications || 0;
        totals.lines += program.lines || 0;
        var runItem = runBucket(allRuns, run);
        runItem.applications += program.applications || 0;
        runItem.programs[program.name] = true;

        var p = f.byProgram[program.name] || {
          name: program.name,
          subfolder: (program.folder && program.folder !== '(root)') ? program.folder : '',
          applications: 0,
          lines: 0,
          rules: {},
          details: []
        };
        p.applications += program.applications || 0;
        p.lines += program.lines || 0;
        (program.rules || []).forEach(function (id) { p.rules[id] = true; });

        (program.details || []).forEach(function (detail) {
          var enriched = Object.assign({}, detail, {
            program: program.name,
            runId: run.runId,
            runLabel: (run.appliedAtLocal || run.appliedAt || '') + ' · ' + user,
            userId: (run.user && run.user.id) || '',
            userKey: userKeyOf(run),
            userSource: (run.user && run.user.source) || '',
            local: !!run.local
          });
          p.details.push(enriched);
          if (detail.type === 'Added') { f.added++; totals.added++; }
          else if (detail.type === 'Deleted') { f.deleted++; totals.deleted++; }
          else { f.modified++; totals.modified++; }
          var id = detail.ruleId || '';
          var rule = byRule[id] || {
            id: id,
            name: detail.ruleName || '',
            category: detail.category || '',
            severity: detail.severity || '',
            applications: 0,
            lines: 0,
            programs: {}
          };
          rule.lines++;
          rule.programs[program.name] = true;
          byRule[id] = rule;
          var fr = f.byRule[id] || Object.assign({}, rule, {
            applications: 0,
            lines: 0,
            programs: {}
          });
          fr.lines++;
          fr.programs[program.name] = true;
          f.byRule[id] = fr;
        });

        Object.keys(program.ruleCounts || {}).forEach(function (id) {
          var count = program.ruleCounts[id] || 0;
          var meta = (program.ruleMeta && program.ruleMeta[id]) || {};
          if (!byRule[id]) {
            byRule[id] = { id: id, name: meta.name || '', category: meta.category || '',
              severity: meta.severity || '',
              applications: 0, lines: 0, programs: {} };
          }
          if (!byRule[id].name && meta.name) byRule[id].name = meta.name;
          if (!byRule[id].category && meta.category) byRule[id].category = meta.category;
          if (!byRule[id].severity && meta.severity) byRule[id].severity = meta.severity;
          byRule[id].applications += count;
          byRule[id].programs[program.name] = true;
          if (!f.byRule[id]) {
            f.byRule[id] = { id: id, name: byRule[id].name, category: byRule[id].category,
              severity: byRule[id].severity, applications: 0, lines: 0, programs: {} };
          }
          f.byRule[id].applications += count;
          f.byRule[id].programs[program.name] = true;
        });

        f.byProgram[program.name] = p;
      });
    });

    var folders = Object.keys(byFolder).map(function (key) {
      var folder = byFolder[key];
      folder.runs = Object.keys(folder.runIds).length;
      return folder;
    })
      .sort(function (a, b) {
        return String(b.lastAt || '').localeCompare(String(a.lastAt || ''));
      });
    var rules = Object.keys(byRule).map(function (key) {
      var rule = byRule[key];
      return Object.assign({}, rule, {
        programs: Object.keys(rule.programs).length
      });
    }).sort(function (a, b) { return b.applications - a.applications; });

    return {
      runs: runs || [],
      folders: folders,
      rules: rules,
      totals: totals,
      folderCount: folders.length,
      programCount: Object.keys(allPrograms).length,
      targetedCount: Object.keys(allTargeted).length,
      byRun: allRuns,
      latest: (runs || [])[0] || null
    };
  }

  function runBucket(store, run) {
    var id = run.runId || run.appliedAt || 'run';
    var entry = store[id];
    if (!entry) {
      entry = {
        runId: id,
        at: run.appliedAt || '',
        atLocal: run.appliedAtLocal || run.appliedAt || '',
        folder: run.rootFolder || (run.folders || []).join(', ') || '(root)',
        applications: 0,
        programs: {}
      };
      store[id] = entry;
    }
    return entry;
  }

  function displayUser(user) {
    if (!user) return '(unattributed)';
    if (user.name) return user.name;
    if (user.id) return user.id;
    return '(unattributed)';
  }

  function userKeyOf(run) {
    var user = (run && run.user) || {};
    return String(user.key || user.id || '').toLowerCase();
  }

  function identityLabel(identity) {
    var who = identity || state.identity || {};
    if (who.source === 'device') return 'this browser (unidentified user)';
    return who.userId || '(unattributed)';
  }

  function historyControlValue(id, fallback) {
    var el = $(id);
    if (!el) return fallback || '';
    var value = el.value;
    return value == null ? (fallback || '') : value;
  }

  function selectedHistoryUserLabel() {
    var select = $('runHistoryUser');
    if (!select) return identityLabel();
    var value = select.value || '@me';
    if (value === '@me') return identityLabel();
    if (value === '') return 'All users';
    if (value === '@none') return '(unattributed)';
    return select.options && select.selectedIndex >= 0
      ? select.options[select.selectedIndex].text : value;
  }

  function renderIdentityChip() {
    if (state.tab === 'history' && state.historySubtab === 'runs') {
      renderRunHistoryLoaded();
    }
  }

  function dashboardHtml(model) {
    var latest = model.latest;
    var latestText = latest
      ? 'Latest run: ' + esc(latest.appliedAtLocal || latest.appliedAt || '') +
        ' by ' + esc(displayUser(latest.user)) +
        (latest.local ? ' <span class="run-chip">local</span>' : '')
      : '';
    var avg = model.folderCount
      ? (model.totals.applications / model.folderCount) : 0;
    return '<div class="dash">' +
      overallRowHtml(model, avg) +
      '<div class="history-asof">' + latestText + '</div>' +
      '<div class="folder-rows">' +
        model.folders.map(function (folder) {
          return folderRowHtml(folder);
        }).join('') +
      '</div>' +
      ruleBarsHtml(model.rules) +
      '<div class="strip history-list-search">' +
        '<input type="search" id="historyProgramSearch" class="mini-search" ' +
          'value="' + attr(state.historyProgramQuery || '') + '" ' +
          'placeholder="Search programs…" ' +
          'title="Type part of a program or folder name (adsl), or both (adam ae). ' +
            'End a term with / to match a folder exactly." ' +
          'aria-label="Search programs in migration history" ' +
          'aria-controls="historyProgramGroups">' +
        '<span class="mono strip-path" id="historyProgramSearchCount" ' +
          'aria-live="polite"></span>' +
      '</div>' +
      '<div class="fgroups history-folder-groups" id="historyProgramGroups"></div>' +
    '</div>';
  }

  /* The overall row pairs the single run trend with the stat cards. Folder
     rows are cards only - there is one chart in the view, not one per folder. */
  function dashRow(chart, cards, title) {
    return '<section class="dash-row">' +
      (title ? '<h4 class="dash-row-title">' + esc(title) + '</h4>' : '') +
      '<div class="dash-row-body' + (chart ? '' : ' dash-row-solo') + '">' +
        (chart ? '<article class="chart-card">' + chart + '</article>' : '') +
        '<div class="kpi-row">' + cards + '</div>' +
      '</div>' +
    '</section>';
  }

  function overallRowHtml(model, avg) {
    var updated = model.programCount;
    var targeted = model.targetedCount || updated;
    var cards =
      kpi(avg.toFixed(1), 'Avg fixes per folder') +
      kpi(model.folderCount, 'Folders touched') +
      kpi(updated + '/' + targeted, 'Programs updated') +
      kpi(model.totals.applications, 'Total fixes applied') +
      kpi(model.runs.length, 'Apply Fix runs');
    return dashRow(runChart(historySeries(model.byRun)), cards, '');
  }

  function folderRowHtml(folder) {
    var targeted = Object.keys(folder.programs).length;
    var updated = Object.keys(folder.updatedPrograms || folder.programs).length;
    var cards =
      kpi(updated + '/' + targeted, 'Programs updated') +
      kpi(folder.applications, 'Fixes applied') +
      kpi(folder.lines, 'Lines changed') +
      kpi(folder.runs, 'Apply Fix runs') +
      kpi(folder.lastAt ? shortStamp(folder.lastAt) : '--', 'Last run');
    return dashRow('', cards, folder.folder);
  }

  function shortStamp(iso) {
    var text = String(iso || '');
    return text.length >= 10 ? text.slice(0, 10) : text;
  }

  function kpi(value, label) {
    return '<div class="kpi-card"><div class="kpi-value mono">' + esc(value) +
      '</div><div class="kpi-label">' + esc(label) + '</div></div>';
  }

  /* Ordered run points with running totals: cumulative distinct programs
     updated, cumulative fixes applied, and the folder each run was applied to. */
  function historySeries(byRun) {
    var seen = {};
    var fixes = 0;
    return Object.keys(byRun || {}).map(function (id) { return byRun[id]; })
      .sort(function (a, b) {
        return String(a.at).localeCompare(String(b.at)) ||
          String(a.runId).localeCompare(String(b.runId));
      })
      .map(function (entry, index) {
        fixes += entry.applications || 0;
        Object.keys(entry.programs).forEach(function (key) { seen[key] = true; });
        return {
          index: index + 1,
          runId: entry.runId,
          at: entry.atLocal || entry.at || '',
          folder: entry.folder || '(root)',
          programs: Object.keys(seen).length,
          fixes: fixes
        };
      });
  }

  function niceMax(value) {
    if (value <= 6) return 6;
    var step = Math.max(2,
      2 * Math.pow(10, Math.floor(Math.log(value) / Math.LN10) - 1));
    return Math.ceil(value / step) * step;
  }

  function clipLabel(text, maxChars) {
    var value = String(text || '');
    return value.length <= maxChars ? value
      : value.slice(0, Math.max(1, maxChars - 1)) + '\u2026';
  }

  /* Hand-drawn SVG so the dashboard keeps working offline and under file://.
     One chart for the whole view: two cumulative lines on a shared y axis,
     one point per Apply Fix run, each labelled with the folder that run was
     applied to. Nothing is drawn until a second run exists. */
  var CHART_LEFT = 40;
  var CHART_RIGHT = 330;
  var CHART_TOP = 12;
  var CHART_BOTTOM = 108;

  function runChart(points) {
    if (!points || points.length < 2) return '';
    var max = niceMax(points.reduce(function (top, point) {
      return Math.max(top, point.programs, point.fixes);
    }, 0));
    var span = points.length - 1;
    var x = function (index) {
      return CHART_LEFT + (index / span) * (CHART_RIGHT - CHART_LEFT);
    };
    var y = function (value) {
      return CHART_BOTTOM - (value / max) * (CHART_BOTTOM - CHART_TOP);
    };
    var line = function (key) {
      return points.map(function (point, index) {
        return x(index).toFixed(1) + ',' + y(point[key]).toFixed(1);
      }).join(' ');
    };
    var dots = function (key, cls) {
      return points.map(function (point, index) {
        return '<circle class="' + cls + '" cx="' + x(index).toFixed(1) +
          '" cy="' + y(point[key]).toFixed(1) + '" r="2.8">' +
          '<title>' + esc(point.folder + ' · ' + point.at + ' · ' +
            String(point[key]) + ' ' +
            (key === 'fixes' ? 'fixes' : 'programs') + ' so far') +
          '</title></circle>';
      }).join('');
    };
    var grid = [0, 0.5, 1].map(function (step) {
      var value = max * step;
      var at = y(value).toFixed(1);
      return '<line class="chart-grid" x1="' + CHART_LEFT + '" y1="' + at +
        '" x2="' + CHART_RIGHT + '" y2="' + at + '"></line>' +
        '<text class="chart-tick" x="' + (CHART_LEFT - 6) + '" y="' +
        (Number(at) + 3.5).toFixed(1) + '" text-anchor="end">' +
        esc(String(Math.round(value))) + '</text>';
    }).join('');
    var slot = (CHART_RIGHT - CHART_LEFT) / span;
    var maxChars = Math.max(3, Math.floor(slot / 5.6));
    var ticks = points.map(function (point, index) {
      if (index && point.folder === points[index - 1].folder) return '';
      var anchor = index === 0 ? 'start'
        : (index === span ? 'end' : 'middle');
      var at = index === 0 ? CHART_LEFT
        : (index === span ? CHART_RIGHT : x(index));
      return '<text class="chart-tick chart-folder" x="' + Number(at).toFixed(1) +
        '" y="' + (CHART_BOTTOM + 16) + '" text-anchor="' + anchor + '">' +
        esc(clipLabel(point.folder, maxChars)) + '</text>';
    }).join('');
    var last = points[points.length - 1];
    var summary = 'Across ' + points.length + ' Apply Fix runs: ' +
      last.programs + ' programs updated and ' + last.fixes + ' fixes applied';
    return '<div class="chart-legend">' +
        '<span class="chart-key chart-key-programs">Programs updated</span>' +
        '<span class="chart-key chart-key-fixes">Total fixes applied</span>' +
      '</div>' +
      '<svg class="run-chart" viewBox="0 0 340 132" role="img" aria-label="' +
        esc(summary) + '">' +
        '<title>' + esc(summary) + '</title>' +
        grid +
        '<polyline class="chart-line chart-line-programs" points="' +
          line('programs') + '"></polyline>' +
        '<polyline class="chart-line chart-line-fixes" points="' +
          line('fixes') + '"></polyline>' +
        dots('programs', 'chart-dot chart-dot-programs') +
        dots('fixes', 'chart-dot chart-dot-fixes') +
        ticks +
      '</svg>';
  }

  function ruleBarsHtml(rules) {
    var shown = rules.slice(0, 12);
    var max = shown.reduce(function (m, rule) {
      return Math.max(m, rule.applications || 0);
    }, 1);
    return '<div class="rule-bars"><h3>Rule applications</h3>' +
      shown.map(function (rule) {
        var count = rule.applications || 0;
        var width = Math.round((count / max) * 100);
        return '<div class="rule-bar-row">' +
          '<span class="mono rule-id">' + esc(rule.id || '') + '</span>' +
          '<span class="rule-name">' + esc(rule.name || 'Rule ' + rule.id) + '</span>' +
          '<span class="rule-bar-track" role="progressbar" aria-valuemin="0" ' +
            'aria-valuemax="' + max + '" aria-valuenow="' + count + '" aria-label="' +
            esc((rule.id || 'Rule') + ' applications') + '">' +
            '<span class="rule-bar-fill ' + riskClass(rule.severity) +
              '" style="width:' + width + '%"></span>' +
          '</span>' +
          '<span class="mono rule-count">' + count + '</span>' +
        '</div>';
      }).join('') +
      (rules.length > 12 ? '<div class="history-asof">' +
        esc(rules.length - 12) + ' more rules hidden by default.</div>' : '') +
    '</div>';
  }

  function riskClass(severity) {
    var s = String(severity || '').toLowerCase();
    if (s.indexOf('high') !== -1) return 'risk-high';
    if (s.indexOf('medium') !== -1) return 'risk-medium';
    if (s.indexOf('low') !== -1) return 'risk-low';
    return 'risk-unknown';
  }

  function renderFolderGroups(container, model) {
    var fragment = document.createDocumentFragment();
    model.folders.forEach(function (folder, index) {
      var section = document.createElement('div');
      section.className = 'history-folder-section';
      section.dataset.folder = folder.folder;
      historyFolderCardPlan(folder).forEach(function (card) {
        if (card.kind === 'summary') {
          section.appendChild(folderSummaryGroup(folder, index === 0));
        } else {
          section.appendChild(programHistoryGroup(folder.byProgram[card.program],
            folder.folder));
        }
      });
      fragment.appendChild(section);
    });
    container.appendChild(fragment);
  }

  function applyHistoryProgramSearch() {
    var groups = document.querySelector('#runHistoryPanel .history-folder-groups');
    if (!groups) return;

    var input = $('historyProgramSearch');
    var count = $('historyProgramSearchCount');
    var query = normalizeQuery(input && input.value);
    state.historyProgramQuery = query;

    var shown = 0;
    var total = 0;

    Array.prototype.forEach.call(
      groups.querySelectorAll('.history-folder-section'), function (section) {
        var visible = 0;

        Array.prototype.forEach.call(
          section.querySelectorAll('.history-program'), function (card) {
            var hit = matchesQuery(card.dataset.programHay || '', query);
            card.hidden = !hit;
            total += 1;
            if (hit) { visible += 1; shown += 1; }
          });

        Array.prototype.forEach.call(
          section.querySelectorAll('.summary-table tbody tr'), function (row) {
            row.hidden = !matchesQuery(row.dataset.programHay || '', query);
          });

        section.hidden = !!query && !visible;
      });

    if (count) {
      count.textContent = query ? shown + ' of ' + plural(total, 'program') : '';
    }

    var empty = groups.querySelector('.history-search-empty');
    if (query && !shown) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'history-empty history-search-empty';
        groups.appendChild(empty);
      }
      empty.textContent = 'No program matches "' + query + '".';
      empty.hidden = false;
    } else if (empty) {
      empty.hidden = true;
    }
  }

  function historyCardKey(kind, folder, program) {
    var key = kind + ':' + String(folder || '(root)');
    return program ? key + ':' + String(program) : key;
  }

  function historyCardOpen(key, fallback) {
    var open = state.historyOpenCards || {};
    return Object.prototype.hasOwnProperty.call(open, key) ? !!open[key] : !!fallback;
  }

  function historyFolderCardPlan(folder) {
    return [{ kind: 'summary', key: historyCardKey('summary', folder.folder) }]
      .concat(Object.keys(folder.byProgram).sort().map(function (name) {
        return {
          kind: 'program',
          key: historyCardKey('program', folder.folder, name),
          program: name
        };
      }));
  }

  function folderSummaryGroup(folder, defaultOpen) {
    var key = historyCardKey('summary', folder.folder);
    var isOpen = historyCardOpen(key, defaultOpen);
    var group = document.createElement('section');
    group.className = 'fgroup history-folder-summary' + (isOpen ? ' is-open' : '');
    group.dataset.folder = folder.folder;
    group.dataset.historyKey = key;
    group.innerHTML =
      '<button class="fgroup-head" type="button" aria-expanded="' +
          (isOpen ? 'true' : 'false') + '">' +
        '<span class="fgroup-chevron">▸</span>' +
        '<span class="fgroup-title">' + esc(folder.folder) + ' — Summary</span>' +
        '<span class="fgroup-count mono">' + esc(folderChipText(folder)) + '</span>' +
      '</button>' +
      '<div class="fgroup-body compact"></div>';
    group.querySelector('.fgroup-body').appendChild(programSummaryTable(folder));
    return group;
  }

  function folderChipText(folder) {
    var updated = Object.keys(folder.updatedPrograms || folder.programs).length;
    return plural(updated, 'program') + ' · ' +
      plural(folder.applications, 'fix', 'fixes') + ' · ' +
      plural(folder.lines, 'line') +
      (folder.lastAt ? ' · ' + shortStamp(folder.lastAt) : '');
  }

  function historyProgramLabel(program) {
    var name = String(program.name || '');
    var sub = String(program.subfolder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!sub) return name;
    return name.indexOf(sub + '/') === 0 ? name : sub + '/' + name;
  }

  function programSummaryTable(folder) {
    var wrap = document.createElement('div');
    var showSubfolder = Object.keys(folder.byProgram).some(function (name) {
      return !!folder.byProgram[name].subfolder;
    });
    var rows = Object.keys(folder.byProgram).sort().map(function (name) {
      var program = folder.byProgram[name];
      var label = showSubfolder ? historyProgramLabel(program) : name;
      var hay = String(folder.folder || '') + '/' + historyProgramLabel(program);
      return '<tr data-program-hay="' + attr(hay) + '"><td class="mono">' +
        esc(label) + '</td><td>' +
        esc(Object.keys(program.rules).length) + '</td><td>' +
        esc(program.applications) + '</td><td>' + esc(program.lines) + '</td></tr>';
    }).join('');
    wrap.innerHTML =
      '<table class="detail-table summary-table"><thead><tr>' +
      '<th>Program</th><th>Distinct Rules Applied</th>' +
      '<th>Rule Applications</th><th>Lines Changed</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
    return wrap;
  }

  function programHistoryGroup(program, folderName) {
    var key = historyCardKey('program', folderName, program.name);
    var isOpen = historyCardOpen(key, false);
    var group = document.createElement('section');
    group.className = 'fgroup history-program' + (isOpen ? ' is-open' : '');
    group.dataset.historyKey = key;
    group.dataset.folder = folderName || '';
    group.dataset.programHay = String(folderName || '') + '/' + historyProgramLabel(program);
    group.innerHTML =
      '<button class="fgroup-head" type="button" aria-expanded="' +
          (isOpen ? 'true' : 'false') + '">' +
        '<span class="fgroup-chevron">▸</span>' +
        '<span class="fgroup-title mono">' + esc(historyProgramLabel(program)) + '</span>' +
        '<span class="fgroup-count mono">' +
          plural(program.applications, 'fix', 'fixes') + ' · ' +
          plural(program.lines, 'line') +
        '</span>' +
      '</button>' +
      '<div class="fgroup-body compact"></div>';
    var details = program.details.slice().sort(function (a, b) {
      return (a.originalLine || a.fixedLine || 0) - (b.originalLine || b.fixedLine || 0) ||
        String(a.ruleName || '').localeCompare(String(b.ruleName || ''));
    });
    group.querySelector('.fgroup-body').appendChild(detailTable(details));
    return group;
  }

  function detailTable(details) {
    var wrap = document.createElement('div');
    var shown = details.slice(0, 200);
    var rows = shown.map(function (detail) {
      return '<tr>' +
        '<td class="muted mono">' + esc(detail.program || '') + '</td>' +
        '<td class="mono">' + esc(detail.ruleId || '') + '</td>' +
        '<td>' + esc(detail.ruleName || '') + '</td>' +
        '<td>' + esc(detail.category || '') + '</td>' +
        '<td>' + esc(detail.severity || '') + '</td>' +
        '<td><span class="change-chip ' + changeClass(detail.type) + '">' +
          esc(detail.type || '') + '</span></td>' +
        '<td class="mono">' + esc(detail.originalLine == null ? '' : detail.originalLine) + '</td>' +
        '<td class="mono">' + esc(detail.fixedLine == null ? '' : detail.fixedLine) + '</td>' +
        '<td class="mono code-cell">' + esc(detail.before || '') + '</td>' +
        '<td class="mono code-cell">' + esc(detail.after || '') + '</td>' +
        '<td>' + esc(detail.runLabel || '') +
          (detail.local ? ' <span class="run-chip">local</span>' : '') + '</td>' +
      '</tr>';
    }).join('');
    wrap.innerHTML =
      '<table class="detail-table"><thead><tr>' +
      '<th>Program</th><th>Rule ID</th><th>Rule Name</th><th>Category</th>' +
      '<th>Risk</th><th>Change Type</th><th>Original Line</th><th>Fixed Line</th>' +
      '<th>Original Text</th><th>Fixed Text</th><th>Run</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      (details.length > shown.length ? '<div class="history-asof">Showing first 200 rows; ' +
        esc(details.length - shown.length) + ' more hidden.</div>' : '');
    return wrap;
  }

  function changeClass(type) {
    if (type === 'Added') return 'is-add';
    if (type === 'Deleted') return 'is-del';
    return 'is-mod';
  }

  function downloadRunHistory() {
    var model = aggregateRunHistory(filterRunHistory(state.runHistory || []));
    var rows = [];
    model.folders.forEach(function (folder) {
      Object.keys(folder.byProgram).forEach(function (name) {
        folder.byProgram[name].details.forEach(function (detail) {
          rows.push({
            User: detail.userId || '',
            Program: detail.program || '',
            'Rule ID': detail.ruleId || '',
            'Rule Name': detail.ruleName || '',
            Category: detail.category || '',
            Risk: detail.severity || '',
            'Change Type': detail.type || '',
            'Original Line': detail.originalLine == null ? '' : detail.originalLine,
            'Fixed Line': detail.fixedLine == null ? '' : detail.fixedLine,
            'Original Text': detail.before || '',
            'Fixed Text': detail.after || '',
            Run: detail.runLabel || ''
          });
        });
      });
    });
    if (!rows.length) {
      toast('No migration history rows match the current filters.', 'warn');
      return;
    }
    var columns = Object.keys(rows[0]).map(function (header) {
      return { header: header, width: header.indexOf('Text') !== -1 ? 60 : 18 };
    });
    var data = rows.map(function (row) {
      return columns.map(function (col) { return row[col.header]; });
    });
    var blob = new Blob([window.MigExcel.write([{
      name: 'Migration History',
      columns: columns,
      rows: data
    }])], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    download(blob, 'Migrate_Studio_History_' + timestampYYYYMMDDHHMM() + '.xlsx');
  }

  window.MigrateStudioHistory = {
    folderKey: folderKey,
    runProgramRecord: runProgramRecord,
    aggregateRunHistory: aggregateRunHistory,
    mergeRuns: mergeRuns,
    clip: clip,
    runBucket: runBucket,
    historySeries: historySeries,
    niceMax: niceMax,
    clipLabel: clipLabel,
    runChart: runChart,
    displayUser: displayUser,
    userKeyOf: userKeyOf,
    filterRunHistory: filterRunHistory,
    buildRunRecord: buildRunRecord,
    historyCardKey: historyCardKey,
    historyFolderCardPlan: historyFolderCardPlan,
    isOutputFolderName: isOutputFolderName,
    isInsideOutputFolder: isInsideOutputFolder,
    groupProgramsByDirectory: groupProgramsByDirectory,
    backupRelPathFor: backupRelPathFor,
    inPlaceApplied: inPlaceApplied,
    partitionTargets: partitionTargets,
    liveRunRowsFor: liveRunRowsFor,
    hitsFromHistoryRows: hitsFromHistoryRows,
    restorePriorRun: restorePriorRun,
    renderReleaseNotes: renderReleaseNotes,
    summaryWorkbookTitle: summaryWorkbookTitle,
    state: state
  };

  function renderHistory() {
    var program = current();
    var list = $('historyList');
    var status = $('historyStatus');
    list.innerHTML = '';

    if (!program) {
      status.textContent = '—';
      list.innerHTML = '<div class="history-empty">No program selected.</div>';
      return;
    }

    var query = ($('historyFilter').value || '').trim().toLowerCase();
    var versions = program.versions.filter(function (v) {
      if (!query) return true;
      return (v.id + ' ' + (v.rules || '') + ' ' + (v.author || ''))
        .toLowerCase().indexOf(query) !== -1;
    });

    status.textContent = program.name + ' · ' +
      plural(program.versions.length, 'version');

    if (!versions.length) {
      list.innerHTML = '<div class="history-empty">' +
        (program.versions.length
          ? 'No version matches that search.'
          : 'No fix applied to this program yet. Every Apply Fix records a ' +
            'version here.') +
        '</div>';
      return;
    }

    versions.forEach(function (version, index) {
      list.appendChild(versionRow(program, version, index === 0));
    });
  }

  function versionRow(program, version, isCurrent) {
    var row = document.createElement('div');
    row.className = 'version-row' + (isCurrent ? ' is-current' : '');

    var head = document.createElement('div');
    head.className = 'version-head';
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');
    head.innerHTML =
      '<span class="version-chevron">▸</span>' +
      '<span class="version-id mono">' + esc(version.id) + '</span>' +
      (isCurrent ? '<span class="version-chip">current</span>' : '') +
      '<span class="version-message">' +
        esc(version.reverted ? 'Reverted to the original'
          : version.restoredFrom ? ('Restored from ' + version.restoredFrom)
          : (plural(version.applied || 0, 'update') + ' from ' +
             (version.rules || 'the rule book'))) +
      '</span>' +
      '<span class="version-stats mono"><span class="added">+' +
        (version.applied || 0) + '</span></span>' +
      '<span class="version-age">' + esc(ago(version.at)) + '</span>';
    function toggleVersion() {
      var open = !row.classList.contains('is-open');
      row.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) showVersion(program, version);
    }
    head.addEventListener('click', toggleVersion);
    head.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleVersion();
      }
    });

    var detail = document.createElement('div');
    detail.className = 'version-detail';
    detail.innerHTML =
      line('when', new Date(version.at).toLocaleString()) +
      line('rules', version.rules || '—') +
      line('author', version.author || '—') +
      line('total', plural(version.total || 0, 'update'));

    var actions = document.createElement('div');
    actions.className = 'version-actions';

    var view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn btn-xs';
    view.textContent = 'View';
    view.addEventListener('click', function () { showVersion(program, version); });
    actions.appendChild(view);

    if (typeof version.text === 'string' && !isCurrent) {
      var restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-xs primary';
      restore.textContent = 'Restore';
      restore.addEventListener('click', function () {
        confirmDialog('Restore ' + version.id + '?',
          'A new version is recorded, so the copy you are restoring away from ' +
          'is kept.', 'Restore')
          .then(function (ok) { if (ok) restoreVersion(program, version); });
      });
      actions.appendChild(restore);
    }

    detail.appendChild(actions);
    row.appendChild(head);
    row.appendChild(detail);
    return row;
  }

  function line(key, value) {
    return '<div class="version-line"><span class="k">' + esc(key) +
           '</span><span class="v">' + esc(value) + '</span></div>';
  }

  function showVersion(program, version) {
    var detail = $('historyDetail');
    if (typeof version.text !== 'string') {
      detail.innerHTML =
        '<div class="detail-title">' + esc(version.id) + '</div>' +
        '<p class="detail-note">The body of this version was dropped to make ' +
        'room in local storage. Its record of what changed is intact.</p>';
      return;
    }
    var rows = window.MigDiff.align(program.original, version.text);
    var stat = detailStats(version.hits || []);
    detail.innerHTML =
      '<div class="detail-title">' + esc(version.id) + ' against the original — ' +
        stat.changed + ' changed, ' + stat.added + ' added, ' +
        stat.removed + ' removed</div>' +
      '<div class="code-view"><pre class="mono">' +
        paneHtml(contextOnly(rows, 2), 'right',
                 String(window.MigDiff.splitLines(version.text).length).length) +
      '</pre></div>';
  }

  /* ---------------------------------------------------------------------
   * Rendering — right rail
   * ------------------------------------------------------------------ */

  function renderContext() {
    var program = current();

    var summary = $('summaryLines');
    var badge = $('summaryBadge');
    summary.innerHTML = '';
    if (!program) {
      badge.textContent = 'no program';
      badge.className = 'ctx-badge';
      summary.innerHTML = '<div><dt>—</dt><dd class="none">Pick a program</dd></div>';
    } else {
      badge.textContent = program.fixed == null ? 'original' : 'fixed';
      badge.className = 'ctx-badge' + (program.fixed == null ? '' : ' ok');
      var fixedLines = program.fixed == null ? null
        : window.MigDiff.splitLines(program.fixed).length;
      summary.innerHTML =
        pair('program', program.name, true) +
        pair('folder', state.folderName || '—', true) +
        pair('size', bytes(program.size)) +
        pair('lines', String(window.MigDiff.splitLines(program.original).length) +
          (fixedLines == null ? '' : ' → ' + fixedLines)) +
        pair('modified', program.modified
          ? new Date(program.modified).toLocaleDateString() : '—');
    }

    var fixLines = $('fixLines');
    var fixBadge = $('fixBadge');
    if (!program) {
      fixBadge.textContent = '—';
      fixBadge.className = 'ctx-badge mono';
      fixLines.innerHTML = '<div><dt>—</dt><dd class="none">No program</dd></div>';
    } else {
      fixBadge.textContent = String(program.fixCount);
      fixBadge.className = 'ctx-badge mono' + (program.fixCount ? ' ok' : '');
      fixLines.innerHTML =
        pair('updates', String(program.fixCount)) +
        pair('rules hit', String(program.hits.length)) +
        pair('versions', String(program.versions.length)) +
        pair('state', program.fixed == null ? 'not fixed'
          : (state.dirty ? 'unsaved' : 'saved'));
    }

    var hits = $('ruleHits');
    var ruleBadge = $('ruleBadge');
    hits.innerHTML = '';
    if (!program || !program.hits.length) {
      ruleBadge.textContent = activeBook()
        ? selectedRuleCount() + ' selected' : '—';
      ruleBadge.className = 'ctx-badge mono';
      hits.innerHTML = '<li class="issue-empty">' +
        (activeBook() ? 'No fix applied yet.' : 'No rule book loaded.') + '</li>';
    } else {
      ruleBadge.textContent = plural(program.hits.length, 'rule');
      ruleBadge.className = 'ctx-badge mono ok';
      program.hits.slice()
        .sort(function (a, b) { return b.count - a.count; })
        .forEach(function (hit) {
          var li = document.createElement('li');
          li.innerHTML =
            '<span class="rid">' + esc(hit.id) + '</span>' +
            '<span class="rtx">' + esc(hit.name || '—') + '</span>' +
            '<span class="rn">' + hit.count + '</span>';
          if (hit.error) li.title = hit.error;
          hits.appendChild(li);
        });
    }

    var versions = $('miniVersions');
    var versionBadge = $('versionBadge');
    versions.innerHTML = '';
    if (!program || !program.versions.length) {
      versionBadge.textContent = '—';
      versions.innerHTML = '<li class="issue-empty">No versions yet.</li>';
    } else {
      versionBadge.textContent = plural(program.versions.length, 'version');
      program.versions.slice(0, 5).forEach(function (version) {
        var li = document.createElement('li');
        li.innerHTML =
          '<span class="mv-id mono">' + esc(version.id) + '</span>' +
          '<span class="mv-msg">' +
            esc(version.reverted ? 'reverted'
              : plural(version.applied || 0, 'update')) + '</span>' +
          '<span class="mv-age">' + esc(ago(version.at)) + '</span>';
        versions.appendChild(li);
      });
    }
  }

  function pair(key, value, mono) {
    return '<div><dt>' + esc(key) + '</dt><dd' +
           (mono ? ' class="mono"' : '') + '>' + esc(value) + '</dd></div>';
  }

  function renderSaveState() {
    var el = $('saveState');
    var foot = $('footState');
    if (!state.programs.length) {
      el.textContent = 'no folder';
      el.className = 'save-state mono offline';
      foot.textContent = 'no folder open';
      return;
    }
    if (state.dirty) {
      el.textContent = 'unsaved fixes';
      el.className = 'save-state mono dirty';
    } else {
      el.textContent = state.writable ? 'saved' : 'read-only';
      el.className = 'save-state mono ' + (state.writable ? 'clean' : 'offline');
    }
    foot.textContent = state.folderName + ' · ' +
      plural(state.programs.length, 'program') + ' · ' +
      (activeBook() ? plural(ruleCounts().total, 'rule') : 'no rule book');
  }

  function renderAll() {
    renderRail();
    renderSelectAll();
    renderHead();
    renderRules();
    renderFixed();
    renderCompare();
    renderFindings();
    renderHistory();
    if (state.tab === 'history' && state.historySubtab === 'runs') {
      renderRunHistoryLoaded();
    }
    renderContext();
    renderSaveState();
    renderApplyState();
    showJmBanner();
  }

  /* ---------------------------------------------------------------------
   * Tabs and panel view controls
   * ------------------------------------------------------------------ */

  function setTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(
      document.querySelectorAll('#editorTabs .seg-btn'), function (button) {
        var on = button.dataset.tab === name;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    Array.prototype.forEach.call(
      document.querySelectorAll('.tab-panel'), function (panel) {
        panel.classList.toggle('is-on', panel.dataset.panel === name);
    });
    if (name === 'compare') renderCompare();
    if (name === 'findings') renderFindings();
    if (name === 'history') {
      setHistorySubtab(state.historySubtab || 'runs');
      renderRunHistory();
    }
  }

  /* The three viewer buttons are drawn here rather than in the HTML so the
     same icon set can be reused across the Fixed SAS and Fix Compare panels
     without repeating the paths four times in the markup. */
  var ICONS = {
    expand: '<svg viewBox="0 0 24 24"><path d="M4 10V4h6"/><path d="M20 14v6h-6"/>' +
            '<path d="M4 4l7 7"/><path d="M20 20l-7-7"/></svg>',
    shrink: '<svg viewBox="0 0 24 24"><path d="M10 4v6H4"/><path d="M14 20v-6h6"/>' +
            '<path d="M4 10l7-7"/><path d="M20 14l-7 7"/></svg>',
    full:   '<svg viewBox="0 0 24 24"><path d="M8 3H3v5"/><path d="M16 3h5v5"/>' +
            '<path d="M8 21H3v-5"/><path d="M16 21h5v-5"/></svg>',
    collapse: '<svg viewBox="0 0 24 24"><path d="M4 9h16"/><path d="M4 15h16"/></svg>'
  };

  function setIcon(id, icon) {
    var button = $(id);
    if (button) button.innerHTML = ICONS[icon];
  }

  function wirePanelControls(panelId, expandId, fullId, collapseId, bodyClass) {
    var panel = $(panelId);

    on($(expandId), 'click', function () {
      var on = document.body.classList.toggle(bodyClass);
      $(expandId).setAttribute('aria-pressed', on ? 'true' : 'false');
      setIcon(expandId, on ? 'shrink' : 'expand');
      $(expandId).title = on ? 'Restore panel' : 'Expand panel';
    });

    on($(fullId), 'click', function () {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (panel && panel.requestFullscreen) {
        panel.requestFullscreen().catch(function () {
          toast('This browser would not go fullscreen here.', 'warn');
        });
      }
    });

    if (collapseId) {
      on($(collapseId), 'click', function () {
        var on = panel.classList.toggle('is-collapsed');
        $(collapseId).setAttribute('aria-pressed', on ? 'true' : 'false');
        $(collapseId).title = on ? 'Expand viewer' : 'Collapse viewer';
      });
    }
  }

  document.addEventListener('fullscreenchange', function () {
    ['btnFullscreenFixedPanel', 'btnFullscreenComparePanel',
     'btnFullscreenHistoryPanel'].forEach(function (id) {
      var button = $(id);
      if (!button) return;
      var inside = !!document.fullscreenElement &&
        document.fullscreenElement.contains(button);
      button.setAttribute('aria-pressed', inside ? 'true' : 'false');
      button.title = inside ? 'Leave fullscreen' : 'Enter fullscreen';
    });
  });

  /* ---------------------------------------------------------------------
   * The editable nav label
   * ------------------------------------------------------------------ */

  function wireNavLabel() {
    var button = $('navLabel');
    var input = $('navLabelInput');

    function show() {
      button.textContent = state.label || 'Migration Name';
      button.classList.toggle('is-empty', !state.label);
      document.title = 'Migrate Studio' + (state.label ? ' - ' + state.label : '');
    }

    function begin() {
      input.value = state.label;
      button.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    }

    function commit() {
      state.label = input.value.trim();
      input.hidden = true;
      button.hidden = false;
      savePrefs();
      show();
    }

    on(button, 'click', begin);
    on(input, 'blur', commit);
    on(input, 'keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      if (event.key === 'Escape') {
        input.hidden = true; button.hidden = false;
      }
    });
    show();
  }

  /* ---------------------------------------------------------------------
   * The overflow menu
   * ------------------------------------------------------------------ */

  function wireMenu() {
    var button = $('btnFileMenu');
    var menu = $('fileMenu');

    function close() {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }

    on(button, 'click', function (event) {
      event.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.addEventListener('click', function (event) {
      if (!menu.hidden && !menu.contains(event.target)) close();
    });

    on(menu, 'click', function (event) {
      var item = event.target.closest('[data-action]');
      if (!item) return;
      close();
      var action = item.dataset.action;
      if (action === 'import-rules') $('rulesInput').click();
      else if (action === 'export-rules') exportRules();
      else if (action === 'download-fix') downloadFixed();
      else if (action === 'download-summary') downloadSummaryUpdates();
      else if (action === 'user-manual') openUserManual();
      else if (action === 'author') openAuthor();
      else if (action === 'logout') logout();
    });
  }

  function openUserManual() {
    var tab = window.open('docs/user_manual.html', '_blank');
    if (tab) tab.opener = null;
    else toast('The browser blocked the new tab. Allow pop-ups for Migrate Studio.', 'warn');
  }

  function openAuthor() {
    $('authorName').value = state.author.name || '';
    $('authorEmail').value = state.author.email || '';
    $('authorDialog').showModal();
  }

  function promptForAuthorOnce() {
    if (state.author.name || state.authorPrompted) return Promise.resolve();
    state.authorPrompted = true;
    return new Promise(function (resolve) {
      var dialog = $('authorDialog');
      function done() {
        dialog.removeEventListener('close', done);
        resolve();
      }
      dialog.addEventListener('close', done);
      openAuthor();
    });
  }

  function renderAuthor() {
    var name = state.author.name || '';
    $('menuUserProfileLabel').textContent = name || 'Profile';
    var initials = name.split(/\s+/).filter(Boolean)
      .slice(0, 2).map(function (part) { return part.charAt(0); })
      .join('').toUpperCase();
    $('menuUserProfileAvatar').textContent = initials || 'U';
  }

  function logout() {
    closeServerSession()
      .catch(function () {
        /* The server may close while the response is finishing. */
      })
      .then(function () {
        document.body.innerHTML = '';
        window.close();
      });
  }

  /* ---------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------ */

  function boot() {
    loadPrefs();
    state.identityReady = resolveIdentity().then(function (identity) {
      state.identity = identity;
      renderAuthor();
      renderIdentityChip();
      return identity;
    });
    renderAuthor();
    wireNavLabel();
    wireMenu();

    setIcon('btnExpandFixedPanel', 'expand');
    setIcon('btnFullscreenFixedPanel', 'full');
    setIcon('btnCollapseFixedPanel', 'collapse');
    setIcon('btnExpandComparePanel', 'expand');
    setIcon('btnFullscreenComparePanel', 'full');
    setIcon('btnExpandHistoryPanel', 'expand');
    setIcon('btnFullscreenHistoryPanel', 'full');

    wirePanelControls('fixedPanel', 'btnExpandFixedPanel',
      'btnFullscreenFixedPanel', 'btnCollapseFixedPanel', 'fixed-panel-expanded');
    wirePanelControls('comparePanel', 'btnExpandComparePanel',
      'btnFullscreenComparePanel', null, 'compare-panel-expanded');
    wirePanelControls('historyPanel', 'btnExpandHistoryPanel',
      'btnFullscreenHistoryPanel', null, 'history-panel-expanded');

    /* folder + programs */
    on($('btnPickFolder'), 'click', pickFolder);
    on($('folderInput'), 'change', function (event) {
      readFolderFallback(event.target.files);
      event.target.value = '';
    });
    on($('programFilter'), 'input', debounce(function () {
      renderRail(); renderSelectAll();
    }, 120));
    on($('btnSelectAll'), 'click', function () {
      var list = visiblePrograms();
      var all = list.length > 0 && list.every(function (p) {
        return state.checked[p.name];
      });
      list.forEach(function (p) {
        if (all) delete state.checked[p.name];
        else state.checked[p.name] = true;
      });
      renderRail(); renderSelectAll();
    });

    /* tabs */
    on($('editorTabs'), 'click', function (event) {
      var button = event.target.closest('.seg-btn');
      if (button) {
        if (button.dataset.tab === 'history') setHistorySubtab('runs');
        setTab(button.dataset.tab);
      }
    });

    /* rules */
    on($('rulesInput'), 'change', function (event) {
      var file = event.target.files[0];
      if (file) readRulesFile(file).then(renderAll);
      event.target.value = '';
    });
    on($('mcPackInput'), 'change', function (event) {
      var file = event.target.files[0];
      if (file) readJmPackFile(file);
      event.target.value = '';
    });
    on($('btnImportPack'), 'click', function () { $('mcPackInput').click(); });
    on($('btnImportPackBanner'), 'click', function () { $('mcPackInput').click(); });
    on($('btnImportRules'), 'click', function () { $('rulesInput').click(); });
    on($('btnExportRules'), 'click', exportRules);
    on($('ruleFilter'), 'input', debounce(renderRules, 140));
    on($('ruleSource'), 'change', function (event) {
      state.ruleSource = event.target.value === 'legacy' ? 'legacy' : 'mc';
      savePrefs();
      refreshFindings();
      renderAll();
    });
    on($('osFamily'), 'change', function (event) {
      state.osFamily = event.target.value === 'WINDOWS' ? 'WINDOWS' : 'LINUX';
      savePrefs();
      refreshFindings();
      renderAll();
    });
    on($('pathRoot'), 'input', debounce(function (event) {
      state.pathRoot = event.target.value.trim();
      savePrefs();
      refreshFindings();
      renderFindings();
    }, 160));
    on($('btnDownloadFindings'), 'click', downloadFindings);

    /* fixes */
    on($('btnApplyFix'), 'click', applyFixToSelection);
    on($('btnApplyFixThis'), 'click', applyFixToSelection);
    on($('btnApplyFixTab'), 'click', applyFixToSelection);
    on($('btnRevertProgram'), 'click', revertProgram);
    on($('btnSave'), 'click', save);

    /* fixed SAS tab */
    on($('btnReloadFixed'), 'click', function () {
      var program = current();
      if (!program || !program.handle) {
        toast('Nothing to reload — this folder is not connected.', 'warn');
        return;
      }
      program.handle.getFile()
        .then(function (file) { return decodeProgramFile(file); })
        .then(function (text) {
          program.original = text;
          program.eol = detectEol(text);
          refreshFindings();
          renderAll();
          toast(program.name + ' reloaded from disk.');
        })
        .catch(function (error) {
          toast('Could not reload: ' + error.message, 'err');
        });
    });
    on($('btnCopyFixed'), 'click', function () {
      var program = current();
      if (!program) return;
      var text = program.fixed != null ? program.fixed : program.original;
      navigator.clipboard.writeText(text)
        .then(function () { toast('Copied ' + program.name + '.'); })
        .catch(function () { toast('The browser blocked the copy.', 'err'); });
    });
    on($('btnDownloadFixed'), 'click', function () {
      var program = current();
      if (!program) return;
      downloadFixedProgram(program);
    });
    on($('btnDownloadFixScreen'), 'click', downloadFixed);

    /* compare */
    on($('cmpVersion'), 'change', renderCompare);
    on($('cmpChangesOnly'), 'change', renderCompare);
    on($('btnPrevModified'), 'click', function () { jumpToModified(-1); });
    on($('btnNextModified'), 'click', function () { jumpToModified(1); });
    on($('cmpModifiedLabel'), 'click', function (event) {
      if (event.target.closest('.cmp-jump-link')) jumpToModified(1);
    });

    /* history */
    on($('historyFilter'), 'input', debounce(renderHistory, 140));
    on($('runHistorySearch'), 'input', debounce(renderRunHistoryLoaded, 140));
    on($('runHistoryUser'), 'change', renderRunHistoryLoaded);
    on($('runHistoryFolder'), 'change', renderRunHistoryLoaded);
    on($('btnDownloadRunHistory'), 'click', downloadRunHistory);
    document.addEventListener('input', function (event) {
      if (event.target && event.target.id === 'historyProgramSearch') {
        applyHistoryProgramSearch();
      }
    });
    document.addEventListener('search', function (event) {
      if (event.target && event.target.id === 'historyProgramSearch') {
        applyHistoryProgramSearch();
      }
    }, true);
    on($('historySubTabs'), 'click', function (event) {
      var button = event.target.closest('.seg-btn');
      if (!button) return;
      setHistorySubtab(button.dataset.subtab);
      if (state.historySubtab === 'runs') renderRunHistory();
      else renderHistory();
    });
    on($('btnOpenHistory'), 'click', function () {
      setHistorySubtab('program');
      setTab('history');
    });
    on($('btnClearHistory'), 'click', function () {
      var program = current();
      if (!program || !program.versions.length) return;
      confirmDialog('Clear the history for ' + program.name + '?',
        'The versions are removed. The fixed copy in front of you is kept.',
        'Clear')
        .then(function (ok) {
          if (!ok) return;
          program.versions = [];
          saveHistory();
          renderAll();
        });
    });

    /* fgroup headers on the History tab */
    document.addEventListener('click', function (event) {
      var head = event.target.closest('.fgroup-head');
      if (!head) return;
      var group = head.closest('.fgroup');
      if (!group) return;
      var open = !group.classList.contains('is-open');
      group.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (group.dataset.historyKey) {
        state.historyOpenCards = state.historyOpenCards || {};
        state.historyOpenCards[group.dataset.historyKey] = open;
      }
    });

    /* dialogs */
    on($('authorForm'), 'submit', function () {
      state.author = {
        name: $('authorName').value.trim(),
        email: $('authorEmail').value.trim()
      };
      savePrefs();
      renderAuthor();
      toast('Profile saved.');
    });
    on($('btnAbout'), 'click', showAbout);
    on($('btnReleaseNotes'), 'click', showReleaseNotes);
    on($('btnDismissFs'), 'click', function () { $('fsBanner').hidden = true; });
    on($('btnDismissBanner'), 'click', function () { $('modeBanner').hidden = true; });
    on($('btnReconnectFolder'), 'click', reconnectLastFolder);

    /* burger, for the narrow layout */
    on(document.querySelector('.nav-burger'), 'click', function () {
      var burger = document.querySelector('.nav-burger');
      var open = document.body.classList.toggle('rail-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    /* keyboard */
    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
        return;
      }
      if (state.tab !== 'compare') return;
      var tag = (event.target && event.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'select' || tag === 'textarea' ||
        (event.target && event.target.isContentEditable);
      var next = (event.altKey && event.key === 'ArrowDown') ||
        (!typing && !event.altKey && event.key.toLowerCase() === 'n');
      var prev = (event.altKey && event.key === 'ArrowUp') ||
        (!typing && !event.altKey && event.key.toLowerCase() === 'p');
      if (!next && !prev) return;
      if (!modifiedRows('cmpRight').length) return;
      event.preventDefault();
      jumpToModified(next ? 1 : -1);
    });

    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });

    /* Opening state: first try to restore the remembered folder. If that is
       not possible, say how to open one by hand. */
    setLoading(null);
    $('appFrame').hidden = false;
    renderAll();

    restoreLastFolder().then(function (restored) {
      if (!restored) showOpeningState();
    }).finally(function () {
      /* Last, because it is the only part of startup that can fail slowly and
         nothing else waits on it. */
      loadJmPack().then(loadRulesBeside);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
