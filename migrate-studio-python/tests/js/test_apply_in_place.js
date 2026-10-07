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
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};

const js = fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8');
vm.runInThisContext(js);

const history = global.MigrateStudioHistory;
const applyFixSource = js.slice(
  js.indexOf('function applyFixToSelection()'),
  js.indexOf('function revertProgram()')
);
const backupSource = js.slice(
  js.indexOf('function browserBackupFile('),
  js.indexOf('function originalBackupFile(')
);

assert.ok(applyFixSource.indexOf('confirmDialog(') === -1);
assert.ok(js.indexOf('function confirmInPlace') === -1);
assert.ok(applyFixSource.indexOf('requireWritableFolder') < applyFixSource.indexOf('readBackupIndex(targets)'));
assert.ok(applyFixSource.indexOf('readBackupIndex(targets)') < applyFixSource.indexOf('partitionTargets('));
assert.ok(applyFixSource.indexOf('partitionTargets(') < applyFixSource.indexOf('ensureOriginalBackup(targets)'));
assert.ok(applyFixSource.indexOf('ensureOriginalBackup(targets)') < applyFixSource.indexOf('writeInPlace(p)'));
assert.ok(js.indexOf('function ensureOriginalBackup(programs)') !== -1);
assert.ok(js.indexOf('function ensureOriginalBackupInBrowser(resolution, programs, rootToken)') !== -1);
assert.ok(js.indexOf('function readBackupIndex(programs)') !== -1);
assert.ok(js.includes('state.backupIndex = new Map();'));
assert.ok(js.includes('Apply Fix updates the checked programs in place'));
assert.ok(js.includes('Originals copied to '));
assert.ok(backupSource.includes("setLoading('Backing up originals…')"));
assert.ok(backupSource.includes('resolveBackupRootToken()'));
assert.ok(js.includes("postJson('api/backup/resolve'"));
assert.ok(backupSource.includes("postJson('api/backup/originals'"));
assert.ok(backupSource.includes('ensureOriginalBackupInBrowser'));
assert.ok(backupSource.includes('state.backupIndex = response.index || {};'));
assert.ok(backupSource.includes('program.handle.getFile()'));
assert.ok(backupSource.includes('writeDataToHandle(backupFile, file)'));
assert.ok(js.includes("postJson('api/backup/stamp'"));
assert.ok(js.includes("getFileHandle('_original_times.json'"));
assert.ok(backupSource.includes('response.failed && response.failed.length'));
assert.ok(backupSource.includes('throw error;'));
assert.ok(js.indexOf('Migrate Studio needs the full path of') === -1);

assert.strictEqual(history.isOutputFolderName('_migrate_original'), true);
assert.strictEqual(history.isOutputFolderName('Migrate_Studio'), true);
assert.strictEqual(history.isInsideOutputFolder('_migrate_original/adae.sas'), true);
assert.strictEqual(history.isInsideOutputFolder('adam/_migrate_original/adae.sas'), true);
assert.strictEqual(
  history.isInsideOutputFolder('STUDY_DST_TLF/MA_Testing/_migrate_original/t-ae.sas'),
  true
);
assert.strictEqual(history.isInsideOutputFolder('adam/adae.sas'), false);

history.state.folderName = 'adam';
history.state.folderPath = '/studies/EXAMPLE001/adam';
assert.strictEqual(
  history.summaryWorkbookTitle(),
  'Migrate Studio | Update Summary | /studies/EXAMPLE001/adam'
);
history.state.folderPath = '';
assert.strictEqual(
  history.summaryWorkbookTitle(),
  'Migrate Studio | Update Summary | adam'
);

function sas(relPath) {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const at = clean.lastIndexOf('/');
  return {
    name: clean,
    relPath: clean,
    dirRelPath: at < 0 ? '' : clean.slice(0, at),
    fixed: null,
    versions: []
  };
}

function backupIndex(rows) {
  const map = new Map();
  Object.keys(rows).forEach(dir => map.set(dir, new Set(rows[dir])));
  return map;
}

