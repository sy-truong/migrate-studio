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

const renderCompare = js.slice(
  js.indexOf('function renderCompare()'),
  js.indexOf('function contextOnly(')
);
const updateModifiedLabel = js.slice(
  js.indexOf('function updateModifiedLabel(total)'),
  js.indexOf('function markCurrentModified()')
);
const wire = js.slice(
  js.indexOf("on($('btnPrevModified')"),
  js.indexOf('/* history */')
);
const keydown = js.slice(
  js.indexOf('document.addEventListener(\'keydown\''),
  js.indexOf('window.addEventListener(\'beforeunload\'')
);

assert(
  renderCompare.indexOf('markCurrentModified();') <
    renderCompare.indexOf('updateModifiedLabel(stat.changed);'),
  'modified label must update after compare rows are rendered'
);

assert(
  updateModifiedLabel.includes('total === 1 && modifiedRows(\'cmpRight\').length > 0') &&
    updateModifiedLabel.includes('class="cmp-jump-link"') &&
    updateModifiedLabel.includes('link.textContent = text;'),
  'a single rendered modified row should make the count a reusable jump link'
);

assert(
  wire.includes("on($('cmpModifiedLabel'), 'click'") &&
    wire.includes("event.target.closest('.cmp-jump-link')") &&
    wire.includes('jumpToModified(1)'),
  'single modified jump link should be wired through the compare label'
);

assert(
  keydown.includes("if (!modifiedRows('cmpRight').length) return;") &&
    !keydown.includes("if ($('btnNextModified').hidden) return;"),
  'compare keyboard shortcuts should work when exactly one modified row exists'
);

assert(
  css.includes('.cmp-jump-link') &&
    css.includes('color:var(--violet)') &&
    css.includes('.cmp-jump-link:focus-visible'),
  'jump link should be styled and focus-visible'
);

console.log('compare single jump tests passed');
