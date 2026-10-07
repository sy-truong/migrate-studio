/* ===========================================================================
 * Migrate Studio — MC migration rule pack interpreter
 *
 * rules/migration_rules.json is the source/provenance for the MC macro rule
 * pack. This file is the browser interpreter: it maps that JSON into the same
 * rule-book shape as MigRules, scans programs line by line, and applies the
 * supported MC updates in the macro-defined order.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function (global) {
  'use strict';

  var DISPLAY = global.MigRules ? global.MigRules.DISPLAY
    : ['id', 'name', 'category', 'desc'];
  var DISPLAY_LABELS = global.MigRules ? global.MigRules.DISPLAY_LABELS
    : { id: 'Rule ID', name: 'Short Title', category: 'Category', desc: 'Description' };

  var DETECTION_ORDER = [
    'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10',
    'U11', 'U12', 'U13', 'O1', 'O2', 'O3', 'S1', 'S2', 'S3', 'S4',
    'S5', 'D1', 'D2', 'D3', 'C1', 'C2', 'L1', 'L2', 'L3', 'L4',
    'O5', 'O6', 'F3', 'F1', 'F2', 'U14', 'U15'
  ];
  var UPDATE_ORDER = [
    'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10',
    'U11', 'U12', 'U13', 'F1', 'F2', 'F3', 'O1', 'O2', 'O3', 'O4',
    'O5', 'O6', 'M1', 'M2', 'U14', 'U15', 'L3', 'S1', 'S5'
  ];
  var IMPLEMENTED_UPDATES = {
    U1: true, U2: true, U3: true, U4: true, U5: true, U6: true, U7: true,
    U8: true, U9: true, U10: true, U11: true, U12: true, U13: true,
    U14: true, U15: true,
    F1: true, F2: true, F3: true, O1: true, O2: true, O3: true, O4: true,
    O5: true, O6: true, M1: true, M2: true, L3: true, S1: true, S5: true
  };
  var U3_MARKER = '/* MIGRATE-STUDIO: local_setup generated from source setup.sas (U3) */';
  var U2_PREFIX = '*** MIGRATE-STUDIO U2: removed recursive setup call ***; *';
  var CP1252_HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  var RX = {
    f1: /(study_toc\.xlsx|toc\.xlsx)/ig,
    f3Options: /\b(noxsync|xsync|noxwait|xwait|noxcmd|xcmd)\b/ig,
    o1x: /\bx\s*["']cd\s+/i,
    o1systask: /\bsystask\s+command\s*=\s*["']cd\s+/i,
    o2: /%sysget\s*\(\s*username\s*\)/ig,
    o3: /\bfilename\s+_all_\s*;/i,
    o5Proc: /\bproc\s+import\b/i,
    o5Excel: /\.xlsx\b/i,
    o5Dbms: /\bdbms\s*=\s*xlsx\b/i,
    o6: /\bx\s*"copy\s+/i,
    o6Systask: /\bsystask\s+command\s*=\s*"cmd\s+\/c\s+copy\s+/i,
    s1Detect: /_sasprogramfile/i,
    s1Update: /&_SASPROGRAMFILE/ig,
    s2: /\bproc\s+append\b/i,
    s3LibExcel: /\blibname\b/i,
    s3Excel: /\bexcel\b/i,
    s3Export: /\bproc\s+export\b/i,
    s3Import: /\bproc\s+import\b/i,
    s3DbmsExcel: /\bdbms\s*=\s*excel\b/i,
    d1: /\.bat\b/i,
    d2: /\.sh(\s|["';]|$)/i,
    d3: /[\u2018\u2019]|\u00E2\u20AC[\u02DC\u2122]/,
    c1: /patient profiles[\\\/]|[\\\/]vendor|[\\\/]profile|anadata[\\\/]sdtm([\\\/]|\b)|reference[\\\/]smq|validate[\\\/]tlf[\\\/]qcdata/i,
    c2: /\bsasuser\b/i,
    l1: /\blibname\s+(cdf|here|pfdata|vendordata|rawvend|raww|sdtma|smq|tlfout|tlfvdata|utility)\b/i,
    l2Filename: /\bfilename\b/i,
    l2Pipe: /\bpipe\b/i,
    l3: /\bx\s*["']del\s+|\bsystask\s+command\s*=\s*"del\s+/i,
    m1: /^\s*%include\b/i,
    m1Drive: /[A-Za-z]:\\/,
    m1Unc: /^\s*%include\s+["']\\\\/i,
    m2: /^(\s*)([A-Za-z_][A-Za-z0-9_]*_?PATH)(\s*=\s*)([A-Za-z]:\\[^,;]*\.(?:xlsx|xls|csv|txt))(\s*[,;]?\s*)$/i,
    setup: /%setup\b\s*(\(|;)/i,
    chmod: /\bchmod\b/i,
    validvarname: /\bvalidvarname\s*=\s*v7\b/i
  };

  function parse(spec, sourceName, housePack) {
    if (!spec || !Array.isArray(spec.rules)) {
      throw new Error('MC rule pack is not a valid migration_rules.json document.');
    }
    var specParameters = {};
    (spec.parameters || []).forEach(function (parameter) {
      if (parameter && parameter.name && parameter.default != null) {
        specParameters[parameter.name] = clone(parameter.default);
      }
    });
    var book = {
      kind: 'mc',
      source: sourceName || 'migration_rules.json',
      rulesSheet: 'MC Rules',
      sheetNames: ['MC Rules'],
      sheets: {},
      headers: ['Rule ID', 'Pack', 'Short Title', 'Category', 'Description', 'Scope', 'OS', 'Update', 'Detection'],
      display: ['id', 'pack', 'name', 'category', 'desc'],
      displayLabels: { id: 'Rule ID', pack: 'Pack', name: 'Short Title', category: 'Category', desc: 'Description' },
      map: {},
      rules: [],
      executable: 0,
      warnings: [],
      spec: spec,
      parameters: Object.assign(specParameters, housePack && housePack.parameters || {}),
      macroVersion: spec.source && spec.source.macro_version || '',
      detectionOrder: ((spec.rule_evaluation_order || {}).line_level_order || DETECTION_ORDER)
        .map(cleanRuleId),
      updateOrder: updateOrderFromPacks(spec, housePack)
    };

    spec.rules.forEach(function (item, index) {
      if (!item || !item.rule_id || item.rule_id === 'S6') return;
      var rule = buildRule(item, index + 1, 'mc', 'MC');
      if (rule.scope === 'environment') {
        book.warnings.push('Rule ' + item.rule_id +
          ' is not evaluated in the browser because SASAUTOS is not visible.');
      }
      book.rules.push(rule);
    });

    applyHousePack(book, housePack);

    spec.rules.forEach(function (item) {
      if (item && item.update && item.update.supported === true &&
          item.enabled !== false && !IMPLEMENTED_UPDATES[item.rule_id]) {
        book.warnings.push('Rule ' + item.rule_id +
          ' declares update logic that this engine does not implement.');
      }
    });

    book.executable = book.rules.filter(function (rule) {
      return rule.executable && rule.enabled;
    }).length;
    book.sheets['MC Rules'] = {
      headers: book.headers,
      headerRow: 0,
      rows: book.rules.map(function (rule) {
        return [
          rule.id, rule.pack || '', rule.name, rule.category, rule.description,
          rule.scope, rule.cells.OS, rule.cells.Update, rule.cells.Detection
        ];
      })
    };
    if (!book.rules.length) book.warnings.push('The MC rule pack has no active rules.');
    return book;
  }

  function cleanRuleId(id) {
    return String(id || '').replace(/\(.*\)$/, '');
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function tocFilenames(book, ctx) {
    var names = ctx && ctx.params && ctx.params.TOC_FILENAMES;
    if (!names && book && book.parameters) names = book.parameters.TOC_FILENAMES;
    if (!names && book && book.spec) {
      (book.spec.parameters || []).some(function (parameter) {
        if (parameter && parameter.name === 'TOC_FILENAMES') {
          names = parameter.default;
          return true;
        }
        return false;
      });
    }
    if (typeof names === 'string') names = names.trim().split(/\s+/);
    if (!Array.isArray(names)) names = ['study_toc.xlsx', 'toc.xlsx'];
    return names.map(String).filter(function (name) { return name.trim() !== ''; });
  }

  function updateOrderFromPacks(spec, housePack) {
    var order = housePack && Array.isArray(housePack.update_order)
      ? housePack.update_order
      : ((spec.update_mode || {}).update_application_order || UPDATE_ORDER);
    return order.map(cleanRuleId).filter(function (id) { return IMPLEMENTED_UPDATES[id]; });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function buildRule(item, row, origin, packLabel) {
    var enabled = item.enabled !== false;
    var executable = !!(item.update && item.update.supported === true && enabled);
    var isBrowserUnsupported = item.scope === 'environment';
    var rule = {
      sheet: 'MC Rules',
      row: row,
      id: item.rule_id,
      key: item.rule_id,
      name: item.rule_name || item.rule_id,
      description: item.description || '',
      category: item.category || '',
      severity: item.update && item.update.supported ? 'Auto-fix' : 'Review',
      scope: item.scope || '',
      axis: item.special_rule || '',
      conditions: item.criteria_template || item.detection && (item.detection.pattern || item.detection.method) || '',
      enabled: enabled,
      executable: executable && !isBrowserUnsupported,
      selected: executable && !isBrowserUnsupported,
      needsParameters: false,
      mode: origin === 'house' ? 'house' : 'mc',
      origin: origin,
      pack: packLabel || '',
      find: '',
      replace: executable ? 'MC update' : '',
      cells: {
        Pack: packLabel || '',
        Scope: item.scope || '',
        OS: item.os_scope || '',
        Update: executable ? 'Auto-fix' : 'Report only',
        Detection: isBrowserUnsupported
          ? 'not evaluated in browser'
          : item.detection && item.detection.method || item.special_rule || ''
      },
      mc: item,
      note: isBrowserUnsupported
        ? 'Not evaluated in the browser because SASAUTOS is not visible. Run the CLI for S7.'
        : ''
    };
    return rule;
  }

  function applyHousePack(book, housePack) {
    if (!housePack) return;
    var extended = {};
    (housePack.extends || []).forEach(function (item) {
      if (!item || !item.rule_id) return;
      var rule = ruleById(book, item.rule_id);
      if (!rule) {
        book.warnings.push('House pack extends missing MC rule ' + item.rule_id + '.');
        return;
      }
      extended[item.rule_id] = true;
      rule.mc = Object.assign({}, rule.mc, { update: Object.assign({}, rule.mc.update || {}, item.update || {}) });
      rule.executable = !!(rule.mc.update && rule.mc.update.supported);
      rule.selected = rule.executable;
      rule.severity = rule.executable ? 'Auto-fix' : rule.severity;
      rule.origin = 'mc+house';
      rule.pack = 'MC + Migrate Studio';
      rule.replace = rule.executable ? 'MC update' : rule.replace;
      rule.cells.Pack = rule.pack;
      rule.cells.Update = rule.executable ? 'Auto-fix' : rule.cells.Update;
    });
    var seen = {};
    var nextRow = 0;
    book.rules.forEach(function (rule) { seen[rule.id] = true; });
    book.rules.forEach(function (rule) { nextRow = Math.max(nextRow, rule.row || 0); });
    (housePack.rules || []).forEach(function (item, index) {
      if (!item || !item.rule_id) return;
      if (seen[item.rule_id] && !extended[item.rule_id]) {
        book.warnings.push('House rule ' + item.rule_id +
          ' collides with a MC rule ID and was not added.');
        return;
      }
      seen[item.rule_id] = true;
      book.rules.push(buildRule(clone(item), nextRow + index + 1, 'house', 'Migrate Studio'));
    });
    (housePack.rules || []).forEach(function (item) {
      if (item && item.rule_id && book.detectionOrder.indexOf(item.rule_id) === -1) {
        book.detectionOrder.push(item.rule_id);
      }
    });
  }

  function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  function joinLines(lines) { return lines.join('\n'); }

  function ruleById(book, id) {
    return (book.rules || []).filter(function (rule) { return rule.id === id; })[0] || null;
  }

  function willRun(book, id) {
    var rule = ruleById(book, id);
    return !!(rule && rule.enabled && rule.executable && rule.selected);
  }

  function ruleEnabled(book, id) {
    var rule = ruleById(book, id);
    return !!(rule && rule.enabled);
  }

  function normalizePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  }

  function displayPath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  function fileName(path) {
    var parts = displayPath(path).split('/');
    return parts[parts.length - 1] || path || '';
  }

  function dirName(path) {
    var clean = displayPath(path);
    var at = clean.lastIndexOf('/');
    return at < 0 ? '' : clean.slice(0, at);
  }

  function baseNameLower(path) {
    return String(fileName(path) || '').toLowerCase();
  }

  function isSetupFile(ctx) {
    var name = baseNameLower(ctx && ctx.programPath);
    return name === 'setup.sas' || name === 'local_setup.sas';
  }

  function hasU3Marker(text) {
    return String(text || '').indexOf(U3_MARKER) !== -1;
  }

  function definesGlobalSetup(text) {
    return /%macro\s+setup\s*\(/i.test(String(text || ''));
  }

  function sourceSetupSignatureCount(text) {
    var src = String(text || '');
    return [
      /%let\s+pgmpath\s*=/i,
      /%let\s+macpath\s*=/i,
      /%let\s+volume\s*=/i,
      /^\s*libname\s+_all_\s*;/im,
      /%global\s+default_header\b/i
    ].filter(function (re) { return re.test(src); }).length;
  }

  function isSourceSetup(text) {
    return sourceSetupSignatureCount(text) >= 2 &&
      !hasU3Marker(text) && !definesGlobalSetup(text);
  }

  function globalPathRegex(ctx) {
    var pattern = ctx && ctx.params && ctx.params.GLOBAL_PATH_PATTERN || '';
    if (pattern) {
      var m = String(pattern).match(/^\/(.*)\/([a-z]*)$/i);
      if (m) {
        try { return new RegExp(m[1], m[2]); } catch (e) { /* default below */ }
      }
    }
    return /(^|[\/\\_\-\s.])global([\/\\_\-\s.]|$)/i;
  }

  function setupRole(text, ctx) {
    if (baseNameLower(ctx && ctx.programPath) !== 'setup.sas' || !isSourceSetup(text)) {
      return { role: '', reason: 'not setup' };
    }
    var abs = displayPath((ctx && (ctx.absolutePath || ctx.fullPath)) || '');
    var rel = displayPath((ctx && ctx.programPath) || '');
    var root = displayPath((ctx && ctx.pathRoot) || '');
    var candidate = abs || (root ? [root, rel].filter(Boolean).join('/') : '');
    var re = globalPathRegex(ctx);
    if (candidate) {
      return re.test(dirName(candidate))
        ? { role: 'GLOBAL', path: candidate }
        : { role: 'LOCAL', path: candidate };
    }
    if (re.test(dirName(rel))) return { role: 'GLOBAL', path: rel };
    return { role: 'UNKNOWN', path: rel };
  }

  function makeCtx(ctx, fileNameArg) {
    ctx = ctx || {};
    var path = ctx.programPath || fileNameArg || '';
    return {
      osFamily: String(ctx.osFamily || 'LINUX').toUpperCase(),
      programPath: path,
      programDir: ctx.programDir != null ? ctx.programDir : dirName(path),
      sep: ctx.sep || '/',
      tocCaseMap: ctx.tocCaseMap || {},
      listDir: typeof ctx.listDir === 'function' ? ctx.listDir : function () { return null; },
      params: Object.assign({}, ctx.bookParameters || {}, ctx.params || {}),
      absolutePath: ctx.absolutePath || ctx.fullPath || '',
      pathRoot: ctx.pathRoot || '',
      folderName: ctx.folderName || '',
      operator: ctx.operator || '',
      runDate: ctx.runDate || '',
      f4Enabled: !!ctx.f4Enabled,
      inventory: ctx.inventory || []
    };
  }

  function flags(lines, ctx) {
    var out = { hasValidvarnameV7: false, hasChmod: false, hasSetupCall: false };
    lines.forEach(function (line) {
      if (RX.validvarname.test(line)) out.hasValidvarnameV7 = true;
      RX.validvarname.lastIndex = 0;
      if (RX.chmod.test(line)) out.hasChmod = true;
      if (ctx.osFamily === 'LINUX') {
        var active = String(line || '').replace(/\/\*.*?\*\//g, '');
        if (!/^\s*\*/.test(active) && RX.setup.test(active)) out.hasSetupCall = true;
      }
    });
    return out;
  }

  function contextFor(lines, index) {
    var line = lines[index] || '';
    return {
      line: line,
      lineUp: line.toUpperCase(),
      prev1: index > 0 ? lines[index - 1] : '',
      prev2: index > 1 ? lines[index - 2] : '',
      prev3: index > 2 ? lines[index - 3] : '',
      next1: index + 1 < lines.length ? lines[index + 1] : '',
      next2: index + 2 < lines.length ? lines[index + 2] : ''
    };
  }

  function winExempt(prev1, prev2, prev3) {
    return [prev1, prev2, prev3].some(function (p) {
      var u = String(p || '').toUpperCase();
      return u.indexOf('"WIN"') !== -1 || u.indexOf("'WIN'") !== -1;
    });
  }

  function s5Classify(line) {
    line = String(line || '');
    if (line.indexOf('\\') === -1) return '';
    if (/^\s*(\/\*|%\*)/.test(line)) return '';
    var up = line.toUpperCase();
    if (up.indexOf('PRXCHANGE') !== -1) return '';
    if (/[C-H]:\\/.test(up)) return 'PATH';
    if (line.indexOf('\\\\') !== -1) return 'PATH';
    if (line.indexOf('..\\') !== -1 || line.indexOf('.\\') !== -1) return 'PATH';
    return '';
  }

  function encodeProgramText(text) {
    var src = String(text == null ? '' : text);
    var out = new Uint8Array(src.length);
    for (var i = 0; i < src.length; i++) {
      var code = src.charCodeAt(i);
      out[i] = code < 0x100 ? code
        : (CP1252_HIGH[code] != null ? CP1252_HIGH[code] : 0x3F);
    }
    return out;
  }

  function finding(book, id, ctx, lineNum, lineText, criteria, overrides) {
    var rule = ruleById(book, id) || { id: id };
    return Object.assign({
      category: rule.category || '',
      rule_id: id,
      rule_name: rule.name || id,
      rule_desc: rule.description || '',
      criteria: criteria || '',
      pgm_name: fileName(ctx.programPath),
      pgm_path: ctx.programPath || '',
      line_num: lineNum || 0,
      line_text: lineText || ''
    }, overrides || {});
  }

  function scanLine(book, ctx, fl, index, out) {
    var c = contextFor(fl.lines, index);
    var line = c.line;
    var n = index + 1;
    var exempt = winExempt(c.prev1, c.prev2, c.prev3);
    var generatedSetup = !!fl.hasU3Marker;

    (book.detectionOrder || DETECTION_ORDER).forEach(function (id) {
      if (!ruleEnabled(book, id)) return;
      if (generatedSetup && !/^U(?:[1-9]|1[0-3])$/.test(id)) return;
      if (id === 'O1' && !exempt && (RX.o1systask.test(line) || RX.o1x.test(line))) {
        out.push(finding(book, id, ctx, n, line, 'Matched: cd shell command'));
      } else if (id === 'O2' && /%sysget\s*\(\s*username\s*\)/i.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: %SYSGET(USERNAME)'));
      } else if (id === 'O3' && RX.o3.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: filename _all_;'));
      } else if (id === 'S1' && RX.s1Detect.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: _sasprogramfile'));
      } else if (id === 'S2' && RX.s2.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: proc append'));
      } else if (id === 'S3') {
        if (RX.s3LibExcel.test(line) && RX.s3Excel.test(line)) {
          out.push(finding(book, id, ctx, n, line, 'Matched on same line: libname + excel'));
        } else if (RX.s3Export.test(line)) {
          out.push(finding(book, id, ctx, n, line, 'Matched: proc export'));
        } else if (RX.s3Import.test(line) && RX.s3DbmsExcel.test(line)) {
          out.push(finding(book, id, ctx, n, line, 'Matched on same line: proc import + dbms=excel'));
        }
      } else if (id === 'S4' &&
          (line.indexOf('ERROR:') !== -1 || line.indexOf('WARNING:') !== -1 ||
           (line.indexOf('ER') !== -1 && line.indexOf('ROR:') !== -1) ||
           (line.indexOf('WAR') !== -1 && line.indexOf('NING:') !== -1))) {
        out.push(finding(book, id, ctx, n, line, 'Matched uppercase ERROR:/WARNING: token'));
      } else if (id === 'S5' && s5Classify(line) === 'PATH') {
        out.push(finding(book, id, ctx, n, line, 'Matched S5 path indicator; Action=CONVERT'));
      } else if (id === 'D1' && RX.d1.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: .bat'));
      } else if (id === 'D2' && RX.d2.test(line) && !fl.hasChmod) {
        out.push(finding(book, id, ctx, n, line, 'Matched: .sh; Missing in program: chmod'));
      } else if (id === 'D3' && RX.d3.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: smart quote'));
      } else if (id === 'C1' && RX.c1.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched source-platform folder'));
      } else if (id === 'C2' && RX.c2.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: sasuser'));
      } else if (id === 'L1' && !exempt && RX.l1.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched standard Windows/source platform libname'));
      } else if (id === 'L2' && RX.l2Filename.test(line) && RX.l2Pipe.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched on same line: filename + pipe'));
      } else if (id === 'L3' && !/^\s*(\*|\/\*)/.test(line) && RX.l3.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: x/systask del command'));
      } else if (id === 'L4' && /[^\x00-\x7F]/.test(line)) {
        var risky = [];
        for (var i = 0; i < line.length; i++) {
          if (line.charCodeAt(i) > 127) {
            risky.push('pos' + (i + 1) + '=[HEX:' + line.charCodeAt(i).toString(16).toUpperCase() + ']');
          }
        }
        out.push(finding(book, id, ctx, n, line,
          'Encoding risk count=' + risky.length + '; ' + risky.join(', ')));
      } else if (id === 'O5' && o5Matches(line, c)) {
        out.push(finding(book, id, ctx, n, line, 'Matched: proc import plus .xlsx or dbms=xlsx'));
      } else if (id === 'O6' && (RX.o6.test(line) || RX.o6Systask.test(line))) {
        out.push(finding(book, id, ctx, n, line, 'Matched: x "copy or systask command="cmd /c copy'));
      } else if (id === 'M1' && m1Matches(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched hard-coded %INCLUDE path'));
      } else if (id === 'M2' && RX.m2.test(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched reference-file path parameter'));
      } else if (id === 'F3' && !exempt && /\boptions\b/i.test(line)) {
        var matches = line.match(RX.f3Options);
        RX.f3Options.lastIndex = 0;
        if (matches && matches.length) {
          out.push(finding(book, id, ctx, n, line,
            matches.map(function (m) { return 'Option=[' + m + ']'; }).join(' | ')));
        }
      } else if (id === 'F1') {
        collectF1(book, ctx, n, line, out);
      } else if (id === 'F2') {
        collectF2(book, ctx, n, line, out);
      } else if (id === 'U2' && u2Matches(line, ctx)) {
        out.push(finding(book, id, ctx, n, line, 'Matched recursive setup call'));
      } else if (id === 'U14' && u14Matches(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched &rawpath.\\vendor reference'));
      } else if (id === 'U15' && u15LineHasTarget(line)) {
        out.push(finding(book, id, ctx, n, line, 'Matched retired setup path variable'));
      }
    });
  }

  function o5Matches(line, c) {
    if (/^\s*(\*|\/\*)/.test(line)) return false;
    if (!RX.o5Proc.test(line)) return false;
    var ctx = [line, c.next1, c.next2].filter(function (part) {
      return String(part || '').trim() !== '';
    }).join(' ');
    if (!RX.o5Excel.test(ctx) && !RX.o5Dbms.test(ctx)) return false;
    return !/^\s*options\s+validvarname\s*=\s*v7\s*;/i.test(c.prev1);
  }

  function collectF1(book, ctx, n, line, out) {
    var names = tocFilenames(book, ctx);
    var re = new RegExp('(' + names.map(escapeRegex).join('|') + ')', 'ig');
    var m;
    while ((m = re.exec(line))) {
      var expected = ctx.tocCaseMap[String(m[1]).toLowerCase()] || '';
      if (expected && m[1] !== expected) {
        out.push(finding(book, 'F1', ctx, n, line,
          'Referenced=[' + m[1] + '] Physical file=[' + expected + ']'));
      }
    }
  }

  function resolveParent(prefix, ctx) {
    var token = String(prefix || '').trim();
    if (!token || token.indexOf('&') !== -1 || token.indexOf('%') !== -1) return '';
    token = token.replace(/\\/g, '/').replace(/\/+$/g, '');
    if (/^[A-Za-z]:/.test(token) || /^\/\//.test(token) || /^\//.test(token)) return token;
    return [ctx.programDir, token].filter(Boolean).join('/');
  }

  function physicalChild(parent, ref, ctx) {
    if (!parent || !ref || ref === '.' || ref === '..') return null;
    if (parent.indexOf('&') !== -1 || parent.indexOf('%') !== -1) return null;
    var names = ctx.listDir(parent);
    if (!names) return null;
    var low = ref.toLowerCase();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i]).toLowerCase() === low) return names[i];
    }
    return null;
  }

  function collectF2(book, ctx, n, line, out) {
    if (/^\s*(%?\*|\/\*)/.test(line)) return;
    var findings = folderCaseFindings(line, ctx);
    findings.forEach(function (item) {
      out.push(finding(book, 'F2', ctx, n, line,
        'Referenced=[' + item.ref + '] Physical=[' + item.actual + '] Parent=[' + item.parent + ']'));
    });
  }

  function folderCaseFindings(line, ctx) {
    var out = [];
    var re = /[\\\/]([^\\\/"'\s;,()]+)/g;
    var match;
    while ((match = re.exec(line))) {
      var ref = match[1];
      if (!ref || ref === '.' || ref === '..') continue;
      var prefix = line.slice(0, match.index);
      var qpos = Math.max(prefix.lastIndexOf('"'), prefix.lastIndexOf("'"));
      var tokenPrefix = qpos >= 0 ? prefix.slice(qpos + 1) : prefix.slice(Math.max(
        prefix.lastIndexOf(' '), prefix.lastIndexOf('='), prefix.lastIndexOf(','),
        prefix.lastIndexOf('('), prefix.lastIndexOf(')'), prefix.lastIndexOf(';')) + 1);
      var parent = resolveParent(tokenPrefix, ctx);
      var actual = physicalChild(parent, ref, ctx);
      if (!actual || actual === ref) continue;
      if (!ctx.listDir([parent, actual].filter(Boolean).join('/'))) continue;
      out.push({ ref: ref, actual: actual, parent: parent, at: match.index + 1, end: match.index + 1 + ref.length });
    }
    return out;
  }

  function scan(book, text, fileNameArg, rawCtx) {
    var ctx = makeCtx(Object.assign({ bookParameters: book && book.parameters || {} }, rawCtx || {}), fileNameArg);
    var lines = splitLines(text);
    var fl = flags(lines, ctx);
    fl.lines = lines;
    fl.hasU3Marker = hasU3Marker(text);
    var findings = [];
    var role = setupRole(text, ctx);
    if (ruleEnabled(book, 'U1') && role.role) {
      var criteria = 'Role=[' + role.role + '] Path=[' + (role.path || '') + '] Action=[' +
        (role.role === 'LOCAL' ? 'rename to local_setup.sas' :
          (role.role === 'GLOBAL' ? 'keep setup.sas' : 'none')) + ']';
      var code = role.role === 'GLOBAL' ? 'U1-G' : (role.role === 'UNKNOWN' ? 'U1-U' : 'U1');
      findings.push(finding(book, 'U1', ctx, 0, '', criteria, {
        line_text: code + ': ' + criteria
      }));
    }
    lines.forEach(function (_, index) { scanLine(book, ctx, fl, index, findings); });
    if (ruleEnabled(book, 'O4') && ctx.osFamily === 'LINUX' && !fl.hasSetupCall &&
        !o4SetupSkip(text, ctx)) {
      findings.push(finding(book, 'O4', ctx, 0, '',
        'Linux only: missing standard %setup macro invocation',
        { line_text: 'Program-level check: missing standard %setup macro invocation.' }));
    }
    return findings;
  }

  function updateDesc(rule, fallback) {
    return fallback || rule && rule.mc && rule.mc.update && rule.mc.update.update_desc || '';
  }

  function hitFor(book, id, before, after, count, desc) {
    var rule = ruleById(book, id) || { id: id };
    return {
      key: id,
      id: id,
      name: rule.name || id,
      description: rule.description || '',
      category: rule.category || '',
      severity: rule.severity || '',
      find: '',
      replace: '',
      count: count,
      updateDesc: updateDesc(rule, desc || ''),
      details: global.MigRules && global.MigRules.buildChangeDetails
        ? global.MigRules.buildChangeDetails(before, after) : [],
      error: ''
    };
  }

  function recordHit(book, hits, id, before, after, count, desc) {
    if (!count || before === after) return 0;
    hits.push(hitFor(book, id, before, after, count, desc));
    return count;
  }

  function apply(book, text, fileNameArg, rawCtx) {
    var ctx = makeCtx(Object.assign({ bookParameters: book && book.parameters || {} }, rawCtx || {}), fileNameArg);
    ctx.claimedLines = {};
    var beforeAll = String(text == null ? '' : text);
    var out = beforeAll;
    var hits = [];
    var findings = [];
    var rename = null;
    var total = 0;

    (book.updateOrder || UPDATE_ORDER).forEach(function (id) {
      var rule = ruleById(book, id);
      if (!willRun(book, id)) return;
      var before = out;
      var fixed = updateById(id, out, ctx, rule);
      out = fixed.text;
      if (fixed.rename) rename = fixed.rename;
      if (fixed.findings && fixed.findings.length) {
        Array.prototype.push.apply(findings, fixed.findings);
      }
      total += recordHit(book, hits, id, before, out, fixed.count, fixed.desc);
    });

    return {
      text: out,
      total: total,
      hits: hits,
      findings: findings,
      rename: rename
    };
  }

  function mapLines(text, fn) {
    var lines = splitLines(text);
    var count = 0;
    var next = [];
    lines.forEach(function (line, index) {
      var result = fn(line, index, lines);
      if (result.changed) count += result.count || 1;
      Array.prototype.push.apply(next, result.lines);
    });
    return { text: joinLines(next), count: count };
  }

  function updateById(id, text, ctx, rule) {
    if (hasU3Marker(text) && !/^U(?:[1-9]|1[0-3])$/.test(id)) {
      return { text: text, count: 0 };
    }
    if (id === 'U1') return withDesc(updateU1(text, ctx), rule);
    if (id === 'U2') return withDesc(updateU2(text, ctx), rule);
    if (id === 'U3') return withDesc(updateU3(text, ctx), rule);
    if (/^U(?:[4-9]|1[0-3])$/.test(id)) return { text: text, count: 0 };
    if (id === 'F1') return withDesc(updateF1(text, ctx), rule);
    if (id === 'F2') return withDesc(updateF2(text, ctx), rule);
    if (id === 'F3') return withDesc(updateF3(text), rule);
    if (id === 'O1') return withDesc(updateO1(text), rule);
    if (id === 'O2') return withDesc(updateSimple(text, RX.o2, '%sysget(USER)'), rule);
    if (id === 'O3') return withDesc(updateO3(text), rule);
    if (id === 'O4') return withDesc(o4SetupSkip(text, ctx) ? { text: text, count: 0 } : updateO4(text, ctx), rule);
    if (id === 'O5') return withDesc(updateO5(text), rule);
    if (id === 'O6') return withDesc(updateO6(text), rule);
    if (id === 'M1') return withDesc(updateM1(text, ctx), rule);
    if (id === 'M2') return withDesc(updateM2(text, ctx, rule), rule);
    if (id === 'L3') return withDesc(updateL3(text), rule);
    if (id === 'S1') return withDesc(updateSimple(text, RX.s1Update, '%sysget(SAS_EXECFILEPATH)'), rule);
    if (id === 'U14') return withDesc(updateU14(text, ctx), rule);
    if (id === 'U15') return withDesc(updateU15(text, ctx), rule);
    if (id === 'S5') return withDesc(hasU3Marker(text) ? { text: text, count: 0 } : updateS5(text, ctx), rule);
    return { text: text, count: 0 };
  }

  function withDesc(result, rule) {
    result.desc = result.desc || updateDesc(rule, '');
    return result;
  }

  function updateSimple(text, re, replacement) {
    var count = 0;
    re.lastIndex = 0;
    var next = text.replace(re, function () { count++; return replacement; });
    return { text: next, count: count };
  }

  function o4SetupSkip(text, ctx) {
    return isSetupFile(ctx) || definesGlobalSetup(text) || hasU3Marker(text);
  }

  function activeCode(line) {
    return String(line || '').replace(/\/\*.*?\*\//g, '');
  }

  function commentLike(line) {
    return /^\s*(\*|\/\*|%\*)/.test(String(line || ''));
  }

  function u2Matches(line, ctx) {
    if (!isSetupFile(ctx) || commentLike(line) ||
        /^\s*%macro\s+setup\b/i.test(line) || /^\s*\*{3}\s*MIGRATE-STUDIO U2/i.test(line)) {
      return false;
    }
    var active = activeCode(line);
    return /^\s*%include\s+["'][^"']*[\/\\]setup\.sas["']\s*;/i.test(active) ||
      /^\s*%setup\s*(\(\s*\))?\s*;/i.test(active);
  }

  function updateU2(text, ctx) {
    return mapLines(text, function (line) {
      if (!u2Matches(line, ctx)) return { lines: [line] };
      return { changed: true, lines: [U2_PREFIX + line] };
    });
  }

  function u14Matches(line) {
    if (commentLike(line)) return false;
    return /&rawpath\.?[\\\/]vendor([\\\/]|(?=["']))/i.test(line);
  }

  function updateU14(text) {
    return mapLines(text, function (line) {
      if (!u14Matches(line)) return { lines: [line] };
      var next = line.replace(/&rawpath\.?[\\\/]vendor([\\\/]|(?=["']))/ig,
        function (_, tail) { return '&rawvend.' + (tail ? '/' : ''); });
      return { lines: [next], changed: next !== line };
    });
  }

  var U15_MAP = [
    [/&anapath\.?[\\\/]SDTM(?=[\\\/"'\s;)]|$)/ig, '&sdtmdatapath.'],
    [/&anapath\.?[\\\/]ADaM(?=[\\\/"'\s;)]|$)/ig, '&adamdatapath.'],
    [/&valpath\.?[\\\/]SDTM[\\\/]QCdata(?=[\\\/"'\s;)]|$)/ig, '&sdtmvalpath.'],
    [/&valpath\.?[\\\/]ADaM[\\\/]QCdata(?=[\\\/"'\s;)]|$)/ig, '&adamvalpath.'],
    [/&valpath\.?[\\\/]tlf[\\\/]QCdata(?=[\\\/"'\s;)]|$)/ig, '&rsltvalpath.'],
    [/&valpath\.?[\\\/]tlf[\\\/]results(?=[\\\/"'\s;)]|$)/ig, '&rsltvalpath.'],
    [/&rsltpath\.?[\\\/]tlfdata(?=[\\\/"'\s;)]|$)/ig, '&rsltdatapath.'],
    [/&pgmpath\.?[\\\/]sdtm(?=[\\\/"'\s;)]|$)/ig, '&sdtmpgmpath.'],
    [/&pgmpath\.?[\\\/]adam(?=[\\\/"'\s;)]|$)/ig, '&adampgmpath.'],
    [/&pgmpath\.?[\\\/]tlf(?=[\\\/"'\s;)]|$)/ig, '&rsltpgmpath.']
  ];

  function u15LineHasTarget(line) {
    if (commentLike(line)) return false;
    var text = String(line || '');
    return U15_MAP.some(function (pair) {
      pair[0].lastIndex = 0;
      return pair[0].test(text);
    }) || /&(anapath|valpath|rawpath|pgmpath|volume|study|author|hocpath|valutpath)\b\.?/i.test(text);
  }

  function updateU15(text) {
    return mapLines(text, function (line) {
      if (commentLike(line)) return { lines: [line] };
      var next = line;
      U15_MAP.forEach(function (pair) {
        pair[0].lastIndex = 0;
        next = next.replace(pair[0], pair[1]);
      });
      return { lines: [next], changed: next !== line };
    });
  }

  function localSetupName(ctx) {
    return (ctx.params && ctx.params.LOCAL_SETUP_NAME) || 'local_setup.sas';
  }

  function localSetupSiblingExists(ctx) {
    var names = ctx.listDir(ctx.programDir || dirName(ctx.programPath)) || [];
    var want = localSetupName(ctx).toLowerCase();
    return names.some(function (name) { return String(name || '').toLowerCase() === want; });
  }

  function updateU1(text, ctx) {
    var role = setupRole(text, ctx);
    if (!role.role) return { text: text, count: 0 };
    if (role.role === 'LOCAL') {
      if (localSetupSiblingExists(ctx)) {
        return {
          text: text,
          count: 0,
          findings: [finding({ rules: [] }, 'U1', ctx, 0, '',
            'U1-C: local_setup.sas already exists; not overwritten')]
        };
      }
      return {
        text: text,
        count: 0,
        rename: {
          from: fileName(ctx.programPath),
          to: localSetupName(ctx),
          reason: 'Renamed source setup.sas to local_setup.sas for target platform.'
        }
      };
    }
    return {
      text: text,
      count: 0,
      findings: [finding({ rules: [] }, 'U1', ctx, 0, '',
        role.role === 'GLOBAL'
          ? 'U1-G: global setup kept as setup.sas; convert to the target platform standard template by hand.'
          : 'U1-U: could not resolve the absolute path; rename skipped.')]
    };
  }

  function headerField(text, label) {
    var re = new RegExp('^\\s*\\*\\s*' + label.replace(/\s+/g, '\\s+') +
      '\\s*:\\s*(.*?)\\s*$', 'im');
    var m = re.exec(text);
    return m ? m[1].trim() : '';
  }

  function macroValue(text, name) {
    var re = new RegExp('%let\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\s*=\\s*([\\s\\S]*?);', 'i');
    var m = re.exec(text);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  }

  function formatRunDate(date) {
    if (date) return String(date).toUpperCase();
    var d = new Date();
    var months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return String(d.getDate()).padStart(2, '0') + months[d.getMonth()] + d.getFullYear();
  }

  function padLet(name, value, width) {
    width = width || 14;
    return '%let ' + name + String(' ').repeat(Math.max(1, width - name.length)) +
      '= ' + value + ';';
  }

  function extractVendorPairs(text) {
    var out = [];
    var re = /%global\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*%let\s+\1\s*=\s*([\s\S]*?);/ig;
    var m;
    while ((m = re.exec(text))) {
      var name = m[1];
      if (/^(dcodate|datecutoff|corevars)$/i.test(name)) continue;
      out.push({ name: name, value: m[2].replace(/\s+/g, ' ').trim() });
    }
    return out;
  }

  function vendorValue(pair, ctx) {
    var value = pair.value;
    if (!/\.(csv|xlsx?|xlsm|txt)\b/i.test(value)) return value;
    var dirs = ['source_data', 'source_data/EDC_Vendor', 'source_data/vendor'];
    var normalized = value.toLowerCase().replace(/[-\s]+/g, '_');
    var candidates = [];
    dirs.forEach(function (dir) {
      var names = ctx.listDir(dir) || [];
      names.forEach(function (name) {
        var text = String(name || '');
        if (text === value || text.toLowerCase() === value.toLowerCase() ||
            text.toLowerCase().replace(/[-\s]+/g, '_') === normalized) {
          candidates.push(text);
        }
      });
    });
    var unique = candidates.filter(function (name, i) { return candidates.indexOf(name) === i; });
    return unique.length === 1 ? unique[0] : value;
  }

  function extractCorevars(text) {
    var m = /%let\s+corevars\s*=\s*([\s\S]*?);/i.exec(text);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  }

  function libStatement(text, libref) {
    var re = new RegExp('^\\s*libname\\s+' + libref + '\\b[^;]*;', 'im');
    var m = re.exec(text);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  function buildLocalSetup(text, ctx) {
    var protocol = headerField(text, 'PROTOCOL NO') || macroValue(text, 'STUDY') || macroValue(text, 'PROTOCOL') || 'UNKNOWN';
    var drug = headerField(text, 'STUDY DRUG') || '';
    var programmer = headerField(text, 'PROGRAMMER') || '';
    var created = headerField(text, 'DATE CREATED') || '';
    var vendors = extractVendorPairs(text).map(function (pair) {
      return { name: pair.name, value: vendorValue(pair, ctx) };
    });
    var rawvendFolder = (ctx.params && ctx.params.RAWVEND_FOLDER) || 'EDC_Vendor';
    var sasautosMode = ((ctx.params && ctx.params.SASAUTOS_MODE) || 'append').toLowerCase();
    var corevars = extractCorevars(text);
    var lines = [
      '/***************************************************************************',
      ' * STUDY DRUG:       ' + drug,
      ' * PROTOCOL NO:      ' + protocol,
      ' *',
      ' * PROGRAMMER:       ' + programmer,
      ' * DATE CREATED:     ' + created,
      ' * PROGRAM NAME:     local_setup',
      ' * PURPOSE:          Local overrides and study-specific macro variables for',
      ' *                   ' + protocol + '. Included by the target platform global %setup macro from',
      ' *                   <state>/modules/local_setup.sas.',
      ' ***************************************************************************',
      ' PROGRAM MODIFICATION LOG',
      ' ***************************************************************************',
      ' Programmer:    ' + (ctx.operator || 'MIGRATE'),
      ' Date:          ' + formatRunDate(ctx.runDate),
      ' Description:   Converted from source setup.sas to target platform local_setup.sas by',
      '                Migrate Studio (rules U1-U13).',
      ' *************************************************************************/',
      U3_MARKER,
      '',
      '/* ------------------------------------------------------------------',
      '   1. OVERRIDE GLOBAL DATES & HEADERS',
      '   ------------------------------------------------------------------ */',
      padLet('default_header', macroValue(text, 'default_header')),
      '',
      '/* Legacy cut-off dates */',
      padLet('datextr', macroValue(text, 'datextr')),
      padLet('dcodate', macroValue(text, 'dcodate')),
      padLet('datecutoff', macroValue(text, 'datecutoff')),
      '',
      '/* Legacy data types */',
      padLet('DATATYP', macroValue(text, 'DATATYP')),
      padLet('DATA_EXTRACT', macroValue(text, 'DATA_EXTRACT')),
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   2. OVERRIDE SPECIFICATION FILES',
      '   ------------------------------------------------------------------ */',
      '%global ' + vendors.map(function (v) { return v.name; }).concat([
        'raw', 'rawvend', 'rawvend_folder', 'sdtm_spec_file', 'adam_spec_file', 'utilpath'
      ]).join(' ') + ';',
      padLet('sdtm_spec_file', macroValue(text, 'sdtm_spec_file')),
      padLet('adam_spec_file', macroValue(text, 'adam_spec_file')),
      padLet('SPECSXLS', macroValue(text, 'SPECSXLS') || macroValue(text, 'sdtm_spec_file').replace(/\.[^.]+$/, '')),
      padLet('utilpath', '&macpath.'),
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   3. EXTERNAL VENDOR DATA',
      '   ------------------------------------------------------------------ */'
    ];
    vendors.forEach(function (pair, index) {
      lines.push(padLet(pair.name, pair.value, 11));
      if (index === 3 || index === 6 || index === 11) lines.push('');
    });
    lines = lines.concat([
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   4. DOMAIN SPECIFIC MACRO VARIABLES',
      '   ------------------------------------------------------------------ */',
      '%global corevars;',
      '%let corevars = ' + corevars + ';',
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   5. RAW PATHS',
      '   The global setup assigns RAW as a concatenation of the latest dated',
      '   folder for each vendor. Members are picked by folder name, not by',
      '   LEVEL, because LEVEL follows the alphabetical order of vendor names.',
      '   ------------------------------------------------------------------ */',
      '%let rawvend_folder = ' + rawvendFolder + ';',
      '%let raw            = ;',
      '%let rawvend        = ;',
      '',
      'proc sql noprint;',
      '    /* Vendor member: the RAW path under the vendor folder */',
      '    select path into :rawvend trimmed',
      '    from sashelp.vlibnam',
      "    where libname = 'RAW'",
      '      and index(upcase(path), "/%upcase(&rawvend_folder.)/") > 0;',
      '',
      '    /* Primary EDC member: the first RAW path that is not the vendor folder */',
      '    select path into :raw trimmed',
      '    from sashelp.vlibnam',
      "    where libname = 'RAW'",
      '      and index(upcase(path), "/%upcase(&rawvend_folder.)/") = 0;',
      'quit;',
      '',
      '%put NOTE: target platform - Primary raw path is: &raw;',
      '%put NOTE: target platform - Vendor raw path is: &rawvend;',
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   6. ADDITIONAL LIBRARIES',
      '   ------------------------------------------------------------------ */'
    ]);
    var rawvend = libStatement(text, 'rawvend') || 'libname rawvend "&rawpath.\\vendor" access=readonly;';
    var tlfvdata = libStatement(text, 'tlfvdata') || 'libname tlfvdata "&valpath.\\tlf\\QCdata";';
    var smq = libStatement(text, 'smq');
    lines.push('/* source platform: ' + rawvend + ' */');
    lines.push('%_target_assign_lib(rawvend, &rawvend., access=readonly);', '');
    lines.push('/* source platform: ' + tlfvdata + ' */');
    lines.push('%_target_assign_lib(tlfvdata, &rsltvalpath.);', '');
    if (smq) {
      var smqPath = (smq.match(/["']([^"']+)["']/) || [])[1] || '';
      smqPath = smqPath.replace(/\\/g, '/').replace(/^.*?\/statdoc\//i, 'statdoc/');
      lines.push('/* SMQ Reference */');
      lines.push('/* source platform: ' + smq + ' */');
      lines.push('%_target_assign_lib(smq, &targetroot./&purpose_name./' + smqPath + ', access=readonly);', '');
    }
    lines = lines.concat([
      '/* Patient Profiles */',
      '%_target_assign_lib(vendordata, &targetroot./&purpose_name./Patient Profiles/data);',
      '%_target_assign_lib(pfdata, &targetroot./&purpose_name./Patient Profiles/data/profile);',
      '',
      '/* MIGRATE-STUDIO REVIEW (U10): source-platform statements with no target platform equivalent.',
      '   Confirm no program still needs them before deleting this block.',
      '   ' + (libStatement(text, 'raw') || 'libname raw "&rawpath.\\" access=readonly INENCODING=ASCIIANY;'),
      '       -> RAW is now assigned by the global setup, without INENCODING=ASCIIANY.',
      '   ' + (libStatement(text, 'raww') || 'libname raww  "&rawpath.\\";'),
      '       -> write alias of RAW; RAW is read-only on target platform.',
      '   ' + (libStatement(text, 'cdf') || 'libname cdf "&path.\\anadata\\cdf";'),
      '       -> target platform has no anadata folder.',
      '   ' + (libStatement(text, 'sdtma') || 'libname sdtma  "&anapath\\SDTM\\archive";'),
      '       -> archive copies are not carried to target platform.',
      '*/',
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   7. LOCAL MACRO PATHS (SASAUTOS)',
      '   APPEND keeps the source platform precedence: modules are searched before the',
      '   study program folders.',
      '   ------------------------------------------------------------------ */',
      'options ' + sasautosMode + '=(sasautos=(',
      '    "&sdtmpgmpath."',
      '    "&adampgmpath."',
      '    "&rsltpgmpath."',
      '));',
      '',
      '%put NOTE: target platform - SASAUTOS successfully updated. Current search path:;',
      'proc options option=sasautos; run;',
      '',
      '',
      '/* ------------------------------------------------------------------',
      '   8. LOCAL DEBUGGING OPTIONS',
      '   ------------------------------------------------------------------ */'
    ]);
    if (/options\s+mprint\s+mlogic\s+symbolgen\s*;/i.test(text)) {
      lines.push('options mprint mlogic symbolgen;');
    }
    return lines.join('\n');
  }

  function updateU3(text, ctx) {
    if (hasU3Marker(text) || definesGlobalSetup(text)) return { text: text, count: 0 };
    var role = setupRole(text, ctx);
    if (role.role !== 'LOCAL' || localSetupSiblingExists(ctx)) return { text: text, count: 0 };
    return { text: buildLocalSetup(text, ctx), count: 1 };
  }

  function updateF1(text, ctx) {
    var count = 0;
    var names = tocFilenames(null, ctx);
    var re = new RegExp('(' + names.map(escapeRegex).join('|') + ')', 'ig');
    var next = text.replace(re, function (m) {
      var actual = ctx.tocCaseMap[String(m).toLowerCase()] || '';
      if (actual && actual !== m) { count++; return actual; }
      return m;
    });
    return { text: next, count: count };
  }

  function updateF2(text, ctx) {
    return mapLines(text, function (line) {
      if (/^\s*(%?\*|\/\*)/.test(line)) return { lines: [line] };
      var changed = false;
      var next = line;
      var guard = 0;
      while (guard++ < 50) {
        var findings = folderCaseFindings(next, ctx);
        if (!findings.length) break;
        var item = findings[0];
        next = next.slice(0, item.at) + item.actual + next.slice(item.end);
        changed = true;
      }
      return { lines: [next], changed: changed };
    });
  }

  function updateF3(text) {
    return mapLines(text, function (line, index, lines) {
      if (/^\s*\*{3}\s*remove for linux\s*\*{3}/i.test(line)) return { lines: [line] };
      var c = contextFor(lines, index);
      if (!winExempt(c.prev1, c.prev2, c.prev3) && /\boptions\b/i.test(line) &&
          /\b(noxsync|xsync|noxwait|xwait|noxcmd|xcmd)\b/i.test(line)) {
        return { lines: ['*** remove for linux *** ' + line], changed: true };
      }
      return { lines: [line] };
    });
  }

  function extractCd(line) {
    var m = line.match(/\bsystask\s+command\s*=\s*["']cd\s+([^"']+)["']/i);
    if (m) return m[1];
    m = line.match(/\bx\s*["']cd\s+([^"']+)["']/i);
    return m ? m[1] : '';
  }

  function updateO1(text) {
    return mapLines(text, function (line, index, lines) {
      if (/^\s*\*{3}\s*Updated to use dlgcdir\(\)\s*\*{3}/i.test(line)) return { lines: [line] };
      var c = contextFor(lines, index);
      if (winExempt(c.prev1, c.prev2, c.prev3) || (!RX.o1systask.test(line) && !RX.o1x.test(line))) {
        return { lines: [line] };
      }
      var path = extractCd(line);
      if (!path || path === line) return { lines: [line] };
      path = path.replace(/\\/g, '/');
      return {
        changed: true,
        lines: [
          'data _null_;',
          '   rc = dlgcdir("' + path + '");',
          '   put "NOTE: Change directory return code (0 means success): " rc;',
          'run;',
          '*** Updated to use dlgcdir() *** ' + line
        ]
      };
    });
  }

  function updateO3(text) {
    return mapLines(text, function (line, index, lines) {
      if (!RX.o3.test(line)) return { lines: [line] };
      var markerRe = /^\s*\*{3}\s*Updated to preserve _GSFNAME\s*\*{3}\s*;/i;
      var already = lines.slice(Math.max(0, index - 8), index).some(function (prev) {
        return markerRe.test(prev || '');
      });
      if (already) {
        return { lines: [line] };
      }
      return {
        changed: true,
        lines: [
          '*** Updated to preserve _GSFNAME ***;',
          '%let old_path=;',
          '',
          'data _null_;',
          "    if fileref('_GSFNAME') = 0 then",
          "    call symputx('old_path', pathname('_GSFNAME'), 'g');",
          'run;',
          line,
          'data _null_;',
          '    if symget(\'old_path\') ne \'\' then call execute(cats(\'filename _GSFNAME "\', symget(\'old_path\'), \'";\'));',
          "    else call execute('filename _GSFNAME temp;');",
          'run;'
        ]
      };
    });
  }

  var SETUP_COMMENT = '*** Include the standard setup for this project;';
  var SETUP_ANCHOR = /^\s*\*+\s*Include the standard setup for this project\s*;/i;

  function headerEnd(text) {
    var spans = (global.MigRules && global.MigRules.inactiveSpans)
      ? global.MigRules.inactiveSpans(text) : [];

    function inactive(offset) {
      for (var s = 0; s < spans.length; s++) {
        if (offset >= spans[s][0] && offset < spans[s][1]) return true;
      }
      return false;
    }

    var pos = 0;
    var first = -1;
    for (var i = 0; i < spans.length && first === -1; i++) {
      var gap = /\S/.exec(text.slice(pos, spans[i][0]));
      if (gap) {
        first = pos + gap.index;
      } else {
        pos = Math.max(pos, spans[i][1]);
      }
    }
    if (first === -1) {
      var tail = /\S/.exec(text.slice(pos));
      if (tail) first = pos + tail.index;
    }
    if (first === -1) return splitLines(text).length;

    var before = text.slice(0, first);
    var parts = before.split('\n');
    var line = parts.length - 1;
    var lineStart = first - parts[parts.length - 1].length;
    for (var o = lineStart; o < first; o++) {
      if (inactive(o)) return line + 1;
    }
    return line;
  }

  function updateO4(text, ctx) {
    if (ctx.osFamily !== 'LINUX') return { text: text, count: 0 };
    var lines = splitLines(text);
    if (flags(lines, ctx).hasSetupCall) return { text: text, count: 0 };

    var at = -1;
    lines.forEach(function (line, index) {
      if (SETUP_ANCHOR.test(line)) at = index;
    });

    var insert;
    if (at !== -1) {
      at += 1;
      insert = ['%setup;'];
    } else {
      at = headerEnd(joinLines(lines));
      insert = [SETUP_COMMENT, '%setup;'];
    }
    if (String(lines[at] || '').trim() !== '') insert.push('');
    lines.splice.apply(lines, [at, 0].concat(insert));
    return { text: joinLines(lines), count: 1 };
  }

  function updateO5(text) {
    return mapLines(text, function (line, index, lines) {
      var c = contextFor(lines, index);
      if (!o5Matches(line, c)) return { lines: [line] };
      return { changed: true, lines: ['options validvarname=v7;', line] };
    });
  }

  function parseCopyPayload(line) {
    var m = line.match(/^\s*x\s*["']copy\s+(.*)["']\s*;?\s*$/i);
    if (!m) return null;
    var payload = m[1].trim();
    var src = '';
    var dest = '';
    if (payload.indexOf('""') === 0) {
      var qm = payload.match(/^""([^"]+)""\s+""([^"]+)""/);
      if (qm) { src = qm[1]; dest = qm[2]; }
    }
    if (!src || !dest) {
      var parts = payload.replace(/""/g, '"').split(/\s+/);
      src = (parts[0] || '').replace(/^"+|"+$/g, '');
      dest = (parts[1] || '').replace(/^"+|"+$/g, '');
    }
    return src && dest ? { src: src, dest: dest } : null;
  }

  function updateO6(text) {
    return mapLines(text, function (line) {
      if (/^\s*\*{3}\s*Update to use fcopy \( \)\s*\*{3}/i.test(line)) return { lines: [line] };
      var pair = parseCopyPayload(line);
      if (!pair) return { lines: [line] };
      return {
        changed: true,
        lines: [
          '*** Update to use fcopy ( ) *** ' + line,
          'filename src  "' + pair.src + '";',
          'filename dest "' + pair.dest + '";',
          '',
          'data _null_;',
          "    rc = fcopy('src', 'dest');",
          '    if rc = 0 then put "NOTE: Copied ' + pair.src + ' to ' + pair.dest + '";',
          '    else put "ERROR: Copy failed. " rc= sysmsg();',
          'run;'
        ]
      };
    });
  }

  function m1Matches(line) {
    if (/^\s*%\*\*\*include\b/i.test(line)) return false;
    if (/^\s*(\*|\/\*|%\*)/.test(line)) return false;
    if (!RX.m1.test(line)) return false;
    return RX.m1Drive.test(line) || RX.m1Unc.test(line);
  }

  function markClaimed(ctx, index, length) {
    if (!ctx || !ctx.claimedLines) return;
    for (var i = index; i < index + length; i++) ctx.claimedLines[i] = true;
  }

  function updateM1(text, ctx) {
    var lines = splitLines(text);
    var out = [];
    var count = 0;
    lines.forEach(function (line) {
      var prev = out[out.length - 1] || '';
      if (!m1Matches(line) || /Remove hard coded included paths/i.test(prev)) {
        out.push(line);
        return;
      }
      var at = out.length;
      var neutral = line.replace(/^(\s*)%include\b/i, '$1%***include');
      out.push('*** Remove hard coded included paths ***;', neutral);
      markClaimed(ctx, at, 2);
      count++;
    });
    return { text: joinLines(out), count: count };
  }

  function houseParam(rule, name, fallback) {
    return rule && rule.mc && rule.mc.parameters && rule.mc.parameters[name] || fallback;
  }

  function updateM2(text, ctx, rule) {
    var root = (ctx.params && ctx.params.REFDATA_ROOT) ||
      houseParam(rule, 'REFDATA_ROOT', '../../other/data');
    var lines = splitLines(text);
    var out = [];
    var count = 0;
    var desc = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = RX.m2.exec(line);
      var guarded = /^\s*\/\*\*\*/.test(line) ||
        /Replace reference files other data folder/i.test(out[out.length - 1] || '');
      if (!m || guarded) {
        out.push(line);
        continue;
      }

      var indent = m[1];
      var file = m[4].split('\\').pop();
      var replacement = indent + m[2] + m[3] + root + '/' + file + m[5];
      var at = out.length;
      out.push(indent + '/*** Replace reference files other data folder ***/');
      out.push(indent + '/*** ' + line.trim() + ' ***/');
      out.push(replacement);
      markClaimed(ctx, at, 3);
      if (String(lines[i + 1] || '').trim() === '') i++;
      count++;
      desc = 'Repointed ' + m[2] + ' from ' + m[4] + ' to ' + root + '/' + file + '.';
    }
    return { text: joinLines(out), count: count, desc: count === 1 ? desc : '' };
  }

  function updateL3(text) {
    return mapLines(text, function (line) {
      if (/^\s*\*{3}\s*Update del command with rm\s*\*{3}\s*;/i.test(line)) return { lines: [line] };
      if (/^\s*(\*|\/\*)/.test(line)) return { lines: [line] };
      var next = line.replace(/(\bx\s*["'])del\s+/i, '$1rm -f ');
      if (next === line) {
        next = line.replace(/(\bsystask\s+command\s*=\s*")del\s+/i, '$1rm -f ');
      }
      if (next === line) return { lines: [line] };
      return { changed: true, lines: ['*** Update del command with rm ***; ' + next] };
    });
  }

  function updateS5(text, ctx) {
    var claimed = ctx && ctx.claimedLines || {};
    return mapLines(text, function (line, index) {
      if (claimed[index]) return { lines: [line] };
      if (s5Classify(line) !== 'PATH') return { lines: [line] };
      return { changed: true, lines: [line.replace(/\\/g, '/')] };
    });
  }

  function inventory(book, programs, rawCtx) {
    var ctx = makeCtx(Object.assign({ bookParameters: book && book.parameters || {} }, rawCtx || {}), '');
    var rows = (programs || []).map(function (program) {
      return Object.assign(deriveProgram(program, ctx), { program: program });
    });
    return scanF5(book, rows, ctx).concat(scanF6(book, rows, ctx));
  }

  function deriveProgram(program, ctx) {
    var path = displayPath(program.relPath || program.name || '');
    var parent = dirName(path);
    var stem = fileName(path).replace(/\.sas$/i, '');
    var parts = path.split('/');
    var statAt = parts.map(function (p) { return p.toLowerCase(); }).indexOf('stat');
    var purpose = '';
    var purposeSrc = 'NONE';
    var f6Folder = parent;
    if (statAt >= 0 && parts[statAt + 1]) {
      purpose = parts[statAt + 1];
      purposeSrc = 'STAT';
      f6Folder = parts.slice(statAt + 1, -1).join('/');
    } else if (parent) {
      purpose = parent.split('/')[0] || parent.split('/').pop() || '';
      purposeSrc = purpose ? 'FOLDER' : 'NONE';
    }
    return {
      pgm_name: fileName(path),
      pgm_stem: stem,
      pgm_path: path,
      parent_path: parent,
      parent_key: normalizePath(parent),
      purpose: purpose,
      purpose_key: purpose.toLowerCase(),
      purpose_src: purposeSrc,
      pgm_name_key: fileName(path).toLowerCase(),
      folder_path_for_f6: f6Folder
    };
  }

  function scanF5(book, rows, ctx) {
    if (!ruleEnabled(book, 'F5')) return [];
    var groups = {};
    rows.forEach(function (row) {
      if (!row.purpose_key || !row.pgm_name_key || row.purpose_src === 'NONE') return;
      var key = row.purpose_src + '|' + row.purpose_key + '|' + row.pgm_name_key;
      (groups[key] || (groups[key] = [])).push(row);
    });
    var out = [];
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      if (group.length < 2) return;
      group.forEach(function (row) {
        out.push(finding(book, 'F5', Object.assign({}, ctx, { programPath: row.pgm_path }), 0,
          'Program-level check: duplicate program filename found within purpose ' + row.purpose +
          '. Full path: ' + row.pgm_path,
          'Purpose=[' + row.purpose + '] Source=[' + row.purpose_src + '] Program=[' +
          row.pgm_name + '] Matching files=' + group.length));
      });
    });
    return out;
  }

  function scanF6(book, rows, ctx) {
    if (!ruleEnabled(book, 'F6')) return [];
    var out = [];
    var seen = {};
    var dateRe = /(0[1-9]|[12][0-9]|3[01])(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9]{4}|(0[1-9]|[12][0-9]|3[01])_(0[1-9]|1[0-2])_[0-9]{4}|[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])|[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/i;
    function add(row, criteria, text) {
      var key = row.pgm_path + '|' + criteria;
      if (seen[key]) return;
      seen[key] = true;
      out.push(finding(book, 'F6', Object.assign({}, ctx, { programPath: row.pgm_path }), 0, text, criteria));
    }
    rows.forEach(function (row) {
      row.folder_path_for_f6.split('/').some(function (segment) {
        var reason = /archive/i.test(segment) ? 'Folder name contains archive'
          : dateRe.test(segment) ? 'Folder name contains a supported archive date' : '';
        if (!reason) return false;
        add(row, 'Folder=[' + segment + '] Reason=[' + reason + ']', 
          'Program-level check: program may be an archive or backup copy. Full path: ' + row.pgm_path);
        return true;
      });
    });
    rows.forEach(function (a, i) {
      rows.slice(i + 1).forEach(function (b) {
        if (a.parent_key !== b.parent_key) return;
        var pair = alternatePair(a.pgm_stem, b.pgm_stem);
        if (!pair) return;
        add(a, 'Same-folder alternate pair=[' + a.pgm_name + '] and [' + b.pgm_name + '] Confidence=' + pair.level,
          'Program-level check: filename may be an alternate archive or backup copy of ' + b.pgm_name +
          '. Confidence: ' + pair.level + '. Basis: ' + pair.reason + ' Folder: ' + a.parent_path);
        add(b, 'Same-folder alternate pair=[' + a.pgm_name + '] and [' + b.pgm_name + '] Confidence=' + pair.level,
          'Program-level check: filename may be an alternate archive or backup copy of ' + a.pgm_name +
          '. Confidence: ' + pair.level + '. Basis: ' + pair.reason + ' Folder: ' + b.parent_path);
      });
    });
    return out;
  }

  function alternatePair(a, b) {
    var shortStem = a.length <= b.length ? a : b;
    var longStem = a.length <= b.length ? b : a;
    if (shortStem.length === longStem.length) return null;
    if (longStem.toLowerCase().indexOf(shortStem.toLowerCase()) !== 0) return null;
    var suffixRaw = longStem.slice(shortStem.length);
    var hadDelim = /^[_-]/.test(suffixRaw);
    var suffix = suffixRaw.replace(/^[_-]/, '');
    if (!suffix) return null;
    var isNumber = /^\d+$/.test(suffix);
    var isInitial = /^[A-Za-z]{1,2}$/.test(suffix);
    var isKeyword = /^(bak|backup|bkp|old|orig|prev|previous|copy|arch|archive|v[0-9]+)$/i.test(suffix);
    if (isNumber && !hadDelim && /\d$/.test(shortStem)) return null;
    if (!isNumber && !isInitial && !isKeyword) return null;
    if (isKeyword) return { level: 'HIGH', reason: 'Suffix [' + suffix + '] is an explicit backup or version keyword.' };
    if (hadDelim && isInitial) return { level: 'HIGH', reason: 'Delimited initials [' + suffix + '] appended.' };
    if (isInitial) return { level: 'MEDIUM', reason: 'Undelimited initials [' + suffix + '] appended.' };
    if (hadDelim && isNumber) return { level: 'MEDIUM', reason: 'Delimited numeric suffix [' + suffix + '] appended.' };
    return { level: 'LOW', reason: 'Undelimited numeric suffix [' + suffix + '] appended.' };
  }

  global.MigMcRules = {
    parse: parse,
    apply: apply,
    scan: scan,
    inventory: inventory,
    helpers: {
      winExempt: winExempt,
      s5Classify: s5Classify,
      lineContext: contextFor,
      encodeProgramText: encodeProgramText
    },
    ORDER: {
      detection: DETECTION_ORDER,
      update: UPDATE_ORDER
    },
    RX: RX,
    DISPLAY: DISPLAY,
    DISPLAY_LABELS: DISPLAY_LABELS
  };
})(typeof window !== 'undefined' ? window : this);
