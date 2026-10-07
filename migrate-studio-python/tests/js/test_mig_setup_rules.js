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
vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/mig-rules.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/mig-mc-rules.js'), 'utf8'));

const spec = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'rules/migration_rules.json'), 'utf8'));
const house = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'rules/migrate_studio_rules.json'), 'utf8'));
const book = MigMcRules.parse(spec, 'migration_rules.json', house);

const ids = new Set(book.rules.map(rule => rule.id));
assert.strictEqual(house.rules.length, 0);
assert.strictEqual([...ids].some(id => /^U\\d+/.test(id)), false);
assert.strictEqual(ids.has('M1'), false);
assert.strictEqual(ids.has('M2'), false);

const source = [
  '/***************************************************************************',
  ' * PROGRAM NAME:     setup',
  ' *************************************************************************/',
  '%LET STUDY=EXAMPLE001;',
  'libname raw "&rawpath./vendor" access=readonly;',
  'data demo; run;'
].join('\\n');

book.rules.forEach(rule => { rule.selected = /^U\\d+$|^M[12]$/.test(rule.id); });
const result = MigMcRules.apply(book, source, 'setup.sas', {
  osFamily: 'LINUX',
  programPath: 'dev_state/modules/setup.sas',
  programDir: 'dev_state/modules',
  pathRoot: '/studies/EXAMPLE001',
  operator: 'SYNTH',
  runDate: '01JAN2026',
  listDir: () => null
});

assert.strictEqual(result.total, 0);
assert.strictEqual(result.rename, null);
assert.strictEqual(result.text, source);

console.log('public setup rule pack tests passed.');
