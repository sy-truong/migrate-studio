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
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};

vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8'));

const history = global.MigrateStudioHistory;
const book = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'history.sample.json'), 'utf8'));
const model = history.aggregateRunHistory(book.runs);
const expectedByFolder = {};
book.runs.forEach(run => {
  const folder = run.rootFolder || '(root)';
  if (!expectedByFolder[folder]) expectedByFolder[folder] = { lastAt: '', runIds: new Set() };
  if (String(run.appliedAt || '') > expectedByFolder[folder].lastAt) {
    expectedByFolder[folder].lastAt = String(run.appliedAt || '');
  }
  expectedByFolder[folder].runIds.add(run.runId);
});
const expectedFolders = Object.keys(expectedByFolder)
  .sort((a, b) => expectedByFolder[b].lastAt.localeCompare(expectedByFolder[a].lastAt));

assert.deepStrictEqual(model.folders.map(folder => folder.folder), expectedFolders);
assert(!model.folders.some(folder => folder.folder === '(root)'));

const cardFolders = new Set(model.folders.map(folder => folder.folder));
const chartFolders = Array.from(new Set(
  history.historySeries(model.byRun).map(point => point.folder)
));
chartFolders.forEach(folder => {
  assert(cardFolders.has(folder), folder + ' chart label is missing a card');
});

const byName = Object.fromEntries(model.folders.map(folder => [folder.folder, folder]));
Object.keys(expectedByFolder).forEach(folder => {
  assert.strictEqual(byName[folder].runs, expectedByFolder[folder].runIds.size);
});
assert.strictEqual(model.folders.reduce((sum, folder) => sum + folder.applications, 0),
  model.totals.applications);

const adamCards = history.historyFolderCardPlan(byName.adam || model.folders[0]);
assert.strictEqual(adamCards[0].kind, 'summary');
assert.strictEqual(adamCards[0].key,
  history.historyCardKey('summary', byName.adam ? 'adam' : model.folders[0].folder));
assert.strictEqual(adamCards.filter(card => card.kind === 'summary').length, 1);
assert(adamCards.slice(1).every(card => card.kind === 'program'));
assert(adamCards.slice(1).every(card => card.key.indexOf('program:') === 0));
assert.strictEqual(new Set(adamCards.map(card => card.key)).size, adamCards.length);
assert(!Object.prototype.hasOwnProperty.call(adamCards[0], 'program'));

const nested = history.aggregateRunHistory([{
  runId: 'nested',
  appliedAt: '2026-09-13T12:00:00.000Z',
  rootFolder: '',
  programs: [{
    name: 'ae.sas',
    folder: 'sdtm/derived',
    applications: 1,
    lines: 1,
    rules: ['O4'],
    ruleCounts: { O4: 1 },
    details: []
  }]
}]);
assert.strictEqual(nested.folders[0].folder, 'sdtm/derived');
assert.strictEqual(nested.folders[0].byProgram['ae.sas'].subfolder, 'sdtm/derived');

const unnamed = history.aggregateRunHistory([{
  runId: 'unnamed',
  appliedAt: '2026-09-13T12:00:00.000Z',
  rootFolder: '',
  programs: [{
    name: 'dm.sas',
    applications: 1,
    lines: 1,
    rules: ['O4'],
    ruleCounts: { O4: 1 },
    details: []
  }]
}]);
assert.strictEqual(unnamed.folders[0].folder, '(root)');

console.log('History folder tests passed.');
