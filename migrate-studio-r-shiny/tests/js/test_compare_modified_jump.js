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

const renderStart = js.indexOf('function renderCompare()');
const renderEnd = js.indexOf('function setCompareMessage', renderStart);
assert(renderStart !== -1 && renderEnd !== -1, 'renderCompare should be present');
const renderCompare = js.slice(renderStart, renderEnd);

assert(
  renderCompare.indexOf('markCurrentModified();') <
    renderCompare.indexOf('updateModifiedLabel(stat.changed);'),
  'modified label must update after panes render and current rows are marked'
);

const labelStart = js.indexOf('function updateModifiedLabel(total)');
const labelEnd = js.indexOf('function markCurrentModified()', labelStart);
assert(labelStart !== -1 && labelEnd !== -1, 'updateModifiedLabel should be present');
const labelSource = js.slice(labelStart, labelEnd);

assert(
  labelSource.includes('total === 1 && modifiedRows') &&
    labelSource.includes('cmp-jump-link') &&
    labelSource.includes('link.textContent = text'),
  'single modified labels should render a focus-preserving jump link'
);

assert(
  js.includes("on($('cmpModifiedLabel'), 'click', function (event)") &&
    js.includes("event.target.closest('.cmp-jump-link')") &&
    js.includes('jumpToModified(1);'),
  'the jump link should be wired with delegated click handling'
);

assert(
  js.includes("if (!modifiedRows('cmpRight').length) return;"),
  'compare keyboard shortcuts should work when there is one modified row'
);

assert(
  css.includes('.cmp-jump-link{') &&
    css.includes('color:var(--violet)') &&
    css.includes('.cmp-jump-link:focus-visible'),
  'the single-modified jump link should have link and focus-visible styling'
);

console.log('compare modified jump tests passed');