const samplePrograms = [
  sas('adam_t_demog.sas'),
  sas('root_dm.sas'),
  sas('root_ae.sas'),
  sas('STUDY_SRC_ADAM/adsl.sas'),
  sas('STUDY_SRC_ADAM/adae.sas'),
  sas('STUDY_SRC_SDTM/dm.sas'),
  sas('STUDY_SRC_TLF/t-ae.sas'),
  sas('STUDY_DST_SDTM/dm.sas'),
  sas('STUDY_DST_SDTM/test_tool/tool_dm.sas'),
  sas('STUDY_DST_TLF/t-demog.sas'),
  sas('STUDY_DST_TLF/MA_Testing/t-ae.sas'),
  sas('STUDY_SRC_ADAM/Migrate_Studio/ignored.sas'),
  sas('STUDY_SRC_ADAM/PortFix/ignored.sas'),
  sas('STUDY_DST_TLF/MA_Testing/_migrate_original/ignored.sas')
].filter(program => !history.isInsideOutputFolder(program.relPath));

const groups = history.groupProgramsByDirectory(samplePrograms);
assert.deepStrictEqual(groups.map(group => group.dirRelPath), [
  '',
  'STUDY_DST_SDTM',
  'STUDY_DST_SDTM/test_tool',
  'STUDY_DST_TLF',
  'STUDY_DST_TLF/MA_Testing',
  'STUDY_SRC_ADAM',
  'STUDY_SRC_SDTM',
  'STUDY_SRC_TLF'
]);

assert.strictEqual(
  history.backupRelPathFor(sas('STUDY_DST_TLF/MA_Testing/t-ae.sas')),
  'STUDY_DST_TLF/MA_Testing/_migrate_original/t-ae.sas'
);
assert.strictEqual(
  history.backupRelPathFor(sas('adam_t_demog.sas')),
  '_migrate_original/adam_t_demog.sas'
);

const maTesting = groups.filter(group => group.dirRelPath === 'STUDY_DST_TLF/MA_Testing')[0];
const sceTlf = groups.filter(group => group.dirRelPath === 'STUDY_DST_TLF')[0];
assert.deepStrictEqual(maTesting.programs.map(program => program.name), [
  'STUDY_DST_TLF/MA_Testing/t-ae.sas'
]);
assert.strictEqual(
  sceTlf.programs.some(program => program.name === 'STUDY_DST_TLF/MA_Testing/t-ae.sas'),
  false
);

const adsl = sas('adsl.sas');
const adae = sas('adae.sas');
const adlb = sas('adlb.sas');

assert.strictEqual(history.inPlaceApplied(adsl, backupIndex({ '': ['adsl.sas'] }), []), true);

const applyRun = {
  runId: 'apply',
  action: 'apply-fix-in-place',
  appliedAt: '2026-09-15T10:00:00.000Z',
  rootFolder: 'adam',
  programs: [{ name: 'adae.sas', relPath: 'adae.sas' }]
};
assert.strictEqual(history.inPlaceApplied(adae, new Map(), [applyRun]), true);
assert.strictEqual(history.inPlaceApplied(adae, new Map(), [
  Object.assign({}, applyRun, { rootFolder: 'sdtm' })
]), false);

const cdrDm = sas('STUDY_SRC_SDTM/dm.sas');
const sceDm = sas('STUDY_DST_SDTM/dm.sas');
assert.strictEqual(
  history.inPlaceApplied(cdrDm, backupIndex({ 'STUDY_SRC_SDTM': ['dm.sas'] }), []),
  true
);
assert.strictEqual(
  history.inPlaceApplied(sceDm, backupIndex({ 'STUDY_SRC_SDTM': ['dm.sas'] }), []),
  false
);

const newSdtmProgram = sas('STUDY_SRC_SDTM/new_dm.sas');
assert.strictEqual(
  history.inPlaceApplied(newSdtmProgram, backupIndex({ 'STUDY_SRC_SDTM': ['dm.sas'] }), []),
  false
);

