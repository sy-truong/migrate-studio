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

function ctx(extra = {}) {
  const dirs = {
    'stat/adam': ['Data', 'Macros'],
    'stat/adam/Data': ['Raw'],
    'stat/adam/Data/Raw': []
  };
  return Object.assign({
    osFamily: 'LINUX',
    programPath: 'stat/adam/adae.sas',
    programDir: 'stat/adam',
    tocCaseMap: { 'study_toc.xlsx': 'Study_TOC.xlsx' },
    listDir: p => dirs[String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')] || null
  }, extra);
}

function only(ids) {
  const wanted = new Set(ids);
  book.rules.forEach(rule => { rule.selected = wanted.has(rule.id); });
}

assert.strictEqual(spec.source.macro_version, '4.30');
assert.strictEqual(spec.rules.length, 28);
assert.strictEqual(book.kind, 'mc');
assert.strictEqual(book.rules.length, 27);
assert.strictEqual(book.rules.filter(r => r.executable).length, 11);
assert.deepStrictEqual(book.updateOrder, [
  'F1', 'F2', 'F3', 'O1', 'O2', 'O3', 'O5', 'O6', 'L3', 'S1', 'S5'
]);
assert(book.warnings.some(w => w.includes('S7')));
assert(book.headers.includes('Pack'));
assert.strictEqual(book.rules.find(r => r.id === 'O4').pack, 'MC');

assert.strictEqual(MigMcRules.helpers.winExempt('', 'if os = "WIN" then do;', ''), true);
assert.strictEqual(MigMcRules.helpers.winExempt('', 'if os = "LINUX" then do;', ''), false);
assert.strictEqual(MigMcRules.helpers.s5Classify('path="C:\\temp\\x";'), 'PATH');
assert.strictEqual(MigMcRules.helpers.s5Classify('put "\\brdrb";'), '');
assert.strictEqual(MigMcRules.helpers.s5Classify('x=prxchange("s/\\\\/\\//",-1,x);'), '');

{
  only(['O2', 'S1', 'S5']);
  const source = '%let user=%sysget(USERNAME);\n%put &_SASPROGRAMFILE;\n%let p=C:\\Temp\\raw;';
  const result = MigMcRules.apply(book, source, 'adae.sas', ctx());
  assert.strictEqual(result.total, 3);
  assert(result.text.includes('%sysget(USER)'));
  assert(result.text.includes('%sysget(SAS_EXECFILEPATH)'));
  assert(result.text.includes('C:/Temp/raw'));
  assert(result.hits.some(hit => hit.id === 'O2' && /Replaced %sysget/.test(hit.updateDesc)));
  assert.strictEqual(MigMcRules.apply(book, result.text, 'adae.sas', ctx()).total, 0);
}

{
  only(['F1', 'F2', 'S5']);
  const source = 'filename toc "study_toc.xlsx";\n%include "Data\\raw\\load.sas";';
  const result = MigMcRules.apply(book, source, 'adae.sas', ctx());
  assert(result.text.includes('Study_TOC.xlsx'));
  assert(result.text.includes('"Data\\Raw\\load.sas"'));
  assert.strictEqual(MigMcRules.apply(book, result.text, 'adae.sas', ctx()).total, 0);
}

{
  only(['F3', 'O1', 'L3']);
  const source = 'options noxwait xsync;\nx "cd C:\\work";\nx "del old.txt";';
  const result = MigMcRules.apply(book, source, 'adae.sas', ctx());
  assert(result.text.includes('*** remove for linux *** options noxwait xsync;'));
  assert(result.text.includes('rc = dlgcdir("C:/work");'));
  assert(result.text.includes('*** Update del command with rm ***; x "rm -f old.txt";'));
  assert(/^\s*\*{3}\s*Update del command with rm\s*\*{3}\s*;/im.test(result.text));
  assert.strictEqual(MigMcRules.apply(book, result.text, 'adae.sas', ctx()).total, 0);
}

{
  only(['O3', 'O5', 'O6']);
  const source = 'filename _all_;\nproc import datafile="a.xlsx"; run;\nx "copy in.txt out.txt";';
  const result = MigMcRules.apply(book, source, 'adae.sas', ctx());
  assert(result.text.includes('*** Updated to preserve _GSFNAME ***;'));
  assert(/^\s*\*{3}\s*Updated to preserve _GSFNAME\s*\*{3}\s*;/im.test(result.text));
  assert(result.text.includes('options validvarname=v7;\nproc import'));
  assert(result.text.includes("rc = fcopy('src', 'dest');"));
  assert.strictEqual(MigMcRules.apply(book, result.text, 'adae.sas', ctx()).total, 0);
}

{
  const findings = MigMcRules.scan(book,
    'libname xl excel "a.xlsx"; proc export data=x outfile=y; ERROR: z\nx "run.bat";\nx "run.sh";\n’',
    'adae.sas',
    ctx());
  const ids = findings.map(f => f.rule_id);
  assert(ids.includes('S3'));
  assert(ids.includes('S4'));
  assert(ids.includes('D1'));
  assert(ids.includes('D2'));
  assert(ids.includes('D3'));
  assert(ids.includes('L4'));
  assert.strictEqual(ids.filter(id => id === 'S3').length, 1);
}

{
  const mojibaked = new TextDecoder('windows-1252')
    .decode(Uint8Array.from([0x25, 0x6c, 0x65, 0x74, 0x20, 0x78, 0x3d, 0xe2, 0x80, 0x98, 0x61, 0xe2, 0x80, 0x99, 0x3b]));
  const ids = MigMcRules.scan(book, mojibaked + '\n%let y=‘b’;', 'adae.sas', ctx())
    .map(f => f.rule_id);
  assert(ids.filter(id => id === 'D3').length >= 2);
  assert(ids.includes('L4'));
}

{
  const findings = MigMcRules.scan(book,
    '%let p="/profiles/site";\n%let v="\\\\srv\\vendordata\\x";\n%let r="reference/smqlist";\n%let n="/nothing/here";',
    'adae.sas',
    ctx());
  assert.strictEqual(findings.filter(f => f.rule_id === 'C1').length, 3);
}

{
  const source = 'if os = "WIN" then do;\noptions noxwait;\nif os = "WIN" then do;\nx "cd C:\\work";\nif os = "WIN" then do;\nlibname cdf "x";';
  const findings = MigMcRules.scan(book, source, 'adae.sas', ctx());
  const ids = findings.map(f => f.rule_id);
  assert(!ids.includes('F3'));
  assert(!ids.includes('O1'));
  assert(!ids.includes('L1'));
}

{
  assert(MigMcRules.scan(book, 'data x; run;', 'adae.sas', ctx())
    .some(f => f.rule_id === 'O4'));
  assert(!MigMcRules.scan(book, 'data x; run;', 'adae.sas', ctx({ osFamily: 'WINDOWS' }))
    .some(f => f.rule_id === 'O4'));
}

{
  only(['O4']);
  const source = '*** Include the standard setup for this project;\\ndata x; run;';
  assert.strictEqual(MigMcRules.apply(book, source, 'dm.sas', ctx()).total, 0);
  assert(MigMcRules.scan(book, source, 'dm.sas', ctx())
    .some(finding => finding.rule_id === 'O4'));
  assert.strictEqual(book.rules.some(rule => rule.id === 'M1'), false);
  assert.strictEqual(book.rules.some(rule => rule.id === 'M2'), false);
}

{
  const bytes = Uint8Array.from([0x25, 0x6c, 0x65, 0x74, 0x20, 0x78, 0x3d, 0xe9, 0x3b, 0x20, 0x91, 0x92]);
  const decoded = new TextDecoder('windows-1252').decode(bytes);
  assert.deepStrictEqual(Array.from(MigMcRules.helpers.encodeProgramText(decoded)), Array.from(bytes));
}

{
  const inv = MigMcRules.inventory(book, [
    { name: 'stat/adam/adae.sas', relPath: 'stat/adam/adae.sas' },
    { name: 'stat/adam/archive/adae.sas', relPath: 'stat/adam/archive/adae.sas' },
    { name: 'stat/adam/adae_bak.sas', relPath: 'stat/adam/adae_bak.sas' }
  ], ctx());
  assert(inv.some(f => f.rule_id === 'F5'));
  assert(inv.some(f => f.rule_id === 'F6'));
}

console.log('MC migration rule tests passed.');
