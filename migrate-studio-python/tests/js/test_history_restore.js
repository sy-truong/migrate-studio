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

const h = global.MigrateStudioHistory;
h.state.folderName = 'sdtm';

function program(overrides = {}) {
  return Object.assign({
    name: 'dm.sas',
    relPath: 'dm.sas',
    dirRelPath: '',
    original: 'FIXED',
    fixed: null,
    hits: [],
    fixCount: 0,
    versions: []
  }, overrides);
}

function detail(type) {
  return {
    ruleId: 'S5',
    ruleName: 'Windows path backslash',
    type,
    originalLine: 1,
    fixedLine: 1,
    before: 'a\\b',
    after: 'a/b'
  };
}

function run(id, at, action, details, extra = {}) {
  return Object.assign({
    runId: id,
    appliedAt: at,
    action,
    rootFolder: 'sdtm',
    programs: [{
      name: 'dm.sas',
      relPath: 'dm.sas',
      applications: 2,
      lines: details.length,
      rules: ['S5'],
      ruleCounts: { S5: 2 },
      ruleMeta: { S5: { name: 'Windows path backslash', category: 'Paths' } },
      details
    }]
  }, extra);
}

const index = new Map([['', new Set(['dm.sas'])]]);

{
  const p = program();
  const restored = h.restorePriorRun([p], index, [
    run('a', '2026-09-01', 'apply-fix-in-place', [detail('Modified'), detail('Added')]),
    run('x', '2026-09-02', 'apply-fix', [detail('Modified')]),
    run('b', '2026-09-03', 'apply-fix-in-place', [detail('Deleted')],
      { rootFolder: 'adam' })
  ]);

  assert.strictEqual(restored, 1);
  assert.strictEqual(p.fixCount, 2);
  assert.strictEqual(p.fixed, 'FIXED');
  assert.strictEqual(p.original, null);
  assert.deepStrictEqual(p.fromHistory.stats,
    { changed: 1, added: 1, removed: 0, total: 2 });
  assert.deepStrictEqual(p.fromHistory.runs, ['a']);
  assert.strictEqual(p.hits[0].id, 'S5');
  assert.strictEqual(p.hits[0].details.length, 2);
}

{
  const p = program();
  h.restorePriorRun([p], index, [
    run('a', '2026-09-01', 'apply-fix-in-place', [detail('Modified')]),
    run('r', '2026-09-02', 'revert-in-place', [])
  ]);
  assert.strictEqual(p.fixCount, 0);
  assert.strictEqual(p.fixed, null);
}

{
  const p = program();
  h.restorePriorRun([p], new Map(), [
    run('a', '2026-09-01', 'apply-fix-in-place', [detail('Modified')])
  ]);
  assert.strictEqual(p.fixCount, 0);
  assert.strictEqual(p.fixed, null);
}

{
  const p = program({ name: 'local_setup.sas', relPath: 'local_setup.sas' });
  h.restorePriorRun([p], new Map([['', new Set(['setup.sas'])]]), [
    run('a', '2026-09-01', 'apply-fix-in-place', [detail('Modified')], {
      programs: [{
        name: 'local_setup.sas',
        relPath: 'local_setup.sas',
        renamed_from: 'setup.sas',
        applications: 1,
        lines: 1,
        rules: ['U3'],
        ruleCounts: { U3: 1 },
        ruleMeta: { U3: { name: 'Build local_setup from source platform setup' } },
        details: [Object.assign(detail('Modified'), { ruleId: 'U3' })]
      }]
    })
  ]);
  assert.strictEqual(p.fixCount, 1);
  assert.strictEqual(p.originalBackupName, 'setup.sas');
}

console.log('history restore tests passed');
