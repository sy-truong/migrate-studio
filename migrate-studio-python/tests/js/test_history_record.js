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

assert.strictEqual(history.folderKey({ relPath: 'sdtm/dm.sas' }), 'sdtm');
assert.strictEqual(history.folderKey({ relPath: 'dm.sas' }), '(root)');
assert.strictEqual(history.folderKey({ relPath: 'a/b/dm.sas' }), 'a/b');

const program = { name: 'sdtm/dm.sas', relPath: 'sdtm/dm.sas', dirRelPath: 'sdtm' };
const outcome = {
  versionId: 'v2',
  applied: 2,
  hits: [{
    id: 'O4',
    name: 'Standard Setup Macro',
    category: 'Other',
    severity: 'Medium',
    count: 1,
    details: [{
      type: 'add',
      originalLine: null,
      fixedLine: 12,
      before: '',
      after: '%setup;'
    }]
  }]
};
const record = history.runProgramRecord(program, outcome);
assert.strictEqual(record.folder, 'sdtm');
assert.strictEqual(record.versionId, 'v2');
assert.deepStrictEqual(record.rules, ['O4']);
assert.strictEqual(record.ruleCounts.O4, 1);
assert.deepStrictEqual(record.details[0], {
  ruleId: 'O4',
  ruleName: 'Standard Setup Macro',
  category: 'Other',
  severity: 'Medium',
  type: 'Added',
  originalLine: null,
  fixedLine: 12,
  before: '',
  after: '%setup;'
});

const runs = [{
  runId: 'r2',
  appliedAt: '2026-09-11T11:00:00.000Z',
  appliedAtLocal: '2026-09-11 07:00',
  rootFolder: 'sdtm',
  user: { name: 'Sy' },
  programs: [record]
}, {
  runId: 'r1',
  appliedAt: '2026-09-11T10:00:00.000Z',
  appliedAtLocal: '2026-09-11 06:00',
  rootFolder: 'sdtm',
  user: { name: '' },
  programs: [Object.assign({}, record, {
    applications: 1,
    ruleCounts: { O4: 1 },
    details: [Object.assign({}, record.details[0], { fixedLine: 14 })]
  })]
}];
const model = history.aggregateRunHistory(runs);
assert.strictEqual(model.folderCount, 1);
assert.strictEqual(model.programCount, 1);
assert.strictEqual(model.totals.applications, 3);
assert.strictEqual(model.totals.added, 2);
assert.strictEqual(model.rules[0].applications, 2);
assert.strictEqual(model.rules[0].programs, 1);
assert.strictEqual(model.folders[0].runs, 2);
assert.deepStrictEqual(history.historySeries(model.byRun).map(point => point.fixes), [1, 3]);
assert.deepStrictEqual(history.historySeries(model.byRun).map(point => point.folder), ['sdtm', 'sdtm']);

const coverage = history.aggregateRunHistory([Object.assign({}, runs[0], {
  targetedPrograms: [
    { name: 'sdtm/dm.sas', folder: 'sdtm' },
    { name: 'sdtm/ae.sas', folder: 'sdtm' }
  ]
})]);
assert.strictEqual(Object.keys(coverage.folders[0].programs).length, 2);
assert.strictEqual(Object.keys(coverage.folders[0].updatedPrograms).length, 1);
assert.strictEqual(coverage.targetedCount, 2);
assert.strictEqual(coverage.programCount, 1);

assert.strictEqual(history.mergeRuns([runs[0]], [runs[0], runs[1]]).length, 2);
assert.strictEqual(history.clip('x'.repeat(401)).length, 403);
assert.strictEqual(history.clip('short'), 'short');
assert.strictEqual(history.runBucket({}, { runId: 'a', rootFolder: 'sdtm' }).folder, 'sdtm');
assert.strictEqual(history.runBucket({}, { runId: 'a', folders: ['sdtm', 'adam'] }).folder, 'sdtm, adam');
assert.strictEqual(history.runBucket({}, { runId: 'a' }).folder, '(root)');

const series = history.historySeries({
  b: { runId: 'b', at: '2026-09-03', folder: 'sdtm', applications: 4, programs: { 'sdtm/dm.sas': true } },
  a: { runId: 'a', at: '2026-09-01', folder: 'sdtm', applications: 2, programs: { 'sdtm/dm.sas': true, 'sdtm/ae.sas': true } },
  c: { runId: 'c', at: '2026-09-05', folder: 'adam', applications: 1, programs: { 'adam/adsl.sas': true } }
});
assert.deepStrictEqual(series.map(point => point.runId), ['a', 'b', 'c']);
assert.deepStrictEqual(series.map(point => point.folder), ['sdtm', 'sdtm', 'adam']);
assert.deepStrictEqual(series.map(point => point.fixes), [2, 6, 7]);
assert.deepStrictEqual(series.map(point => point.programs), [2, 2, 3]);
assert.strictEqual(history.historySeries({}).length, 0);
assert.strictEqual(history.historySeries({
  only: { runId: 'only', at: '2026-09-01', folder: 'sdtm', applications: 3, programs: { 'sdtm/dm.sas': true } }
}).length, 1);
assert.strictEqual(history.clipLabel('tlf', 6), 'tlf');
assert.strictEqual(history.clipLabel('adam_efficacy', 6), 'adam_…');

assert.strictEqual(history.niceMax(447), 460);
assert.strictEqual(history.niceMax(3), 6);
assert.strictEqual(history.niceMax(1284), 1400);

assert.strictEqual(history.runChart(series.slice(0, 1)), '');
const chart = history.runChart(series);
assert.ok(chart.indexOf('chart-line-programs') !== -1);
assert.ok(chart.indexOf('chart-line-fixes') !== -1);
assert.ok(chart.indexOf('Programs updated') !== -1);
assert.ok(chart.indexOf('Total fixes applied') !== -1);
assert.ok(chart.indexOf('chart-folder') !== -1);
assert.ok(chart.indexOf('sdtm') !== -1);
assert.ok(chart.indexOf('adam') !== -1);
assert.strictEqual(chart.indexOf('Run 1'), -1);

console.log('History record tests passed.');
