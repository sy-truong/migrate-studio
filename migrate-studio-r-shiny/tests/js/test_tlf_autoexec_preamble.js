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
global.fflate = require(path.join(ASSET_ROOT, 'js/vendor/fflate.min.js'));
vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/mig-excel.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/mig-rules.js'), 'utf8'));

const workbook = MigExcel.read(fs.readFileSync(path.join(ROOT, 'rules/Migrate_Studio_Rules.xlsx')));
const book = MigRules.parse(workbook, 'rules/Migrate_Studio_Rules.xlsx');
const rule = book.rules.find(candidate => candidate.id === 'R-036');

assert(rule, 'R-036 should parse from the workbook');
assert.strictEqual(rule.selected, true, 'R-036 should start selected');
assert.strictEqual(rule.mode, 'special');

function apply(text, filename) {
  book.rules.forEach(candidate => { candidate.selected = candidate.id === 'R-036'; });
  return MigRules.apply(book, text, filename);
}

{
  const source = [
    '/*********************************/',
    'options symbolgen mprint mlogic;',
    '%let studyid = EXAMPLE002;',
    '',
    '%macro demo;',
    '%mend;',
  ].join('\n');
  const result = apply(source, 'STUDY_SRC_TLF/autoexec.sas');

  assert.strictEqual(result.total, 1);
  assert(result.text.includes('/* TLF AUTOEXEC - target SCE Migration'));
  assert(result.text.includes('%include "&targetStudy.\\Dev\\Programs\\SDTM\\autoexec.sas";'));
  assert(result.text.includes('%let macro=%str(&targetStudy.\\Dev\\Programs\\TLF\\primary\\macros);'));
  assert(result.text.indexOf('/* TLF AUTOEXEC') < result.text.indexOf('%macro demo;'));
  assert.strictEqual(apply(result.text, 'STUDY_SRC_TLF/autoexec.sas').total, 0);
}

{
  const source = 'options symbolgen;\n%let studyid = EXAMPLE002;\n';
  assert.strictEqual(apply(source, 'STUDY_SRC_SDTM/autoexec.sas').total, 0);
  assert.strictEqual(apply(source, 'STUDY_SRC_TLF/listing.sas').total, 0);
}

console.log('TLF autoexec preamble tests passed.');
