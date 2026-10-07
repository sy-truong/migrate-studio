'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
global.window = global;
global.fflate = require(path.join(root, 'www/js/vendor/fflate.min.js'));
vm.runInThisContext(fs.readFileSync(path.join(root, 'www/js/mig-excel.js'), 'utf8'));
const safe = MigExcel.write([{name: 'Rules', rows: [['Rule', 'Description'], ['R-001', 'Example']]}]);
// Preserve actual workbook import alongside adversarial archives.
assert(MigExcel.read(fs.readFileSync(path.join(root, 'rules/Migrate_Studio_Rules.xlsx'))).names.includes('Rules'));
assert.throws(() => MigExcel.read(new Uint8Array(16 * 1024 * 1024 + 1)), /exceeds/);
const zip = global.fflate.zipSync({'xl/worksheets/sheet1.xml': new Uint8Array(17 * 1024 * 1024)}, {level: 6});
assert.throws(() => MigExcel.read(zip), /not a readable/);
const escape = global.fflate.zipSync({'../secret.xml': new Uint8Array([1])});
assert.throws(() => MigExcel.read(escape), /not a readable/);
console.log('Workbook bounds and safe import passed.');
