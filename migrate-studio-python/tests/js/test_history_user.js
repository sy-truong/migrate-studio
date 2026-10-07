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
const elements = {
  runHistorySearch: { value: '' },
  runHistoryFolder: { value: '' },
  runHistoryUser: { value: '@me', options: [], selectedIndex: 0 },
  ruleFilter: { value: '' }
};

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
  getElementById(id) { return elements[id] || null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return {}; }
};
global.MigDiff = {
  escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};

vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8'));

const history = global.MigrateStudioHistory;
const shipped = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'history.sample.json'), 'utf8'));

assert(shipped.runs.length > 0);
const legacyRuns = shipped.runs.filter(run => {
  const user = run.user || {};
  return !user.id && !user.key;
});
assert(legacyRuns.length > 0);
legacyRuns.forEach(run => {
  assert.strictEqual(history.userKeyOf(run), '');
});
shipped.runs.filter(run => (run.user || {}).key).forEach(run => {
  assert.strictEqual(history.userKeyOf(run), run.user.key.toLowerCase());
});

history.state.identity = {
  userId: 'ExampleUser',
  userKey: 'exampleuser',
  source: 'os',
  host: 'target-host',
  os: 'Windows',
  sessionId: 'session-1',
  resolvedAt: '2026-09-13T10:00:00.000Z'
};
history.state.author = { name: '', email: '' };
history.state.ruleSource = 'mc';
history.state.mcRules = {
  kind: 'mc',
  source: 'migration_rules.json',
  macroVersion: '4.30',
  rules: [{ row: 1, id: 'O4', selected: true, executable: true, enabled: true }]
};

const programRecord = {
  name: 'dm.sas',
  folder: '(root)',
  applications: 1,
  lines: 1,
  rules: ['O4'],
  ruleCounts: { O4: 1 },
  details: []
};
const run = history.buildRunRecord(1, [programRecord], [{ name: 'dm.sas', relPath: 'dm.sas' }]);
assert.strictEqual(run.user.id, 'ExampleUser');
assert.strictEqual(run.user.key, 'exampleuser');
assert.strictEqual(run.user.source, 'os');
assert.strictEqual(run.user.host, 'target-host');
assert.strictEqual(run.user.name, '');
assert.strictEqual(run.sessionId, 'session-1');

const mixed = [{
  runId: 'mine',
  appliedAt: '2026-09-13T10:00:00.000Z',
  rootFolder: 'sdtm',
  user: { id: 'ExampleUser', key: 'exampleuser', source: 'os' },
  programs: [Object.assign({}, programRecord, { name: 'dm.sas' })],
  targetedPrograms: [{ name: 'dm.sas', folder: '(root)' }]
}, {
  runId: 'theirs',
  appliedAt: '2026-09-13T11:00:00.000Z',
  rootFolder: 'adam',
  user: { id: 'AJones', key: 'ajones', source: 'os' },
  programs: [Object.assign({}, programRecord, { name: 'adsl.sas' })],
  targetedPrograms: [{ name: 'adsl.sas', folder: '(root)' }]
}, {
  runId: 'legacy',
  appliedAt: '2026-09-13T12:00:00.000Z',
  rootFolder: 'tlf',
  user: { name: 'Legacy User', email: '' },
  programs: [Object.assign({}, programRecord, { name: 't-ae.sas' })],
  targetedPrograms: [{ name: 't-ae.sas', folder: '(root)' }]
}];

elements.runHistoryUser.value = '@me';
assert.deepStrictEqual(history.filterRunHistory(mixed).map(item => item.runId), ['mine']);

elements.runHistoryUser.value = '';
assert.deepStrictEqual(history.filterRunHistory(mixed).map(item => item.runId),
  ['mine', 'theirs', 'legacy']);

elements.runHistoryUser.value = '@none';
assert.deepStrictEqual(history.filterRunHistory(mixed).map(item => item.runId), ['legacy']);

history.state.author = { name: 'Profile Name', email: 'profile@example.com' };
assert.strictEqual(run.user.id, 'ExampleUser');
assert.strictEqual(run.user.name, '');

const nextRun = history.buildRunRecord(1, [programRecord], [{ name: 'dm.sas', relPath: 'dm.sas' }]);
assert.strictEqual(nextRun.user.id, 'ExampleUser');
assert.strictEqual(nextRun.user.name, 'Profile Name');

console.log('History user tests passed.');
