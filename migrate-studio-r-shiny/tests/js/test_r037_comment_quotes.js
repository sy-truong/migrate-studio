/*
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

/* R-037 -- curly double quotes inside comments become straight quotes.
 *
 * A synthetic fixture, not a sample program: none of the 154 .sas files under
 * samples/ currently contains U+201C or U+201D, so there is nothing in the
 * corpus to assert against. The fixture is written in escapes rather than
 * literal glyphs so the file stays ASCII and cannot be damaged by whatever
 * editor or transfer step touches it next -- which is the same class of
 * problem this rule exists to clean up.
 *
 * Run:  node tests/test_r037_comment_quotes.js
 */

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

function applyOnly(id, text, filename) {
  book.rules.forEach(rule => { rule.selected = rule.id === id; });
  return MigRules.apply(book, text, filename);
}

const L = '\u201C';   // U+201C LEFT DOUBLE QUOTATION MARK
const R = '\u201D';   // U+201D RIGHT DOUBLE QUOTATION MARK

const source = [
  `/* Read the ${L}raw${R} data from source. */`,
  'data ae;',
  '  set raw.ae;',
  `  where flag = ${L}Y${R};`,
  'run;',
  `* legacy ${L}step${R} removed per the ${L}migration${R} note ;`,
  '/* multi-line',
  `   note with ${L}quotes${R} inside`,
  `   and more ${L}text${R} */`,
  `title ${L}Not a comment${R};`,
  ''
].join('\n');

const result = applyOnly('R-037', source, 'ae.sas');
const out = result.text;
const hit = result.hits.find(h => h.id === 'R-037');

/* Ten curly quotes sit inside comments: two on the opening block comment,
   four on the statement comment, four across the multi-line block comment. */
assert.ok(hit, 'R-037 should report a hit');
assert.strictEqual(hit.count, 10, 'R-037 should straighten ten quotes');

/* Block comments, statement comments and multi-line comments are all cleaned. */
assert.ok(out.includes('/* Read the "raw" data from source. */'));
assert.ok(out.includes('* legacy "step" removed per the "migration" note ;'));
assert.ok(out.includes('note with "quotes" inside'));
assert.ok(out.includes('and more "text" */'));

/* Executable code is untouched -- a curly quote outside a comment may be
   deliberate, and in a WHERE or TITLE it is part of the program's behaviour. */
assert.ok(out.includes(`where flag = ${L}Y${R};`), 'WHERE clause must not change');
assert.ok(out.includes(`title ${L}Not a comment${R};`), 'TITLE must not change');

/* Nothing else moved: the only difference is the ten characters. */
assert.strictEqual(
  out.replace(/"/g, '\u0000').length, source.replace(/[\u201C\u201D"]/g, '\u0000').length,
  'the fix must not add or remove characters');

/* Idempotent: running it twice changes nothing the second time. */
const again = applyOnly('R-037', out, 'ae.sas');
assert.strictEqual(again.hits.filter(h => h.id === 'R-037').length, 0,
  'R-037 must not fire on already-straightened text');

/* A program with no comments at all is left exactly as it was. */
const plain = 'data x;\n  set y;\nrun;\n';
assert.strictEqual(applyOnly('R-037', plain, 'x.sas').text, plain);

console.log('R-037 comment smart-quote tests passed.');
