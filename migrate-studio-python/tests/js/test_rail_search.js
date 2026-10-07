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
global.localStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; }
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
global.document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createTextNode(text) { return { textContent: text }; },
  createElement() {
    return {
      appendChild() {},
      addEventListener() {},
      setAttribute() {},
      classList: { toggle() { return false; } },
      style: {}
    };
  }
};

vm.runInThisContext(fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8'));

const rail = global.MigrateStudioRailSearch;
const adae = { dirRelPath: 'adam', file: 'adae.sas' };
const dm = { dirRelPath: 'sdtm', file: 'dm.sas' };
const qc = { dirRelPath: 'adamqc', file: 'adae.sas' };
const patient = { dirRelPath: 'Patient Profiles/current', file: 'ae.sas' };

assert.strictEqual(rail.programHaystack(adae), 'adam/adae.sas');
assert.strictEqual(rail.fileNameOf({ relPath: 'adam/adae.sas' }), 'adae.sas');

assert(rail.matchesQuery(rail.programHaystack(adae), 'adam'));
assert(rail.matchesQuery(rail.programHaystack(adae), 'adam/'));
assert(!rail.matchesQuery(rail.programHaystack(qc), 'adam/'));
assert(rail.matchesQuery(rail.programHaystack(adae), 'adam ae'));
assert(!rail.matchesQuery(rail.programHaystack(dm), 'adam ae'));
assert(rail.matchesQuery(rail.programHaystack(adae), 'adam\\adae'));
assert(rail.matchesQuery(rail.programHaystack(dm), 'SDTM/DM'));
assert(rail.matchesQuery(rail.programHaystack(patient), 'patient profiles'));
assert(rail.matchesQuery(rail.programHaystack(patient), 'profiles ae'));

assert.strictEqual(global.MigrateStudioIO.detectEol('a\r\nb\r\n'), '\r\n');
assert.strictEqual(global.MigrateStudioIO.detectEol('a\nb\n'), '\n');
assert.strictEqual(global.MigrateStudioIO.outputProgramText({
  eol: '\r\n',
  fixed: 'a\nb\n'
}), 'a\r\nb\r\n');

const ledger = global.MigrateStudioChangeLedger;
assert.deepStrictEqual(ledger.detailStats([
  {
    id: 'R1',
    count: 9,
    details: [
      { type: 'change' },
      { type: 'add' },
      { type: 'delete' }
    ]
  },
  { id: 'R2', count: 2, details: [{ type: 'Added' }] }
]), { changed: 1, added: 2, removed: 1, total: 4 });
assert.deepStrictEqual(ledger.detailStats([
  { id: 'LEGACY', count: 3 }
]), { changed: 3, added: 0, removed: 0, total: 3 });
assert.strictEqual(ledger.detailTotal([
  { id: 'R1', count: 5, details: [{ type: 'add' }, { type: 'change' }] }
]), 2);

console.log('Rail search tests passed.');
