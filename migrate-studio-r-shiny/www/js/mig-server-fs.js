/* ===========================================================================
 * Migrate Studio -- server folder mode (optional).
 *
 * Active only when the Shiny app runs with folder_mode = "server". It defines
 * window.showDirectoryPicker, returning handle objects that behave like the
 * File System Access API handles migrate-studio.js already uses:
 *
 *   directory: name, kind, values(), getDirectoryHandle(), getFileHandle(),
 *              removeEntry(), queryPermission(), requestPermission()
 *   file:      name, kind, getFile(), createWritable(), queryPermission()
 *
 * Reads and writes are answered by R/fs_server.R. File bytes travel as
 * base64 and are decoded by the same File/Blob code paths the browser uses,
 * so program text, encodings and line endings are handled exactly as before.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function () {
  'use strict';

  if (window.MIGRATE_STUDIO_FOLDER_MODE !== 'server') return;
  if (!window.MigBridge) {
    console.error('mig-server-fs.js needs mig-shiny-bridge.js loaded first.');
    return;
  }

  var bridge = window.MigBridge;

  function join(rel, name) {
    return rel ? rel + '/' + name : name;
  }

  function domError(name, message) {
    try { return new DOMException(message, name); } catch (e) {
      var error = new Error(message);
      error.name = name;
      return error;
    }
  }

  function fs(op, body) {
    return bridge.json('POST', 'fs/' + op, body).catch(function (error) {
      if (error.name === 'NotFoundError' || error.status === 404) {
        throw domError('NotFoundError', error.message);
      }
      throw error;
    });
  }

  function granted() { return Promise.resolve('granted'); }

  /* ---- directory handle ------------------------------------------------ */

  function DirHandle(root, rel, name, path) {
    this.kind = 'directory';
    this.name = name;
    this._root = String(root);
    this._rel = rel || '';
    this._path = path || '';
    this.__migServer = true;          // survives IndexedDB structured clone
  }

  DirHandle.prototype.queryPermission = granted;
  DirHandle.prototype.requestPermission = granted;

  DirHandle.prototype.isSameEntry = function (other) {
    return Promise.resolve(!!other && other._root === this._root &&
      other._rel === this._rel && other.kind === this.kind);
  };

  DirHandle.prototype.values = function () {
    var self = this;
    var list = null;
    var index = 0;
    var iterator = {
      next: function () {
        var ready = list ? Promise.resolve(list)
          : fs('entries', { root: self._root, rel: self._rel })
            .then(function (data) { list = data.entries || []; return list; });
        return ready.then(function (entries) {
          if (index >= entries.length) return { done: true, value: undefined };
          var entry = entries[index++];
          var rel = join(self._rel, entry.name);
          return {
            done: false,
            value: entry.kind === 'directory'
              ? new DirHandle(self._root, rel, entry.name,
                  self._path ? join(self._path, entry.name) : '')
              : new FileHandle(self._root, rel, entry.name)
          };
        });
      }
    };
    if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {
      iterator[Symbol.asyncIterator] = function () { return iterator; };
    }
    return iterator;
  };

  DirHandle.prototype.getDirectoryHandle = function (name, options) {
    var self = this;
    var rel = join(self._rel, name);
    return fs('dir', { root: self._root, rel: rel, create: !!(options && options.create) })
      .then(function () {
        return new DirHandle(self._root, rel, name,
          self._path ? join(self._path, name) : '');
      });
  };

  DirHandle.prototype.getFileHandle = function (name, options) {
    var self = this;
    var rel = join(self._rel, name);
    return fs('file', { root: self._root, rel: rel, create: !!(options && options.create) })
      .then(function () { return new FileHandle(self._root, rel, name); });
  };

  DirHandle.prototype.removeEntry = function (name, options) {
    return fs('remove', {
      root: this._root,
      rel: join(this._rel, name),
      recursive: !!(options && options.recursive)
    }).then(function () { return undefined; });
  };

  /* ---- file handle ------------------------------------------------------ */

  function FileHandle(root, rel, name) {
    this.kind = 'file';
    this.name = name;
    this._root = String(root);
    this._rel = rel;
    this.__migServer = true;
  }

  FileHandle.prototype.queryPermission = granted;
  FileHandle.prototype.requestPermission = granted;
  FileHandle.prototype.isSameEntry = DirHandle.prototype.isSameEntry;

  FileHandle.prototype.getFile = function () {
    var self = this;
    return fs('read', { root: self._root, rel: self._rel }).then(function (data) {
      var file = new File([bridge.base64ToBytes(data.base64)], data.name || self.name, {
        lastModified: data.lastModified
      });
      /* Lets a Revert copy the backup's modified date back onto the program. */
      Object.defineProperty(file, '_migSource', {
        value: { root: self._root, rel: self._rel }
      });
      return file;
    });
  };

  FileHandle.prototype.createWritable = function () {
    var self = this;
    var parts = [];
    var copyFrom = null;
    return Promise.resolve({
      write: function (data) {
        if (data && typeof data === 'object' && data.type === 'write' &&
            'data' in data) {
          data = data.data;                   // { type: 'write', data } form
        }
        if (data && data._migSource && !parts.length) {
          copyFrom = data._migSource;
          return Promise.resolve();
        }
        copyFrom = null;
        parts.push(data == null ? '' : data);
        return Promise.resolve();
      },
      truncate: function () { parts = []; copyFrom = null; return Promise.resolve(); },
      abort: function () { parts = []; copyFrom = null; return Promise.resolve(); },
      close: function () {
        if (copyFrom) {
          return fs('write', { root: self._root, rel: self._rel, copyFrom: copyFrom });
        }
        /* Strings become UTF-8, as FileSystemWritableFileStream does. */
        return new Blob(parts).arrayBuffer().then(function (buffer) {
          return fs('write', {
            root: self._root,
            rel: self._rel,
            base64: bridge.bytesToBase64(new Uint8Array(buffer))
          });
        }).then(function () { return undefined; });
      }
    });
  };

  /* ---- folder picker ---------------------------------------------------- */

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function pickServerFolder() {
    return fs('roots', {}).then(function (data) {
      var roots = data.roots || [];
      if (!roots.length) {
        throw new Error('No server folders are configured. Set ' +
          'MIGRATE_STUDIO_SERVER_ROOTS before starting the app.');
      }
      return new Promise(function (resolve, reject) {
        var dialog = el('dialog', { 'class': 'dialog server-folder-dialog' });
        var form = el('form', { method: 'dialog' });
        var title = el('h2', {}, 'Choose a server folder');
        var note = el('p', { 'class': 'dialog-note' });
        var rootSelect = el('select', { 'class': 'mini-select', 'aria-label': 'Root folder' });
        var list = el('div', { 'class': 'server-folder-list', role: 'listbox' });
        var actions = el('div', { 'class': 'dialog-actions' });
        var up = el('button', { type: 'button', 'class': 'btn btn-sm' }, 'Up');
        var cancel = el('button', { type: 'button', 'class': 'btn btn-sm' }, 'Cancel');
        var choose = el('button', { type: 'submit', 'class': 'btn btn-sm btn-dark' },
          'Use this folder');
        var state = { root: roots[0].id, rel: '' };
        var done = false;

        roots.forEach(function (root) {
          rootSelect.appendChild(el('option', { value: root.id }, root.path));
        });
        actions.appendChild(up);
        actions.appendChild(cancel);
        actions.appendChild(choose);
        [title, rootSelect, note, list, actions].forEach(function (node) {
          form.appendChild(node);
        });
        dialog.appendChild(form);
        document.body.appendChild(dialog);

        function rootInfo() {
          return roots.filter(function (r) { return r.id === state.root; })[0];
        }

        function render() {
          note.textContent = 'Loading…';
          list.textContent = '';
          fs('list-dirs', { root: state.root, rel: state.rel }).then(function (info) {
            var here = state.rel ? rootInfo().path + '/' + state.rel : rootInfo().path;
            note.textContent = here + ' — ' + info.sasCount + ' .sas program' +
              (info.sasCount === 1 ? '' : 's') + ' here';
            up.disabled = !state.rel;
            (info.dirs || []).forEach(function (name) {
              var item = el('button', { type: 'button', 'class': 'server-folder-item' },
                name + '/');
              item.addEventListener('click', function () {
                state.rel = join(state.rel, name);
                render();
              });
              list.appendChild(item);
            });
            if (!(info.dirs || []).length) {
              list.appendChild(el('p', { 'class': 'dialog-note' }, 'No subfolders.'));
            }
          }).catch(function (error) { note.textContent = error.message; });
        }

        function finish(result, error) {
          if (done) return;
          done = true;
          dialog.close();
          dialog.remove();
          if (error) reject(error); else resolve(result);
        }

        rootSelect.addEventListener('change', function () {
          state.root = rootSelect.value;
          state.rel = '';
          render();
        });
        up.addEventListener('click', function () {
          state.rel = state.rel.split('/').slice(0, -1).join('/');
          render();
        });
        cancel.addEventListener('click', function () {
          finish(null, domError('AbortError', 'The user aborted a request.'));
        });
        dialog.addEventListener('cancel', function () {
          finish(null, domError('AbortError', 'The user aborted a request.'));
        });
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          fs('select', { root: state.root, rel: state.rel }).then(function (sel) {
            finish(new DirHandle(state.root, state.rel, sel.name, sel.path || ''));
          }).catch(function (error) { note.textContent = error.message; });
        });

        dialog.showModal();
        render();
      });
    });
  }

  window.showDirectoryPicker = function () { return pickServerFolder(); };

  /* A handle read back from IndexedDB is a plain object; give it its methods
     back and tell the server which folder is in use again. */
  window.MigServerFs = {
    revive: function (stored) {
      /* A browser (local disk) handle saved in browser mode is not usable
         here: forget it rather than read the user's PC in server mode. */
      if (!stored || !stored.__migServer || stored.kind !== 'directory') return null;
      var handle = new DirHandle(stored._root, stored._rel, stored.name,
        stored._path || '');
      return fs('select', { root: handle._root, rel: handle._rel })
        .then(function (sel) {
          handle._path = (sel && sel.path) || handle._path || '';
          return handle;
        })
        .catch(function () { return null; });
    }
  };
})();
