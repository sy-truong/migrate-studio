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

const appSource = fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8');
vm.runInThisContext(appSource);

const {
  inPlaceApplied,
  partitionTargets,
  groupProgramsByDirectory,
  backupRelPathFor,
  backupRequestDirectories,
  backupFingerprint,
  backupIndexFromResponse,
  isOutputFolderName,
  isInsideOutputFolder
} = global.MigrateStudioHistory;

const applyStart = appSource.indexOf('function applyFixToSelection()');
const applyEnd = appSource.indexOf('function revertProgram()', applyStart);
assert(applyStart !== -1 && applyEnd !== -1, 'applyFixToSelection source should be present');
const applySource = appSource.slice(applyStart, applyEnd);

assert(
  !appSource.includes('function confirmInPlace'),
  'Apply Fix should not have a first-run confirmation helper'
);
assert(
  !/confirmDialog\s*\(/.test(applySource) && !/confirmInPlace\s*\(/.test(applySource),
  'Apply Fix path must not call confirmDialog or confirmInPlace'
);
assert(
  !/promptForBackupRoot|window\.prompt|api\/backup\/validate-root|backupRootPrefs/.test(appSource),
  'Apply Fix should not prompt for or store a manually entered backup path'
);
assert(
  applySource.indexOf('requireWritableFolder') !== -1 &&
    applySource.indexOf('readBackupIndex(targets)') !== -1 &&
    applySource.indexOf('ensureOriginalBackup(targets)') !== -1,
  'Apply Fix should still require write access, read the backup index, and back up originals'
);
assert(
  applySource.indexOf('requireWritableFolder') <
    applySource.indexOf('readBackupIndex(targets)') &&
    applySource.indexOf('readBackupIndex(targets)') <
    applySource.indexOf('ensureOriginalBackup(targets)'),
  'Apply Fix should gate writes, then read backup markers, before creating backups'
);
assert(
  applySource.includes('if (!granted) return null;'),
  'read-only folders should stop before backup creation and writes'
);
assert(
  applySource.indexOf('ensureOriginalBackup(targets)') <
    applySource.indexOf('writeInPlace(p)'),
  'backup failures must abort before fixed programs are written in place'
);
assert(
  /api\/backup\/stamp/.test(appSource) &&
    /_original_times\.json/.test(appSource),
  'browser fallback should record original times and use the stamp endpoint when possible'
);

function program(relPath) {
  const dir = relPath.includes('/') ? relPath.replace(/\/[^/]+$/, '') : '';
  return { name: relPath, relPath, dirRelPath: dir, fixed: null, versions: [] };
}

const fixture = [
  program('adam_t_demog.sas'),
  program('root_a.sas'),
  program('root_b.sas'),
  program('STUDY_SRC_ADAM/adae.sas'),
  program('STUDY_SRC_ADAM/adsl.sas'),
  program('STUDY_SRC_SDTM/dm.sas'),
  program('STUDY_SRC_TLF/t-ae.sas'),
  program('STUDY_DST_SDTM/dm.sas'),
  program('STUDY_DST_SDTM/test_tool/check.sas'),
  program('STUDY_DST_TLF/t-demog.sas'),
  program('STUDY_DST_TLF/MA_Testing/t-ae.sas')
];

const grouped = groupProgramsByDirectory(fixture);
assert.deepStrictEqual(grouped.map(group => group.dirRelPath), [
  '',
  'STUDY_DST_SDTM',
  'STUDY_DST_SDTM/test_tool',
  'STUDY_DST_TLF',
  'STUDY_DST_TLF/MA_Testing',
  'STUDY_SRC_ADAM',
  'STUDY_SRC_SDTM',
  'STUDY_SRC_TLF'
]);

assert.deepStrictEqual(
  grouped.find(group => group.dirRelPath === 'STUDY_DST_TLF/MA_Testing')
    .programs.map(item => item.name),
  ['STUDY_DST_TLF/MA_Testing/t-ae.sas']
);
assert.deepStrictEqual(
  grouped.find(group => group.dirRelPath === 'STUDY_DST_TLF')
    .programs.map(item => item.name),
  ['STUDY_DST_TLF/t-demog.sas']
);

global.MigrateStudioHistory.state.folderName = 'adam';
global.MigrateStudioHistory.state.folderPath = '/studies/EXAMPLE002/adam';
assert.strictEqual(
  global.MigrateStudioHistory.summaryWorkbookTitle(),
  'Migrate Studio | Update Summary | /studies/EXAMPLE002/adam'
);
global.MigrateStudioHistory.state.folderPath = '';
assert.strictEqual(
  global.MigrateStudioHistory.summaryWorkbookTitle(),
  'Migrate Studio | Update Summary | adam'
);

assert.strictEqual(isOutputFolderName('_migrate_original'), true);
assert.strictEqual(
  isInsideOutputFolder('STUDY_DST_TLF/MA_Testing/_migrate_original/t-ae.sas'),
  true
);

assert(
  appSource.includes("entry.kind === 'file' && /\\.sas$/i.test(entry.name)"),
  'readBackupIndex should collect only .sas files'
);

assert.strictEqual(
  backupRelPathFor(program('STUDY_DST_TLF/MA_Testing/t-ae.sas')),
  'STUDY_DST_TLF/MA_Testing/_migrate_original/t-ae.sas'
);
assert.strictEqual(
  backupRelPathFor(program('adam_t_demog.sas')),
  '_migrate_original/adam_t_demog.sas'
);

assert.deepStrictEqual(backupRequestDirectories([
  program('STUDY_SRC_SDTM/dm.sas'),
  program('STUDY_SRC_SDTM/ae.sas'),
  program('adam_t_demog.sas')
]), [
  { folder: '', files: ['adam_t_demog.sas'] },
  { folder: 'STUDY_SRC_SDTM', files: ['ae.sas', 'dm.sas'] }
]);

assert.deepStrictEqual(backupFingerprint([
  Object.assign(program('STUDY_SRC_SDTM/dm.sas'), { size: 9133, modified: 1725900461000 }),
  Object.assign(program('adam_t_demog.sas'), { size: 4821, modified: 1725900000000 })
]), {
  '': [{ name: 'adam_t_demog.sas', size: 4821, lastModified: 1725900000000 }],
  STUDY_SRC_SDTM: [{ name: 'dm.sas', size: 9133, lastModified: 1725900461000 }]
});

const responseIndex = backupIndexFromResponse({
  '': ['adam_t_demog.sas'],
  STUDY_SRC_SDTM: ['ae.sas', 'dm.sas']
});
assert.strictEqual(responseIndex.get('').has('adam_t_demog.sas'), true);
assert.strictEqual(responseIndex.get('STUDY_SRC_SDTM').has('dm.sas'), true);

const ensureStart = appSource.indexOf('function ensureOriginalBackup(programs)');
const ensureEnd = appSource.indexOf('function writeInPlace', ensureStart);
const ensureSource = appSource.slice(ensureStart, ensureEnd);
assert(ensureSource.includes("postJson('api/backup/originals'"),
  'browser backup should call the server copy2 endpoint');
assert(appSource.includes("postJson('api/backup/resolve'"),
  'browser backup should first ask the server to resolve the folder fingerprint');
assert(ensureSource.includes('resolveBackupRoot(programs)'),
  'ensureOriginalBackup should begin with fingerprint resolution');
assert(ensureSource.includes('backupOriginalsInBrowser(programs,'),
  'unresolved server resolution should fall back to the browser copy path');
assert(!/writeOriginalManifest/.test(ensureSource),
  'browser backup should not write backup manifests');
assert(ensureSource.includes('rootToken') &&
    appSource.includes("postJson('api/backup/stamp'"),
  'browser fallback should carry the resolution token into the stamp call when available');
assert(
  ensureSource.includes('state.backupIndex = backupIndexFromResponse(result.index || {});'),
  'server response index should populate state.backupIndex without another walk'
);
assert(
  ensureSource.indexOf('resolveBackupRoot(programs)') <
    ensureSource.indexOf("postJson('api/backup/originals'"),
  'server copy should happen only after fingerprint resolution'
);
assert(
  appSource.includes("backupMode: 'server-copy'") &&
    appSource.includes("backupMode: serverMode ? 'server-fallback' : 'browser'"),
  'run records should distinguish server, server fallback, and browser backup modes'
);
assert(
  appSource.includes('result.datesPreserved !== false') &&
    appSource.includes('backupDatesPreserved: !dateFailed.length') &&
    appSource.includes('dateFailed:') &&
    appSource.includes('backupResolution:'),
  'run records should say whether backup dates were preserved, which failed, and how resolution happened'
);

assert.strictEqual(
  inPlaceApplied(program('STUDY_SRC_SDTM/dm.sas'), [],
    new Map([['STUDY_SRC_SDTM', new Set(['dm.sas'])]]), 'samples'),
  true,
  'backup marker alone should mark a program as already applied'
);

assert.strictEqual(
  inPlaceApplied(program('STUDY_DST_SDTM/dm.sas'), [],
    new Map([['STUDY_SRC_SDTM', new Set(['dm.sas'])]]), 'samples'),
  false,
  'same file names in different directories must not share backup markers'
);

assert.strictEqual(
  inPlaceApplied(program('adam/adae.sas'), [{
    action: 'apply-fix-in-place',
    rootFolder: 'adam',
    appliedAt: '2026-09-14T10:00:00Z',
    programs: [{ relPath: 'adam/adae.sas' }]
  }], new Map(), 'adam'),
  true,
  'matching in-place history run should mark a program as already applied'
);

assert.strictEqual(
  inPlaceApplied(program('adam/adae.sas'), [{
    action: 'apply-fix-in-place',
    rootFolder: 'sdtm',
    appliedAt: '2026-09-14T10:00:00Z',
    programs: [{ relPath: 'adam/adae.sas' }]
  }], new Map(), 'adam'),
  false,
  'history from another picked folder should not mark this program applied'
);

const mixed = partitionTargets([
  program('adam/adae.sas'),
  program('adam/adsl.sas')
], [], new Map([['adam', new Set(['adae.sas'])]]), 'adam');
assert.deepStrictEqual(mixed.applied.map(p => p.name), ['adam/adae.sas']);
assert.deepStrictEqual(mixed.pending.map(p => p.name), ['adam/adsl.sas']);

const addedProgram = partitionTargets([
  program('adam/new.sas')
], [], new Map([['adam', new Set(['adae.sas'])]]), 'adam');
assert.deepStrictEqual(addedProgram.applied.map(p => p.name), []);
assert.deepStrictEqual(addedProgram.pending.map(p => p.name), ['adam/new.sas']);

assert.strictEqual(
  inPlaceApplied(program('adam/adae.sas'), [
    {
      action: 'apply-fix-in-place',
      rootFolder: 'adam',
      appliedAt: '2026-09-14T10:00:00Z',
      programs: [{ relPath: 'adam/adae.sas' }]
    },
    {
      action: 'revert-in-place',
      rootFolder: 'adam',
      appliedAt: '2026-09-14T11:00:00Z',
      programs: [{ relPath: 'adam/adae.sas' }]
    }
  ], new Map(), 'adam'),
  false,
  'a later in-place revert should leave the program eligible again'
);

console.log('apply-in-place tests passed');
