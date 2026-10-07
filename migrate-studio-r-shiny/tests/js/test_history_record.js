/*
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const assert = require('assert');

const HISTORY_TEXT_MAX = 400;

function cleanRelPath(path) {
  return String(path || '').replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function relDir(path) {
  const clean = cleanRelPath(path);
  const at = clean.lastIndexOf('/');
  return at < 0 ? '' : clean.slice(0, at);
}

function folderKey(program) {
  const dir = cleanRelPath(program.dirRelPath != null
    ? program.dirRelPath : relDir(program.relPath || program.name));
  return dir || '(root)';
}

function clip(value) {
  const text = value == null ? '' : String(value);
  return text.length > HISTORY_TEXT_MAX
    ? text.slice(0, HISTORY_TEXT_MAX) + '...' : text;
}

function mergeRuns(fileRuns, localRuns) {
  const byId = {};
  (localRuns || []).forEach(run => {
    if (run && run.runId) byId[run.runId] = run;
  });
  (fileRuns || []).forEach(run => {
    if (run && run.runId) byId[run.runId] = Object.assign({}, run, { localOnly: false });
  });
  return Object.keys(byId).map(id => byId[id])
    .sort((a, b) => String(b.appliedAt || '').localeCompare(String(a.appliedAt || '')));
}

function runBucket(store, run) {
  let entry = store[run.runId];
  if (!entry) {
    entry = {
      runId: run.runId,
      at: run.appliedAt || '',
      folder: run.rootFolder || (run.folders || []).join(', ') || '(root)',
      applications: 0,
      programs: {}
    };
    store[run.runId] = entry;
  }
  return entry;
}

function historySeries(byRun) {
  const seen = {};
  let fixes = 0;
  return Object.keys(byRun || {}).map(id => byRun[id])
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) ||
      String(a.runId).localeCompare(String(b.runId)))
    .map((entry, index) => {
      fixes += entry.applications || 0;
      Object.keys(entry.programs).forEach(key => { seen[key] = true; });
      return {
        index: index + 1,
        runId: entry.runId,
        folder: entry.folder || '(root)',
        programs: Object.keys(seen).length,
        fixes
      };
    });
}

function clipLabel(text, maxChars) {
  const value = String(text || '');
  return value.length <= maxChars ? value
    : value.slice(0, Math.max(1, maxChars - 1)) + '\u2026';
}

function aggregateRunHistory(runs) {
  const byFolder = {};
  const allPrograms = {};
  let totalApplications = 0;

  function empty(folder) {
    return byFolder[folder] || (byFolder[folder] = {
      folder,
      programs: {},
      programsUpdated: {},
      applications: 0,
      lines: 0
    });
  }

  (runs || []).forEach(run => {
    (run.programs || []).forEach(program => {
      const folder = program.folder || '(root)';
      const item = empty(folder);
      const key = program.relPath || program.name;
      item.programs[key] = true;
      item.programsUpdated[key] = true;
      item.applications += program.applications || 0;
      item.lines += program.lines || 0;
      allPrograms[folder + '/' + key] = true;
      totalApplications += program.applications || 0;
    });
  });

  return {
    folderCount: Object.keys(byFolder).filter(folder => byFolder[folder].applications > 0).length,
    programCount: Object.keys(allPrograms).length,
    totalApplications,
    byFolder
  };
}

assert.strictEqual(folderKey({ relPath: 'sdtm/dm.sas' }), 'sdtm');
assert.strictEqual(folderKey({ relPath: 'dm.sas' }), '(root)');
assert.strictEqual(folderKey({ relPath: 'a/b/dm.sas' }), 'a/b');

assert.strictEqual(clip('short'), 'short');
assert.strictEqual(clip('x'.repeat(401)), 'x'.repeat(400) + '...');

const merged = mergeRuns(
  [{ runId: 'same', appliedAt: '2026-09-11T10:00:00Z' }],
  [
    { runId: 'local', appliedAt: '2026-09-11T11:00:00Z', localOnly: true },
    { runId: 'same', appliedAt: '2026-09-11T09:00:00Z', localOnly: true }
  ]
);
assert.deepStrictEqual(merged.map(run => run.runId), ['local', 'same']);
assert.strictEqual(merged.find(run => run.runId === 'same').localOnly, false);

const model = aggregateRunHistory([
  {
    runId: 'one',
    programs: [
      { name: 'sdtm/dm.sas', relPath: 'sdtm/dm.sas', folder: 'sdtm', applications: 2, lines: 3 }
    ]
  },
  {
    runId: 'two',
    programs: [
      { name: 'sdtm/dm.sas', relPath: 'sdtm/dm.sas', folder: 'sdtm', applications: 4, lines: 5 }
    ]
  }
]);
assert.strictEqual(model.folderCount, 1);
assert.strictEqual(model.programCount, 1);
assert.strictEqual(model.totalApplications, 6);
assert.strictEqual(model.byFolder.sdtm.applications, 6);

assert.strictEqual(runBucket({}, { runId: 'a', rootFolder: 'sdtm' }).folder, 'sdtm');
assert.strictEqual(runBucket({}, { runId: 'a', folders: ['sdtm', 'adam'] }).folder, 'sdtm, adam');
assert.strictEqual(runBucket({}, { runId: 'a' }).folder, '(root)');

const series = historySeries({
  b: { runId: 'b', at: '2026-09-03', folder: 'sdtm', applications: 4, programs: { 'sdtm/dm.sas': true } },
  a: { runId: 'a', at: '2026-09-01', folder: 'sdtm', applications: 2, programs: { 'sdtm/dm.sas': true, 'sdtm/ae.sas': true } },
  c: { runId: 'c', at: '2026-09-05', folder: 'adam', applications: 1, programs: { 'adam/adsl.sas': true } }
});
assert.deepStrictEqual(series.map(point => point.runId), ['a', 'b', 'c']);
assert.deepStrictEqual(series.map(point => point.folder), ['sdtm', 'sdtm', 'adam']);
assert.deepStrictEqual(series.map(point => point.fixes), [2, 6, 7]);
assert.deepStrictEqual(series.map(point => point.programs), [2, 2, 3]);
assert.strictEqual(historySeries({}).length, 0);
assert.strictEqual(historySeries({
  only: { runId: 'only', at: '2026-09-01', folder: 'sdtm', applications: 3, programs: { 'sdtm/dm.sas': true } }
}).length, 1);

assert.strictEqual(clipLabel('tlf', 6), 'tlf');
assert.strictEqual(clipLabel('adam_efficacy', 6), 'adam_\u2026');

console.log('history record tests passed');
