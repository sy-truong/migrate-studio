/*
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.basename(__dirname) === 'js' ? path.resolve(__dirname, '../..') : path.resolve(__dirname, '..');
const ASSET_ROOT = fs.existsSync(path.join(ROOT, 'www')) ? path.join(ROOT, 'www') : ROOT;
const storage = {};

global.window = global;
global.location = { protocol: 'http:' };
Object.defineProperty(global, 'navigator',
  { value: { userAgent: 'test' }, writable: true, configurable: true });
global.localStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; }
};
global.document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return {}; }
};
global.MigDiff = {
  escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
};

vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8'));

const render = global.MigrateStudioHistory.renderReleaseNotes;

const html = render([
  '# Top title',
  '',
  '## v0.3 Beta · Build 2026.09.21',
  '',
  '### Improvements',
  '',
  '- **Bold item** with `code` and [Meta-X](https://meta-x.com).',
  '- continuation',
  '  wraps on the same bullet.',
  '',
  '---',
  '',
  '```',
  '<script>alert(1)</script>',
  '```'
].join('\n'));

assert(!html.includes('Top title'), 'top-level release-note title should be skipped');
assert(html.includes('<h3>v0.3 Beta · Build 2026.09.21</h3>'));
assert(html.includes('<h4>Improvements</h4>'));
assert(html.includes('<strong>Bold item</strong>'));
assert(html.includes('<code>code</code>'));
assert(html.includes('<a href="https://meta-x.com" target="_blank" rel="noopener noreferrer">Meta-X</a>'));
assert(html.includes('continuation wraps on the same bullet'));
assert(html.includes('<hr>'));
assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert(!html.includes('<script>'));

const injected = render('[bad](https://example.com/" onclick="alert(1))');
assert(!injected.includes('<a href='), 'URLs with quotes must stay plain text');
assert(injected.includes('[bad](https://example.com/" onclick="alert(1))'));

const local = render('[local](file:///tmp/x) [relative](notes.md)');
assert(!local.includes('<a href='), 'only http(s) links should render');

console.log('release notes tests passed');
