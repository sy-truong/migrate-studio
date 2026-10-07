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
const js = fs.readFileSync(path.join(ASSET_ROOT, 'js/migrate-studio.js'), 'utf8');
const css = fs.readFileSync(path.join(ASSET_ROOT, 'css/migrate-studio.css'), 'utf8');
const html = fs.readFileSync(path.join(ASSET_ROOT, 'index.html'), 'utf8');

assert(
  html.includes('id="historyProgramSearch"'),
  'History tab needs a program search input above the program list'
);

assert(
  html.indexOf('id="historyProgramSearch"') < html.indexOf('id="runHistoryGroups"'),
  'the program search must sit above the program list, not below it'
);

assert(
  js.includes("on($('historyProgramSearch'), 'input', applyHistoryProgramSearch);"),
  'program search must filter on input, with no debounce'
);

assert(
  !/historyProgramSearch'\), 'input', debounce/.test(js),
  'program search must not be debounced'
);

assert(
  js.includes('section.dataset.programHay') && js.includes('data-program-hay="'),
  'program cards and summary rows need a searchable haystack attribute'
);

assert(
  /applyHistoryProgramSearch\(\);/.test(js.slice(js.indexOf('function renderHistoryFolderGroups'))),
  'the filter must be re-applied after the folder groups are re-rendered'
);

assert(
  css.includes('.history-folder-section[hidden]') &&
    css.includes('.history-program-group[hidden]'),
  'flex sections need an explicit [hidden] display rule to actually hide'
);

console.log('history search tests passed');
