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

assert.strictEqual(
  (js.match(/event\.target\.closest\('\.fgroup-head'\)/g) || []).length,
  1,
  'collapsible fgroup cards should use exactly one delegated click handler'
);

assert(
  js.includes("var open = !group.classList.contains('is-open');") &&
    js.includes("group.classList.toggle('is-open', open);") &&
    js.includes("head.setAttribute('aria-expanded', open ? 'true' : 'false');"),
  'fgroup handler should force the next open state and mirror aria-expanded'
);

assert(
  js.includes('state.historyOpenCards[group.dataset.historyKey] = open;'),
  'history card open state should be remembered per expandable card'
);

assert(
  css.includes('.fgroup.is-open > .fgroup-head > .fgroup-chevron{transform:rotate(90deg)}'),
  'open chevron rotation must be scoped to the card\'s own header'
);

assert(
  !/\.fgroup\.is-open \.fgroup-chevron\s*\{/.test(css),
  'the descendant-combinator chevron rule rotates nested collapsed cards and must not return'
);

assert(
  css.includes('.fgroup > .fgroup-head > .fgroup-chevron{transform:rotate(0deg)}'),
  'collapsed cards need an explicit rotate(0) reset'
);

console.log('history toggle tests passed');
