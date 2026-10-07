/* ===========================================================================
 * Migrate Studio — xlsx codec
 *
 * The bytes-level half of the Excel interchange: a workbook in, a workbook
 * out, and no opinion about what the sheets mean. js/tlf-workbook.js owns the
 * mapping between those sheets and the Migrate Studio metadata.
 *
 * Why hand-rolled rather than a library: Migrate Studio has no build step and is
 * expected to work when index.html is opened straight off disk, so every
 * dependency is a file somebody on the team has to read. An .xlsx is a zip of
 * XML, and the subset of SpreadsheetML needed for grids of text and numbers is
 * small. Only the zip container is vendored (js/vendor/fflate.min.js, MIT) —
 * inflate is not something worth writing twice.
 *
 * Writing uses inline strings rather than a shared-string table. It makes a
 * larger file and Excel rewrites it to shared strings on first save, which is
 * fine: reading handles both, and the writer stays a few hundred lines.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function (global) {
  'use strict';

  var fflate = global.fflate;

  /* Column widths are in Excel's "characters of the default font" unit; these
     are clamped rather than measured, since a Where clause can run to 200
     characters and a column that wide is unusable. */
  var MIN_WIDTH = 8;
  var MAX_WIDTH = 52;

  // -- small helpers -------------------------------------------------------

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      /* Excel rejects most C0 controls outright. A tab or newline inside a
         cell is legitimate; the rest are dropped rather than escaped, because
         they cannot have been meant. */
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  }

  function colName(index) {
    var name = '';
    var n = index;
    while (n >= 0) {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    }
    return name;
  }

  function colIndex(name) {
    var n = 0;
    for (var i = 0; i < name.length; i++) {
      n = n * 26 + (name.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  /* Excel caps sheet names at 31 characters and forbids : \ / ? * [ ]. Names
     are ours, not user input, but a truncated name that silently collides
     would break the import, so collisions get a numeric suffix. */
  function safeSheetName(name, taken) {
    var clean = String(name).replace(/[:\\\/?*\[\]]/g, ' ').slice(0, 31).trim();
    if (!clean) clean = 'Sheet';
    var candidate = clean;
    var n = 2;
    while (taken[candidate.toLowerCase()]) {
      var suffix = ' ' + n++;
      candidate = clean.slice(0, 31 - suffix.length) + suffix;
    }
    taken[candidate.toLowerCase()] = true;
    return candidate;
  }

  function isNumeric(value) {
    return typeof value === 'number' && isFinite(value);
  }

  // -- writing -------------------------------------------------------------

  function cellXml(ref, value, styleIndex) {
    var style = styleIndex ? ' s="' + styleIndex + '"' : '';
    if (value === null || value === undefined || value === '') {
      return style ? '<c r="' + ref + '"' + style + '/>' : '';
    }
    if (isNumeric(value)) {
      return '<c r="' + ref + '"' + style + '><v>' + value + '</v></c>';
    }
    if (typeof value === 'boolean') {
      return '<c r="' + ref + '"' + style + ' t="b"><v>' + (value ? 1 : 0) +
             '</v></c>';
    }
    return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="' +
           'preserve">' + esc(value) + '</t></is></c>';
  }

  /**
   * Build one worksheet.
   *
   * @param {Object} sheet
   *   name      sheet name
   *   columns   [{header, width, choices, style}] — choices become a dropdown
   *             style = body xf for the column
   *   rows      array of arrays, aligned to columns
   *   zebra     false to disable row banding (default on)
   *   styleFor  fn(rowIndex, colIndex, value) -> xf index | null
   *             wins over column.style and zebra; rowIndex is 0-based
   *             within rows
   *   rowHeight fn(rowIndex) -> points | null
   *   headerHeight points for row 1 (default 22)
   *   merges    ['A1:E1', ...]
   *   frozen    false to skip the frozen header row (default true)
   */
  function sheetXml(sheet) {
    var columns = sheet.columns || [];
    var rows = sheet.rows || [];
    var parts = [];

    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/' +
      'spreadsheetml/2006/main">');

    var lastCol = colName(Math.max(columns.length - 1, 0));
    parts.push('<dimension ref="A1:' + lastCol + Math.max(rows.length + 1, 1) +
      '"/>');

    parts.push('<sheetViews><sheetView workbookViewId="0">');
    if (sheet.frozen !== false) {
      parts.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" ' +
        'state="frozen"/>');
    }
    parts.push('</sheetView></sheetViews>');
    parts.push('<sheetFormatPr defaultRowHeight="15"/>');

    if (columns.length) {
      parts.push('<cols>');
      columns.forEach(function (column, index) {
        var width = Math.min(Math.max(column.width || MIN_WIDTH, MIN_WIDTH),
                             MAX_WIDTH);
        parts.push('<col min="' + (index + 1) + '" max="' + (index + 1) +
          '" width="' + width + '" customWidth="1"/>');
      });
      parts.push('</cols>');
    }

    parts.push('<sheetData>');

    parts.push('<row r="1" ht="' + (sheet.headerHeight || 22) +
               '" customHeight="1" s="1" customFormat="1">');
    columns.forEach(function (column, index) {
      parts.push(cellXml(colName(index) + '1', column.header, S.HEAD));
    });
    parts.push('</row>');

    var banded = sheet.zebra !== false;
    rows.forEach(function (row, rowIndex) {
      var r = rowIndex + 2;
      var ht = sheet.rowHeight && sheet.rowHeight(rowIndex);
      parts.push('<row r="' + r + '"' +
        (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>');
      for (var i = 0; i < columns.length; i++) {
        var s = sheet.styleFor && sheet.styleFor(rowIndex, i, row[i]);
        if (s == null) s = columns[i].style;
        if (s == null) {
          s = banded && (rowIndex % 2 === 1) ? S.ZEBRA : S.BODY;
        } else if (banded && rowIndex % 2 === 1) {
          /* Paired light/zebra variants so banding survives a column style. */
          if (s === S.BODY) s = S.ZEBRA;
          else if (s === S.NUM) s = S.NUM_ZEBRA;
          else if (s === S.MONO) s = S.MONO_ZEBRA;
        }
        var cell = cellXml(colName(i) + r, row[i], s);
        if (cell) parts.push(cell);
      }
      parts.push('</row>');
    });

    parts.push('</sheetData>');

    if (sheet.autofilter !== false && columns.length && rows.length) {
      parts.push('<autoFilter ref="A1:' + lastCol + (rows.length + 1) + '"/>');
    }

    if (sheet.merges && sheet.merges.length) {
      parts.push('<mergeCells count="' + sheet.merges.length + '">');
      sheet.merges.forEach(function (ref) {
        parts.push('<mergeCell ref="' + ref + '"/>');
      });
      parts.push('</mergeCells>');
    }

    /* Dropdowns for controlled-value columns. They are a convenience for
       whoever edits the workbook, not a guarantee — Excel lets a pasted value
       through a validation list without complaint, which is exactly why
       import re-checks every one of these against the schema. */
    var validations = [];
    columns.forEach(function (column, index) {
      if (!column.choices || !column.choices.length) return;
      var list = column.choices.filter(function (v) { return v !== ''; });
      if (!list.length) return;
      var formula = '"' + list.join(',').replace(/"/g, '') + '"';
      if (formula.length > 255) return;   // Excel's inline-list limit
      var ref = colName(index) + '2:' + colName(index) +
                Math.max(rows.length + 1, 2);
      validations.push('<dataValidation type="list" allowBlank="1" ' +
        'showInputMessage="1" showErrorMessage="0" sqref="' + ref +
        '"><formula1>' + esc(formula) + '</formula1></dataValidation>');
    });
    if (validations.length) {
      parts.push('<dataValidations count="' + validations.length + '">');
      parts.push(validations.join(''));
      parts.push('</dataValidations>');
    }

    parts.push('</worksheet>');
    return parts.join('');
  }

  /* Style registry. Indices are contract: 0 = body, 1 = header. Anything
     appended must go on the end. Excel requires fill 0 = none and fill 1 =
     gray125; both are placeholders it will not let you reuse. */
  var S = {
    BODY: 0, HEAD: 1, ZEBRA: 2, SECTION: 3, TITLE: 4,
    LABEL: 5, NUM: 6, NUM_ZEBRA: 7, NOTE: 8,
    MONO: 9, MONO_ZEBRA: 10, ADD: 11, DEL: 12, MOD: 13
  };

  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/' +
      '2006/main">' +

      '<fonts count="6">' +
      '<font><sz val="11"/><color rgb="FF1C1815"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="16"/><color rgb="FF1C1815"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF1C1815"/><name val="Calibri"/></font>' +
      '<font><i/><sz val="10"/><color rgb="FF6F655C"/><name val="Calibri"/></font>' +
      '<font><sz val="10"/><color rgb="FF1C1815"/><name val="Consolas"/></font>' +
      '</fonts>' +

      '<fills count="9">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      fill('FF1A1B1B') +
      fill('FFF4F1EA') +
      fill('FFFAF8F4') +
      fill('FFFFF1EC') +
      fill('FFF0F6E7') +
      fill('FFFDEEEE') +
      fill('FFFDF3E0') +
      '</fills>' +

      '<borders count="4">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      hairline('bottom') +
      '<border>' + edge('left') + edge('right') +
        edge('top') + edge('bottom') + '<diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="medium">' +
        '<color rgb="FFFF7A59"/></bottom><diagonal/></border>' +
      '</borders>' +

      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" ' +
      'borderId="0"/></cellStyleXfs>' +

      '<cellXfs count="14">' +
      xf(0, 0, 0, { align: 'top' }) +
      xf(1, 2, 0, { align: 'center', wrap: 1 }) +
      xf(0, 4, 0, { align: 'top' }) +
      xf(3, 3, 1, { align: 'center' }) +
      xf(2, 0, 3, { align: 'center' }) +
      xf(3, 0, 0, { align: 'top' }) +
      xf(0, 0, 0, { align: 'top', horiz: 'right', numFmt: 3 }) +
      xf(0, 4, 0, { align: 'top', horiz: 'right', numFmt: 3 }) +
      xf(4, 0, 0, { align: 'top' }) +
      xf(5, 0, 0, { align: 'top', wrap: 1 }) +
      xf(5, 4, 0, { align: 'top', wrap: 1 }) +
      xf(0, 6, 0, { align: 'top' }) +
      xf(0, 7, 0, { align: 'top' }) +
      xf(0, 8, 0, { align: 'top' }) +
      '</cellXfs>' +

      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/>' +
      '</cellStyles></styleSheet>';
  }

  function fill(argb) {
    return '<fill><patternFill patternType="solid"><fgColor rgb="' + argb +
           '"/><bgColor indexed="64"/></patternFill></fill>';
  }

  function edge(side) {
    return '<' + side + ' style="thin"><color rgb="FFE2DCD3"/></' + side + '>';
  }

  function hairline(side) {
    return '<border><left/><right/><top/><bottom/><diagonal/></border>'
      .replace('<' + side + '/>', edge(side));
  }

  /* Excel ignores font/fill/border/format on an xf unless the matching
     apply* flag is set. Emitting them unconditionally is harmless and removes
     the single most common cause of "my styles did nothing". */
  function xf(fontId, fillId, borderId, opt) {
    opt = opt || {};
    var a = '<alignment vertical="' + (opt.align || 'top') + '"' +
      (opt.horiz ? ' horizontal="' + opt.horiz + '"' : '') +
      ' wrapText="' + (opt.wrap ? 1 : 0) + '"/>';
    return '<xf numFmtId="' + (opt.numFmt || 0) + '" fontId="' + fontId +
      '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"' +
      ' applyFont="1" applyFill="1" applyBorder="1"' +
      ' applyAlignment="1" applyNumberFormat="1">' + a + '</xf>';
  }

  /**
   * Write a workbook.
   *
   * @param  {Array}  sheets  see sheetXml
   * @return {Uint8Array}     .xlsx bytes
   */
  function write(sheets) {
    if (!fflate) throw new Error('The zip library did not load.');

    var taken = {};
    var named = sheets.map(function (sheet) {
      var copy = {};
      for (var key in sheet) {
        if (Object.prototype.hasOwnProperty.call(sheet, key)) {
          copy[key] = sheet[key];
        }
      }
      copy.name = safeSheetName(sheet.name, taken);
      return copy;
    });

    var files = {};

    var types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/' +
      'content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats' +
      '-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.' +
      'openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.' +
      'openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
    named.forEach(function (sheet, index) {
      types.push('<Override PartName="/xl/worksheets/sheet' + (index + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.' +
        'spreadsheetml.worksheet+xml"/>');
    });
    types.push('</Types>');
    files['[Content_Types].xml'] = types.join('');

    files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" ' +
      'standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats' +
      '.org/package/2006/relationships"><Relationship Id="rId1" Type="http://' +
      'schemas.openxmlformats.org/officeDocument/2006/relationships/' +
      'officeDocument" Target="xl/workbook.xml"/></Relationships>';

    var book = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/' +
      'main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/' +
      'relationships"><sheets>'];
    named.forEach(function (sheet, index) {
      book.push('<sheet name="' + esc(sheet.name) + '" sheetId="' +
        (index + 1) + '" r:id="rId' + (index + 1) + '"/>');
    });
    book.push('</sheets></workbook>');
    files['xl/workbook.xml'] = book.join('');

    var rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/' +
      'relationships">'];
    named.forEach(function (sheet, index) {
      rels.push('<Relationship Id="rId' + (index + 1) + '" Type="http://' +
        'schemas.openxmlformats.org/officeDocument/2006/relationships/' +
        'worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>');
    });
    rels.push('<Relationship Id="rId' + (named.length + 1) + '" Type="http://' +
      'schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
      'Target="styles.xml"/>');
    rels.push('</Relationships>');
    files['xl/_rels/workbook.xml.rels'] = rels.join('');

    files['xl/styles.xml'] = stylesXml();
    named.forEach(function (sheet, index) {
      files['xl/worksheets/sheet' + (index + 1) + '.xml'] = sheetXml(sheet);
    });

    var zipInput = {};
    Object.keys(files).forEach(function (path) {
      zipInput[path] = fflate.strToU8(files[path]);
    });
    /* A fixed entry timestamp so exporting the same metadata twice produces
       identical bytes. It must remain inside the DOS ZIP date range (1980-2099)
       after conversion to local time in every timezone. Noon UTC on 1980-01-01
       stays in 1980 even in negative UTC offsets. The human-readable export
       time lives on the File_Info sheet. */
    return fflate.zipSync(zipInput, {
      level: 6,
      mtime: new Date(Date.UTC(1980, 0, 1, 12, 0, 0))
    });
  }

  // -- reading -------------------------------------------------------------

  /* SpreadsheetML may be written with a namespace prefix on every element —
     <x:sheet>, <x:row>, <x:c> — instead of a default namespace. Both are valid
     and both are common: Excel writes the unprefixed form, several generator
     libraries write the prefixed one. Rather than parse XML properly, every
     tag pattern below allows an optional prefix, which is the whole difference
     between reading a workbook and telling somebody it has no worksheets in it.

     Closing tags carry their own prefix, which need not match the opening one
     in these hand-written patterns — no writer mixes them within a document,
     and being lenient costs nothing here. */
  var NS = '(?:[A-Za-z_][A-Za-z0-9_.-]*:)?';

  function tagRe(name, flags) {
    /* <name .../>  or  <name ...>body</name>, with the body captured second
       and the attributes first. */
    return new RegExp(
      '<' + NS + name + '(?:\\s([^>]*?))?(?:\\/>|>([\\s\\S]*?)<\\/' + NS +
      name + '>)', flags || 'g');
  }

  function bodyRe(name, flags) {
    /* <name ...>body</name> only, body captured first. For elements that never
       appear self-closing in a way we care about. */
    return new RegExp(
      '<' + NS + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + NS + name + '>',
      flags || 'g');
  }

  function unescapeXml(text) {
    return text
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/&#(\d+);/g, function (m, dec) {
        return String.fromCharCode(parseInt(dec, 10));
      })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* Concatenate every <t> in a run-formatted string. Excel splits a cell into
     runs the moment one word is bolded, and dropping the tail would silently
     truncate a description. */
  function textOf(xml) {
    var out = '';
    var re = tagRe('t');
    var match;
    while ((match = re.exec(xml))) out += unescapeXml(match[2] || '');
    return out;
  }

  function sharedStrings(xml) {
    if (!xml) return [];
    var out = [];
    var re = tagRe('si');
    var match;
    while ((match = re.exec(xml))) out.push(match[2] ? textOf(match[2]) : '');
    return out;
  }

  function parseSheet(xml, strings) {
    var rows = [];
    var rowRe = tagRe('row');
    var rowMatch;

    while ((rowMatch = rowRe.exec(xml))) {
      var attrs = rowMatch[1] || '';
      var body = rowMatch[2] || '';
      var rNumber = /\br="(\d+)"/.exec(attrs);
      /* Trust the r attribute over position: a sheet where the user deleted a
         middle row still numbers the survivors by their real position, and the
         import errors quote Excel row numbers back at the user. */
      var rowIndex = rNumber ? parseInt(rNumber[1], 10) - 1 : rows.length;
      var cells = [];

      var cellRe = tagRe('c');
      var cellMatch;
      while ((cellMatch = cellRe.exec(body))) {
        var cellAttrs = cellMatch[1] || '';
        var cellBody = cellMatch[2] || '';
        var ref = /\br="([A-Z]+)\d+"/.exec(cellAttrs);
        var index = ref ? colIndex(ref[1]) : cells.length;
        var type = /\bt="([^"]+)"/.exec(cellAttrs);
        var kind = type ? type[1] : 'n';
        var value = '';

        if (kind === 'inlineStr') {
          value = textOf(cellBody);
        } else {
          var v = bodyRe('v', '').exec(cellBody);
          var raw = v ? unescapeXml(v[1]) : '';
          if (kind === 's') {
            var at = parseInt(raw, 10);
            value = (isFinite(at) && strings[at] !== undefined) ? strings[at] : '';
          } else if (kind === 'b') {
            value = raw === '1' ? 'TRUE' : 'FALSE';
          } else if (kind === 'e') {
            value = raw;                       // #REF!, #N/A — reported as-is
          } else if (kind === 'str') {
            value = raw;
          } else {
            value = raw === '' ? '' : Number(raw);
            if (typeof value === 'number' && !isFinite(value)) value = raw;
          }
        }
        cells[index] = value;
      }

      for (var i = 0; i < cells.length; i++) {
        if (cells[i] === undefined) cells[i] = '';
      }
      rows[rowIndex] = cells;
    }

    for (var r = 0; r < rows.length; r++) {
      if (rows[r] === undefined) rows[r] = [];
    }
    return rows;
  }

  /**
   * Read a workbook.
   *
   * @param  {ArrayBuffer|Uint8Array} data
   * @return {Object} { names: [sheet names in book order],
   *                    sheets: { name: [ [cell, ...], ... ] } }
   *          Row 0 of each sheet is Excel row 1, so an index i in the array is
   *          Excel row i + 1 — the number the user sees in the row gutter.
   */
  function read(data) {
    if (!fflate) throw new Error('The zip library did not load.');

    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length > 16 * 1024 * 1024) throw new Error('Workbook exceeds 16 MiB.');
    var expanded = 0;
    var entries;
    try {
      entries = fflate.unzipSync(bytes, { filter: function (entry) {
        expanded += entry.originalSize;
        if (expanded > 64 * 1024 * 1024 || entry.originalSize > 16 * 1024 * 1024) {
          throw new Error('Workbook exceeds decompression limits.');
        }
        if (/(^|[\\/])\.\.([\\/]|$)/.test(entry.name) || /^[\\/]/.test(entry.name)) {
          throw new Error('Unsafe workbook entry.');
        }
        return /\.(xml|rels)$/.test(entry.name);
      } });
    } catch (error) {
      throw new Error('That file is not a readable .xlsx workbook.');
    }

    function textEntry(path) {
      var entry = entries[path] || entries[path.replace(/^\//, '')];
      return entry ? fflate.strFromU8(entry) : '';
    }

    var bookXml = textEntry('xl/workbook.xml');
    if (!bookXml) {
      throw new Error('That file is not an Excel workbook — no workbook part ' +
        'inside it.');
    }

    var relsXml = textEntry('xl/_rels/workbook.xml.rels');
    var targets = {};
    var relRe = new RegExp('<' + NS + 'Relationship\\b([^>]*?)\\/?>', 'g');
    var relMatch;
    while ((relMatch = relRe.exec(relsXml))) {
      var id = /\bId="([^"]+)"/.exec(relMatch[1]);
      var target = /\bTarget="([^"]+)"/.exec(relMatch[1]);
      if (id && target) {
        var path = target[1].replace(/^\//, '');
        targets[id[1]] = /^xl\//.test(path) ? path : 'xl/' + path;
      }
    }

    var strings = sharedStrings(textEntry('xl/sharedStrings.xml'));

    var names = [];
    var sheets = {};
    var sheetRe = new RegExp('<' + NS + 'sheet\\b([^>]*?)\\/?>', 'g');
    var sheetMatch;
    var ordinal = 0;
    while ((sheetMatch = sheetRe.exec(bookXml))) {
      var sheetAttrs = sheetMatch[1] || '';
      /* <sheets> itself and <sheetPr>, <sheetView>… all start with "sheet";
         the \b above stops the latter, but the container does need excluding. */
      if (!/\bname="/.test(sheetAttrs)) continue;
      ordinal++;

      var nameAttr = /\bname="([^"]*)"/.exec(sheetAttrs);
      /* The relationship-namespace prefix is r: by convention but not by rule,
         so accept any prefix. \b keeps this off sheetId. */
      var ridAttr = /\b[A-Za-z_][A-Za-z0-9_.-]*:id="([^"]+)"/.exec(sheetAttrs) ||
                    /\bid="([^"]+)"/.exec(sheetAttrs);
      var name = nameAttr ? unescapeXml(nameAttr[1]) : ('Sheet' + ordinal);
      /* Some writers omit r:id and rely on positional sheetN.xml naming. */
      var part = (ridAttr && targets[ridAttr[1]]) ||
                 ('xl/worksheets/sheet' + ordinal + '.xml');
      names.push(name);
      sheets[name] = parseSheet(textEntry(part), strings);
    }

    if (!names.length) {
      throw new Error('That workbook has no worksheets in it.');
    }
    return { names: names, sheets: sheets };
  }

  global.MigExcel = {
    write: write,
    read: read,
    colName: colName,
    colIndex: colIndex,
    STYLE: S
  };
})(typeof window !== 'undefined' ? window : this);
