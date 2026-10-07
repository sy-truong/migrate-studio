/*
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const assert = require('assert');

function cleanRelPath(path) {
  return String(path || '').replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function relDir(path) {
  const clean = cleanRelPath(path);
  const at = clean.lastIndexOf('/');
  return at < 0 ? '' : clean.slice(0, at);
}

function fileNameOf(program) {
  const clean = cleanRelPath(program.relPath || program.name || '');
  const at = clean.lastIndexOf('/');
  return at < 0 ? clean : clean.slice(at + 1);
}

function programHaystack(program) {
  const dir = cleanRelPath(program.dirRelPath != null
    ? program.dirRelPath : relDir(program.relPath || program.name));
  const file = fileNameOf(program);
  return (dir ? dir + '/' + file : file).toLowerCase();
}

function normalizeQuery(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesTerm(hay, term) {
  if (!term) return true;
  if (term.length > 1 && term.charAt(term.length - 1) === '/') {
    const segment = term.slice(0, -1);
    return ('/' + hay).indexOf('/' + segment + '/') !== -1;
  }
  return hay.indexOf(term) !== -1;
}

function matchesQuery(hay, query) {
  query = normalizeQuery(query);
  if (!query) return true;
  if (matchesTerm(hay, query)) return true;
  const terms = query.split(' ');
  if (terms.length < 2) return false;
  return terms.every(term => matchesTerm(hay, term));
}

const adae = { dirRelPath: 'adam', relPath: 'adam/adae.sas' };
const dm = { dirRelPath: 'sdtm', relPath: 'sdtm/dm.sas' };
const qc = { dirRelPath: 'adamqc', relPath: 'adamqc/adae.sas' };
const profiles = {
  dirRelPath: 'patient profiles',
  relPath: 'patient profiles/profile-list.sas'
};

assert(matchesQuery(programHaystack(adae), 'adam'));
assert(matchesQuery(programHaystack(adae), 'adam/'));
assert(!matchesQuery(programHaystack(qc), 'adam/'));
assert(matchesQuery(programHaystack(adae), 'adam ae'));
assert(!matchesQuery(programHaystack(dm), 'adam ae'));
assert(matchesQuery(programHaystack(adae), 'adam\\adae'));
assert(matchesQuery(programHaystack(dm), 'SDTM/DM'));
assert(matchesQuery(programHaystack(profiles), 'patient profiles'));

console.log('rail search tests passed');
