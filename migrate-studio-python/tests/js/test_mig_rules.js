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
const allIds = book.rules.map(rule => rule.id);
const sampleRoot = path.join(ROOT, 'samples/EXAMPLE001_windows_to_linux');

function selected(ids) {
  const wanted = new Set(ids);
  book.rules.forEach(rule => { rule.selected = wanted.has(rule.id); });
}

function apply(text, filename, ids = allIds) {
  selected(ids);
  return MigRules.apply(book, text, filename);
}

function readSample(relative) {
  return fs.readFileSync(path.join(sampleRoot, relative), 'latin1');
}

const legacy = '%include "../../../../programs/tlf/20260131_SYNTH/primary/autoexec.sas";';
const tlfAutoexec = '%include "&targetStudy.\\Dev\\Programs\\TLF\\autoexec.sas";';
const mheadfoot = '%include "&targetStudy.\\Dev\\Programs\\Macros\\mheadfoot.sas";';
const setupanl = '%include "&targetStudy.\\Dev\\Programs\\Macros\\setupanl.sas";';
const mtrim = '%include "&targetStudy.\\Dev\\Programs\\Macros\\mtrim.sas";';
const padam = 'libname padam "&targetData.\\ADaM";';
const sdtmAutoexec = '%include "&targetStudy.\\Dev\\Programs\\SDTM\\autoexec.sas";';

{
  const cases = {
    'adam/adae.sas': ['R-014', 'R-015', 'R-016'],
    'adam/adpr.sas': ['R-012', 'R-014', 'R-015', 'R-016'],
    'sdtm/autoexec.sas': ['R-010'],
    'tlf/t-ae-overall.sas': ['R-008', 'R-009', 'R-011']
  };
  for (const [relative, expected] of Object.entries(cases)) {
    const result = apply(readSample(relative), path.basename(relative));
    const changed = new Set(result.hits.filter(hit => hit.count).map(hit => hit.id));
    for (const id of expected) assert(changed.has(id), relative + ' should trigger ' + id);
  }
}

{
  const result = apply(readSample('tlf/t-ae-overall.sas'), 't-ae-overall-saf.sas',
    ['R-009', 'R-011', 'R-008', 'R-012']);
  assert.strictEqual(result.total, 4);
  assert(result.text.includes('/*' + legacy + '*/'));
  assert(result.text.indexOf(tlfAutoexec) < result.text.indexOf(mheadfoot));
  assert(result.text.includes(setupanl));
  assert(!result.text.includes(sdtmAutoexec));
}

{
  const result = apply(readSample('adam/adae.sas'), 'adae.sas', ['R-005', 'R-015', 'R-014', 'R-016']);
  assert.strictEqual(result.total, 4);
  assert(result.text.includes(mtrim));
  assert(result.text.includes(padam));
  assert(result.text.indexOf(mtrim) < result.text.indexOf(padam));
  assert(result.text.includes('&targetStudy.\\Dev\\Data\\ADAM\\&tlfkey..xpt'));
  assert.strictEqual(apply(result.text, 'adae.sas', ['R-005', 'R-015', 'R-014', 'R-016']).total, 0);
}

{
  const source = '* EXAMPLE001-PROT synthetic signal;\n%util_getdata(adsl);\n';
  const result = apply(source, 'u900addv.sas', ['R-013']);
  assert.strictEqual(result.total, 1);
  assert(result.text.includes('%util_getdata(adsl, libref=ADaM)'));
}

{
  const source = [
    '* EXAMPLE001 synthetic signal;',
    '%let tdpath=%str("../../../../programs/sdtm/20260131_SYNTH/documents/EXAMPLE001 SDTM Specs_v1.0.xlsx");',
    'proc import out=spec datafile="../../../../programs/sdtm/documents/EXAMPLE001 SDTM Specs_v1.0.xlsx" dbms=xlsx replace;'
  ].join('\n');
  const result = apply(source, 'autoexec.sas', ['R-017']);
  assert.strictEqual(result.total, 2);
  assert.strictEqual((result.text.match(/&targetStudy\.\\Documents\\EXAMPLE001 SDTM Specs_v1\.0\.xlsx/g) || []).length, 2);
}

{
  const source = '* EXAMPLE001-PROT synthetic signal;\n%util_cvtds(dm);\n%util_cvtds(suppdm);\n%util_cvtds(ae);\n';
  const result = apply(source, 't900dm.sas', ['R-018']);
  assert.strictEqual(result.total, 2);
  assert(/^\*%util_cvtds\(dm\);$/m.test(result.text));
  assert(/^\*%util_cvtds\(suppdm\);$/m.test(result.text));
  assert(/^%util_cvtds\(ae\);$/m.test(result.text));
}

{
  const source = [
    '* EXAMPLE001-PROT synthetic signal;',
    'proc import datafile="&rescreen."',
    '  out=rescr dbms=xlsx replace;',
    '  sheet="rescreen";',
    '  getnames=yes;',
    'run;'
  ].join('\n');
  const result = apply(source, 't900sv.sas', ['R-019']);
  assert(result.hits.some(hit => hit.id === 'R-019' && hit.count === 1));
  assert(result.text.includes('data rescr;'));
  assert(result.text.includes('rename=(old_subject_id=old_subject_id1)'));
  assert.strictEqual(apply(result.text, 't900sv.sas', ['R-019']).total, 0);
}

{
  const source = '* EXAMPLE001 synthetic signal;\n%adam_spec(sheet=&tlfkey);\n%put &attribadsl.;\ndata adlb; run;\n';
  const result = apply(source, 'adlb.sas', ['R-020']);
  assert.strictEqual(result.total, 1);
  assert(!/^\s*%adam_spec\s*\(/im.test(result.text));
}

{
  const source = '* EXAMPLE001-PROT synthetic signal;\n%util_getdata(dm, engine=V9, libref=data);\n';
  const result = apply(source, 't900pr.sas', ['R-021']);
  assert.strictEqual(result.total, 1);
  assert(result.text.includes('libref=Data'));
}

{
  for (const file of fs.readdirSync(sampleRoot, { recursive: true })) {
    if (!/\.sas$/i.test(file)) continue;
    const first = apply(readSample(file), path.basename(file));
    const second = apply(first.text, path.basename(file));
    assert.strictEqual(second.total, 0, file);
  }
}

console.log('mig-rules synthetic tests passed');