const partition = history.partitionTargets(
  [adsl, adae, adlb],
  backupIndex({ '': ['adsl.sas'] }),
  [applyRun]
);
assert.deepStrictEqual(partition.applied.map(program => program.name), ['adsl.sas', 'adae.sas']);
assert.deepStrictEqual(partition.pending.map(program => program.name), ['adlb.sas']);

const revertRun = {
  runId: 'revert',
  action: 'revert-in-place',
  appliedAt: '2026-09-15T11:00:00.000Z',
  rootFolder: 'adam',
  programs: [{ name: 'adae.sas', relPath: 'adae.sas' }]
};
assert.strictEqual(history.inPlaceApplied(adae, new Map(), [applyRun, revertRun]), false);

const locallyFixed = {
  name: 'local.sas',
  relPath: 'local.sas',
  fixed: 'data x; run;',
  versions: [{ id: 'v1', reverted: false }]
};
assert.strictEqual(history.inPlaceApplied(locallyFixed, new Map(), []), true);

const locallyReverted = {
  name: 'local.sas',
  relPath: 'local.sas',
  fixed: null,
  versions: [{ id: 'v2', reverted: true }, { id: 'v1', reverted: false }]
};
assert.strictEqual(history.inPlaceApplied(locallyReverted, new Map(), []), false);

history.state.identity = { userId: 'testuser', userKey: 'testuser', source: 'os' };
history.state.programs = samplePrograms;
history.state.lastBackupInfo = {
  mode: 'server-copy2',
  datesPreserved: true,
  resolution: 'search'
};
history.state.mcRules = {
  kind: 'mc',
  source: 'migration_rules.json',
  macroVersion: '4.30',
  rules: [{ row: 1, id: 'O4', selected: true, executable: true, enabled: true }]
};
const runRecord = history.buildRunRecord(1, [{
  name: 'adlb.sas',
  relPath: 'adlb.sas',
  folder: '(root)',
  applications: 1,
  lines: 0,
  rules: ['O4'],
  ruleCounts: { O4: 1 },
  details: []
}], [adlb]);
assert.strictEqual(runRecord.action, 'apply-fix-in-place');
assert.deepStrictEqual(runRecord.backupFolders, [
  '(root)',
  'STUDY_DST_SDTM',
  'STUDY_DST_SDTM/test_tool',
  'STUDY_DST_TLF',
  'STUDY_DST_TLF/MA_Testing',
  'STUDY_SRC_ADAM',
  'STUDY_SRC_SDTM',
  'STUDY_SRC_TLF'
]);
assert.strictEqual(Object.prototype.hasOwnProperty.call(runRecord, 'backupFolder'), false);
assert.strictEqual(runRecord.inPlace, true);
assert.strictEqual(runRecord.backupMode, 'server-copy2');
assert.strictEqual(runRecord.backupDatesPreserved, true);
assert.strictEqual(runRecord.backupResolution, 'search');
assert.strictEqual(runRecord.rootPath, '');

history.state.lastBackupInfo = {
  mode: 'browser',
  datesPreserved: false,
  resolution: 'unresolved',
  dateFailed: [{ folder: '', name: 'adlb.sas' }],
  stamped: false,
  stampMode: 'browser'
};
const browserRunRecord = history.buildRunRecord(1, [], [adlb]);
assert.strictEqual(browserRunRecord.backupMode, 'browser');
assert.strictEqual(browserRunRecord.backupDatesPreserved, false);
assert.strictEqual(browserRunRecord.backupResolution, 'unresolved');
assert.deepStrictEqual(browserRunRecord.dateFailed, [{ folder: '', name: 'adlb.sas' }]);
assert.strictEqual(browserRunRecord.backupStamped, false);
assert.strictEqual(browserRunRecord.backupStampMode, 'browser');

console.log('apply in-place tests passed');
