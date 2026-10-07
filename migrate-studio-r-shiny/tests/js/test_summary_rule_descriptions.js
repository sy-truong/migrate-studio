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

const book = MigRules.parse(
  MigExcel.read(fs.readFileSync(path.join(ROOT, 'rules/Migrate_Studio_Rules.xlsx'))),
  'rules/Migrate_Studio_Rules.xlsx');

/* 1. Every rule and logic id the engine can report has a description. */
const withBook = MigRules.ruleDescriptions(book);
const reportable = book.rules.map(r => r.id)
  .concat(Object.keys(MigRules.LOGIC_RULES));
reportable.forEach(id => {
  assert.ok(withBook[id] && withBook[id].trim(), 'missing description: ' + id);
});

/* 2. L-### descriptions come from the Logic Changes sheet when it is present. */
assert.strictEqual(withBook['L-034'],
  'Disables the Vendorlab external-data load without an in-place replacement ' +
  'in the same source block.');
assert.ok(/^Adapts RESCREEN/.test(withBook['L-032']));
assert.ok(/RS\/adjustment/.test(withBook['L-035']));

/* 3. Rules-sheet descriptions still win for R-### ids. */
const r001 = book.rules.find(r => r.id === 'R-001');
assert.strictEqual(withBook['R-001'], r001.description);

/* 4. Built-in fallback works with no rule book at all (history-only session). */
const noBook = MigRules.ruleDescriptions(null);
['L-032', 'L-034', 'L-035'].forEach(id => {
  assert.ok(noBook[id], 'built-in fallback missing: ' + id);
});

console.log('test_summary_rule_descriptions: ok');
