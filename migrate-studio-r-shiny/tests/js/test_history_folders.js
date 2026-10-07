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
const appSource = fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8');

global.window = global;
global.document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }
};
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'node-test' },
  configurable: true
});
global.MigDiff = { escapeHtml: value => String(value == null ? '' : value) };

vm.runInThisContext(appSource);

const {
  aggregateRunHistory,
  historySeries,
  historyFolderName
} = global.MigrateStudioHistory;

function run(runId, appliedAt, rootFolder, programName, applications) {
  return {
    runId,
    appliedAt,
    appliedAtLocal: appliedAt.slice(0, 10),
    rootFolder,
    folders: ['(root)'],
    programs: [{
      name: programName,
      relPath: programName,
      folder: '(root)',
      applications,
      lines: applications + 1,
      rules: ['R-001'],
      ruleApplications: { 'R-001': applications },
      details: []
    }]
  };
}

const runs = [
  run('r1', '2026-09-10T08:00:00Z', 'sdtm', 'dm.sas', 3),
  run('r2', '2026-09-11T08:00:00Z', 'adam', 'adsl.sas', 4),
  run('r3', '2026-09-11T09:00:00Z', 'adam', 'adae.sas', 5),
  run('r4', '2026-09-12T08:00:00Z', 'tlf', 't-ae.sas', 6),
  run('r5', '2026-09-12T09:00:00Z', 'tlf', 't-dm.sas', 7)
];

const model = aggregateRunHistory(runs);

assert.deepStrictEqual(model.folders, ['tlf', 'adam', 'sdtm']);
assert(!model.folders.includes('(root)'));

const chartFolders = Array.from(new Set(historySeries(model.byRun).map(point => point.folder)));
chartFolders.forEach(folder => {
  assert(model.folders.includes(folder), `${folder} should have a matching folder card`);
});

assert.strictEqual(Object.keys(model.byFolder.adam.runs).length, 2);
assert.strictEqual(Object.keys(model.byFolder.tlf.runs).length, 2);
assert.strictEqual(Object.keys(model.byFolder.sdtm.runs).length, 1);

const summedApplications = model.folders.reduce((sum, folder) => {
  return sum + model.byFolder[folder].applications;
}, 0);
assert.strictEqual(summedApplications, model.totalApplications);

assert.strictEqual(
  historyFolderName({ rootFolder: '' }, { folder: 'sdtm/derived' }),
  'sdtm/derived'
);
assert.strictEqual(historyFolderName({ rootFolder: '' }, {}), '(root)');

assert(
  appSource.includes("section.className = 'history-folder-section';"),
  'folder history should render a non-collapsible folder section'
);
assert(
  appSource.includes("section.appendChild(folderSummaryGroup(folder, showSubfolders, index, open));"),
  'folder section should append the summary card as its own child'
);
assert(
  appSource.includes("section.appendChild(historyProgramGroup(folder.byProgram[programName],"),
  'folder section should append program cards as siblings of the summary card'
);
assert(
  !appSource.includes('body.appendChild(historyProgramGroup('),
  'program cards must not be appended inside the summary card body'
);
assert(
  appSource.includes("var key = 'summary:' + folder.folder;") &&
    appSource.includes("var key = 'program:' + program.folder + ':'"),
  'summary and program cards should have independent history open-state keys'
);
assert(
  appSource.includes('state.historyOpenCards[group.dataset.historyKey] = open;'),
  'history toggle handler should persist open state per expandable card'
);

console.log('history folder tests passed');
