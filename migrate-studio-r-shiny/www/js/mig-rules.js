/* ===========================================================================
 * Migrate Studio — the rule book
 *
 * Migrate_Studio_Rules.xlsx is written by people, in Excel, and no two sites will
 * agree on what to call the columns or where to start the table. So this file
 * does not impose a schema. It finds the header row, matches the headers it
 * recognises against the alias lists below, keeps every column verbatim for
 * the Rules tab, and separately works out — per row — whether there is enough
 * there to actually change a program.
 *
 * Four things are worth knowing before reading further.
 *
 * The header is not row 1. A consolidated rule book usually opens with a title
 * and a note about how the IDs are scoped, and the table starts under them. So
 * the first dozen rows are scored against the aliases and the best-matching one
 * is taken as the header — not the first non-blank row, which would read the
 * title as a one-column table.
 *
 * Rules come from the Rules sheet alone. The other sheets in a consolidated
 * workbook — evidence, crosswalks, a program inventory — are provenance.
 * Reading them as instructions would be a category error.
 *
 * A row is executable when it carries something to match on. Everything else
 * is documentation: shown in the table, counted, and skipped when a fix runs.
 * That split is deliberate. A rule book is a shared document long before it is
 * a program, and a row somebody is still writing must not silently corrupt a
 * study's SAS.
 *
 * Patterns are written as code, not as regular expressions. "%init;" means
 * that text. "%util_cvtds(<DOMAIN>);" means that macro call with anything in the
 * argument, and the After column writing "<DOMAIN>" back gets the real domain
 * out of the program. The wildcards are "...", "<NAME>", "{NAME}", "[optional
 * text]" and "a|b"; whitespace is elastic; everything else is literal. A
 * pattern can still be an explicit regex when a Mode column says so, or when
 * it is written /like this/i. A Before cell holding several numbered variants
 * becomes one rule per variant, paired with the matching After variant.
 *
 * A parameter the Before pattern never captures — "{ADAM_LIBREF}" appearing
 * only on the After side — has no value to substitute. Such a rule parses and
 * is listed, but it starts unticked, because writing the placeholder itself
 * into somebody's SAS is worse than not running.
 * =========================================================================
 * Migrate Studio
 *
 * Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
*/
(function (global) {
  'use strict';

  /* -- header matching ---------------------------------------------------- */

  var ALIASES = {
    id:       ['ruleid', 'globalruleid', 'id', 'rule', 'ruleno', 'rulenumber',
               'no', 'seq'],
    name:     ['shorttitle', 'rulename', 'name', 'title', 'shortname', 'label'],
    desc:     ['description', 'desc', 'comment', 'comments', 'note', 'notes',
               'rationale', 'reason', 'detail', 'details'],
    category: ['category', 'group', 'type', 'class', 'area', 'topic', 'module'],
    axis:     ['axis', 'dimension', 'layer'],
    find:     ['beforepatternvariants', 'beforepattern', 'before', 'find',
               'match', 'pattern', 'search', 'searchfor', 'from', 'old',
               'oldvalue', 'source', 'regex', 'regexp', 'findwhat', 'lookfor',
               'target'],
    replace:  ['afterpatternvariants', 'afterpattern', 'after', 'replace',
               'replacement', 'replacewith', 'to', 'new', 'newvalue', 'fix',
               'fixto', 'result', 'substitute', 'sub'],
    conditions: ['conditions', 'condition', 'when', 'applieswhen', 'guard'],
    mode:     ['mode', 'matchtype', 'kind', 'method', 'style', 'regexflag',
               'isregex', 'useregex'],
    flags:    ['flags', 'regexflags', 'options', 'modifiers'],
    scope:    ['scope', 'appliesto', 'filefilter', 'filepattern', 'programs',
               'program', 'filemask'],
    enabled:  ['enabled', 'active', 'on', 'use', 'apply', 'include', 'status'],
    severity: ['severity', 'riskifwrong', 'risk', 'level', 'priority', 'impact'],
    automatability: ['automatability', 'automation', 'automatable', 'auto'],
    occurrences: ['occurrences', 'occurrence', 'count', 'hits', 'instances'],
    examples: ['exampleprograms', 'examples', 'example'],
    conflict: ['conflictstatus', 'conflict', 'conflicts'],
    confidence: ['confidence', 'certainty']
  };

  /* The columns the Rules tab shows, in order. Everything else the workbook
     carries is still parsed and still on the rule — it is simply not what
     somebody choosing which fixes to run needs to read. */
  var DISPLAY = ['id', 'name', 'category', 'desc'];
  var DISPLAY_LABELS = {
    id: 'Rule ID',
    name: 'Short Title',
    category: 'Category',
    desc: 'Description'
  };

  /* Which sheet holds the rules, matched after normalising. */
  var RULES_SHEET = 'rules';

  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** Map each logical field to the index of the first header that matches. */
  function mapHeaders(headers) {
    var norm = headers.map(normalize);
    var map = {};
    Object.keys(ALIASES).forEach(function (field) {
      var aliases = ALIASES[field];
      for (var i = 0; i < norm.length; i++) {
        if (aliases.indexOf(norm[i]) !== -1) { map[field] = i; return; }
      }
    });
    return map;
  }

  /* -- value coercion ------------------------------------------------------ */

  var TRUE_WORDS  = ['y', 'yes', 'true', '1', 'on', 'x', 'enabled', 'active',
                     'apply', 'include'];
  var FALSE_WORDS = ['n', 'no', 'false', '0', 'off', 'disabled', 'inactive',
                     'skip', 'exclude', 'ignore'];
  var DEFAULT_PARAMS = {
    ADAM_LIBREF: 'ADaM'
  };

  /** Blank means enabled. A rule book listing rules that do nothing by default
      would be a surprising document; the opt-out is the explicit "N". */
  function truthy(value) {
    var text = normalize(value);
    if (!text) return true;
    if (FALSE_WORDS.indexOf(text) !== -1) return false;
    if (TRUE_WORDS.indexOf(text) !== -1) return true;
    return true;
  }

  function cell(row, index) {
    if (index == null || index < 0 || index >= row.length) return '';
    var value = row[index];
    return value == null ? '' : String(value).trim();
  }

  function nonEmpty(value) {
    return value != null && String(value).trim() !== '';
  }

  /* -- how a row matches ---------------------------------------------------
   * Four modes:
   *   regex   an explicit mode/flag column says so, or the pattern is written
   *           in /…/flags form
   *   word    a bare identifier or macro token — matched on word boundaries,
   *           so replacing DATA does not maul VALIDATA
   *   code    a fragment of SAS with wildcards in it. The default, because it
   *           is what a Before/After column in a migration rule book holds
   *   text    a literal substring, when a mode column asks for one
   * A site that wants to be explicit puts regex / text / word / code in a mode
   * column and none of the guessing applies. */

  var BARE_WORD = /^[A-Za-z_%&][A-Za-z0-9_.]*$/;

  function decideMode(pattern, modeText, flagsText) {
    var mode = normalize(modeText);
    if (mode.indexOf('regex') !== -1 ||
        mode === 'y' || mode === 'yes' || mode === 'true' || mode === '1') {
      return 'regex';
    }
    if (mode.indexOf('word') !== -1) return 'word';
    if (mode.indexOf('code') !== -1 || mode.indexOf('sas') !== -1) return 'code';
    if (mode.indexOf('text') !== -1 || mode.indexOf('literal') !== -1 ||
        mode.indexOf('exact') !== -1 || mode.indexOf('plain') !== -1 ||
        mode === 'n' || mode === 'no' || mode === 'false' || mode === '0') {
      return 'text';
    }
    if (flagsText) return 'regex';
    if (/^\/[\s\S]*\/[gimsuy]*$/.test(pattern)) return 'regex';
    if (BARE_WORD.test(pattern)) return 'word';
    return 'code';
  }

  function escapeRe(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Compile a fragment of SAS into a pattern.
   *
   * A single left-to-right scan, so a token is only ever recognised in the
   * original text — never in something an earlier substitution produced. That
   * is the whole reason this is a scanner and not a chain of .replace() calls:
   * escaping first and then rewriting inside the escaped string is how a stray
   * bracket in a rule book turns into a syntax error, or worse, into syntax.
   *
   *   ...            any run of text, non-greedy. Greedy would let "%mac(...);"
   *                  run to the last semicolon in the program rather than to
   *                  the end of the call
   *   <NAME>         a placeholder: whatever is in that position, captured, so
   *                  the After column can put the same value back
   *   {NAME}         a named parameter. Captured too when it appears here — a
   *                  parameter the Before pattern reads is a value the program
   *                  already carries
   *   [text like this]   optional text, when the brackets hold a comma or a
   *                  space. "[, existing options]" is prose for "and whatever
   *                  else was already there"
   *   [abc]          a character class, when they do not. "%[xk]updata1" means
   *                  either spelling of the macro
   *   a|b            either bare word — "libref=data|DATA"
   *   whitespace     any whitespace, because no two programmers indent a macro
   *                  call the same way
   *
   * Everything else is literal.
   *
   * Returns { source, groups } where groups maps each placeholder name to its
   * capture-group number, so the replacement can refer back to it.
   */
  var PLACEHOLDER_ANGLE = /^<([^<>\n]{1,60})>/;
  var PLACEHOLDER_BRACE = /^\{([A-Za-z0-9_]{1,60})\}/;
  var BRACKETED = /^\[([^\][\n]{0,80})\]/;

  /* A named placeholder stands for one argument, so it is greedy but stops at
     a comma. Greedy matters: "<NAME>[, the rest]" with a lazy first group lets
     the second group take everything and the first match nothing, which is how
     "%util_getdata(adsl, libref=data)" becomes "%util_getdata(, libref=ADaM)". */
  var NAMED_MATCH = '([^,;\\n]*)';
  /* Bracketed prose and "..." stand for any amount of text, so they stay lazy
     and stop at the end of the statement. */
  var LOOSE_MATCH = '([^;\\n]*?)';
  var ELLIPSIS_MATCH = '([\\s\\S]*?)';

  /**
   * Tokenise a Before or After pattern into the wildcards it contains.
   *
   * Both sides use the same vocabulary, which is the point: a wildcard in the
   * After column refers to what the same wildcard in the Before column matched.
   * Sharing one tokeniser is what keeps that promise true — the two sides
   * cannot drift into disagreeing about what "..." is.
   *
   * Calls `onToken(kind, name, length)` for each wildcard and `onChar(ch)` for
   * everything else, strictly left to right, so nothing is ever recognised in
   * text an earlier step produced.
   */
  function scanPattern(text, onToken, onChar, onSpace) {
    var source = String(text);
    var i = 0;

    while (i < source.length) {
      var rest = source.slice(i);

      if (rest.slice(0, 3) === '...') {
        onToken('ellipsis', '', 3);
        i += 3;
        continue;
      }

      var angle = PLACEHOLDER_ANGLE.exec(rest);
      if (angle && /[A-Z]/.test(angle[1])) {
        onToken('name', angle[1].trim(), angle[0].length);
        i += angle[0].length;
        continue;
      }

      var brace = PLACEHOLDER_BRACE.exec(rest);
      if (brace) {
        onToken('name', brace[1].trim(), brace[0].length);
        i += brace[0].length;
        continue;
      }

      var bracket = BRACKETED.exec(rest);
      if (bracket) {
        /* "[, existing options]" is prose for "and whatever else was there".
           "[xk]" is a character class. Whitespace or a comma tells them apart,
           which is not a deep rule but is exactly how rule books are written. */
        if (/[,\s]/.test(bracket[1])) {
          onToken('optional', '', bracket[0].length);
        } else {
          onToken('class', bracket[1], bracket[0].length);
        }
        i += bracket[0].length;
        continue;
      }

      var space = /^\s+/.exec(rest);
      if (space) {
        if (onSpace) onSpace(space[0]);
        else onChar(space[0]);
        i += space[0].length;
        continue;
      }

      var alternation = /^([A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)+)/.exec(rest);
      if (alternation) {
        onToken('alternation', alternation[1], alternation[1].length);
        i += alternation[1].length;
        continue;
      }

      onChar(source.charAt(i));
      i += 1;
    }
  }

  /**
   * Compile a Before pattern into a regular expression.
   *
   *   ...              any run of text, captured
   *   <NAME> {NAME}    one argument, captured under that name
   *   [text like this] optional text, captured
   *   [abc]            a character class
   *   a|b              either bare word
   *   whitespace       any whitespace, because no two programmers indent a
   *                    macro call the same way
   *
   * Everything else is literal, escaped one character at a time so that a
   * stray bracket in a rule book can never become syntax.
   *
   * Returns { source, groups, slots }: `groups` maps a placeholder name to its
   * capture number, and `slots` lists every capture in order with its kind, so
   * the After pattern can refer back to them by name or by position.
   */
  function compileCodePattern(text) {
    var out = '';
    var groups = {};
    var slots = [];
    var group = 0;

    function open(kind, name, pattern) {
      /* A name used twice in one pattern means the same value in both places,
         which is a backreference, not a second capture. */
      if (name && Object.prototype.hasOwnProperty.call(groups, name)) {
        return '\\' + groups[name];
      }
      group += 1;
      if (name) groups[name] = group;
      slots.push({ kind: kind, name: name, group: group });
      return pattern;
    }

    scanPattern(text,
      function (kind, name) {
        if (kind === 'ellipsis') {
          out += open('ellipsis', '', ELLIPSIS_MATCH);
        } else if (kind === 'name') {
          out += open('name', name, NAMED_MATCH);
        } else if (kind === 'optional') {
          out += open('optional', '', LOOSE_MATCH) + '?';
        } else if (kind === 'class') {
          out += '[' + name.replace(/[\\^\]]/g, '\\$&') + ']';
        } else if (kind === 'alternation') {
          out += '(?:' + name.split('|').map(escapeRe).join('|') + ')';
        }
      },
      function (ch) { out += escapeRe(ch); },
      function () { out += '\\s+'; });

    return { source: out, groups: groups, slots: slots };
  }

  /**
   * Turn an After pattern into a replacement string.
   *
   * Every wildcard on the After side refers to what the matching wildcard on
   * the Before side captured. Named ones match by name, so
   * "%util_cvtds(<DOMAIN>);" -> "%util_cvtds(<DOMAIN>,libref=ADaM);" keeps the real
   * domain. Unnamed ones — "..." and "[, existing options]" — match by
   * position among wildcards of the same kind, so
   * "%util_resize_xpt(...);" -> "*%util_resize_xpt(...);" comments out the call the program
   * actually contains rather than writing three literal dots into it.
   *
   * A name the Before pattern never captured is a parameter with no value.
   * Writing "{ADAM_LIBREF}" into somebody's SAS would be worse than not
   * running, so those names are collected and the caller refuses to tick the
   * rule.
   */
  function buildReplacement(after, compiled, params) {
    var groups = (compiled && compiled.groups) || {};
    var slots = (compiled && compiled.slots) || [];
    var values = params || {};
    var pending = [];
    var out = '';
    var used = { ellipsis: 0, optional: 0 };

    function nextOf(kind) {
      var matches = slots.filter(function (slot) { return slot.kind === kind; });
      var slot = matches[used[kind]];
      used[kind] += 1;
      return slot ? slot.group : 0;
    }

    scanPattern(after == null ? '' : after,
      function (kind, name, length) {
        if (kind === 'name') {
          if (Object.prototype.hasOwnProperty.call(groups, name)) {
            out += '$' + groups[name];
          } else if (Object.prototype.hasOwnProperty.call(values, name)) {
            out += values[name];
          } else {
            if (pending.indexOf(name) === -1) pending.push(name);
            /* Leave the placeholder visible rather than dropping it: the rule
               will not be ticked, and if somebody ticks it anyway the output
               says plainly what was missing. */
            out += String(after).substr(0, 0) + '{' + name + '}';
          }
        } else if (kind === 'ellipsis' || kind === 'optional') {
          var group = nextOf(kind);
          out += group ? ('$' + group) : (kind === 'ellipsis' ? '...' : '');
        } else if (kind === 'class') {
          out += '[' + name + ']';
        } else if (kind === 'alternation') {
          /* Alternation is a matching idea, not a writing one. On the After
             side the first spelling is what gets written. */
          out += name.split('|')[0];
        }
      },
      function (ch) { out += ch; },
      function (ws) { out += ws; });

    /* Protect a lone "$" the workbook meant literally, without disturbing the
       "$n" backreferences just built. */
    out = out.replace(/\$(?!\d)/g, '$$$$');
    return { text: out, pending: pending };
  }

  /* SAS is case-insensitive in its own syntax, and a rule book that had to
     spell PROC three ways would be unusable. So "i" is on unless a flags
     column deliberately leaves it off. "g" is always on: a rule that fixed
     only the first occurrence in a 2,000-line program would be a bug report. */
  function buildRegex(rule) {
    var pattern = rule.find;
    var flags = rule.flags;

    if (rule.mode === 'regex') {
      var wrapped = /^\/([\s\S]*)\/([gimsuy]*)$/.exec(pattern);
      if (wrapped) { pattern = wrapped[1]; flags = flags || wrapped[2]; }
    } else if (rule.mode === 'word') {
      pattern = '(?<![A-Za-z0-9_])' + escapeRe(pattern) + '(?![A-Za-z0-9_])';
    } else if (rule.mode === 'code') {
      var compiled = compileCodePattern(pattern);
      pattern = compiled.source;
      rule.compiled = compiled;
      rule.groups = compiled.groups;
    } else {
      pattern = escapeRe(pattern);
    }

    var use = 'g';
    if (flags) {
      /* Keep only the flags that mean something here, and never let a workbook
         turn off "g". */
      String(flags).toLowerCase().split('').forEach(function (f) {
        if ('imsu'.indexOf(f) !== -1 && use.indexOf(f) === -1) use += f;
      });
    }
    if (use.indexOf('i') === -1 && !/(^|[^a-z])case/.test(normalize(rule.flags))) {
      use += 'i';
    }

    try {
      return new RegExp(pattern, use);
    } catch (error) {
      /* Lookbehind is unsupported in older Safari; fall back to a capture. */
      if (rule.mode === 'word') {
        try {
          rule.wordFallback = true;
          return new RegExp('\\b' + escapeRe(rule.find) + '\\b', use);
        } catch (e2) { /* fall through */ }
      }
      rule.error = error.message;
      return null;
    }
  }

  /* Excel keeps $1 as a literal, and so do most people writing a rule book.
     Backreferences are still honoured for anyone who wants them, so the
     replacement is passed through untouched — except for a bare "$" that is
     not part of one, which JavaScript would otherwise eat. */
  function normalizeReplacement(text) {
    return String(text).replace(/\$(?![$&`'\d<])/g, '$$$$');
  }

  /* -- variants -------------------------------------------------------------
   * A Before cell often holds several numbered spellings of the same change,
   * with the After cell holding the matching ones:
   *
   *     Variant 1: %util_getdata(..., libref=data, ...);
   *     Variant 2: %util_getdata(..., lib=data, ...);
   *
   * Each pair becomes its own rule, so one variant firing does not imply the
   * other did and the count against a program stays honest. The Rules tab
   * still shows one line per workbook row. */

  var VARIANT = /^[ \t]*variant\s*(\d+)\s*[:.)-]\s*/i;

  function splitVariants(text) {
    var value = String(text == null ? '' : text);
    if (!/variant\s*\d/i.test(value)) {
      return value.trim() ? [{ n: 0, text: value.trim() }] : [];
    }

    var out = [];
    var current = null;
    value.split(/\r?\n/).forEach(function (line) {
      var head = VARIANT.exec(line);
      if (head) {
        if (current) out.push(current);
        current = { n: parseInt(head[1], 10), text: line.replace(VARIANT, '') };
      } else if (current) {
        current.text += '\n' + line;
      }
    });
    if (current) out.push(current);

    return out.map(function (part) {
      part.text = part.text.trim();
      return part;
    }).filter(function (part) { return part.text; });
  }

  /* A Before cell that describes an absence rather than a pattern — the
     workbook convention is square brackets, "[no corresponding line]". There
     is nothing to match, but that does not make the rule inert: if the After
     column carries a line, the rule is an INSERTION, and what makes it
     applicable is an anchor rather than a pattern. Only a row with no After
     either is documentation. */
  function isAbsence(text) {
    return /^\s*\[/.test(text);
  }

  /* -- where an insertion goes ---------------------------------------------
   * The rules that insert say where in their Conditions column: "Insert in the
   * startup/bootstrap section before migration-dependent macro calls. | Insert
   * once in program startup." So the anchor is the end of the opening run of
   * startup statements.
   *
   * Only the OPENING block counts. These programs have startup-shaped
   * statements further down too — a `libname trans xport` before the transport
   * copy, a `%let tlfkey` before the spec call — and taking the last of them
   * anywhere in the file would put the insertion at the bottom of the program,
   * after everything that depends on it. So the scan stops at the first
   * statement that begins the program proper.
   *
   * A commented-out startup statement still counts as startup: that is exactly
   * what the rules which disable `%init;` leave behind, and an insertion
   * belongs with them rather than above them. */

  var STARTUP_STATEMENT =
    /^\s*(?:options\b|%init\b|%setupanl\b|%include\b|libname\b|filename\b|%let\b)/i;

  /* `proc datasets ... kill` is excluded deliberately: clearing WORK is
     housekeeping these programs do around their startup block, not the start
     of the analysis. */
  var STOP_STATEMENT = /^\s*(?:%macro\b|data\b|proc\s+(?!datasets\b)\w+)/i;

  /**
   * For each line, the code it contributes — or null if it contributes none.
   *
   * Three cases, and telling them apart is the whole job:
   *   - a line with executable code returns that code
   *   - a line that is entirely one comment returns what is inside it, so a
   *     commented-out startup statement still marks the startup block
   *   - a line inside a multi-line comment returns null, so a program's header
   *     banner does not read as "the program has begun"
   *
   * The last case is why this cannot work on line shape alone: the middle
   * lines of a banner comment look like ordinary text.
   */
  function lineProbes(text) {
    var lines = String(text).split(/\r?\n/);
    var probes = [];
    var inBlock = false;

    lines.forEach(function (line) {
      var active = '';
      var i = 0;
      var opened = inBlock;

      while (i < line.length) {
        if (inBlock) {
          var close = line.indexOf('*/', i);
          if (close === -1) { i = line.length; break; }
          inBlock = false;
          i = close + 2;
          continue;
        }
        if (line.charAt(i) === '/' && line.charAt(i + 1) === '*') {
          inBlock = true;
          i += 2;
          continue;
        }
        active += line.charAt(i);
        i += 1;
      }

      active = active.trim();
      if (active) { probes.push(active); return; }

      var stripped = line.trim();
      if (!opened && /^\/\*[\s\S]*\*\/$/.test(stripped) && stripped.length > 3) {
        probes.push(stripped.slice(2, -2).trim());
      } else if (/^\*.*;$/.test(stripped)) {
        probes.push(stripped.slice(1).trim());
      } else {
        probes.push(null);
      }
    });

    return probes;
  }

  /* -- what is code and what is not ---------------------------------------
   * Every replacement needs the same guarantee: do not fire inside a comment.
   * Without it a rule that comments a statement out re-comments it on the next
   * run — `/*%init;*\/` becoming `/*\/*%init;*\/*\/` — and a rule that replaces
   * a legacy include also rewrites the commented-out copy the migration
   * deliberately left behind as a record.
   *
   * Two comment forms, both of which SAS actually uses, plus quoted strings so
   * that a Windows path containing a slash-star cannot open a comment that
   * swallows the rest of the file.
   *
   * This is a scanner, not a parser. It is short enough to read, and every
   * rule that depends on it works at statement level where the macro-quoting
   * corner cases it gets wrong do not arise. */

  function inactiveSpans(text) {
    var spans = [];
    var i = 0;
    var n = text.length;
    var atStatementStart = true;

    while (i < n) {
      var ch = text.charAt(i);

      if (ch === '/' && text.charAt(i + 1) === '*') {
        var close = text.indexOf('*/', i + 2);
        var end = close === -1 ? n : close + 2;
        spans.push([i, end]);
        i = end;
        atStatementStart = false;
        continue;
      }

      if (ch === '"' || ch === "'") {
        var j = i + 1;
        while (j < n) {
          if (text.charAt(j) === ch) {
            if (text.charAt(j + 1) === ch) { j += 2; continue; }
            j += 1;
            break;
          }
          j += 1;
        }
        spans.push([i, Math.min(j, n)]);
        i = Math.min(j, n);
        atStatementStart = false;
        continue;
      }

      /* A statement whose first token is `*` is a comment to the next `;`. */
      if (ch === '*' && atStatementStart) {
        var semi = text.indexOf(';', i);
        var stop = semi === -1 ? n : semi + 1;
        spans.push([i, stop]);
        i = stop;
        atStatementStart = true;
        continue;
      }

      if (ch === ';') atStatementStart = true;
      else if (!/\s/.test(ch)) atStatementStart = false;
      i += 1;
    }
    return spans;
  }

  function activeAt(spans, position) {
    for (var i = 0; i < spans.length; i++) {
      if (position >= spans[i][0] && position < spans[i][1]) return false;
      if (spans[i][0] > position) break;
    }
    return true;
  }

  /** The line index an inserted startup statement belongs at. */
  function insertAt(text) {
    var probes = lineProbes(text);
    var last = -1;
    var stop = probes.length;

    for (var i = 0; i < probes.length; i++) {
      var probe = probes[i];
      if (!probe) continue;
      if (STARTUP_STATEMENT.test(probe)) { last = i; continue; }
      if (STOP_STATEMENT.test(probe)) { stop = i; break; }
    }
    return last >= 0 ? last + 1 : stop;
  }

  /** Indentation of the statement an insertion follows. */
  function indentAt(lines, at) {
    for (var i = at - 1; i >= 0; i--) {
      if (lines[i].trim()) return /^\s*/.exec(lines[i])[0];
    }
    return '';
  }

  function isCommentedLine(line) {
    var stripped = String(line || '').trim();
    return (/^\/\*[\s\S]*\*\/$/.test(stripped) && stripped.length > 3) ||
      (/^\*[\s\S]*;$/.test(stripped));
  }

  function commentOut(line) {
    var indent = /^\s*/.exec(line)[0];
    return indent + '/*' + line.trim() + '*/';
  }

  function activeLine(line, offset, spans) {
    var first = /\S/.exec(line);
    return first ? activeAt(spans, offset + first.index) : false;
  }

  function findMacroCalls(text, macro) {
    var spans = inactiveSpans(text);
    var calls = [];
    var opener = new RegExp('%' + escapeRe(macro) + '\\s*\\(', 'gi');
    var match;

    while ((match = opener.exec(text))) {
      if (!activeAt(spans, match.index)) continue;
      var depth = 1;
      var i = opener.lastIndex;
      while (i < text.length && depth) {
        if (!activeAt(spans, i)) { i += 1; continue; }
        var ch = text.charAt(i);
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (!depth) break;
        }
        i += 1;
      }
      if (depth) continue;
      calls.push({
        start: match.index,
        end: i + 1,
        argsStart: opener.lastIndex,
        argsEnd: i
      });
    }
    return calls;
  }

  function splitArgs(text) {
    var args = [];
    var depth = 0;
    var current = '';
    var quote = '';

    String(text || '').split('').forEach(function (ch) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = '';
        return;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        args.push(current);
        current = '';
        return;
      }
      current += ch;
    });
    args.push(current);
    return args;
  }

  function adamMembers(argument) {
    var leading = /^\s*/.exec(argument)[0];
    var trailing = /\s*$/.exec(argument)[0];
    var body = String(argument || '').trim();
    var adam = [];
    var other = [];

    if (!body) return { adam: [], other: [] };
    body.split(/\s+/).forEach(function (member) {
      var name = member.split('.').pop().replace(/^&/, '').toLowerCase();
      if (name.indexOf('ad') === 0) adam.push(member);
      else other.push(member);
    });

    return {
      adam: adam.length ? [leading + adam.join(' ') + trailing] : [],
      other: other.length ? [leading + other.join(' ') + trailing] : []
    };
  }

  function replaceLibrefArgs(args, value) {
    return args.map(function (arg) {
      return String(arg).replace(/^(\s*libref\s*=\s*)data(\s*)$/i,
        function (_, head, tail) { return head + value + tail; });
    });
  }

  function hasDataLibref(args) {
    return args.some(function (arg) {
      return /^\s*libref\s*=\s*data\s*$/i.test(arg);
    });
  }

  function hasSyntheticSignal(text, fileName) {
    return /EXAMPLE002|20260228_SYNTH/i.test(String(fileName || '') + '\n' + text);
  }

  function has301Signal(text, fileName) {
    return /EXAMPLE002-PROT|[ult]900/i.test(String(fileName || '') + '\n' + text);
  }

  function specialHit(rule, count, find, replace, details) {
    return {
      key: rule.key || rule.id,
      id: rule.id,
      name: rule.name || rule.description || rule.id,
      description: rule.description || '',
      category: rule.category,
      severity: rule.severity,
      find: find || rule.find || '',
      replace: replace || rule.replace || '',
      count: count,
      details: details || [],
      error: ''
    };
  }

  /* Capture plain-text, line-level changes for the Summary Updates workbook.
     MigDiff is loaded by the page before any fix can be applied, so use its
     established line alignment when available. The fallback keeps mig-rules.js
     usable in isolated tests that do not load the UI diff module. */
  function buildChangeDetails(beforeText, afterText) {
    var before = String(beforeText == null ? '' : beforeText);
    var after = String(afterText == null ? '' : afterText);
    if (before === after) return [];

    var rows;
    if (global.MigDiff && typeof global.MigDiff.align === 'function') {
      rows = global.MigDiff.align(before, after);
    } else {
      var left = before.replace(/\r\n?/g, '\n').split('\n');
      var right = after.replace(/\r\n?/g, '\n').split('\n');
      if (before === '') left = [];
      if (after === '') right = [];

      var head = 0;
      while (head < left.length && head < right.length && left[head] === right[head]) {
        head++;
      }
      var tail = 0;
      while (tail < left.length - head && tail < right.length - head &&
             left[left.length - 1 - tail] === right[right.length - 1 - tail]) {
        tail++;
      }

      rows = [];
      var i;
      for (i = 0; i < head; i++) {
        rows.push({ kind: 'same', left: left[i], right: right[i],
                    leftNo: i + 1, rightNo: i + 1 });
      }
      var midLeft = left.slice(head, left.length - tail);
      var midRight = right.slice(head, right.length - tail);
      var paired = Math.min(midLeft.length, midRight.length);
      for (i = 0; i < paired; i++) {
        rows.push({ kind: midLeft[i] === midRight[i] ? 'same' : 'change',
                    left: midLeft[i], right: midRight[i],
                    leftNo: head + i + 1, rightNo: head + i + 1 });
      }
      for (i = paired; i < midLeft.length; i++) {
        rows.push({ kind: 'del', left: midLeft[i], right: null,
                    leftNo: head + i + 1, rightNo: null });
      }
      for (i = paired; i < midRight.length; i++) {
        rows.push({ kind: 'add', left: null, right: midRight[i],
                    leftNo: null, rightNo: head + i + 1 });
      }
      for (i = 0; i < tail; i++) {
        var li = left.length - tail + i;
        var ri = right.length - tail + i;
        rows.push({ kind: 'same', left: left[li], right: right[ri],
                    leftNo: li + 1, rightNo: ri + 1 });
      }
    }

    return rows.filter(function (row) { return row.kind !== 'same'; })
      .map(function (row) {
        return {
          originalLine: row.leftNo == null ? null : row.leftNo,
          fixedLine: row.rightNo == null ? null : row.rightNo,
          type: row.kind === 'del' ? 'delete' : row.kind,
          before: row.left == null ? '' : String(row.left),
          after: row.right == null ? '' : String(row.right)
        };
      });
  }

  function attachDetails(hit, beforeText, afterText) {
    if (!hit) return hit;
    hit.details = buildChangeDetails(beforeText, afterText);
    return hit;
  }

  var SPECIAL_ORDER = [
    'R-003',
    'R-029',
    'R-005',
    'R-030',
    'R-001',
    'R-002',
    'R-018',
    'R-004',
    'R-006',
    'R-007',
    'R-009',
    'R-011',
    'R-008',
    'R-012',
    'R-010',
    'R-013',
    'R-015',
    'R-014',
    'R-020',
    'R-016',
    'R-017',
    'R-019',
    'R-021',
    'R-022',
    'R-023',
    'R-024',
    'R-025',
    'R-026',
    'R-027',
    'R-028',
    'R-031',
    'R-032',
    'R-033',
    'R-036',
    'R-037'
  ];
  var BLANK_BEFORE_SPECIALS = { 'R-008': true, 'R-009': true, 'R-036': true };
  var EXCLUSIONS = {
    'R-003': { 'relrec.sas': true, 'l-death.sas': true },
    'R-005': { 'relrec.sas': true },
    'R-007': { 'adpr.sas': true, 'l-death.sas': true },
    'R-011': { 'l-death.sas': true }
  };
  var R006_DISABLED_DOMAINS = {
    ae: true, suppae: true,
    cm: true, suppcm: true,
    co: true,
    cv: true,
    dd: true, suppdd: true,
    ds: true, suppds: true,
    ee: true, suppee: true,
    eg: true,
    fa: true, suppfa: true,
    ie: true, suppie: true,
    is: true, suppis: true,
    lb: true, supplb: true,
    pc: true, supppc: true,
    pe: true, supppe: true,
    pr: true, supppr: true
  };
  var R009_MA_TESTING = {
    'l-death.sas': true,
    't-lb-lc-saf.sas': true
  };
  var R010_301_SDTM_PROGRAMS = {
    't900ae.sas': true,
    't900cm.sas': true,
    't900co.sas': true,
    't900cv.sas': true,
    't900dd.sas': true,
    't900dm.sas': true,
    't900ds.sas': true,
    't900dv.sas': true,
    't900ee.sas': true,
    't900eg.sas': true,
    't900fa.sas': true,
    't900ie.sas': true,
    't900is.sas': true,
    't900lb.sas': true
  };
  var R012_TLF_PROGRAMS = {
    'l-lb-liver.sas': true,
    't-ae-aesi-overall-saf.sas': true,
    't-ae-overall-saf.sas': true,
    't-ae-teae-soc-pt.sas': true,
    't-ae-teae-wrstgr-saf.sas': true,
    't-ae-teae-wrstgr-saf2.sas': true,
    't-aesi-teae-wrstgr-saf.sas': true,
    't-dm-fas.sas': true,
    't-ds-dispo-scrn.sas': true,
    't-ex-saf.sas': true,
    't-lb-lc-saf.sas': true,
    't-pac-fas.sas': true,
    't-pchad-nsclc-fas.sas': true,
    't-pchmrcls-fas.sas': true,
    't-pchsq-nsclc-fas.sas': true,
    't-pchss-fas.sas': true,
    't-pchuc-fas.sas': true
  };
  var R013_PROGRAMS = {
    'u900addv.sas': true,
    'u900adef.sas': true,
    'u900adis.sas': true,
    'u900admh.sas': true,
    'u900adpc.sas': true,
    'u900adrs.sas': true,
    'l900cv01.sas': true,
    'l900ds05.sas': true,
    'l900ex01.sas': true,
    'l900ex02.sas': true,
    'l900is01.sas': true
  };
  var R014_R015_ADAM_PROGRAMS = {
    'adae.sas': true,
    'adbase.sas': true,
    'adcm.sas': true,
    'adex.sas': true,
    'adexsum.sas': true,
    'adlb.sas': true,
    'adpr.sas': true,
    'adsl.sas': true
  };
  var R016_REBUILT_PROGRAMS = {
    'adae.sas': true,
    'adbase.sas': true,
    'adcm.sas': true,
    'adex.sas': true,
    'adexsum.sas': true,
    'adlb.sas': true,
    'adsl.sas': true
  };
  var R017_301_ADAM_PROGRAMS = {
    'u900adcm.sas': true,
    'u900adsl.sas': true
  };
  var R018_OUTPUTS = {
    't900dm.sas': { dm: true, suppdm: true },
    't900ds.sas': { ds: true, suppds: true },
    't900ie.sas': { ie: true, suppie: true },
    't900lb.sas': { lb: true, supplb: true }
  };
  var R019_PROGRAMS = {
    't900dm.sas': true,
    't900ds.sas': true,
    't900ie.sas': true,
    't900lb.sas': true,
    't900mb.sas': true,
    't900se.sas': true,
    't900sv.sas': true
  };
  var L032_RULE = {
    id: 'L-032',
    key: 'L-032',
    name: 'RESCREEN subject/site identifier type handling',
    category: 'Manual logic migration',
    severity: 'High',
    find: 'numeric RESCREEN subject/site identifier assumptions',
    replace: 'character-aware RESCREEN subject/site identifier handling',
    description: 'Adapts RESCREEN subject/site identifier handling from ' +
      'numeric PUT/INPUT assumptions to character-aware stripping, ' +
      'comparisons, or explicit conversion.'
  };
  var R020_PROGRAMS = {
    'adae.sas': true,
    'adbase.sas': true,
    'adcm.sas': true,
    'adlb.sas': true,
    'adpr.sas': true,
    'adsl.sas': true
  };
  var R021_CALLS = {
    't900dm.sas': { macro: 'util_fetchdata', member: 'sv' },
    't900ec.sas': { macro: 'util_fetchdata', member: 'dm' },
    't900ex.sas': { macro: 'util_getdata', member: 'ec' },
    't900pr.sas': { macro: 'util_getdata', member: 'dm', engine: true },
    't900qs.sas': { macro: 'util_fetchdata', member: 'dm' },
    't900se.sas': { macro: 'util_getdata', member: 'ta' }
  };

  var R022_PROGRAMS = {
    'u900addv.sas': true, 't900mb.sas': true, 't900mh.sas': true,
    't900pr.sas': true, 't900rs.sas': true
  };
  var R023_PROGRAMS = { 't900pc.sas': true, 't900is.sas': true, 't900sv.sas': true };
  var R024_QC_DOMAINS = { 't900ae.sas': 'ae', 't900ie.sas': 'ie', 't900lb.sas': 'lb' };
  var R025_PROGRAMS = { 't900dm.sas': true, 't900lb.sas': true, 't900sv.sas': true };
  var R026_DIRECT_MEMBERS = {
    'u900adae.sas': { adae: true },
    'l900ae03.sas': { adae: true, adsl: true }
  };
  var R027_PROGRAMS = { 't900dm.sas': true, 't900se.sas': true };
  var R028_PROGRAMS = { 't900oe.sas': 'oe', 't900sv.sas': 'sv' };
  var R031_IMAGING_DOMAINS = {
    't900co.sas': { co: true },
    't900sv.sas': { rs: true, tr: true, tu: true }
  };
  var R032_ILD_DATASETS = {
    't900ae.sas': 'Vendorimaginga_ild',
    't900dd.sas': 'Vendorimagingb_ild'
  };
  var R033_PROGRAMS = { 't900lb.sas': true, 't900sv.sas': true };
  var L034_RULE = {
    id: 'L-034', key: 'L-034',
    name: 'Disable study-specific Vendorlab load',
    category: 'Manual logic migration', severity: 'High',
    find: '%util_fetchdata(&vendor_lab_source, libref=rawdata, sort=subjid);',
    replace: '*%util_fetchdata(&vendor_lab_source, libref=rawdata, sort=subjid);',
    description: 'Disables the Vendorlab external-data load without an ' +
      'in-place replacement in the same source block.'
  };
  var L035_RULE = {
    id: 'L-035', key: 'L-035',
    name: 'Disable study-specific RS/adjustment external sources',
    category: 'Manual logic migration', severity: 'High',
    find: 't900rs.sas external RS/adjustment source calls',
    replace: 'comment out the two validated external source calls',
    description: 'Disables an external RS/adjustment source-loading macro call.'
  };

  /* Built-in manual-logic findings, by id. Used where the rule book's Rules
     sheet has no row for an L-### id (for example the Update Summary). */
  var LOGIC_RULES = {
    'L-032': L032_RULE,
    'L-034': L034_RULE,
    'L-035': L035_RULE
  };

  function fileKey(fileName) {
    return String(fileName || '').split(/[\\/]/).pop().toLowerCase();
  }

  function hasActiveLine(text, re) {
    var spans = inactiveSpans(text);
    var offset = 0;
    return text.split('\n').some(function (line) {
      var start = offset;
      offset += line.length + 1;
      return !isCommentedLine(line) && activeLine(line, start, spans) && re.test(line);
    });
  }

  function hasActiveExactLine(text, exact) {
    return hasActiveLine(text, new RegExp('^\\s*' + escapeRe(exact) + '\\s*$', 'i'));
  }

  function activeLineIndex(lines, spans, re) {
    var offset = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var start = offset;
      offset += line.length + 1;
      if (!isCommentedLine(line) && activeLine(line, start, spans) && re.test(line)) {
        return i;
      }
    }
    return -1;
  }

  function isTlfReportListing(text, fileName) {
    var name = fileKey(fileName);
    if (name === 'autoexec.sas' || name === 'chk_log.sas') return false;
    return /^(?:l-|t-)/i.test(name) ||
      /programs[/\\]tlf[/\\]/i.test(text) ||
      hasActiveLine(text, /%mheadfoot\b/i);
  }

  function selectedSpecialRules(rules, fileName) {
    var byId = {};
    (rules || []).forEach(function (rule) {
      if (SPECIAL_ORDER.indexOf(rule.id) === -1) return;
      if (!willRun(rule, fileName)) return;
      if (!byId[rule.id]) byId[rule.id] = rule;
    });
    return SPECIAL_ORDER.filter(function (id) { return byId[id]; })
      .map(function (id) { return byId[id]; });
  }

  function fixR003(text, rule, fileName) {
    if (EXCLUSIONS['R-003'][String(fileName || '').toLowerCase()]) {
      return { text: text, count: 0 };
    }
    if (!hasSyntheticSignal(text, fileName)) return { text: text, count: 0 };

    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      if (/^\s*%init\s*;\s*$/i.test(line)) {
        count += 1;
        return commentOut(line);
      }
      return line;
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, '%init;', '/*%init;*/') : null };
  }

  function fixR005(text, rule, fileName) {
    if (EXCLUSIONS['R-005'][String(fileName || '').toLowerCase()]) {
      return { text: text, count: 0 };
    }
    if (!hasSyntheticSignal(text, fileName)) return { text: text, count: 0 };
    if (isTlfReportListing(text, fileName)) return { text: text, count: 0 };
    if (fileKey(fileName) === 'autoexec.sas' &&
        /__SDTMLIB|libname\s+(?:source|raw)\s+["']&targetData\.?\\Clinical/i.test(text)) {
      return { text: text, count: 0 };
    }

    var include = '%include "&targetStudy.\\Dev\\Programs\\SDTM\\autoexec.sas";';
    if (text.indexOf(include) !== -1) return { text: text, count: 0 };

    var legacy = /^\s*%include\s+["'][^"']*programs[/\\]sdtm[/\\][^"']*autoexec\.sas["']\s*;/i;
    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var replaced = false;
    var out = [];

    text.split('\n').forEach(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (!isCommentedLine(line) && activeLine(line, start, spans) && legacy.test(line)) {
        var indent = /^\s*/.exec(line)[0];
        out.push(commentOut(line));
        out.push(indent + include);
        count += 1;
        replaced = true;
      } else {
        out.push(line);
      }
    });

    if (replaced) {
      return { text: out.join('\n'), count: count,
        hit: specialHit(rule, count, rule.find, include) };
    }

    var lines = text.split('\n');
    var at = insertAt(text);
    lines.splice(at, 0, indentAt(lines, at) + include);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(insertion)', include) };
  }

  function fixR006(text, rule, fileName) {
    if (!has301Signal(text, fileName)) return { text: text, count: 0 };

    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var re = /^(\s*)%util_resize_xpt\s*\(\s*([^,\)\s]+)([\s\S]*)$/i;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      var match = re.exec(line);
      if (!match) return line;
      var domain = match[2].toLowerCase();
      if (!R006_DISABLED_DOMAINS[domain]) return line;
      count += 1;
      return match[1] + '*' + line.slice(match[1].length);
    });

    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, '%util_resize_xpt(domain);',
        '*%util_resize_xpt(domain);') : null };
  }

  function fixR007(text, rule, fileName) {
    if (EXCLUSIONS['R-007'][fileKey(fileName)]) return { text: text, count: 0 };
    if (!hasSyntheticSignal(text, fileName)) return { text: text, count: 0 };

    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      if (/^\s*%setupanl\s*;\s*$/i.test(line)) {
        count += 1;
        return commentOut(line);
      }
      return line;
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, '%setupanl;', '/*%setupanl;*/') : null };
  }

  function tlfAutoexecInclude(fileName) {
    return R009_MA_TESTING[fileKey(fileName)]
      ? '%include "&targetStudy.\\Dev\\Programs\\TLF\\MA_Testing\\autoexec.sas";'
      : '%include "&targetStudy.\\Dev\\Programs\\TLF\\autoexec.sas";';
  }

  function anyTlfAutoexecPresent(text) {
    return hasActiveExactLine(text, '%include "&targetStudy.\\Dev\\Programs\\TLF\\autoexec.sas";') ||
      hasActiveExactLine(text, '%include "&targetStudy.\\Dev\\Programs\\TLF\\MA_Testing\\autoexec.sas";');
  }

  function fixR009(text, rule, fileName) {
    if (!hasSyntheticSignal(text, fileName) || !isTlfReportListing(text, fileName)) {
      return { text: text, count: 0 };
    }
    var include = tlfAutoexecInclude(fileName);
    if (anyTlfAutoexecPresent(text)) return { text: text, count: 0 };

    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var legacy = /%include\s+["'][^"']*programs[/\\]tlf[/\\][^"']*autoexec\.sas["']\s*;/i;
    var at = activeLineIndex(lines, spans, legacy);
    if (at < 0) at = insertAt(text) - 1;
    at = Math.max(0, at + 1);
    lines.splice(at, 0, indentAt(lines, at) + include);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(insertion)', include) };
  }

  function fixR008(text, rule, fileName) {
    if (!hasSyntheticSignal(text, fileName) || !isTlfReportListing(text, fileName)) {
      return { text: text, count: 0 };
    }
    if (!hasActiveLine(text, /%mheadfoot\b/i)) return { text: text, count: 0 };
    var include = '%include "&targetStudy.\\Dev\\Programs\\Macros\\mheadfoot.sas";';
    if (hasActiveExactLine(text, include)) return { text: text, count: 0 };

    var lines = text.split('\n');
    var tlfInclude = /%include\s+["']&targetStudy\.\\Dev\\Programs\\TLF\\(?:MA_Testing\\)?autoexec\.sas["']\s*;/i;
    var at = activeLineIndex(lines, inactiveSpans(text), tlfInclude);
    if (at < 0) at = insertAt(text) - 1;
    at = Math.max(0, at + 1);
    lines.splice(at, 0, indentAt(lines, at) + include);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(insertion)', include) };
  }

  function fixR011(text, rule, fileName) {
    if (EXCLUSIONS['R-011'][fileKey(fileName)] ||
        !hasSyntheticSignal(text, fileName) || !isTlfReportListing(text, fileName)) {
      return { text: text, count: 0 };
    }

    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var legacy = /^\s*%include\s+["']\.\.\/\.\.\/\.\.\/\.\.\/programs\/tlf\/20260228_SYNTH\/primary\/autoexec\.sas["']\s*;\s*$/i;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans) ||
          !legacy.test(line)) return line;
      count += 1;
      return commentOut(line);
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, rule.find, rule.replace) : null };
  }

  function fixR012(text, rule, fileName) {
    var name = fileKey(fileName);
    var include = '%include "&targetStudy.\\Dev\\Programs\\Macros\\setupanl.sas";';
    if (!hasSyntheticSignal(text, fileName) ||
        (name !== 'adpr.sas' && !R012_TLF_PROGRAMS[name])) {
      return { text: text, count: 0 };
    }
    if (hasActiveExactLine(text, include)) return { text: text, count: 0 };

    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var offset = 0;
    var replaced = 0;

    if (name === 'adpr.sas') {
      lines = lines.map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (!replaced && !isCommentedLine(line) && activeLine(line, start, spans) &&
            /^\s*%setupanl\s*;\s*$/i.test(line)) {
          replaced = 1;
          return /^\s*/.exec(line)[0] + include;
        }
        return line;
      });
      if (replaced) {
        return { text: lines.join('\n'), count: 1,
          hit: specialHit(rule, 1, '%setupanl;', include) };
      }
    }

    var at = -1;
    if (name === 't-lb-lc-saf.sas') {
      at = activeLineIndex(lines, spans,
        /%include\s+["']&targetStudy\.\\Dev\\Programs\\Macros\\mheadfoot\.sas["']\s*;/i);
      if (at >= 0) at += 1;
    }
    if (at < 0) {
      at = activeLineIndex(lines, spans,
        /%include\s+["']&targetStudy\.\\Dev\\Programs\\TLF\\(?:MA_Testing\\)?autoexec\.sas["']\s*;/i);
    }
    if (at < 0) {
      var legacy = /%include\s+["'][^"']*programs[/\\]tlf[/\\][^"']*autoexec\.sas["']\s*;/i;
      at = lines.findIndex(function (line) { return legacy.test(line); });
      if (at >= 0) at += 1;
    }
    if (at < 0) at = insertAt(text);
    lines.splice(at, 0, indentAt(lines, at) + include);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(contextual insertion)', include) };
  }

  function fixR010SdtmAutoexec(text, rule) {
    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var count = 0;
    var offset = 0;

    lines = lines.map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      var indent = /^\s*/.exec(line)[0];
      if (/^\s*libname\s+source\s+["']\/placeholder\/cdrdata\/EXAMPLE002\/prod\/data\/edc\/20260228_SYNTH["']\s*;/i.test(line)) {
        count += 1;
        return indent + 'libname source "&targetData\\Clinical";';
      }
      if (/^\s*libname\s+raw\s+["']\/placeholder\/cdrdata\/EXAMPLE002\/prod\/data\/edc\/20260228_SYNTH["']\s*;/i.test(line)) {
        count += 1;
        return indent + 'libname raw    "&targetData\\Clinical";';
      }
      if (/^\s*libname\s+SDTM\s+["']\.\.\/\.\.\/\.\.\/\.\.\/data\/sdtm\/20260228_SYNTH\/primary["']\s*;/i.test(line)) {
        count += 1;
        return indent + 'libname SDTM   "&targetData\\SDTM";';
      }
      if (/^\s*libname\s+prod\s+["']\.\.\/\.\.\/\.\.\/\.\.\/data\/sdtm\/20260228_SYNTH\/primary["']\s*;/i.test(line)) {
        count += 1;
        return indent + 'libname prod "&targetData\\SDTM";';
      }
      if (/^\s*%let\s+__SDTMLIB\s*=\s*%STR\(\.\.\/\.\.\/\.\.\/\.\.\/data\/sdtm\/20260228_SYNTH\/primary\)\s*;/i.test(line)) {
        count += 1;
        return indent + '%let __SDTMLIB = %STR(&targetData\\SDTM);';
      }
      return line;
    });

    var nextText = lines.join('\n');
    var hasExt = hasActiveLine(nextText, /^\s*libname\s+ext\s+["']&targetData\\External Data["']\s*;/i);
    var hasDExt = hasActiveLine(nextText, /^\s*libname\s+dEXT\s+["']&targetData\\External Data["']\s*;/i);
    if (!hasExt || !hasDExt) {
      lines = nextText.split('\n');
      var at = activeLineIndex(lines, inactiveSpans(nextText),
        /^\s*libname\s+SDTM\s+["']&targetData\\SDTM["']\s*;/i);
      if (at >= 0) {
        var indent = indentAt(lines, at + 1);
        var insert = [];
        if (!hasExt) insert.push(indent + 'libname ext    "&targetData\\External Data";');
        if (!hasDExt) insert.push(indent + 'libname dEXT   "&targetData\\External Data";');
        lines.splice.apply(lines, [at + 1, 0].concat(insert));
        count += insert.length;
      }
    }

    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, 'synthetic SDTM autoexec bootstrap',
        'SCE Clinical/SDTM/External Data bootstrap') : null };
  }

  function fixR010TlfAutoexec(text, rule) {
    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var count = 0;
    var rawAt = -1;
    var padamAt = -1;
    var offset = 0;

    lines = lines.map(function (line, index) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      var indent = /^\s*/.exec(line)[0];
      if (/^\s*libname\s+padam\s+["']\.\.\/\.\.\/\.\.\/\.\.\/data\/adam\/20260228_SYNTH\/primary["']\s+inencoding\s*=\s*any\s*;/i.test(line)) {
        padamAt = index;
        count += 1;
        return indent + 'libname padam "&targetData.\\ADaM" inencoding=any;';
      }
      if (/^\s*libname\s+raw\s+["']\/placeholder\/cdrdata\/EXAMPLE002\/prod\/data\/edc\/20260228_SYNTH["']\s+inencoding\s*=\s*any\s*;/i.test(line)) {
        rawAt = index;
        count += 1;
        return indent + 'libname raw   "&targetData.\\Clinical" inencoding=any;';
      }
      return line;
    });

    var nextText = lines.join('\n');
    if (!hasActiveLine(nextText, /^\s*libname\s+sdtm\s+["']&targetData\.\\SDTM["']\s+inencoding\s*=\s*any\s*;/i)) {
      var at = rawAt >= 0 ? rawAt + 1 : (padamAt >= 0 ? padamAt + 1 : -1);
      if (at >= 0) {
        lines.splice(at, 0, indentAt(lines, at) +
          'libname sdtm  "&targetData.\\SDTM" inencoding=any;');
        count += 1;
      }
    }
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, 'synthetic TLF autoexec bootstrap',
        'SCE ADaM/Clinical/SDTM bootstrap') : null };
  }

  var TLF_AUTOEXEC_BLOCK = [
    '/*----------------------------------------------------------------------------*/',
    '/* TLF AUTOEXEC - target SCE Migration                                     */',
    '/*----------------------------------------------------------------------------*/',
    '',
    '/* Study setup */',
    '%include "&targetStudy.\\Dev\\Programs\\SDTM\\autoexec.sas";',
    '',
    '/* Macro path */',
    '%let macro=%str(&targetStudy.\\Dev\\Programs\\TLF\\primary\\macros);',
    '',
    'options sasautos=(sasautos "&macro")',
    "        FORMCHAR='|_---|+|---+=|-/\\<>*'",
    '        ls=132',
    '        ps=52',
    '        nodate',
    '        nonumber',
    '        nocenter',
    '        mprint',
    '        mlogic',
    '        symbolgen',
    '        orientation=landscape;'
  ].join('\n');

  var TLF_AUTOEXEC_MARKER = '/* TLF AUTOEXEC - target SCE Migration';

  function fixR036(text, rule, fileName) {
    if (fileKey(fileName) !== 'autoexec.sas' ||
        !/tlf/i.test(String(fileName || ''))) {
      return { text: text, count: 0 };
    }
    if (text.indexOf(TLF_AUTOEXEC_MARKER) !== -1) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var at = insertAt(text);
    var indent = indentAt(lines, at);
    var block = TLF_AUTOEXEC_BLOCK.split('\n').map(function (line) {
      return line ? indent + line : line;
    });
    lines.splice.apply(lines, [at, 0].concat(block));

    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(insertion)', TLF_AUTOEXEC_BLOCK) };
  }

  /* -- R-037: straighten curly double quotes inside comments -----------------
   * Comments only, never strings. A curly quote inside a quoted string may be
   * deliberate -- a label, a title, or a footnote meant to print that glyph.
   * This also cannot be a workbook pattern rule, because the generic engine
   * intentionally skips matches that start inside comments.
   */
  var SMART_DQUOTE = /[\u201C\u201D]/g;

  function commentSpans(text) {
    return inactiveSpans(text).filter(function (span) {
      var ch = text.charAt(span[0]);
      return ch === '/' || ch === '*';
    });
  }

  function fixR037(text, rule) {
    var spans = commentSpans(text);
    if (!spans.length) return { text: text, count: 0 };

    var out = '';
    var at = 0;
    var count = 0;

    spans.forEach(function (span) {
      var body = text.slice(span[0], span[1]);
      var found = body.match(SMART_DQUOTE);
      if (!found) return;
      out += text.slice(at, span[0]) + body.replace(SMART_DQUOTE, '"');
      at = span[1];
      count += found.length;
    });

    if (!count) return { text: text, count: 0 };
    out += text.slice(at);

    return {
      text: out,
      count: count,
      hit: specialHit(rule, count, '\u201C or \u201D inside a comment', '"')
    };
  }

  function fixR010Sdtm301(text, rule, fileName) {
    if (!has301Signal(text, fileName) || !R010_301_SDTM_PROGRAMS[fileKey(fileName)]) {
      return { text: text, count: 0 };
    }
    if (text.indexOf('libname rawdata "&targetData\\Clinical";') !== -1 &&
        text.indexOf('libname prod "&targetData\\SDTM";') !== -1) {
      return { text: text, count: 0 };
    }
    var block = [
      'libname source "&targetData\\Clinical";',
      'libname rawdata "&targetData\\Clinical";',
      'libname SDTM "&targetData\\SDTM";',
      'libname data "&targetData\\SDTM";',
      '',
      'libname ext "&targetData\\External Data";',
      'libname dEXT "&targetData\\External Data";',
      '',
      'libname pg "&targetStudy.\\Dev\\Programs\\SDTM\\validation";',
      'libname val "&targetStudy.\\Dev\\Data\\SDTM\\validation";',
      'libname prod "&targetData\\SDTM";'
    ];
    var lines = text.split('\n');
    var include = '%include "&targetStudy.\\Programs\\Macros\\autoexec.sas";';
    var at = lines.findIndex(function (line) { return line.trim() === include; });
    if (at < 0) at = insertAt(text) - 1;
    at = Math.max(0, at + 1);
    lines.splice.apply(lines, [at, 0].concat(block));
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(EXAMPLE003 SDTM bootstrap insertion)', block.join('\n')) };
  }

  function fixR010(text, rule, fileName) {
    var name = fileKey(fileName);
    if (name === 'autoexec.sas' && hasSyntheticSignal(text, fileName)) {
      if (/libname\s+padam\s+["']\.\.\/\.\.\/\.\.\/\.\.\/data\/adam\/20260228_SYNTH\/primary/i.test(text)) {
        return fixR010TlfAutoexec(text, rule);
      }
      if (/__SDTMLIB|libname\s+SDTM\s+["']\.\.\/\.\.\/\.\.\/\.\.\/data\/sdtm\/20260228_SYNTH\/primary/i.test(text)) {
        return fixR010SdtmAutoexec(text, rule);
      }
    }
    return fixR010Sdtm301(text, rule, fileName);
  }

  function fixR013(text, rule, fileName) {
    var target = DEFAULT_PARAMS.ADAM_LIBREF;
    var edits = [];
    if (!has301Signal(text, fileName) || !R013_PROGRAMS[fileKey(fileName)]) {
      return { text: text, count: 0 };
    }

    findMacroCalls(text, 'util_getdata').forEach(function (call) {
      var args = splitArgs(text.slice(call.argsStart, call.argsEnd));
      if (!args.length || args.some(function (arg) {
        return /^\s*libref\s*=/i.test(arg);
      })) return;

      var members = adamMembers(args[0]);
      if (!members.adam.length || members.other.length) return;
      var spacing = /^l900/i.test(fileKey(fileName)) || args.length === 1
        ? ' ' : /^\s*/.exec(args[1])[0];
      args.splice(1, 0, spacing + 'libref=' + target);
      edits.push([call.argsStart, call.argsEnd, args.join(',')]);
    });

    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length,
      hit: edits.length ? specialHit(rule, edits.length, rule.find, rule.replace) : null };
  }

  function fixR015(text, rule, fileName) {
    var name = fileKey(fileName);
    var include = '%include "&targetStudy.\\Dev\\Programs\\Macros\\mtrim.sas";';
    if (!hasSyntheticSignal(text, fileName) || !R014_R015_ADAM_PROGRAMS[name] ||
        hasActiveExactLine(text, include)) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var at = activeLineIndex(lines, spans,
      /%include\s+["']&targetStudy\.\\Dev\\Programs\\Macros\\setupanl\.sas["']\s*;/i);
    if (at < 0) {
      at = activeLineIndex(lines, spans,
        /%include\s+["']&targetStudy\.\\Dev\\Programs\\SDTM\\autoexec\.sas["']\s*;/i);
    }
    at = at >= 0 ? at + 1 : insertAt(text);
    lines.splice(at, 0, indentAt(lines, at) + include);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(contextual insertion)', include) };
  }

  function fixR014(text, rule, fileName) {
    var name = fileKey(fileName);
    var statement = 'libname padam "&targetData.\\ADaM";';
    if (!hasSyntheticSignal(text, fileName) || !R014_R015_ADAM_PROGRAMS[name] ||
        hasActiveExactLine(text, statement)) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var at = activeLineIndex(lines, spans,
      /%include\s+["']&targetStudy\.\\Dev\\Programs\\Macros\\mtrim\.sas["']\s*;/i);
    if (at < 0) {
      at = activeLineIndex(lines, spans,
        /%include\s+["']&targetStudy\.\\Dev\\Programs\\SDTM\\autoexec\.sas["']\s*;/i);
    }
    at = at >= 0 ? at + 1 : insertAt(text);
    lines.splice(at, 0, indentAt(lines, at) + statement);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(contextual insertion)', statement) };
  }

  function fixR016(text, rule, fileName) {
    var name = fileKey(fileName);
    var rebuilt = R016_REBUILT_PROGRAMS[name];
    if (!hasSyntheticSignal(text, fileName) && !rebuilt && name !== 'adpr.sas') {
      return { text: text, count: 0 };
    }
    if (!hasSyntheticSignal(text, fileName) || (!rebuilt && name !== 'adpr.sas')) {
      return { text: text, count: 0 };
    }

    var legacy = /^\s*libname\s+trans\s+xport\s+["']\.\.\/\.\.\/\.\.\/\.\.\/data\/adam\/20260228_SYNTH\/primary\/[^"']*\.xpt["']\s*;\s*$/i;
    var lines = text.split('\n');
    var spans = inactiveSpans(text);

    if (name === 'adpr.sas') {
      var directCount = 0;
      var offset = 0;
      lines = lines.map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (directCount || isCommentedLine(line) ||
            !activeLine(line, start, spans) || !legacy.test(line)) return line;
        directCount = 1;
        return /^\s*/.exec(line)[0] +
          'libname trans xport "&targetStudy.\\Dev\\Data\\ADaM\\&tlfkey..xpt";';
      });
      return { text: lines.join('\n'), count: directCount,
        hit: directCount ? specialHit(rule, 1, rule.find,
          'libname trans xport "&targetStudy.\\Dev\\Data\\ADaM\\&tlfkey..xpt";') : null };
    }

    if (hasActiveLine(text,
        /^\s*libname\s+trans\s+xport\s+["']&targetStudy\.\\Dev\\Data\\ADAM\\&tlfkey\.\.xpt["']\s*;/i)) {
      return { text: text, count: 0 };
    }

    var legacyAt = activeLineIndex(lines, spans, legacy);
    if (legacyAt < 0) return { text: text, count: 0 };
    var procAt = -1;
    var runAt = -1;
    for (var i = legacyAt + 1; i < Math.min(lines.length, legacyAt + 10); i++) {
      if (procAt < 0 && /^\s*proc\s+copy\s+in\s*=\s*PADAM\s+out\s*=\s*trans\s*;/i.test(lines[i])) {
        procAt = i;
      } else if (procAt >= 0 && /^\s*run\s*;\s*$/i.test(lines[i])) {
        runAt = i;
        break;
      }
    }
    if (procAt < 0 || runAt < 0) return { text: text, count: 0 };

    var dataset = name.replace(/\.sas$/i, '');
    for (var before = legacyAt - 1; before >= 0; before--) {
      var letMatch = /^\s*%let\s+tlfkey\s*=\s*([^;]+)\s*;\s*$/i.exec(lines[before]);
      if (!letMatch) continue;
      if (letMatch[1].trim().toLowerCase() === dataset) {
        lines[before] = commentOut(lines[before]);
      }
      break;
    }
    for (var old = legacyAt; old <= runAt; old++) {
      if (lines[old].trim() && !isCommentedLine(lines[old])) {
        lines[old] = commentOut(lines[old]);
      }
    }

    var block = [
      '',
      '%let tlfkey=' + dataset + ';',
      '',
      'libname trans xport "&targetStudy.\\Dev\\Data\\ADAM\\&tlfkey..xpt";',
      '',
      'proc copy in=padam out=trans;',
      '   select ' + dataset + ';',
      'run;',
      '',
      'libname trans clear;'
    ];
    lines.splice.apply(lines, [runAt + 1, 0].concat(block));
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, rule.find, block.slice(1).join('\n')) };
  }

  function fixR017(text, rule, fileName) {
    var name = fileKey(fileName);
    var count = 0;
    var spans = inactiveSpans(text);
    var offset = 0;
    var lines = text.split('\n');

    if (name === 'autoexec.sas' && hasSyntheticSignal(text, fileName)) {
      lines = lines.map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
        var indent = /^\s*/.exec(line)[0];
        if (/^\s*%let\s+tdpath\s*=\s*%str\(["']\.\.\/\.\.\/\.\.\/\.\.\/programs\/sdtm\/20260228_SYNTH\/documents\/EXAMPLE002 SDTM Specs_v1\.0\.xlsx["']\)\s*;\s*$/i.test(line)) {
          count += 1;
          return indent + '%let tdpath=%str("&targetStudy.\\Documents\\EXAMPLE002 SDTM Specs_v1.0.xlsx");';
        }
        if (/^\s*proc\s+import\s+out\s*=\s*spec\s+datafile\s*=\s*["']\.\.\/\.\.\/\.\.\/\.\.\/programs\/sdtm\/documents\/EXAMPLE002 SDTM Specs_v1\.0\.xlsx["']\s+dbms\s*=\s*xlsx\s+replace\s*;\s*$/i.test(line)) {
          count += 1;
          return indent + 'proc import out=spec datafile="&targetStudy.\\Documents\\EXAMPLE002 SDTM Specs_v1.0.xlsx" dbms=xlsx replace;';
        }
        return line;
      });
    } else if (has301Signal(text, fileName) && R017_301_ADAM_PROGRAMS[name]) {
      var rawWorkbook = /["']\/\/placeholder\/clinicalstudies\/projects\/{1}&client\/{1}&project\/{1}&study\/final\/rawdata\/&(prior_therapy|post_therapy)\.\.xlsx["']/i;
      lines = lines.map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (isCommentedLine(line) || !activeLine(line, start, spans) ||
            !rawWorkbook.test(line)) return line;
        return line.replace(rawWorkbook, function (_, macroName) {
          count += 1;
          return '"&targetStudy.\\Docs\\&' + macroName + '..xlsx"';
        });
      });
    } else if (has301Signal(text, fileName) && name === 't900dv.sas') {
      lines = lines.map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (isCommentedLine(line) || !activeLine(line, start, spans) ||
            !/^\s*proc\s+import\s+datafile\s*=\s*["']\/\/placeholder\/clinicalstudies\/projects\/&client\/&project\/&study\/final\/rawdata\/&dev_ext_dataset\.["']/i.test(line)) return line;
        count += 1;
        return /^\s*/.exec(line)[0] +
          'proc import datafile= "&targetStudy.\\Docs\\EXAMPLE002_VendorTransfer_v1.0_Protocol_Deviations.xlsx"';
      });
    } else if (has301Signal(text, fileName) && name === 't900lb.sas') {
      var converted = false;
      lines = lines.map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
        if (/^\s*proc\s+import\s+datafile\s*=\s*["']&lbtestfile\.["']/i.test(line)) {
          converted = true;
          count += 1;
          return /^\s*/.exec(line)[0] +
            'proc import datafile="&targetStudy.\\Docs\\lbtest.xls"';
        }
        if (converted && /^\s*out\s*=\s*check_lb\b/i.test(line)) {
          converted = false;
          return line.replace(/dbms\s*=\s*XLSX/i, 'dbms=XLS');
        }
        return line;
      });
    }

    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, rule.find, rule.replace) : null };
  }

  function fixR018(text, rule, fileName) {
    var allowed = R018_OUTPUTS[fileKey(fileName)];
    if (!has301Signal(text, fileName) || !allowed) return { text: text, count: 0 };
    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var re = /^(\s*)%util_cvtds\s*\(\s*([a-z0-9_]+)\s*\)\s*;(.*)$/i;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      var match = re.exec(line);
      if (!match || !allowed[match[2].toLowerCase()]) return line;
      count += 1;
      return match[1] + '*' + line.slice(match[1].length);
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, '%util_cvtds(domain);',
        '*%util_cvtds(domain);') : null };
  }

  function fixR019(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R019_PROGRAMS[name]) {
      return { text: text, count: 0 };
    }
    var spans = inactiveSpans(text);
    var count = 0;
    var importBlock = /^([ \t]*)proc\s+import\s+datafile\s*=\s*["']&rescreen\.["']\s*\r?\n[ \t]*out\s*=\s*rescr\b[^\r\n]*\r?\n[ \t]*sheet\s*=\s*["']rescreen["']\s*;\s*\r?\n[ \t]*getnames\s*=\s*yes\s*;\s*\r?\n[ \t]*run\s*;[^\r\n]*$/gim;
    text = text.replace(importBlock, function (block, indent, position) {
      if (!activeLine(block, position, spans)) return block;
      var newline = block.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
      var commented = block.split(/\r?\n/).map(commentOut).join(newline);
      var setLine = name === 't900sv.sas'
        ? '    set Ext.rescreen(rename=(old_subject_id=old_subject_id1));'
        : '    set Ext.rescreen;';
      count += 1;
      return commented + newline + newline + indent + 'data rescr;' + newline +
        indent + setLine + newline + indent + 'run;';
    });
    return { text: text, count: count,
      hit: count ? specialHit(rule, count, rule.find, rule.replace) : null };
  }

  function fixL032(text, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R019_PROGRAMS[name]) {
      return { text: text, count: 0, hit: null };
    }

    var editCount = 0;

    function replaceActiveLines(source, re, replacer) {
      var spans = inactiveSpans(source);
      var offset = 0;
      var changed = 0;
      var lines = source.split('\n').map(function (line) {
        var start = offset;
        offset += line.length + 1;
        if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
        var hadCr = /\r$/.test(line);
        var probe = hadCr ? line.slice(0, -1) : line;
        var match = re.exec(probe);
        re.lastIndex = 0;
        if (!match) return line;
        changed += 1;
        var replacement = typeof replacer === 'function' ? replacer(match) : replacer;
        if (hadCr) replacement = String(replacement).replace(/\n/g, '\r\n') + '\r';
        return replacement;
      });
      return { text: lines.join('\n'), count: changed };
    }

    function insertRescreenLine(source, statement) {
      if (new RegExp('^\\s*' + escapeRe(statement) + '\\s*$', 'im').test(source)) {
        return { text: source, count: 0 };
      }
      var spans = inactiveSpans(source);
      var re = /(^([ \t]*)data\s+rescr\s*;\s*\r?\n[ \t]*set\s+Ext\.rescreen(?:\s*\([^\r\n]*\))?\s*;\s*\r?\n)/im;
      var match = re.exec(source);
      if (!match || !activeLine(match[0], match.index, spans)) {
        return { text: source, count: 0 };
      }
      var newline = match[1].indexOf('\r\n') >= 0 ? '\r\n' : '\n';
      var indent = match[2] + '    ';
      var replacement = match[1] + indent + statement + newline;
      return {
        text: source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length),
        count: 1
      };
    }

    function run(re, replacer) {
      var result = replaceActiveLines(text, re, replacer);
      text = result.text;
      editCount += result.count;
    }

    if (name === 't900dm.sas') {
      run(/^(\s*)new_subject_id\s*=\s*input\s*\(\s*subjid\s*,\s*best\.?\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'new_subject_id=kstrip(subjid);/*input(subjid,best.);*/'; });
      run(/^(\s*)where\s+input\s*\(\s*a\.subjid\s*,\s*best\.?\s*\)\s*=\s*b\.old_subject_id\s*;\s*$/i,
        function (m) {
          return m[1] + '/*where input(a.subjid,best.)=b.old_subject_id;*/\n' +
            m[1] + 'where a.subjid = kstrip(b.old_subject_id);';
        });
      run(/^(\s*select\s+a\.\*\s*,\s*)kstrip\s*\(\s*put\s*\(\s*b\.old_site_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsite\s*,\s*kstrip\s*\(\s*put\s*\(\s*b\.old_subject_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsubj\s*,\s*$/i,
        function (m) {
          var indent = /^\s*/.exec(m[0])[0];
          return m[1] + 'kstrip(b.old_site_id) as oldsite,\n' +
            indent + '       kstrip(b.old_subject_id) as oldsubj,';
        });
      run(/^(\s*where\s+subjid\s*\^in\s*\(\s*select\s+)kstrip\s*\(\s*put\s*\(\s*old_subject_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+subjid(.*)$/i,
        function (m) { return m[1] + 'kstrip(old_subject_id) as subjid' + m[2]; });
      run(/^(\s*if\s+oldsubj\s+ne\s+["']{2}\s+then\s+siteid\s*=\s*)kstrip\s*\(\s*put\s*\(\s*new_site_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'kstrip(new_site_id);'; });

    } else if (name === 't900ds.sas' || name === 't900ie.sas') {
      var inserted = insertRescreenLine(text, 'old_subject_idn = input(old_subject_id, best.);');
      text = inserted.text; editCount += inserted.count;
      run(/^(\s*select\s+a\.\*\s*,\s*)kstrip\s*\(\s*put\s*\(\s*b\.old_site_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsite(.*)$/i,
        function (m) { return m[1] + 'kstrip(b.old_site_id) as oldsite' + m[2]; });
      run(/^(\s*on\s+a\.old_subject_id\s*=\s*)b\.old_subject_id\s*;\s*$/i,
        function (m) { return m[1] + 'b.old_subject_idn;'; });

    } else if (name === 't900lb.sas') {
      var insertedLb = insertRescreenLine(text, 'old_subject_idn = input(old_subject_id, best.);');
      text = insertedLb.text; editCount += insertedLb.count;
      run(/^(\s*select\s+a\.\*\s*,\s*)kstrip\s*\(\s*put\s*\(\s*b\.old_site_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsite(.*)$/i,
        function (m) { return m[1] + 'kstrip(b.old_site_id) as oldsite' + m[2]; });
      run(/^(\s*on\s+a\.old_subject_id\s*=\s*)b\.old_subject_id\s*;\s*$/i,
        function (m) { return m[1] + 'b.old_subject_idn;'; });
      run(/^(\s*)if\s+new_subject_id\s+ne\s+\.\s+and\s+new_subject_id\s+ne\s+old_subject_id\s+then\s+do\s*;\s*$/i,
        function (m) { return m[1] + "if new_subject_id ne '' and input(new_subject_id,best.) ne old_subject_id then do;"; });
      run(/^(\s*)subject\s*=\s*kstrip\s*\(\s*put\s*\(\s*new_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'subject=kstrip(new_subject_id);'; });

    } else if (name === 't900mb.sas') {
      run(/^(\s*)old_subject_id\s*=\s*input\s*\(\s*subjid\s*,\s*best\.?\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'old_subject_id=kstrip(subjid)/*input(subjid,best.)*/;'; });
      run(/^(\s*)if\s+new_subject_id\s+ne\s+\.\s+and\s+new_subject_id\s+ne\s+old_subject_id\s+then\s+do\s*;\s*$/i,
        function (m) { return m[1] + 'if not missing(new_subject_id) /*new_subject_id ne .*/ and new_subject_id ne old_subject_id then do;'; });
      run(/^(\s*)subject\s*=\s*kstrip\s*\(\s*put\s*\(\s*new_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'subject=kstrip(new_subject_id); /*kstrip(put(new_subject_id,best.));*/'; });
      run(/^(\s*)oldsubj\s*=\s*kstrip\s*\(\s*put\s*\(\s*old_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'oldsubj=kstrip(old_subject_id); /*kstrip(put(old_subject_id,best.));*/'; });

    } else if (name === 't900se.sas') {
      run(/^(\s*)new_subject_id\s*=\s*input\s*\(\s*subject\s*,\s*best\.?\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'new_subject_id=strip(subject);/*input(subject,best.); as new_subject_id is string in the source*/'; });

    } else if (name === 't900sv.sas') {
      var insertedSv = insertRescreenLine(text, 'old_subject_id = input(old_subject_id1, best.);');
      text = insertedSv.text; editCount += insertedSv.count;
      run(/^(\s*)if\s+new_subject_id\s+ne\s+\.\s+and\s+old_subject_id\s+ne\s+new_subject_id\s+then\s+do\s*;\s*$/i,
        function (m) { return m[1] + "if new_subject_id ne '' and strip(put(old_subject_id, best.)) ne new_subject_id then do;"; });
      run(/^(\s*)subject\s*=\s*kstrip\s*\(\s*put\s*\(\s*new_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$/i,
        function (m) { return m[1] + 'subject=strip(new_subject_id);'; });
    }

    var count = editCount ? 1 : 0;
    return { text: text, count: count,
      hit: count ? specialHit(L032_RULE, 1) : null,
      editCount: editCount };
  }

  function fixR020(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!hasSyntheticSignal(text, fileName) || !R020_PROGRAMS[name]) {
      return { text: text, count: 0 };
    }
    var spans = inactiveSpans(text);
    var offset = 0;
    var inBlock = false;
    var count = 0;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (!isCommentedLine(line) && activeLine(line, start, spans) &&
          /^\s*%adam_spec\s*\(\s*sheet\s*=\s*&tlfkey\s*\)\s*;\s*$/i.test(line)) {
        inBlock = true;
        count += 1;
        return commentOut(line);
      }
      if (!inBlock) return line;
      if (/^\s*%put\b[^;]*;\s*$/i.test(line)) return commentOut(line);
      if (/^\s*%\*put\b[^;]*;\s*$/i.test(line)) {
        return name === 'adpr.sas' ? line : commentOut(line);
      }
      inBlock = false;
      return line;
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, '%adam_spec metadata block',
        'commented ADAM_SPEC metadata block') : null };
  }

  function fixR021(text, rule, fileName) {
    var spec = R021_CALLS[fileKey(fileName)];
    if (!has301Signal(text, fileName) || !spec) return { text: text, count: 0 };
    var edits = [];
    findMacroCalls(text, spec.macro).forEach(function (call) {
      var args = splitArgs(text.slice(call.argsStart, call.argsEnd));
      if (!args.length || args[0].trim().toLowerCase() !== spec.member) return;
      if (spec.engine && !args.some(function (arg) {
        return /^\s*engine\s*=\s*V9\s*$/i.test(arg);
      })) return;
      if (!args.some(function (arg) {
        return /^\s*libref\s*=\s*data\s*$/.test(arg);
      })) return;
      edits.push([call.argsStart, call.argsEnd,
        [args[0]].concat(replaceLibrefArgs(args.slice(1), 'Data')).join(',')]);
    });
    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length,
      hit: edits.length ? specialHit(rule, edits.length, 'libref=data',
        'libref=Data') : null };
  }

  function findLineIndex(lines, re, start) {
    start = start || 0;
    for (var i = start; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) return i;
    }
    return -1;
  }

  function commentLineRange(lines, start, end) {
    var out = [];
    for (var i = start; i <= end; i++) {
      var line = lines[i];
      var hadCr = /\r$/.test(line);
      var probe = hadCr ? line.slice(0, -1) : line;
      var commented = commentOut(probe);
      out.push(hadCr ? commented + '\r' : commented);
    }
    return out;
  }

  function fixR022(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R022_PROGRAMS[name]) {
      return { text: text, count: 0 };
    }

    var edits = [];
    findMacroCalls(text, 'util_getdata').forEach(function (call) {
      var args = splitArgs(text.slice(call.argsStart, call.argsEnd));
      if (!args.length) return;
      var member = args[0].trim().toLowerCase();
      var replacement = null;

      if (name === 'u900addv.sas' && (member === 'dv' || member === 'suppdv')) {
        var hasSort = args.slice(1).some(function (a) { return /^\s*sort\s*=\s*usubjid\s*$/i.test(a); });
        var hasEngine = args.slice(1).some(function (a) { return /^\s*engine\s*=\s*V9\s*$/i.test(a); });
        var hasLibref = args.slice(1).some(function (a) { return /^\s*libref\s*=/i.test(a); });
        if (hasSort && hasEngine && !hasLibref) {
          replacement = [args[0], 'libref=DATA'].concat(args.slice(1)).join(',');
        }
      } else if (name === 't900mb.sas' && member === 'dm' && args.length === 1) {
        replacement = 'dm, libref=Data, sort=usubjid, engine=V9';
      } else if (name === 't900mh.sas' && member === 'dm') {
        var mhSort = args.slice(1).some(function (a) { return /^\s*sort\s*=\s*usubjid\s*$/i.test(a); });
        var mhEngine = args.slice(1).some(function (a) { return /^\s*engine\s*=\s*V9\s*$/i.test(a); });
        var mhData = args.slice(1).some(function (a) { return /^\s*libref\s*=\s*data\s*$/i.test(a); });
        if (mhSort && mhEngine && mhData) {
          replacement = [args[0]].concat(replaceLibrefArgs(args.slice(1), 'SDTM')).join(',');
        }
      } else if (name === 't900pr.sas' && member === 'dm') {
        var prSort = args.slice(1).some(function (a) { return /^\s*sort\s*=\s*usubjid\s*$/i.test(a); });
        var prEngine = args.slice(1).some(function (a) { return /^\s*engine\s*=\s*V9\s*$/i.test(a); });
        var prData = args.slice(1).some(function (a) { return /^\s*libref\s*=\s*data\s*$/i.test(a); });
        if (prSort && !prEngine && prData) {
          var prArgs = [args[0]].concat(replaceLibrefArgs(args.slice(1), 'SDTM'));
          prArgs.push(' engine=V9');
          replacement = prArgs.join(',');
        }
      } else if (name === 't900rs.sas' && member === 'sv' && args.length === 1) {
        replacement = 'sv, libref=data, sort=usubjid, engine=V9';
      }

      if (replacement != null && replacement !== text.slice(call.argsStart, call.argsEnd)) {
        edits.push([call.argsStart, call.argsEnd, replacement]);
      }
    });

    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length,
      hit: edits.length ? specialHit(rule, edits.length, rule.find, rule.replace) : null };
  }

  function fixR023(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R023_PROGRAMS[name]) {
      return { text: text, count: 0 };
    }
    var lines = text.split('\n');
    var count = 0;

    if (name === 't900pc.sas') {
      if (!lines.some(function (x) { return /^\s*set\s+&ins\.\s*;/i.test(x); })) {
        var macroAt = findLineIndex(lines, /^\s*%macro\s+pk\s*\(/i);
        var infileAt = findLineIndex(lines, /^\s*infile\s+["'].*&&ins\.\.csv/i, macroAt >= 0 ? macroAt + 1 : 0);
        var runAt = findLineIndex(lines, /^\s*run\s*;/i, infileAt >= 0 ? infileAt + 1 : 0);
        var lengthAt = findLineIndex(lines, /^\s*length\b/i, infileAt >= 0 ? infileAt + 1 : 0);
        var inputAt = findLineIndex(lines, /^\s*input\b/i, lengthAt >= 0 ? lengthAt + 1 : 0);
        if (infileAt >= 0 && infileAt < lengthAt && lengthAt < inputAt && inputAt < runAt) {
          var lengthEnd = lengthAt;
          while (lengthEnd < inputAt && lines[lengthEnd].trim() !== ';') lengthEnd++;
          var inputEnd = inputAt;
          while (inputEnd < runAt && lines[inputEnd].trim() !== ';') inputEnd++;
          if (lengthEnd < inputAt && inputEnd < runAt) {
            var activeLength = lines.slice(lengthAt, lengthEnd + 1);
            var legacy = lines.slice(infileAt, inputEnd + 1);
            var indent = /^\s*/.exec(lines[infileAt])[0];
            legacy[0] = indent + '/*' + legacy[0].trimStart();
            legacy[legacy.length - 1] += '*/';
            lines.splice.apply(lines, [infileAt, inputEnd - infileAt + 1]
              .concat(activeLength, legacy, [indent + 'set &ins.;']));
            count = 1;
          }
        }
      }

      var lets = [
        '%let payload_ext_dataset = ext.vendorpk_pk_payload;',
        '%let intact_ext_dataset  = ext.vendorpk_pk_intact;',
        '%let total_ext_dataset   = ext.vendorpk_pk_total;'
      ];
      var missing = lets.filter(function (stmt) {
        return !lines.some(function (x) { return x.trim().toLowerCase() === stmt.toLowerCase(); });
      });
      if (missing.length) {
        var callAt = findLineIndex(lines, /^\s*%pk\s*\(\s*ins\s*=\s*&payload_ext_dataset/i);
        if (callAt >= 0) {
          lines.splice.apply(lines, [callAt, 0].concat(missing, ['']));
          count = 1;
        }
      }

    } else if (name === 't900is.sas') {
      var procAt = findLineIndex(lines, /^\s*proc\s+import\s+datafile=.*&nab_ext_dataset\.\.csv/i);
      if (procAt >= 0) {
        var procRun = findLineIndex(lines, /^\s*run\s*;/i, procAt + 1);
        if (procRun >= 0) {
          var procIndent = /^\s*/.exec(lines[procAt])[0];
          var procBlock = commentLineRange(lines, procAt, procRun)
            .concat(['', procIndent + 'data pkN;', procIndent + '    set Ext.Vendorpk_nab_final;', procIndent + 'run;']);
          lines.splice.apply(lines, [procAt, procRun - procAt + 1].concat(procBlock));
          count += 1;
        }
      }

      var dataAt = findLineIndex(lines, /^\s*data\s+pk4\s*;/i);
      if (dataAt >= 0 && !lines.slice(dataAt, dataAt + 25).some(function (x) {
        return /^\s*set\s+Ext\.Vendorpk_haha\s*;/i.test(x);
      })) {
        var hahaAt = findLineIndex(lines, /&haha_ext_dataset\.\.csv/i, dataAt + 1);
        var dataRun = findLineIndex(lines, /^\s*run\s*;/i, hahaAt >= 0 ? hahaAt + 1 : dataAt + 1);
        if (hahaAt >= 0 && dataRun >= 0) {
          var dataIndent = /^\s*/.exec(lines[dataAt])[0];
          var dataBlock = commentLineRange(lines, dataAt, dataRun)
            .concat(['', dataIndent + 'data pk4;', dataIndent + '    set Ext.Vendorpk_haha;', dataIndent + 'run;']);
          lines.splice.apply(lines, [dataAt, dataRun - dataAt + 1].concat(dataBlock));
          count += 1;
        }
      }

    } else if (name === 't900sv.sas') {
      var macroStarts = [];
      lines.forEach(function (x, i) { if (/^\s*%macro\s+pk\s*\(/i.test(x)) macroStarts.push(i); });
      if (macroStarts.length) {
        var first = macroStarts[0];
        var mend = findLineIndex(lines, /^\s*%mend\s*;/i, first + 1);
        var firstInfile = findLineIndex(lines, /^\s*infile\s+["'].*&&ins\.\.csv/i, first + 1);
        if (firstInfile >= 0 && mend >= 0 && firstInfile < mend) {
          var firstRun = findLineIndex(lines, /^\s*run\s*;/i, firstInfile + 1);
          var firstInput = findLineIndex(lines, /^\s*input\b/i, firstInfile + 1);
          if (firstInput >= 0 && firstRun >= 0 && firstRun < mend) {
            var firstInputEnd = firstInput;
            while (firstInputEnd < firstRun && lines[firstInputEnd].trim() !== ';') firstInputEnd++;
            if (firstInputEnd < firstRun) {
              var firstComment = commentLineRange(lines, firstInfile, firstInputEnd);
              var firstIndent = /^\s*/.exec(lines[firstInfile])[0];
              lines.splice.apply(lines, [firstInfile, firstInputEnd - firstInfile + 1]
                .concat(firstComment, [firstIndent + 'set Ext.&ins;']));
              count = 1;
            }
          }
        }
      }

      var callMap = {
        payload_ext_dataset: 'Vendorpk_pk_payload',
        intact_ext_dataset: 'Vendorpk_pk_intact',
        total_ext_dataset: 'Vendorpk_pk_total'
      };
      lines = lines.map(function (line) {
        Object.keys(callMap).forEach(function (macroName) {
          var re = new RegExp('&' + macroName + '\\b', 'i');
          if (/%pk\s*\(\s*ins\s*=/i.test(line) && re.test(line)) {
            line = line.replace(re, callMap[macroName]);
            count = 1;
          }
        });
        return line;
      });

      macroStarts = [];
      lines.forEach(function (x, i) { if (/^\s*%macro\s+pk\s*\(/i.test(x)) macroStarts.push(i); });
      if (macroStarts.length >= 2 && !(macroStarts[1] > 0 && lines[macroStarts[1] - 1].trim() === '/*')) {
        var second = macroStarts[1];
        var secondMend = findLineIndex(lines, /^\s*%mend\s*;/i, second + 1);
        if (secondMend >= 0) {
          var body = lines.slice(second, secondMend + 1).map(function (x) {
            return x.replace(/\/\*TIMEPOINT \$40\*\//g, '').replace(/\/\*TIMEPOINT\*\//g, '');
          });
          lines.splice.apply(lines, [second, secondMend - second + 1].concat(['/*'], body, ['*/']));
          count = 1;
        }
      }

      var nabAt = findLineIndex(lines, /^\s*%pk\s*\(\s*ins\s*=\s*&nab_ext_dataset/i);
      if (nabAt >= 0) {
        var nabIndent = /^\s*/.exec(lines[nabAt])[0];
        lines.splice(nabAt, 1,
          nabIndent + '%pk(ins=Vendorpk_haha, outs=pk4);',
          nabIndent + '%pk(ins=Vendorpk_nab_final, outs=pk5);');
        count = 1;
      }

      var pk4At = findLineIndex(lines, /^\s*data\s+pk4\s*;/i);
      if (pk4At >= 0) {
        var kupAt = findLineIndex(lines, /^\s*%util_fetchdata\s*\(\s*pk4\b/i, pk4At + 1);
        if (kupAt >= 0) {
          var pk4Comment = commentLineRange(lines, pk4At, kupAt);
          lines.splice.apply(lines, [pk4At, kupAt - pk4At + 1].concat(pk4Comment));
          count = 1;
        }
      }
      if (count) count = 1;
    }

    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, rule.find, rule.replace) : null };
  }

  function fixR024(text, rule, fileName) {
    var name = fileKey(fileName);
    var domain = R024_QC_DOMAINS[name];
    if (!has301Signal(text, fileName) || !domain) return { text: text, count: 0 };
    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var re = new RegExp('^(\\s*)%util_tscheck\\s*\\(\\s*' + escapeRe(domain) + '\\s*,', 'i');
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (count || isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      var m = re.exec(line);
      if (!m) return line;
      count = 1;
      return m[1] + '*' + line.slice(m[1].length);
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, 1, '%util_tscheck(' + domain + ', ...);', '*%util_tscheck(' + domain + ', ...);') : null };
  }

  function fixR025(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R025_PROGRAMS[name]) return { text: text, count: 0 };
    var edits = [];
    findMacroCalls(text, 'util_fetchdata').forEach(function (call) {
      var args = splitArgs(text.slice(call.argsStart, call.argsEnd));
      if (!args.length || !/^\s*&vendor_lab_source\.?\s*$/i.test(args[0])) return;
      if (!args.slice(1).some(function (a) { return /^\s*libref\s*=\s*rawdata\s*$/i.test(a); })) return;
      var newArgs = [args[0].replace(/&vendor_lab_source\.?/i, 'Vendorlab_lab')];
      args.slice(1).forEach(function (arg) {
        var m = /^(\s*libref\s*=\s*)rawdata(\s*)$/i.exec(arg);
        newArgs.push(m ? (m[1] + 'Ext' + m[2]) : arg);
      });
      edits.push([call.argsStart, call.argsEnd, newArgs.join(',')]);
    });
    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length,
      hit: edits.length ? specialHit(rule, edits.length, rule.find, rule.replace) : null };
  }

  function fixL034(text, fileName) {
    if (!has301Signal(text, fileName) || fileKey(fileName) !== 't900mb.sas') {
      return { text: text, count: 0, hit: null };
    }
    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var re = /^(\s*)%util_fetchdata\s*\(\s*&vendor_lab_source\.?\s*,\s*libref\s*=\s*rawdata\s*,\s*sort\s*=\s*subjid\s*\)\s*;/i;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (count || isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      var m = re.exec(line);
      if (!m) return line;
      count = 1;
      return m[1] + '*' + line.slice(m[1].length);
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(L034_RULE, 1) : null };
  }

  function fixR026(text, rule, fileName) {
    var name = fileKey(fileName);
    var allowed = R026_DIRECT_MEMBERS[name];
    if (!has301Signal(text, fileName) || !allowed) return { text: text, count: 0 };
    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var re = name === 'u900adae.sas'
      ? /(\bproc\s+contents\s+data\s*=\s*)data\.(adae)\b/i
      : /(\bproc\s+sort\s+data\s*=\s*)data\.(adae|adsl)\b/i;
    var lib = name === 'u900adae.sas' ? 'ADaM' : 'adam';
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      return line.replace(re, function (match, lead, member) {
        if (!allowed[member.toLowerCase()]) return match;
        count += 1;
        return lead + lib + '.' + member;
      });
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, rule.find, rule.replace) : null };
  }


  function statementCommentRange(lines, start, end) {
    for (var i = start; i <= end; i++) {
      if (!lines[i].trim()) continue;
      var indent = /^\s*/.exec(lines[i])[0];
      var body = lines[i].slice(indent.length);
      if (body.charAt(0) === '*') continue;
      lines[i] = indent + '*' + body;
    }
  }

  function fixR027(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R027_PROGRAMS[name]) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var count = 0;
    var i = 0;
    while (i < lines.length) {
      var m = /^(\s*)data\s+(vendortreatment|strati)\s*;\s*$/i.exec(lines[i]);
      if (!m || isCommentedLine(lines[i])) { i += 1; continue; }

      var runAt = findLineIndex(lines, /^\s*run\s*;\s*$/i, i + 1);
      if (runAt < 0) break;
      var infileAt = -1;
      for (var j = i + 1; j <= runAt; j++) {
        if (/^\s*infile\s+["'][^"']*&vendortreatment_trt\.\.csv["']/i.test(lines[j])) {
          infileAt = j; break;
        }
      }
      if (infileAt < 0) { i = runAt + 1; continue; }

      var sourceDs = m[2].toLowerCase();
      statementCommentRange(lines, i, runAt);

      if (sourceDs === 'vendortreatment') {
        var indent = m[1];
        lines.splice.apply(lines, [runAt + 1, 0,
          '',
          indent + 'data vendortreatment;',
          indent + '    set ext.Vendortreatment_treatment_code;',
          indent + 'run;'
        ]);
        i = runAt + 5;
      } else {
        var setAt = findLineIndex(lines, /^\s*set\s+strati\s*;\s*$/i, runAt + 1);
        if (setAt >= 0) {
          var setIndent = /^\s*/.exec(lines[setAt])[0];
          lines[setAt] = setIndent + 'set ext.Vendortreatment_treatment_code;';
        }
        i = runAt + 1;
      }
      count += 1;
    }

    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, count, rule.find, rule.replace) : null };
  }

  function fixR028(text, rule, fileName) {
    var name = fileKey(fileName);
    var domain = R028_PROGRAMS[name];
    if (!has301Signal(text, fileName) || !domain) return { text: text, count: 0 };
    if (/^\s*libname\s+data\s+["']&targetData\\SDTM["']\s*;/im.test(text)) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var anchor = new RegExp(
      '^\\s*%jcepoch1\\s*\\([^;\\n]*\\bdomain\\s*=\\s*' +
      escapeRe(domain) + '\\b[^;\\n]*\\)\\s*;\\s*$', 'i');
    var at = findLineIndex(lines, anchor);
    if (at < 0) return { text: text, count: 0 };

    var indent = /^\s*/.exec(lines[at])[0];
    var target = 'libname data "&targetData\\SDTM";';
    lines.splice(at + 1, 0, indent + target);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(insertion)', target) };
  }

  function fixR029(text, rule, fileName) {
    if (fileKey(fileName) !== 'chk_log.sas' || !hasSyntheticSignal(text, fileName)) {
      return { text: text, count: 0 };
    }

    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (count || isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      if (/^\s*%setup\s*;\s*$/i.test(line)) {
        var hadCr = /\r$/.test(line);
        var core = hadCr ? line.slice(0, -1) : line;
        var indent = /^\s*/.exec(core)[0];
        count = 1;
        return indent + '/*' + core.slice(indent.length) + '*/' + (hadCr ? '\r' : '');
      }
      return line;
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(rule, 1, '%setup;', '/*%setup;*/') : null };
  }

  function fixR030(text, rule, fileName) {
    if (fileKey(fileName) !== 'chk_log.sas' || !hasSyntheticSignal(text, fileName)) {
      return { text: text, count: 0 };
    }
    if (/%chk_log\s*\(\s*path\s*=\s*&targetStudy\.\\Dev\\Programs\\(?:SDTM|TLF)\s*\)/i.test(text)) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var sdtmInc = '%include "&targetStudy.\\Dev\\Programs\\SDTM\\autoexec.sas";';
    var hadSdtmInc = false;
    lines = lines.filter(function (line) {
      if (line.trim().toLowerCase() === sdtmInc.toLowerCase()) {
        hadSdtmInc = true;
        return false;
      }
      return true;
    });

    var start = -1;
    var kind = '';
    var legacy = /^\s*proc\s+printto\s+file\s*=\s*["'][^"']*programs[/\\](sdtm|tlf)[/\\][^"']*check_log_result_(?:sdtm|tlf)\.lst["']\s*;\s*$/i;
    for (var i = 0; i < lines.length; i++) {
      var m = legacy.exec(lines[i]);
      if (m && !isCommentedLine(lines[i])) {
        start = i; kind = m[1].toLowerCase(); break;
      }
    }
    if (start < 0 || start + 2 >= lines.length ||
        !/^\s*%chk_log\s*\(/i.test(lines[start + 1]) ||
        !/^\s*run\s*;\s*$/i.test(lines[start + 2])) {
      return { text: text, count: 0 };
    }

    var old = [
      commentOut(lines[start]),
      commentOut(lines[start + 1]),
      commentOut(lines[start + 2])
    ];
    var listInc = '%include "&targetStudy.\\Dev\\Programs\\Macros\\list_files.sas";';
    var chkInc = '%include "&targetStudy.\\Dev\\Programs\\Macros\\chk_log.sas";';
    var block;

    if (kind === 'sdtm') {
      block = old.concat(['', '', listInc, chkInc, sdtmInc]);
      block = block.concat([
        '',
        '    print="&targetStudy.\\Dev\\Programs\\SDTM\\check_log_result_sdtm.lst";',
        'run;',
        '',
        '%chk_log(path=&targetStudy.\\Dev\\Programs\\SDTM);',
        '',
        'proc printto;',
        'run;'
      ]);
    } else {
      block = old.concat([
        '', '',
        listInc,
        chkInc
      ]);
      if (hadSdtmInc) block.push(sdtmInc);
      block = block.concat([
        'proc printto',
        '    print="&targetStudy.\\Dev\\Programs\\ADaM\\check_log_result_TLF.lst";',
        'run;',
        '%chk_log(path=&targetStudy.\\Dev\\Programs\\TLF);',
        'proc printto;',
        'run;'
      ]);
    }

    lines.splice.apply(lines, [start, 3].concat(block));
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, rule.find, rule.replace) };
  }

  function replaceImagingCalls(text, domains) {
    var edits = [];
    ['util_getdata', 'util_fetchdata'].forEach(function (macro) {
      findMacroCalls(text, macro).forEach(function (call) {
        var argsText = text.slice(call.argsStart, call.argsEnd);
        var args = splitArgs(argsText);
        if (!args.length) return;
        var m = /^\s*&([a-z0-9_]+)_ext_dataset\.?\s*$/i.exec(args[0]);
        if (!m) return;
        var domain = m[1].toLowerCase();
        if (!domains[domain]) return;
        if (!args.slice(1).some(function (a) {
          return /^\s*libref\s*=\s*rawdata\s*$/i.test(a);
        })) return;

        var next = ['Vendorimaginga_imaging_' + domain];
        args.slice(1).forEach(function (arg) {
          var lm = /^(\s*libref\s*=\s*)rawdata(\s*)$/i.exec(arg);
          next.push(lm ? (lm[1] + 'Ext' + lm[2]) : arg);
        });
        edits.push([call.argsStart, call.argsEnd, next.join(',')]);
      });
    });
    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length };
  }

  function fixR031(text, rule, fileName) {
    var name = fileKey(fileName);
    var domains = R031_IMAGING_DOMAINS[name];
    if (!has301Signal(text, fileName) || !domains) return { text: text, count: 0 };

    var original = text;
    var mapped = replaceImagingCalls(text, domains);
    text = mapped.text;
    var lines = text.split('\n');

    if (name === 't900co.sas') {
      for (var i = 0; i < lines.length; i++) {
        if (/^\s*set\s+&co_ext_dataset\.?\s*;\s*$/i.test(lines[i])) {
          var indent = /^\s*/.exec(lines[i])[0];
          lines[i] = indent + 'set Vendorimaginga_imaging_co;';
          break;
        }
      }
    } else {
      var dataAt = findLineIndex(lines, /^\s*data\s+tuvend\s*;\s*$/i);
      var runAt = findLineIndex(lines, /^\s*run\s*;\s*$/i, dataAt >= 0 ? dataAt + 1 : 0);
      if (dataAt >= 0 && runAt >= 0) {
        for (var j = dataAt; j <= runAt; j++) {
          ['rs', 'tr', 'tu'].forEach(function (domain) {
            lines[j] = lines[j].replace(
              new RegExp('&' + domain + '_ext_dataset\\.?', 'ig'),
              'Ext.Vendorimaginga_imaging_' + domain);
          });
        }
      }

      var trAt = findLineIndex(lines, /^\s*data\s+tr_uvis\s*;\s*$/i);
      var trRun = findLineIndex(lines, /^\s*run\s*;\s*$/i, trAt >= 0 ? trAt + 1 : 0);
      if (trAt >= 0 && trRun >= 0) {
        for (var k = trAt; k <= trRun; k++) {
          lines[k] = lines[k].replace(/&tr_ext_dataset\.?/ig, 'Vendorimaginga_imaging_tr');
        }
      }
    }

    text = lines.join('\n');
    var count = text !== original || mapped.count ? 1 : 0;
    return { text: text, count: count,
      hit: count ? specialHit(rule, 1, rule.find, rule.replace) : null };
  }

  function fixL035(text, fileName) {
    if (!has301Signal(text, fileName) || fileKey(fileName) !== 't900rs.sas') {
      return { text: text, count: 0, hit: null };
    }
    var spans = inactiveSpans(text);
    var offset = 0;
    var count = 0;
    var patterns = [
      /^(\s*)%util_fetchdata\s*\(\s*&adj_ext_dataset\.?\s*,\s*libref\s*=\s*rawdata\s*,\s*sort\s*=\s*usubjid\s*\)\s*;/i,
      /^(\s*)%util_getdata\s*\(\s*&rs_ext_dataset\.?\s*,\s*libref\s*=\s*rawdata\s*,\s*sort\s*=\s*usubjid\s*,\s*engine\s*=\s*V9\s*\)\s*;/i
    ];
    var lines = text.split('\n').map(function (line) {
      var start = offset;
      offset += line.length + 1;
      if (isCommentedLine(line) || !activeLine(line, start, spans)) return line;
      for (var i = 0; i < patterns.length; i++) {
        var m = patterns[i].exec(line);
        if (m) {
          count += 1;
          return m[1] + '*' + line.slice(m[1].length);
        }
      }
      return line;
    });
    return { text: lines.join('\n'), count: count,
      hit: count ? specialHit(L035_RULE, count) : null };
  }


  function fixR032(text, rule, fileName) {
    var name = fileKey(fileName);
    var dataset = R032_ILD_DATASETS[name];
    if (!has301Signal(text, fileName) || !dataset) return { text: text, count: 0 };
    var target = 'Ext.' + dataset;
    if (new RegExp('^\\s*set\\s+' + escapeRe(target) + '\\s*;\\s*$', 'im').test(text)) {
      return { text: text, count: 0 };
    }

    var lines = text.split('\n');
    var spans = inactiveSpans(text);
    var offsets = [];
    var off = 0;
    lines.forEach(function (line) { offsets.push(off); off += line.length + 1; });

    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (isCommentedLine(lines[i]) || !activeLine(lines[i], offsets[i], spans)) continue;
      if (/^\s*proc\s+import\s+datafile\s*=\s*["'][^"']*&ild_ext_dataset\.\.csv["']/i.test(lines[i])) {
        start = i; break;
      }
    }
    if (start < 0) return { text: text, count: 0 };

    var runAt = findLineIndex(lines, /^\s*run\s*;\s*$/i, start + 1);
    if (runAt < 0) return { text: text, count: 0 };

    var outName = 'ILD';
    for (var j = start; j <= runAt; j++) {
      var om = /\bout\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[j]);
      if (om) { outName = om[1]; break; }
    }
    var originalIndent = /^\s*/.exec(lines[start])[0];
    for (var k = start; k <= runAt; k++) {
      if (lines[k].trim() && !isCommentedLine(lines[k])) lines[k] = commentOut(lines[k]);
    }
    lines.splice(runAt + 1, 0,
      '',
      originalIndent + 'data ' + outName + ';',
      originalIndent + '    set ' + target + ';',
      originalIndent + 'run;'
    );

    if (name === 't900ae.sas') {
      var after = runAt + 5;
      var limit = Math.min(lines.length, after + 8);
      var jc = /^\s*%jcchrp1\s*\(\s*indsn\s*=\s*ILD\s*,\s*outdsn\s*=\s*ILD\s*,\s*debug\s*=\s*N\s*\)\s*;\s*$/i;
      for (var q = after; q < limit; q++) {
        if (jc.test(lines[q])) {
          var qIndent = /^\s*/.exec(lines[q])[0];
          lines[q] = qIndent + '*' + lines[q].slice(qIndent.length);
          break;
        }
      }
    }

    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, rule.find, rule.replace) };
  }

  function fixR033(text, rule, fileName) {
    var name = fileKey(fileName);
    if (!has301Signal(text, fileName) || !R033_PROGRAMS[name]) return { text: text, count: 0 };
    var edits = [];
    findMacroCalls(text, 'util_fetchdata').forEach(function (call) {
      var args = splitArgs(text.slice(call.argsStart, call.argsEnd));
      if (!args.length || !/^\s*&vendor_labb_source\.?\s*$/i.test(args[0])) return;
      if (!args.slice(1).some(function (a) { return /^\s*libref\s*=\s*rawdata\s*$/i.test(a); })) return;
      var next = ['VendorLabB_lab'];
      args.slice(1).forEach(function (arg) {
        var m = /^(\s*libref\s*=\s*)rawdata(\s*)$/i.exec(arg);
        next.push(m ? (m[1] + 'Ext' + m[2]) : arg);
      });
      edits.push([call.argsStart, call.argsEnd, next.join(',')]);
    });
    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });

    if (edits.length) {
      var lines = text.split('\n');
      if (name === 't900lb.sas') {
        for (var i = 0; i < lines.length; i++) {
          if (/^\s*set\s+&vendor_labb_source\.?\s*;\s*$/i.test(lines[i])) {
            var indent = /^\s*/.exec(lines[i])[0];
            lines[i] = indent + 'set VendorLabB_lab;';
            break;
          }
        }
      } else if (name === 't900sv.sas') {
        for (var j = 0; j < lines.length; j++) {
          if (/^\s*set\s+&vendor_labb_source\.?\s*\(/i.test(lines[j])) {
            lines[j] = lines[j].replace(/&vendor_labb_source\.?/i, 'Ext.VendorLabB_lab');
            break;
          }
        }
      }
      text = lines.join('\n');
    }

    var count = edits.length ? 1 : 0;
    return { text: text, count: count,
      hit: count ? specialHit(rule, 1, rule.find, rule.replace) : null };
  }

  function fixR001(text, rule, fileName) {
    var include = '%include "&targetStudy.\\Programs\\Macros\\autoexec.sas";';
    if (!has301Signal(text, fileName)) return { text: text, count: 0 };
    if (text.indexOf(include) !== -1) return { text: text, count: 0 };
    var lines = text.split('\n');
    var at = insertAt(text);
    lines.splice(at, 0, indentAt(lines, at) + include);
    return { text: lines.join('\n'), count: 1,
      hit: specialHit(rule, 1, '(insertion)', include) };
  }

  function fixR002(text, rule, fileName) {
    var target = DEFAULT_PARAMS.ADAM_LIBREF;
    var edits = [];
    if (!has301Signal(text, fileName)) return { text: text, count: 0 };
    findMacroCalls(text, 'util_getdata').forEach(function (call) {
      var argsText = text.slice(call.argsStart, call.argsEnd);
      var args = splitArgs(argsText);
      if (args.length < 2 || !hasDataLibref(args)) return;

      var members = adamMembers(args[0]);
      if (!members.adam.length) return;

      if (members.other.length) {
        var nonAdamArgs = [members.other[0]].concat(args.slice(1));
        var adamArgs = [members.adam[0]].concat(
          replaceLibrefArgs(args.slice(1), target));
        edits.push([call.start, call.end,
          '%util_getdata(' + nonAdamArgs.join(',') + ');\n' +
          '%util_getdata(' + adamArgs.join(',') + ')']);
      } else {
        edits.push([call.argsStart, call.argsEnd,
          [args[0]].concat(replaceLibrefArgs(args.slice(1), target)).join(',')]);
      }
    });

    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length,
      hit: edits.length ? specialHit(rule, edits.length, rule.find, rule.replace) : null };
  }

  function fixR004(text, rule, fileName) {
    var target = DEFAULT_PARAMS.ADAM_LIBREF;
    var edits = [];
    if (!has301Signal(text, fileName)) return { text: text, count: 0 };

    findMacroCalls(text, 'util_cvtds').forEach(function (call) {
      var argsText = text.slice(call.argsStart, call.argsEnd);
      var args = splitArgs(argsText);
      if (!args.length || !String(args[0]).trim()) return;
      if (args.some(function (arg) { return /^\s*libref\s*=/i.test(arg); })) return;
      args.splice(1, 0, 'libref=' + target);
      edits.push([call.argsStart, call.argsEnd, args.join(',')]);
    });

    edits.reverse().forEach(function (edit) {
      text = text.slice(0, edit[0]) + edit[2] + text.slice(edit[1]);
    });
    return { text: text, count: edits.length,
      hit: edits.length ? specialHit(rule, edits.length, rule.find, rule.replace) : null };
  }

  function applySpecial(rule, text, fileName) {
    if (rule.id === 'R-001') return fixR001(text, rule, fileName);
    if (rule.id === 'R-002') return fixR002(text, rule, fileName);
    if (rule.id === 'R-003') return fixR003(text, rule, fileName);
    if (rule.id === 'R-004') return fixR004(text, rule, fileName);
    if (rule.id === 'R-005') return fixR005(text, rule, fileName);
    if (rule.id === 'R-006') return fixR006(text, rule, fileName);
    if (rule.id === 'R-007') return fixR007(text, rule, fileName);
    if (rule.id === 'R-008') return fixR008(text, rule, fileName);
    if (rule.id === 'R-009') return fixR009(text, rule, fileName);
    if (rule.id === 'R-010') return fixR010(text, rule, fileName);
    if (rule.id === 'R-011') return fixR011(text, rule, fileName);
    if (rule.id === 'R-012') return fixR012(text, rule, fileName);
    if (rule.id === 'R-013') return fixR013(text, rule, fileName);
    if (rule.id === 'R-014') return fixR014(text, rule, fileName);
    if (rule.id === 'R-015') return fixR015(text, rule, fileName);
    if (rule.id === 'R-016') return fixR016(text, rule, fileName);
    if (rule.id === 'R-017') return fixR017(text, rule, fileName);
    if (rule.id === 'R-018') return fixR018(text, rule, fileName);
    if (rule.id === 'R-019') return fixR019(text, rule, fileName);
    if (rule.id === 'R-020') return fixR020(text, rule, fileName);
    if (rule.id === 'R-021') return fixR021(text, rule, fileName);
    if (rule.id === 'R-022') return fixR022(text, rule, fileName);
    if (rule.id === 'R-023') return fixR023(text, rule, fileName);
    if (rule.id === 'R-024') return fixR024(text, rule, fileName);
    if (rule.id === 'R-025') return fixR025(text, rule, fileName);
    if (rule.id === 'R-026') return fixR026(text, rule, fileName);
    if (rule.id === 'R-027') return fixR027(text, rule, fileName);
    if (rule.id === 'R-028') return fixR028(text, rule, fileName);
    if (rule.id === 'R-029') return fixR029(text, rule, fileName);
    if (rule.id === 'R-030') return fixR030(text, rule, fileName);
    if (rule.id === 'R-031') return fixR031(text, rule, fileName);
    if (rule.id === 'R-032') return fixR032(text, rule, fileName);
    if (rule.id === 'R-033') return fixR033(text, rule, fileName);
    if (rule.id === 'R-036') return fixR036(text, rule, fileName);
    if (rule.id === 'R-037') return fixR037(text, rule);
    return { text: text, count: 0 };
  }

  /* -- finding the header row ---------------------------------------------
   * Score the first rows by how many of their cells are headers we recognise,
   * breaking ties on how many cells they have at all. A title line scores zero
   * and a real header row scores most of its width, so the gap is wide and
   * this does not need to be cleverer than it is. */

  var HEADER_SCAN = 12;

  function findHeaderRow(grid) {
    var best = -1;
    var bestScore = 0;
    var bestWidth = 0;
    var limit = Math.min(grid.length, HEADER_SCAN);

    for (var i = 0; i < limit; i++) {
      var headers = (grid[i] || []).map(function (h) {
        return h == null ? '' : String(h).trim();
      });
      var score = Object.keys(mapHeaders(headers)).length;
      var width = headers.filter(nonEmpty).length;
      if (score > bestScore ||
          (score === bestScore && score > 0 && width > bestWidth)) {
        best = i; bestScore = score; bestWidth = width;
      }
    }

    /* Nothing recognisable: the first non-blank row, which is the right answer
       for a workbook whose headers we have no alias for. */
    if (best < 0) {
      for (var j = 0; j < grid.length; j++) {
        if ((grid[j] || []).some(nonEmpty)) return j;
      }
      return 0;
    }
    return best;
  }

  /* -- parsing a workbook -------------------------------------------------- */

  /**
   * Turn a workbook (as MigExcel.read returns it) into a rule book.
   *
   * Every sheet is kept whole, so anything else in a consolidated workbook is
   * still there to look at. Rules come from the Rules sheet alone.
   */
  function parse(workbook, sourceName) {
    var book = {
      source: sourceName || 'Migrate_Studio_Rules.xlsx',
      sheetNames: [],
      sheets: {},
      rulesSheet: '',
      headers: [],
      map: {},
      rules: [],
      executable: 0,
      warnings: []
    };

    (workbook.names || []).forEach(function (name) {
      var grid = workbook.sheets[name] || [];
      book.sheetNames.push(name);

      if (!grid.length) {
        book.sheets[name] = { headers: [], rows: [], headerRow: 0 };
        return;
      }

      var start = findHeaderRow(grid);
      book.sheets[name] = {
        headers: (grid[start] || []).map(function (h) {
          return h == null ? '' : String(h).trim();
        }),
        rows: grid.slice(start + 1).filter(function (row) {
          return row.some(nonEmpty);
        }),
        headerRow: start
      };
    });

    var chosen = book.sheetNames.filter(function (name) {
      return normalize(name) === RULES_SHEET;
    })[0] || book.sheetNames[0] || '';
    book.rulesSheet = chosen;

    var sheet = book.sheets[chosen];
    if (sheet && sheet.headers.length) {
      book.headers = sheet.headers;
      book.map = mapHeaders(sheet.headers);
      sheet.rows.forEach(function (row, index) {
        buildRules(chosen, sheet.headers, book.map, row, index)
          .forEach(function (rule) { book.rules.push(rule); });
      });
    }

    book.executable = book.rules.filter(function (r) {
      return r.executable && r.enabled;
    }).length;

    if (!book.rules.length) {
      book.warnings.push(
        'No rules found on the ' + (chosen || 'first') + ' sheet of ' +
        book.source + '.');
    } else if (!book.executable) {
      book.warnings.push(
        'None of the ' + book.rules.length + ' rules carry a usable Before ' +
        'pattern, so Apply Fix has nothing to run.');
    }
    return book;
  }

  /**
   * Turn one workbook row into one rule, or one rule per Before variant.
   *
   * Every rule keeps `row`, so the Rules tab can show one line per workbook
   * row however many variants came out of it, and `cells`, so a column Migrate Studio
   * has no alias for is still there to display.
   */
  function buildRules(sheet, headers, map, row, index) {
    var base = {
      sheet: sheet,
      row: index + 1,
      id: cell(row, map.id) || (sheet + '-' + (index + 1)),
      name: cell(row, map.name),
      description: cell(row, map.desc),
      category: cell(row, map.category),
      axis: cell(row, map.axis),
      conditions: cell(row, map.conditions),
      automatability: cell(row, map.automatability),
      occurrences: cell(row, map.occurrences),
      examples: cell(row, map.examples),
      conflict: cell(row, map.conflict),
      confidence: cell(row, map.confidence),
      flags: cell(row, map.flags),
      scope: cell(row, map.scope),
      severity: cell(row, map.severity),
      enabled: truthy(cell(row, map.enabled)),
      cells: {}
    };

    /* Keep every column verbatim, keyed by its header, so nothing the workbook
       carries is lost on the way through. */
    headers.forEach(function (header, i) {
      base.cells[header || ('Column ' + (i + 1))] = cell(row, i);
    });

    var modeText = cell(row, map.mode);
    var befores = splitVariants(cell(row, map.find));
    var afters = splitVariants(cell(row, map.replace));

    function afterFor(variant, position) {
      if (!afters.length) return '';
      var byNumber = afters.filter(function (a) { return a.n === variant.n; })[0];
      if (byNumber) return byNumber.text;
      /* Unnumbered, or numbered differently: pair by position, and fall back
         to the single After when there is only one. */
      if (afters.length === 1) return afters[0].text;
      return afters[position] ? afters[position].text : '';
    }

    if (!befores.length) {
      if (BLANK_BEFORE_SPECIALS[base.id]) {
        var special = Object.assign({}, base);
        var builtSpecial = buildReplacement(cell(row, map.replace), null, DEFAULT_PARAMS);
        special.variant = '';
        special.variants = 1;
        special.key = special.id;
        special.find = '';
        special.replace = cell(row, map.replace);
        special.mode = 'special';
        special.regex = null;
        special.groups = {};
        special.compiled = null;
        special.replacement = builtSpecial.text;
        special.parameters = builtSpecial.pending;
        special.needsParameters = builtSpecial.pending.length > 0;
        special.executable = true;
        special.selected = special.enabled && !special.needsParameters;
        special.error = '';
        special.note = special.needsParameters
          ? ('Needs a value for ' + builtSpecial.pending.map(function (n) {
              return '{' + n + '}';
            }).join(', ') + ' before it can run.')
          : 'Contextual insertion rule handled by Migrate Studio.';
        return [special];
      }
      return [documentationOnly(Object.assign({}, base), '', '',
        'No Before pattern, so this rule is documentation.')];
    }

    return befores.map(function (variant, position) {
      var rule = Object.assign({}, base);
      rule.variant = variant.n;
      rule.variants = befores.length;
      rule.key = base.id +
        (befores.length > 1 ? ('#' + (variant.n || position + 1)) : '');
      rule.find = variant.text;
      rule.replace = afterFor(variant, position);
      rule.error = '';

      if (isAbsence(rule.find)) {
        /* Nothing to match. If the After column carries a line, this is an
           insertion — applicable, and selectable. If it carries nothing
           either, the row really is documentation. */
        if (!rule.replace) {
          return documentationOnly(rule, rule.find, rule.replace,
            'The Before pattern describes an absence and there is no After ' +
            'line to insert, so this rule is documentation.');
        }
        return asInsertion(rule);
      }

      rule.mode = decideMode(rule.find, modeText, rule.flags);
      rule.groups = {};
      rule.compiled = null;
      rule.regex = buildRegex(rule);
      rule.executable = !!rule.regex;

      var built = buildReplacement(rule.replace, rule.compiled, DEFAULT_PARAMS);
      rule.replacement = built.text;
      rule.parameters = built.pending;
      rule.needsParameters = built.pending.length > 0;

      /* An executable rule starts ticked — unless its After pattern still has
         a parameter nobody has given a value to. Applying that would write the
         placeholder itself into the program, so it is left for a person to
         decide about rather than run by default. */
      rule.selected = rule.executable && rule.enabled && !rule.needsParameters;
      rule.note = rule.needsParameters
        ? ('Needs a value for ' + built.pending.map(function (n) {
            return '{' + n + '}';
          }).join(', ') + ' before it can run.')
        : '';
      return rule;
    });
  }

  /**
   * Turn a row whose Before describes an absence into an insertion rule.
   *
   * It runs, it is ticked by default, and it is idempotent by construction:
   * apply() inserts nothing when the line is already in the program, which is
   * what "Insert once in program startup" asks for and what makes the rule
   * safe to run over a folder somebody has already migrated.
   */
  function asInsertion(rule) {
    var built = buildReplacement(rule.replace, null, DEFAULT_PARAMS);
    rule.mode = 'insert';
    rule.regex = null;
    rule.groups = {};
    rule.compiled = null;
    rule.insertText = built.text;
    rule.replacement = built.text;
    rule.parameters = built.pending;
    rule.needsParameters = built.pending.length > 0;
    rule.executable = true;
    rule.selected = rule.enabled && !rule.needsParameters;
    rule.error = '';
    rule.note = rule.needsParameters
      ? ('Needs a value for ' + built.pending.map(function (n) {
          return '{' + n + '}';
        }).join(', ') + ' before it can run.')
      : 'Inserted once into the program\'s startup block.';
    return rule;
  }

  function documentationOnly(rule, find, replace, note) {
    rule.find = find || '';
    rule.replace = replace || '';
    rule.mode = '';
    rule.regex = null;
    rule.groups = {};
    rule.compiled = null;
    rule.replacement = '';
    rule.parameters = [];
    rule.needsParameters = false;
    rule.executable = false;
    rule.selected = false;
    rule.error = rule.error || '';
    rule.note = note || 'No Before pattern, so this rule is documentation.';
    rule.key = rule.key || rule.id;
    return rule;
  }

  /* -- applying the rule book ---------------------------------------------
   * Rules run in book order against the whole program text. Each one reports
   * how many times it fired, which is what the Fixes card and the count beside
   * a program in the rail are counting: replacements, not rules.
   *
   * Only ticked rules run. That is the point of the tick: a consolidated rule
   * book carries changes from several studies, and applying all of them to one
   * program is almost never what anybody wants.
   *
   * A rule with a scope column only runs against programs whose file name
   * matches it — a glob (adam_*.sas), a comma-separated list of them, or a
   * plain substring. */

  function inScope(rule, fileName) {
    if (!rule.scope) return true;
    var name = String(fileName || '').toLowerCase();
    return rule.scope.split(/[,;|]/).some(function (part) {
      var token = part.trim().toLowerCase();
      if (!token || token === '*' || token === '*.sas' || token === 'all') {
        return true;
      }
      if (token.indexOf('*') !== -1 || token.indexOf('?') !== -1) {
        var re = new RegExp('^' + token.split('').map(function (ch) {
          if (ch === '*') return '.*';
          if (ch === '?') return '.';
          return escapeRe(ch);
        }).join('') + '$');
        return re.test(name);
      }
      return name.indexOf(token) !== -1;
    });
  }

  /** True when this rule should run: ticked, enabled, executable, in scope. */
  function willRun(rule, fileName) {
    if (!rule.selected || !rule.enabled || !rule.executable) return false;
    if (!inScope(rule, fileName)) return false;
    if (rule.mode === 'special') return true;
    /* An insertion has no regex — its applicability is a position, not a
       pattern — so it is the one executable kind without one. */
    return rule.mode === 'insert' ? !!rule.insertText : !!rule.regex;
  }

  /**
   * Run a rule book over one program.
   *
   * Returns { text, total, hits: [...] } and never throws: a rule that blows up
   * is reported on its hit entry and the rest still run. The original text is
   * returned unchanged when nothing fires.
   */
  function apply(book, text, fileName) {
    var out = String(text == null ? '' : text);
    var hits = [];
    var total = 0;

    var runnable = (book.rules || []).filter(function (rule) {
      return willRun(rule, fileName);
    });

    selectedSpecialRules(book.rules, fileName).forEach(function (rule) {
      try {
        var beforeRule = out;
        var fixed = applySpecial(rule, out, fileName);
        out = fixed.text;
        if (fixed.count) {
          total += fixed.count;
          var ruleHit = fixed.hit || specialHit(rule, fixed.count);
          hits.push(attachDetails(ruleHit, beforeRule, out));
        }

        /* R-019 redirects the RESCREEN source. L-032 is a separate, linked
           high-risk logic finding that adapts subject/site identifier types.
           Run it whenever R-019 is selected, even when R-019 itself is already
           satisfied, and report it under its own Logic ID. */
        if (rule.id === 'R-019') {
          var beforeLinked = out;
          var linked = fixL032(out, fileName);
          out = linked.text;
          if (linked.count) {
            total += linked.count;
            hits.push(attachDetails(linked.hit, beforeLinked, out));
          }
        }
        if (rule.id === 'R-025') {
          var beforeVendorlab = out;
          var vendorlabLinked = fixL034(out, fileName);
          out = vendorlabLinked.text;
          if (vendorlabLinked.count) {
            total += vendorlabLinked.count;
            hits.push(attachDetails(vendorlabLinked.hit, beforeVendorlab, out));
          }
        }
        if (rule.id === 'R-031') {
          var beforeImaging = out;
          var imagingException = fixL035(out, fileName);
          out = imagingException.text;
          if (imagingException.count) {
            total += imagingException.count;
            hits.push(attachDetails(imagingException.hit, beforeImaging, out));
          }
        }
      } catch (error) {
        hits.push({
          key: rule.key, id: rule.id,
          name: rule.name || rule.description,
          category: rule.category, count: 0, details: [], error: error.message
        });
      }
    });

    runnable = runnable.filter(function (rule) {
      return SPECIAL_ORDER.indexOf(rule.id) === -1;
    });

    /* Pattern rules first, insertions second. An insertion only fires when its
       line is not already in the program, and a sibling variant of the same
       workbook row often puts it there — R-005 replaces the legacy include on
       one variant and inserts the same line on another. Running insertions
       last is what stops that row from writing the line twice. */
    var patterns = runnable.filter(function (r) { return r.mode !== 'insert'; });
    var inserts = runnable.filter(function (r) { return r.mode === 'insert'; });

    patterns.forEach(function (rule) {
      var count = 0;
      var replacement = rule.replacement != null
        ? rule.replacement : normalizeReplacement(rule.replace);
      var beforePattern = out;

      try {
        /* Recomputed per rule, because the previous rule changed the text and
           with it where the comments are. */
        var spans = inactiveSpans(out);
        rule.regex.lastIndex = 0;

        out = out.replace(rule.regex, function () {
          var args = Array.prototype.slice.call(arguments);
          var match = args[0];
          var offset = args[args.length - 2];

          /* A match that starts inside a comment or a string is not code. */
          if (!activeAt(spans, offset)) return match;

          count++;
          var groups = args.slice(1, -2);
          return replacement.replace(/\$(\d{1,2}|&|\$)/g, function (token, what) {
            if (what === '$') return '$';
            if (what === '&') return match;
            var n = parseInt(what, 10);
            return groups[n - 1] == null ? '' : String(groups[n - 1]);
          });
        });
      } catch (error) {
        hits.push({
          key: rule.key, id: rule.id,
          name: rule.name || rule.description,
          category: rule.category, count: 0, details: [], error: error.message
        });
        return;
      }

      if (count) {
        total += count;
        hits.push({
          key: rule.key,
          id: rule.id,
          name: rule.name || rule.description || rule.find,
          category: rule.category,
          severity: rule.severity,
          find: rule.find,
          replace: rule.replace,
          count: count,
          details: buildChangeDetails(beforePattern, out),
          error: ''
        });
      }
    });

    inserts.forEach(function (rule) {
      var line = rule.insertText;
      /* "Insert once in program startup": already there is success, not a
         miss, and it is what makes this safe over an already-migrated folder. */
      if (!line || out.indexOf(line) !== -1) return;

      var beforeInsert = out;
      var lines = out.split('\n');
      var at = insertAt(out);
      lines.splice(at, 0, indentAt(lines, at) + line);
      out = lines.join('\n');
      total += 1;
      hits.push({
        key: rule.key, id: rule.id,
        name: rule.name || rule.description || 'insert',
        category: rule.category, severity: rule.severity,
        find: '(insertion)', replace: line, count: 1,
        details: buildChangeDetails(beforeInsert, out), error: ''
      });
    });

    return { text: out, total: total, hits: hits };
  }

  /**
   * Map every known rule id to a description, for reports.
   *
   * Order, first non-empty wins per id:
   *   1. the Rules sheet (book.rules; a rule split into variants repeats its id)
   *   2. the Logic Changes sheet, keyed by its Logic ID column, for L-### ids
   *   3. the built-in manual-logic findings (LOGIC_RULES)
   */
  function ruleDescriptions(book) {
    var out = {};
    function keep(id, text) {
      id = String(id == null ? '' : id).trim();
      text = String(text == null ? '' : text).trim();
      if (id && text && !out[id]) out[id] = text;
    }

    ((book && book.rules) || []).forEach(function (rule) {
      if (rule) keep(rule.id, rule.description);
    });

    var sheets = (book && book.sheets) || {};
    Object.keys(sheets).forEach(function (name) {
      if (normalize(name) !== 'logicchanges') return;
      var sheet = sheets[name];
      var headers = (sheet.headers || []).map(normalize);
      var idCol = headers.indexOf('logicid');
      var descCol = headers.indexOf('description');
      if (idCol < 0 || descCol < 0) return;
      (sheet.rows || []).forEach(function (row) {
        keep(row[idCol], row[descCol]);
      });
    });

    Object.keys(LOGIC_RULES).forEach(function (id) {
      keep(id, LOGIC_RULES[id].description);
    });
    return out;
  }

  global.MigRules = {
    parse: parse,
    apply: apply,
    buildChangeDetails: buildChangeDetails,
    inScope: inScope,
    willRun: willRun,
    mapHeaders: mapHeaders,
    compileCodePattern: compileCodePattern,
    buildReplacement: buildReplacement,
    splitVariants: splitVariants,
    findHeaderRow: findHeaderRow,
    insertAt: insertAt,
    inactiveSpans: inactiveSpans,
    lineProbes: lineProbes,
    ALIASES: ALIASES,
    DISPLAY: DISPLAY,
    DISPLAY_LABELS: DISPLAY_LABELS,
    LOGIC_RULES: LOGIC_RULES,
    ruleDescriptions: ruleDescriptions
  };
})(typeof window !== 'undefined' ? window : this);
