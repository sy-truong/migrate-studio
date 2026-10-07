/* ===========================================================================
 * Migrate Studio -- Shiny bridge.
 *
 * migrate-studio.js was written for migrate_studio.py and talks to it with
 * fetch(): api/whoami, api/history, api/backup/..., history.json, the rule
 * book, CHANGELOG.md. Shiny has no place for those URLs, so this file
 * wraps window.fetch: matching requests go over the Shiny websocket
 * (input$mig_api) and come back as ordinary Response objects. Everything
 * else goes to the real fetch. migrate-studio.js is not changed.
 *
 * Requests are sent one at a time. Shiny may merge two values set on the same
 * input in the same tick, and one-at-a-time also matches how the R session
 * runs them.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function () {
  'use strict';

  var ROUTES = [
    /^api\//,
    /^history\.json$/,
    /^current_selections\.json$/,
    /^rules\/(Migrate_Studio|PortFix)_Rules\.xlsx$/,
    /^CHANGELOG\.md$/,
    /^fs\//
  ];
  var LONG_CALLS = /^api\/backup\/|^fs\/(write|read)/;
  var DEFAULT_TIMEOUT_MS = 60 * 1000;
  var LONG_TIMEOUT_MS = 15 * 60 * 1000;

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var queue = [];
  var inFlight = null;
  var pending = {};
  var seq = 0;
  var connected = false;

  function basePath() {
    return new URL('.', document.baseURI).pathname;
  }

  /* Turn any URL into the app-relative path the R side routes on, or null
     when the URL is not one of ours. */
  function routeFor(url) {
    var parsed;
    try { parsed = new URL(url, document.baseURI); } catch (e) { return null; }
    if (parsed.origin !== window.location.origin) return null;
    var path = parsed.pathname;
    var base = basePath();
    if (path.indexOf(base) === 0) path = path.slice(base.length);
    else path = path.replace(/^\/+/, '');     // '/api/logout' behind a proxy
    path = decodeURIComponent(path);
    for (var i = 0; i < ROUTES.length; i++) {
      if (ROUTES[i].test(path)) return path;
    }
    return null;
  }

  /* Only true after Shiny has initialised and the server has answered:
     before that, Shiny.setInputValue is not usable yet. */
  function isConnected() {
    return connected;
  }

  function pump() {
    if (inFlight || !queue.length || !isConnected()) return;
    var request = inFlight = queue.shift();
    pending[request.id] = request;
    request.timer = setTimeout(function () {
      settle(request.id, null, new Error('Migrate Studio server did not answer ' +
        request.path + ' in time.'));
    }, LONG_CALLS.test(request.path) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    try {
      window.Shiny.setInputValue('mig_api', {
        id: request.id,
        method: request.method,
        path: request.path,
        body: request.body
      }, { priority: 'event' });
    } catch (error) {
      settle(request.id, null, error);    // never leave the queue blocked
    }
  }

  function settle(id, reply, error) {
    var request = pending[id];
    if (!request) return;
    delete pending[id];
    clearTimeout(request.timer);
    if (inFlight && inFlight.id === id) inFlight = null;
    if (error) request.reject(error);
    else request.resolve(reply);
    pump();
  }

  /* Promise-returning call, also used directly by mig-server-fs.js. */
  function call(method, path, body) {
    return new Promise(function (resolve, reject) {
      seq += 1;
      queue.push({
        id: 'r' + Date.now().toString(36) + '-' + seq,
        method: method || 'GET',
        path: path,
        body: body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body)),
        resolve: resolve,
        reject: reject
      });
      pump();
    });
  }

  function base64ToBytes(text) {
    var binary = atob(text || '');
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function toResponse(reply) {
    var status = reply.status || 200;
    if (reply.base64 != null) {
      return new Response(base64ToBytes(reply.base64), {
        status: status,
        headers: { 'Content-Type': reply.contentType || 'application/octet-stream' }
      });
    }
    return new Response(reply.json == null ? '' : reply.json, {
      status: status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function bodyText(init) {
    var body = init && init.body;
    if (body == null) return Promise.resolve('');
    if (typeof body === 'string') return Promise.resolve(body);
    return new Response(body).text();
  }

  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var path = routeFor(url);
      if (!path) return nativeFetch(input, init);
      var method = ((init && init.method) ||
        (input && typeof input !== 'string' && input.method) || 'GET').toUpperCase();
      return bodyText(init).then(function (text) {
        return call(method, path, text);
      }).then(toResponse);
    };
  }

  function onConnected() {
    restoreSubmitButtons();
    connected = true;
    pump();
  }

  function onDisconnected() {
    connected = false;
    Object.keys(pending).forEach(function (id) {
      settle(id, null, new Error('Lost the connection to the Migrate Studio server.'));
    });
  }

  /* Shiny switches every input into "submitButton" mode -- nothing is sent
     until a submit button is clicked, and every submit button's click is
     cancelled -- when the page has any submit button at start-up. Migrate
     Studio's dialogs use <button type="submit"> inside <form method="dialog">,
     so hide them from that check and put them back once Shiny is running. */
  var hiddenSubmits = [];

  function hideSubmitButtons() {
    var nodes = document.querySelectorAll('input[type="submit"], button[type="submit"]');
    Array.prototype.forEach.call(nodes, function (node) {
      node.setAttribute('type', 'button');
      hiddenSubmits.push(node);
    });
  }

  function restoreSubmitButtons() {
    hiddenSubmits.forEach(function (node) { node.setAttribute('type', 'submit'); });
    hiddenSubmits = [];
  }

  /* Shiny also cancels the submit event of every <form> without an action
     attribute. A <form method="dialog"> ignores action, so giving it an
     empty one lets Save / OK close the dialog as the browser intends. */
  function markDialogForms(scope) {
    var forms = (scope || document).querySelectorAll('form[method="dialog"]:not([action])');
    Array.prototype.forEach.call(forms, function (form) {
      form.setAttribute('action', '');
    });
  }

  function watchDialogForms() {
    markDialogForms(document);
    if (!window.MutationObserver) return;
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes, function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches('form[method="dialog"]:not([action])')) {
            node.setAttribute('action', '');
          }
          if (node.querySelectorAll) markDialogForms(node);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* The page is Migrate Studio's own HTML, not Shiny UI. Stop Shiny from
     binding its <input> elements (it would turn the rule-book and folder
     file inputs into Shiny uploads). The bridge only uses setInputValue,
     which needs no bindings. */
  function disableInputBindings() {
    var registry = window.Shiny && window.Shiny.inputBindings;
    if (!registry || !registry.getBindings) return;
    registry.getBindings().forEach(function (entry) {
      entry.binding.find = function () { return window.jQuery([]); };
    });
  }

  function install() {
    if (!window.Shiny || !window.Shiny.addCustomMessageHandler) return false;
    disableInputBindings();
    window.Shiny.addCustomMessageHandler('mig-api-reply', function (reply) {
      settle(reply.id, reply, null);
    });
    if (window.jQuery) {
      window.jQuery(document).on('shiny:sessioninitialized', onConnected);
      window.jQuery(document).on('shiny:disconnected', onDisconnected);
    }
    return true;
  }

  hideSubmitButtons();
  watchDialogForms();
  if (!install()) {
    document.addEventListener('DOMContentLoaded', install);
  }

  window.MigBridge = {
    call: call,
    json: function (method, path, body) {
      return call(method, path, body).then(function (reply) {
        var data = reply.json ? JSON.parse(reply.json) : {};
        if ((reply.status || 200) >= 400) {
          var error = new Error(data.error || ('HTTP ' + reply.status));
          error.name = data.name || 'Error';
          error.status = reply.status;
          throw error;
        }
        return data;
      });
    },
    state: function () {
      return { connected: connected, queued: queue.length,
               inFlight: inFlight && inFlight.path };
    },
    base64ToBytes: base64ToBytes,
    bytesToBase64: bytesToBase64
  };
})();
