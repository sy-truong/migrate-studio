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

assert(
  js.includes('id="historyProgramSearch"'),
  'the Migration History dashboard needs a program search input'
);

assert(
  js.indexOf('id="historyProgramSearch"') <
    js.indexOf('class="fgroups history-folder-groups"'),
  'the program search must be emitted above the program list, not below it'
);

assert(
  js.includes("event.target.id === 'historyProgramSearch'"),
  'the program search must be bound by delegation - the panel is re-rendered wholesale'
);

assert(
  !/historyProgramSearch[^\n]*debounce/.test(js),
  'program search must not be debounced'
);

assert(
  js.includes('group.dataset.programHay') && js.includes('data-program-hay="'),
  'program cards and summary rows need a searchable haystack attribute'
);

assert(
  /applyHistoryProgramSearch\(\);/.test(
    js.slice(js.indexOf('function renderRunHistoryLoaded'))),
  'the filter must be re-applied after the panel is re-rendered'
);

assert(
  css.includes('.history-folder-section[hidden]') &&
    css.includes('.history-program[hidden]'),
  'flex sections need an explicit [hidden] display rule to actually hide'
);

console.log('history search tests passed');
