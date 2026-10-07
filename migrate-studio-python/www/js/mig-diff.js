/* ===========================================================================
 * Migrate Studio — line diff and SAS colouring
 *
 * Two jobs, both only needed by the code views:
 *
 *   align(a, b)  turn two arrays of lines into paired rows, so the Fix Compare
 *                panes can be drawn side by side with the same line on the
 *                same screen row. A classic LCS over line hashes; programs are
 *                a few thousand lines at most and the fixed copy differs from
 *                the original in a handful of places, so the quadratic table is
 *                bounded in practice and the fast paths below cover the rest.
 *
 *   colour(text) minimal SAS highlighting — comments, macro tokens, strings,
 *                keywords, numbers — as HTML. Deliberately small: this is a
 *                viewer, not an editor, and a tokenizer that tried to be
 *                complete would be a second product.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function (global) {
  'use strict';

  /* -- alignment ---------------------------------------------------------- */

  /* Above this many lines on either side the LCS table gets expensive enough
     to stall the tab. Past it, fall back to anchoring on the common prefix and
     suffix and treating the middle as one replaced block — which is exactly
     what a whole-file rewrite looks like anyway. */
  var LCS_LIMIT = 4000;

  function splitLines(text) {
    var value = String(text == null ? '' : text);
    if (value === '') return [];
    return value.replace(/\r\n?/g, '\n').split('\n');
  }

  /**
   * Pair up two line arrays.
   *
   * Returns rows of { left, right, leftNo, rightNo, kind } where kind is one
   * of 'same' | 'change' | 'add' | 'del'. A missing side is null, which the
   * renderer draws as a gap so both panes stay in step.
   */
  function align(aText, bText) {
    var a = splitLines(aText);
    var b = splitLines(bText);

    var head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;

    var tail = 0;
    while (tail < a.length - head && tail < b.length - head &&
           a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    var midA = a.slice(head, a.length - tail);
    var midB = b.slice(head, b.length - tail);

    var rows = [];
    var i;
    for (i = 0; i < head; i++) {
      rows.push(row(a[i], b[i], i + 1, i + 1, 'same'));
    }

    var middle = (midA.length > LCS_LIMIT || midB.length > LCS_LIMIT)
      ? blockPair(midA, midB, head)
      : lcsPair(midA, midB, head);
    rows = rows.concat(middle);

    for (i = 0; i < tail; i++) {
      var ai = a.length - tail + i;
      var bi = b.length - tail + i;
      rows.push(row(a[ai], b[bi], ai + 1, bi + 1, 'same'));
    }
    return rows;
  }

  function row(left, right, leftNo, rightNo, kind) {
    return { left: left, right: right, leftNo: leftNo, rightNo: rightNo, kind: kind };
  }

  function normalizedLine(text) {
    return String(text == null ? '' : text)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*([=+\-*/<>(),;])\s*/g, '$1');
  }

  function tokens(text) {
    return normalizedLine(text).match(/[%&]?[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'/g) || [];
  }

  function tokenOverlap(a, b) {
    var left = tokens(a);
    var right = tokens(b);
    if (!left.length || !right.length) return 0;
    var seen = {};
    var union = {};
    left.forEach(function (t) { seen[t] = true; union[t] = true; });
    right.forEach(function (t) { union[t] = true; });
    var common = right.reduce(function (sum, t) {
      return sum + (seen[t] ? 1 : 0);
    }, 0);
    return common / Object.keys(union).length;
  }

  function editDistance(a, b) {
    var n = a.length;
    var m = b.length;
    var prev = new Int32Array(m + 1);
    var curr = new Int32Array(m + 1);
    var i, j, tmp;
    for (j = 0; j <= m; j++) prev[j] = j;
    for (i = 1; i <= n; i++) {
      curr[0] = i;
      for (j = 1; j <= m; j++) {
        curr[j] = a.charAt(i - 1) === b.charAt(j - 1)
          ? prev[j - 1]
          : Math.min(prev[j - 1], prev[j], curr[j - 1]) + 1;
      }
      tmp = prev; prev = curr; curr = tmp;
    }
    return prev[m];
  }

  function lineSimilarity(a, b) {
    var left = normalizedLine(a);
    var right = normalizedLine(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    var maxLen = Math.max(left.length, right.length);
    var charScore = 1 - (editDistance(left, right) / maxLen);
    var tokenScore = tokenOverlap(left, right);
    if (charScore >= 0.82) return charScore;
    if (tokenScore <= 0) return 0;
    return (charScore * 0.75) + (tokenScore * 0.25);
  }

  function changeCandidate(a, b) {
    return lineSimilarity(a, b) >= 0.58;
  }

  function bestCandidate(needle, haystack, start) {
    var best = -1;
    var bestScore = 0;
    for (var i = start; i < haystack.length; i++) {
      var score = lineSimilarity(needle, haystack[i].text);
      if (score >= 0.58 && score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    return best;
  }

  /* Deletions and additions in the same run are paired into 'change' rows only
     when the SAS lines are similar enough to be a genuine replacement. Nearby
     inserted or removed lines stay green or pink instead of turning yellow. */
  function zip(dels, adds, offset) {
    var rows = [];
    var i = 0;
    var j = 0;
    while (i < dels.length || j < adds.length) {
      if (i < dels.length && j < adds.length) {
        if (changeCandidate(dels[i].text, adds[j].text)) {
          rows.push(row(dels[i].text, adds[j].text,
                        dels[i].no + offset, adds[j].no + offset, 'change'));
          i++; j++;
          continue;
        }

        var addMatch = bestCandidate(dels[i].text, adds, j + 1);
        var delMatch = bestCandidate(adds[j].text, dels, i + 1);
        if (addMatch !== -1 && (delMatch === -1 ||
            (addMatch - j) <= (delMatch - i))) {
          while (j < addMatch) {
            rows.push(row(null, adds[j].text, null, adds[j].no + offset, 'add'));
            j++;
          }
          rows.push(row(dels[i].text, adds[j].text,
                        dels[i].no + offset, adds[j].no + offset, 'change'));
          i++; j++;
          continue;
        }
        if (delMatch !== -1) {
          while (i < delMatch) {
            rows.push(row(dels[i].text, null, dels[i].no + offset, null, 'del'));
            i++;
          }
          rows.push(row(dels[i].text, adds[j].text,
                        dels[i].no + offset, adds[j].no + offset, 'change'));
          i++; j++;
          continue;
        }

        rows.push(row(dels[i].text, null, dels[i].no + offset, null, 'del'));
        i++;
      } else if (i < dels.length) {
        rows.push(row(dels[i].text, null, dels[i].no + offset, null, 'del'));
        i++;
      } else {
        rows.push(row(null, adds[j].text, null, adds[j].no + offset, 'add'));
        j++;
      }
    }
    return rows;
  }

  function blockPair(a, b, offset) {
    var dels = a.map(function (text, i) { return { text: text, no: i + 1 }; });
    var adds = b.map(function (text, i) { return { text: text, no: i + 1 }; });
    return zip(dels, adds, offset);
  }

  function lcsPair(a, b, offset) {
    if (!a.length && !b.length) return [];
    if (!a.length || !b.length) return blockPair(a, b, offset);

    var n = a.length;
    var m = b.length;
    /* One row of the table at a time would be enough for the length, but the
       backtrack needs the whole thing. Int32 keeps it compact. */
    var width = m + 1;
    var table = new Int32Array((n + 1) * width);
    var i, j;
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        table[i * width + j] = (a[i] === b[j])
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
      }
    }

    var rows = [];
    var dels = [];
    var adds = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        if (dels.length || adds.length) {
          rows = rows.concat(zip(dels, adds, offset));
          dels = []; adds = [];
        }
        rows.push(row(a[i], b[j], i + 1 + offset, j + 1 + offset, 'same'));
        i++; j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
        dels.push({ text: a[i], no: i + 1 }); i++;
      } else {
        adds.push({ text: b[j], no: j + 1 }); j++;
      }
    }
    while (i < n) { dels.push({ text: a[i], no: i + 1 }); i++; }
    while (j < m) { adds.push({ text: b[j], no: j + 1 }); j++; }
    if (dels.length || adds.length) rows = rows.concat(zip(dels, adds, offset));
    return rows;
  }

  /** Added, removed and changed line counts, for the compare legend. */
  function summarize(rows) {
    var stat = { same: 0, added: 0, removed: 0, changed: 0 };
    rows.forEach(function (r) {
      if (r.kind === 'same') stat.same++;
      else if (r.kind === 'add') stat.added++;
      else if (r.kind === 'del') stat.removed++;
      else stat.changed++;
    });
    return stat;
  }

  /* -- SAS colouring ------------------------------------------------------- */

  var KEYWORDS = new RegExp(
    '\\b(' + [
      'data', 'set', 'merge', 'by', 'run', 'quit', 'proc', 'libname', 'filename',
      'if', 'then', 'else', 'do', 'end', 'while', 'until', 'select', 'when',
      'otherwise', 'output', 'keep', 'drop', 'rename', 'where', 'label',
      'format', 'informat', 'length', 'array', 'retain', 'call', 'stop',
      'delete', 'return', 'infile', 'input', 'put', 'options', 'ods', 'title',
      'footnote', 'attrib', 'class', 'var', 'tables', 'model', 'means', 'sort',
      'freq', 'transpose', 'sql', 'create', 'select', 'from', 'join', 'on',
      'group', 'order', 'having', 'union', 'insert', 'update', 'delete', 'into'
    ].join('|') + ')\\b', 'gi');

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Colour one line of SAS as HTML.
   *
   * Line-at-a-time, so a /* … *\/ comment spanning lines is only coloured on
   * the line that opens it — accepted, because the alternative is carrying
   * lexer state across a diff where the two panes are at different offsets.
   */
  function colourLine(line) {
    var text = String(line == null ? '' : line);

    /* A full-line comment wins outright; nothing inside it is code. */
    if (/^\s*\*/.test(text) || /^\s*\/\*/.test(text)) {
      return '<span class="cmt">' + escapeHtml(text) + '</span>';
    }

    var out = '';
    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);

      /* strings */
      if (ch === '"' || ch === "'") {
        var end = i + 1;
        while (end < text.length && text.charAt(end) !== ch) end++;
        var literal = text.slice(i, Math.min(end + 1, text.length));
        out += '<span class="str">' + escapeHtml(literal) + '</span>';
        i = end + 1;
        continue;
      }

      /* inline comment to end of line */
      if (ch === '/' && text.charAt(i + 1) === '*') {
        out += '<span class="cmt">' + escapeHtml(text.slice(i)) + '</span>';
        return out;
      }

      /* macro variables and macro statements */
      if (ch === '&' || ch === '%') {
        var m = /^[&%][A-Za-z_][A-Za-z0-9_]*\.?/.exec(text.slice(i));
        if (m) {
          out += '<span class="mcr">' + escapeHtml(m[0]) + '</span>';
          i += m[0].length;
          continue;
        }
      }

      /* words and numbers, run at a time */
      var word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (word) {
        KEYWORDS.lastIndex = 0;
        var isKeyword = new RegExp('^(' + word[0] + ')$', 'i').test(word[0]) &&
          KEYWORDS.test(word[0]);
        KEYWORDS.lastIndex = 0;
        out += isKeyword
          ? '<span class="jk">' + escapeHtml(word[0]) + '</span>'
          : escapeHtml(word[0]);
        i += word[0].length;
        continue;
      }

      var num = /^\d+(\.\d+)?/.exec(text.slice(i));
      if (num) {
        out += '<span class="jn">' + escapeHtml(num[0]) + '</span>';
        i += num[0].length;
        continue;
      }

      out += escapeHtml(ch);
      i++;
    }
    return out;
  }

  /* -- word-level change highlighting ------------------------------------ */

  /* Split a single source line into display-preserving tokens. Whitespace is
     kept verbatim for rendering but compares as one logical space, which keeps
     indentation-only differences from making every following token look new. */
  function wordTokens(text) {
    var value = String(text == null ? '' : text);
    var pattern = /\s+|[&%][A-Za-z_][A-Za-z0-9_]*\.?|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|"(?:[^"]|"")*"|'(?:[^']|'')*'|./g;
    var found = value.match(pattern) || [];
    return found.map(function (raw) {
      return { raw: raw, key: /^\s+$/.test(raw) ? ' ' : raw };
    });
  }

  function appendWordPart(parts, text, changed, cssClass) {
    if (!text) return;
    var last = parts.length ? parts[parts.length - 1] : null;
    if (last && last.changed === changed) {
      last.text += text;
    } else {
      parts.push({ text: text, changed: changed, cssClass: cssClass });
    }
  }

  function renderWordParts(parts) {
    return parts.map(function (part) {
      var html = colourLine(part.text);
      return part.changed
        ? '<span class="' + part.cssClass + '">' + html + '</span>'
        : html;
    }).join('');
  }

  /* Highlight the exact changed tokens inside a line pair. This is deliberately
     separate from line alignment: align() still owns same/change/add/del, while
     wordDiff() only decorates a row already classified as change. */
  function wordDiff(leftLine, rightLine) {
    var left = wordTokens(leftLine);
    var right = wordTokens(rightLine);
    var n = left.length;
    var m = right.length;
    var leftChanged = new Array(n).fill(true);
    var rightChanged = new Array(m).fill(true);

    /* Token LCS is tiny for normal SAS source lines. Cap the matrix for an
       unusually generated single line; in that case prefix/suffix matches still
       give useful highlights without risking a large browser allocation. */
    if (n * m <= 250000) {
      var width = m + 1;
      var table = new Int32Array((n + 1) * width);
      var i, j;
      for (i = n - 1; i >= 0; i--) {
        for (j = m - 1; j >= 0; j--) {
          table[i * width + j] = left[i].key === right[j].key
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
        }
      }
      i = 0; j = 0;
      while (i < n && j < m) {
        if (left[i].key === right[j].key) {
          leftChanged[i] = false;
          rightChanged[j] = false;
          i++; j++;
        } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
          i++;
        } else {
          j++;
        }
      }
    } else {
      var head = 0;
      while (head < n && head < m && left[head].key === right[head].key) {
        leftChanged[head] = false;
        rightChanged[head] = false;
        head++;
      }
      var tail = 0;
      while (tail < n - head && tail < m - head &&
             left[n - 1 - tail].key === right[m - 1 - tail].key) {
        leftChanged[n - 1 - tail] = false;
        rightChanged[m - 1 - tail] = false;
        tail++;
      }
    }

    var leftParts = [];
    var rightParts = [];
    left.forEach(function (token, i) {
      appendWordPart(leftParts, token.raw, leftChanged[i], 'word-del');
    });
    right.forEach(function (token, i) {
      appendWordPart(rightParts, token.raw, rightChanged[i], 'word-add');
    });

    return {
      leftHtml: renderWordParts(leftParts),
      rightHtml: renderWordParts(rightParts)
    };
  }

  /** Colour a whole program, with a line-number gutter. */
  function colour(text) {
    var lines = splitLines(text);
    var digits = String(lines.length).length;
    return lines.map(function (line, i) {
      return '<span class="ln">' + pad(i + 1, digits) + '</span>' +
             colourLine(line);
    }).join('\n');
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = ' ' + s;
    return s;
  }

  global.MigDiff = {
    align: align,
    summarize: summarize,
    colour: colour,
    colourLine: colourLine,
    wordDiff: wordDiff,
    splitLines: splitLines,
    escapeHtml: escapeHtml,
    pad: pad
  };
})(typeof window !== 'undefined' ? window : this);
