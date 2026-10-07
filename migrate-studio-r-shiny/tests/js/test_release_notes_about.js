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

const ROOT = path.basename(__dirname) === 'js' ? path.resolve(__dirname, '../..') : path.resolve(__dirname, '..');
const ASSET_ROOT = fs.existsSync(path.join(ROOT, 'www')) ? path.join(ROOT, 'www') : ROOT;
const html = fs.readFileSync(path.join(ASSET_ROOT, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8');
const css = fs.readFileSync(path.join(ASSET_ROOT, 'css/migrate-studio.css'), 'utf8');
const serverPath = fs.existsSync(path.join(ROOT, 'migrate_studio.py'))
  ? path.join(ROOT, 'migrate_studio.py')
  : path.join(ROOT, 'python/migrate_studio.py');
const server = fs.readFileSync(serverPath, 'utf8');
const notes = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

assert(
  html.includes('id="btnReleaseNotes"') &&
    html.includes('id="releaseNotesDialog"') &&
    html.includes('id="releaseNotesBody"'),
  'About needs a Release Notes button and dialog'
);

assert(
  js.includes("var APP_VERSION = 'v0.3 Beta';") &&
    js.includes("var APP_BUILD = '2026.09.21';") &&
    js.includes("var RELEASE_NOTES_FILE = 'CHANGELOG.md';"),
  'About version, build and release notes file should be centralized constants'
);

assert(
  js.includes('function renderReleaseNotes(markdown)') &&
    js.includes("on($('btnAbout'), 'click', showAbout);") &&
    js.includes("on($('btnReleaseNotes'), 'click', showReleaseNotes);"),
  'Release notes renderer and buttons must be wired'
);

assert(
  css.includes('.release-notes-dialog') &&
    css.includes('.release-notes-body') &&
    css.includes('.about-link:focus-visible'),
  'Release notes and About link styles must be present'
);

assert(
  server.includes('".md": "text/markdown; charset=utf-8"'),
  'server must pin .md files as UTF-8 Markdown'
);

assert(
  /^# Changelog/.test(notes) &&
    notes.includes('## [0.3-beta] - 2026-09-21') &&
    notes.includes('_migrate_original/'),
  'changelog should include the current release and backup notes'
);

console.log('release notes About tests passed');
