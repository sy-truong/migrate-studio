#!/usr/bin/env python3
"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0

Migrate Studio -- apply migration rules to SAS programs.

    python mig_apply.py samples/EXAMPLE002_linux_to_windows/adam
    python mig_apply.py samples/EXAMPLE002_linux_to_windows/sdtm/dm.sas --rules R-003,R-005
    python mig_apply.py samples/EXAMPLE002_linux_to_windows/adam --param ADAM_LIBREF=adam --diff

Reads Migrate_Studio_Rules.xlsx, applies the selected rules to the selected programs,
and writes the results into a `Migrate_Studio` subfolder beside them. Originals are
never touched.

    samples/EXAMPLE002_linux_to_windows/adam/adae.sas          <- read
    samples/EXAMPLE002_linux_to_windows/adam/Migrate_Studio/adae.sas  <- written
    samples/EXAMPLE002_linux_to_windows/adam/Migrate_Studio/mig_report.csv


Why the rules are hand-written here
-----------------------------------
The browser side of Migrate Studio compiles the workbook's Before/After columns into
regular expressions, which is the right thing for a rule book somebody is still
drafting: anything you type has some effect, immediately.

These contextual rules have earned better than that. Each has been checked against
the bundled synthetic sample programs in samples/, so what the
transformation actually is -- as opposed to what a two-column summary of it can
say -- is known. Three consequences a regular expression cannot reach:

  * R-001 and R-005 variant 1 are insertions. Their Before column reads
    "[no corresponding executable line]", which is not something to match. What
    makes them applicable is an anchor -- "insert in the startup/bootstrap
    section" -- and that is a position, not a pattern.

  * R-002 and R-004 rewrite one argument of a macro call and must leave the
    rest of it alone, including its spacing and its punctuation oddities. The
    workbook's After column spells out the whole call, so applying it literally
    would normalise call sites that the rule was never about.

  * Every rule has to be safe to run twice, and none of them may fire inside a
    comment. `%init;` becoming `/*%init;*/` must not become `/*/*%init;*/*/`.

So each fixer below is a small function with the rule's conditions and its
known exceptions written into it, and the workbook stays the source of what the
rules ARE -- their identity, wording, and which are selected.

Requires Python 3.9+ and openpyxl.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Require openpyxl and stop with install guidance when it is missing.
try:
    import openpyxl
except ImportError:                                         # pragma: no cover
    print("mig_apply needs openpyxl:\n"
          f"    {sys.executable} -m pip install openpyxl", file=sys.stderr)
    raise SystemExit(2)


# Locate the edition folder, the default rule book, and the output folder name.
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RULES_FILE = ROOT / "rules" / "Migrate_Studio_Rules.xlsx"
OUTPUT_DIRNAME = "Migrate_Studio"

#: The rules this script implements, in dependency order. The TLF and ADaM
#: insertion rules deliberately run after the includes they use as anchors.
IMPLEMENTED = [
    "R-003",
    "R-029",
    "R-005",
    "R-030",
    "R-001",
    "R-002",
    "R-018",
    "R-004",
    "R-006",
    "R-007",
    "R-009",
    "R-011",
    "R-008",
    "R-012",
    "R-010",
    "R-013",
    "R-015",
    "R-014",
    "R-034",
    "R-020",
    "R-016",
    "R-035",
    "R-017",
    "R-019",
    "R-021",
    "R-022",
    "R-023",
    "R-024",
    "R-025",
    "R-026",
    "R-027",
    "R-028",
    "R-031",
    "R-032",
    "R-033",
    "R-037",
]

#: Values the After patterns need that the Before patterns cannot supply. The
#: workbook's Parameters sheet is where these belong long-term; until Migrate Studio
#: has a screen for it, these are the observed SCE values and --param overrides
#: them.
DEFAULT_PARAMS = {
    # P-002. The workbook notes both "ADaM" and "adam" occur in the migrated
    # programs with no visible rule for the choice; "ADaM" is the majority.
    "ADAM_LIBREF": "ADaM",
    "DATA_LIBREF": "DATA",
    # Single-quoted raw strings: these values contain both backslashes and
    # double quotes, and escaping the quotes would put the backslashes into the
    # SAS. Taken verbatim from the rules' After column.
    "TARGET_MACRO_AUTOEXEC": r'%include "&targetStudy.\Programs\Macros\autoexec.sas";',
    "TARGET_SDTM_AUTOEXEC": r'%include "&targetStudy.\Dev\Programs\SDTM\autoexec.sas";',
    "TARGET_TLF_AUTOEXEC": r'%include "&targetStudy.\Dev\Programs\TLF\autoexec.sas";',
    "TARGET_TLF_MA_AUTOEXEC": r'%include "&targetStudy.\Dev\Programs\TLF\MA_Testing\autoexec.sas";',
    "TARGET_MHEADFOOT": r'%include "&targetStudy.\Dev\Programs\Macros\mheadfoot.sas";',
    "TARGET_SETUPANL": r'%include "&targetStudy.\Dev\Programs\Macros\setupanl.sas";',
    "TARGET_MTRIM": r'%include "&targetStudy.\Dev\Programs\Macros\mtrim.sas";',
    "TARGET_PADAM": r'libname padam "&targetData.\ADaM";',
    # Set the source study root that R-034 repoints.
    "SOURCE_STUDY_ROOT": "/placeholder/linux/projects/EXAMPLE002",
}

#: Programs the workbook's Exceptions column excludes by name, per rule. These
#: are not heuristics -- each is a program the evidence shows was NOT migrated
#: the way the rule describes, and applying the rule to it would be wrong.
EXCLUSIONS = {
    "R-003": {"relrec.sas", "l-death.sas"},
    "R-005": {"relrec.sas"},
    "R-007": {"adpr.sas", "l-death.sas"},
    "R-011": {"l-death.sas"},
}

# List the SDTM domains whose resize calls R-006 comments out.
R006_DISABLED_DOMAINS = {
    "ae", "suppae",
    "cm", "suppcm",
    "co",
    "cv",
    "dd", "suppdd",
    "ds", "suppds",
    "ee", "suppee",
    "eg",
    "fa", "suppfa",
    "ie", "suppie",
    "is", "suppis",
    "lb", "supplb",
    "pc", "supppc",
    "pe", "supppe",
    "pr", "supppr",
}

# List the TLF programs that use the MA_Testing autoexec (R-009).
R009_MA_TESTING = {"l-death.sas", "t-lb-lc-saf.sas"}

# List the 301 SDTM programs that receive the R-010 library bootstrap.
R010_301_SDTM_PROGRAMS = {
    "t900ae.sas",
    "t900cm.sas",
    "t900co.sas",
    "t900cv.sas",
    "t900dd.sas",
    "t900dm.sas",
    "t900ds.sas",
    "t900dv.sas",
    "t900ee.sas",
    "t900eg.sas",
    "t900fa.sas",
    "t900ie.sas",
    "t900is.sas",
    "t900lb.sas",
}

# List the TLF programs that receive the SETUPANL include (R-012).
R012_TLF_PROGRAMS = {
    "l-lb-liver.sas",
    "t-ae-aesi-overall-saf.sas",
    "t-ae-overall-saf.sas",
    "t-ae-teae-soc-pt.sas",
    "t-ae-teae-wrstgr-saf.sas",
    "t-ae-teae-wrstgr-saf2.sas",
    "t-aesi-teae-wrstgr-saf.sas",
    "t-dm-fas.sas",
    "t-ds-dispo-scrn.sas",
    "t-ex-saf.sas",
    "t-lb-lc-saf.sas",
    "t-pac-fas.sas",
    "t-pchad-nsclc-fas.sas",
    "t-pchmrcls-fas.sas",
    "t-pchsq-nsclc-fas.sas",
    "t-pchss-fas.sas",
    "t-pchuc-fas.sas",
}

# List the programs whose bare %util_getdata calls get an ADaM libref (R-013).
R013_PROGRAMS = {
    "u900addv.sas",
    "u900adef.sas",
    "u900adis.sas",
    "u900admh.sas",
    "u900adpc.sas",
    "u900adrs.sas",
    "l900cv01.sas",
    "l900ds05.sas",
    "l900ex01.sas",
    "l900ex02.sas",
    "l900is01.sas",
}

# List the ADaM programs that receive the PADAM and MTRIM statements (R-014, R-015).
R014_R015_ADAM_PROGRAMS = {
    "adae.sas",
    "adbase.sas",
    "adcm.sas",
    "adex.sas",
    "adexsum.sas",
    "adlb.sas",
    "adpr.sas",
    "adsl.sas",
}

# List the ADaM programs whose XPT export is rebuilt (R-016).
R016_REBUILT_PROGRAMS = {
    "adae.sas",
    "adbase.sas",
    "adcm.sas",
    "adex.sas",
    "adexsum.sas",
    "adlb.sas",
    "adsl.sas",
}

# List the 301 ADaM programs whose workbook inputs are relocated (R-017).
R017_301_ADAM_PROGRAMS = {"u900adcm.sas", "u900adsl.sas"}

# Map each program to the XPT outputs that R-018 disables.
R018_OUTPUTS = {
    "t900dm.sas": {"dm", "suppdm"},
    "t900ds.sas": {"ds", "suppds"},
    "t900ie.sas": {"ie", "suppie"},
    "t900lb.sas": {"lb", "supplb"},
}

# List the programs whose rescreen import is replaced (R-019).
R019_PROGRAMS = {
    "t900dm.sas",
    "t900ds.sas",
    "t900ie.sas",
    "t900lb.sas",
    "t900mb.sas",
    "t900se.sas",
    "t900sv.sas",
}

# L-032 is a linked manual-logic finding associated with the same seven
# RESCREEN programs as R-019.  Keep it separate from R-019 so the report
# distinguishes source redirection from the higher-risk identifier/type logic.
LINKED_LOGIC = {
    "R-019": ("L-032",),
    "R-025": ("L-034",),
    # R-031 deliberately excludes t900rs.sas from the Vendorimaginga reroute.
    # The paired SCE example instead disables two external-source calls there;
    # keep that high-risk study-specific behavior visible as L-035.
    "R-031": ("L-035",),
}

# List the ADaM programs whose spec block is commented out (R-020).
R020_PROGRAMS = {
    "adae.sas",
    "adbase.sas",
    "adcm.sas",
    "adlb.sas",
    "adpr.sas",
    "adsl.sas",
}

# Map each program to the call, dataset, and flag that R-021 normalizes.
R021_CALLS = {
    "t900dm.sas": ("util_fetchdata", "sv", False),
    "t900ec.sas": ("util_fetchdata", "dm", False),
    "t900ex.sas": ("util_getdata", "ec", False),
    "t900pr.sas": ("util_getdata", "dm", True),
    "t900qs.sas": ("util_fetchdata", "dm", False),
    "t900se.sas": ("util_getdata", "ta", False),
}

# R-022 through R-026 are contextual rules derived from the paired 301 CDR/SCE
# sample programs. Keep filename scopes explicit because many comparable calls
# in the consolidated rule book intentionally remain unchanged.
R022_PROGRAMS = {
    "u900addv.sas", "t900mb.sas", "t900mh.sas", "t900pr.sas", "t900rs.sas",
}
R023_PROGRAMS = {"t900pc.sas", "t900is.sas", "t900sv.sas"}
R024_QC_DOMAINS = {
    "t900ae.sas": "ae", "t900ie.sas": "ie", "t900lb.sas": "lb",
}
R025_PROGRAMS = {"t900dm.sas", "t900lb.sas", "t900sv.sas"}
R026_DIRECT_MEMBERS = {
    "u900adae.sas": {"adae"},
    "l900ae03.sas": {"adae", "adsl"},
}

# R-027 through R-031 are also tightly scoped to the paired CDR/SCE evidence.
R027_PROGRAMS = {"t900dm.sas", "t900se.sas"}
R028_PROGRAMS = {"t900oe.sas": "oe", "t900sv.sas": "sv"}
R031_IMAGING_DOMAINS = {
    "t900co.sas": {"co"},
    "t900sv.sas": {"rs", "tr", "tu"},
}

# R-032 and R-033 are the final two consolidated rules.  The ILD mapping is
# program-specific in the paired EXAMPLE003 SDTM evidence, while the VendorLabB mapping is
# study-wide but only demonstrated in these two programs.
R032_ILD_DATASETS = {
    "t900ae.sas": "Vendorimaginga_ild",
    "t900dd.sas": "Vendorimagingb_ild",
}
R033_PROGRAMS = {"t900lb.sas", "t900sv.sas"}


# ---------------------------------------------------------------------------
# Reading the rule book
# ---------------------------------------------------------------------------

#: Header aliases, kept deliberately in step with js/mig-rules.js. A workbook
#: that opens in the browser must apply the same here.
ALIASES = {
    "id": ["globalruleid", "ruleid", "id", "rule", "no", "seq"],
    "name": ["shorttitle", "rulename", "name", "title"],
    "category": ["category", "group", "type", "class", "area"],
    "desc": ["description", "desc", "comment", "note", "rationale"],
    "before": ["beforepatternvariants", "beforepattern", "before", "find",
               "match", "pattern", "search", "old"],
    "after": ["afterpatternvariants", "afterpattern", "after", "replace",
              "replacement", "to", "new", "fix"],
    "conditions": ["conditions", "condition", "when", "applieswhen"],
    "automatability": ["automatability", "automation", "auto"],
    "risk": ["riskifwrong", "severity", "risk", "level", "priority"],
    "exceptions": ["exceptions", "exception"],
}


# Reduce a header or alias to lowercase letters and digits.
def norm(text) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


# Hold one rule-book row with its parsed columns.
@dataclass
class Rule:
    id: str
    name: str = ""
    category: str = ""
    description: str = ""
    before: str = ""
    after: str = ""
    conditions: str = ""
    automatability: str = ""
    risk: str = ""
    exceptions: str = ""
    row: int = 0

    @property
    def implemented(self) -> bool:
        return self.id in IMPLEMENTED


def find_header_row(rows: list) -> int:
    """Score the first rows by how many headers we recognise.

    A consolidated rule book opens with a title and a note about how the IDs
    are scoped, so the header is not row 1. A title line scores zero and a real
    header row scores most of its width, which makes the gap wide enough that
    this does not need to be cleverer than it is.
    """
    best, best_score, best_width = 0, 0, 0
    for i, row in enumerate(rows[:12]):
        cells = [norm(c) for c in row]
        score = sum(1 for aliases in ALIASES.values()
                    if any(c in aliases for c in cells))
        width = sum(1 for c in row if c not in (None, ""))
        if score > best_score or (score == best_score and score and width > best_width):
            best, best_score, best_width = i, score, width
    return best


# Read the rule-book sheet into Rule records.
def load_rules(path: Path) -> list[Rule]:
    # Open the Rules sheet, falling back to the first sheet.
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = book["Rules"] if "Rules" in book.sheetnames else book.worksheets[0]
    rows = [list(r) for r in sheet.iter_rows(values_only=True)]
    book.close()

    if not rows:
        return []

    # Locate the header row and map each field to its column.
    head_at = find_header_row(rows)
    headers = [norm(c) for c in rows[head_at]]

    index = {}
    for field_name, aliases in ALIASES.items():
        for i, header in enumerate(headers):
            if header in aliases:
                index[field_name] = i
                break

    # Return a trimmed cell value for a field, or an empty string.
    def cell(row, key) -> str:
        i = index.get(key)
        if i is None or i >= len(row) or row[i] is None:
            return ""
        return str(row[i]).strip()

    # Build a Rule for every non-empty row that has an ID.
    rules = []
    for offset, row in enumerate(rows[head_at + 1:]):
        if not any(c not in (None, "") for c in row):
            continue
        rule_id = cell(row, "id")
        if not rule_id:
            continue
        rules.append(Rule(
            id=rule_id,
            name=cell(row, "name"),
            category=cell(row, "category"),
            description=cell(row, "desc"),
            before=cell(row, "before"),
            after=cell(row, "after"),
            conditions=cell(row, "conditions"),
            automatability=cell(row, "automatability"),
            risk=cell(row, "risk"),
            exceptions=cell(row, "exceptions"),
            row=head_at + 2 + offset,
        ))
    return rules


# ---------------------------------------------------------------------------
# Knowing what is code and what is not
# ---------------------------------------------------------------------------

class SasText:
    """A SAS program, with the spans that are not executable code marked.

    Every rule here needs the same thing: do not fire inside a comment. Without
    it, the second run of R-003 turns `/*%init;*/` into `/*/*%init;*/*/`, and
    R-005 matches the commented copy of the legacy include that the migration
    deliberately leaves behind as a record.

    Two comment forms, both of which SAS actually uses:

      /* ... */   block comments, which do not nest in SAS
      * ... ;     a statement comment: a statement whose first token is `*`,
                  running to the next semicolon

    Quoted strings are marked too, so a path or a message containing `/*` does
    not open a comment that swallows the rest of the file.

    This is a scanner, not a parser. It gets macro-quoting corner cases wrong in
    principle -- %str('), and a `*` that is multiplication at the start of a
    continued line -- and in exchange it is short enough to be read and checked.
    Every fixer here works line-by-line on top of it, where those cases do not
    arise.
    """

    # Scan once to mark the comment and string spans.
    def __init__(self, text: str):
        self.text = text
        self._inactive = self._scan(text)

    # Scan the text for block comments, quoted strings, and statement comments.
    @staticmethod
    def _scan(text: str) -> list[tuple[int, int]]:
        spans: list[tuple[int, int]] = []
        i, n = 0, len(text)
        at_statement_start = True

        while i < n:
            ch = text[i]

            # Mark a block comment through its closing marker.
            if ch == "/" and i + 1 < n and text[i + 1] == "*":
                end = text.find("*/", i + 2)
                end = n if end == -1 else end + 2
                spans.append((i, end))
                i = end
                at_statement_start = False
                continue

            # Mark a quoted string, treating a doubled quote as an escape.
            if ch in "\"'":
                quote = ch
                j = i + 1
                while j < n:
                    if text[j] == quote:
                        # A doubled quote inside a string is an escaped quote.
                        if j + 1 < n and text[j + 1] == quote:
                            j += 2
                            continue
                        j += 1
                        break
                    j += 1
                spans.append((i, min(j, n)))
                i = min(j, n)
                at_statement_start = False
                continue

            # Mark a statement comment from a leading asterisk to the next semicolon.
            if ch == "*" and at_statement_start:
                end = text.find(";", i)
                end = n if end == -1 else end + 1
                spans.append((i, end))
                i = end
                at_statement_start = True
                continue

            # Track whether the next token starts a statement.
            if ch == ";":
                at_statement_start = True
            elif not ch.isspace():
                at_statement_start = False
            i += 1

        return spans

    def is_active(self, position: int) -> bool:
        """True when this offset is executable code."""
        return not any(start <= position < end for start, end in self._inactive)

    def active_spans(self, pattern: re.Pattern) -> list[re.Match]:
        """Every match of `pattern` that starts in executable code."""
        return [m for m in pattern.finditer(self.text) if self.is_active(m.start())]

    def comment_spans(self) -> list[tuple[int, int]]:
        """Comment spans only, excluding quoted strings."""
        return [(s, e) for s, e in self._inactive if self.text[s] in "/*"]


def is_commented_line(line: str) -> bool:
    """True for a line that is wholly a comment -- the shape these rules write."""
    stripped = line.strip()
    return (stripped.startswith("/*") and stripped.endswith("*/")) or \
           (stripped.startswith("*") and stripped.endswith(";"))


def comment_out(line: str) -> str:
    """Wrap one line in a block comment, preserving its indentation.

    The trailing part of the line after the statement is kept inside the
    comment rather than dropped: a trailing `/* note */` is part of what the
    programmer wrote, and losing it on migration would be a silent edit.
    """
    indent = line[:len(line) - len(line.lstrip())]
    body = line.strip()
    return f"{indent}/*{body}*/"


# ---------------------------------------------------------------------------
# Macro-call parsing, for the two rules that rewrite one argument
# ---------------------------------------------------------------------------

# Record the offsets of one macro call.
@dataclass
class MacroCall:
    name: str
    start: int          # offset of the leading %
    end: int            # offset just past the closing paren
    args_start: int     # offset just past the opening paren
    args_end: int       # offset of the closing paren

    # Return the slice that covers the call's arguments.
    @property
    def args_text_slice(self) -> slice:
        return slice(self.args_start, self.args_end)


def find_macro_calls(sas: SasText, macro: str) -> list[MacroCall]:
    """Locate every executable `%macro(...)` call, with balanced parentheses.

    Balance matters: an argument can itself contain a parenthesised expression,
    and taking the first `)` would cut the call in half and corrupt whatever was
    written after it.
    """
    calls = []
    # Match the macro name and its opening parenthesis.
    opener = re.compile(r"%" + re.escape(macro) + r"\s*\(", re.IGNORECASE)

    # Scan to the matching close parenthesis, skipping strings and comments.
    for match in sas.active_spans(opener):
        depth = 1
        i = match.end()
        n = len(sas.text)
        while i < n and depth:
            ch = sas.text[i]
            if not sas.is_active(i):        # skip strings and comments
                i += 1
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        if depth:
            continue                        # unterminated call; leave it alone
        calls.append(MacroCall(name=macro, start=match.start(), end=i + 1,
                               args_start=match.end(), args_end=i))
    return calls


def split_args(text: str) -> list[str]:
    """Split a macro argument list on top-level commas."""
    args, depth, current = [], 0, []
    in_quote = ""
    # Split on commas that sit outside quotes and parentheses.
    for ch in text:
        if in_quote:
            current.append(ch)
            if ch == in_quote:
                in_quote = ""
            continue
        if ch in "\"'":
            in_quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            args.append("".join(current))
            current = []
            continue
        current.append(ch)
    args.append("".join(current))
    return args


def adam_members(argument: str) -> tuple[list[str], list[str]]:
    """Split a first `%util_getdata` argument into ADaM and non-ADaM members.

    The rule book's condition is the important part: only ADaM members should
    move from DATA to ADaM. A call can name several members in one positional
    argument, as in `ss adsl`; moving the whole call would route the SDTM member
    incorrectly, so mixed calls are split and each side keeps the same options.
    """
    leading = re.match(r"\s*", argument).group(0)
    trailing = re.search(r"\s*$", argument).group(0)
    body = argument.strip()
    if not body:
        return [], []

    members = body.split()
    adam, other = [], []
    # Treat members whose name starts with ad as ADaM.
    for member in members:
        name = member.split(".", 1)[-1].lstrip("&").lower()
        if name.startswith("ad"):
            adam.append(member)
        else:
            other.append(member)

    # Rebuild an argument from members, keeping its original spacing.
    def wrap(values: list[str]) -> list[str]:
        if not values:
            return []
        return [leading + " ".join(values) + trailing]

    return wrap(adam), wrap(other)


# Replace libref=data with the target libref in an argument list.
def replace_libref_arg(args: list[str], value: str) -> list[str]:
    out = []
    for arg in args:
        match = re.match(r"(\s*libref\s*=\s*)(data)(\s*)$", arg, re.IGNORECASE)
        if match and match.group(2).lower() == "data":
            out.append(f"{match.group(1)}{value}{match.group(3)}")
        else:
            out.append(arg)
    return out


# ---------------------------------------------------------------------------
# The context a fix runs in
# ---------------------------------------------------------------------------

# Carry the program name and parameter overrides for one fix.
@dataclass
class Context:
    filename: str
    params: dict = field(default_factory=dict)

    # Return an override, then the default, for a parameter.
    def param(self, name: str) -> str:
        return self.params.get(name, DEFAULT_PARAMS.get(name, ""))


@dataclass
class Result:
    """What one rule did to one program."""
    rule_id: str
    changes: int = 0
    skipped: str = ""
    notes: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Contextual fixes
# ---------------------------------------------------------------------------

# Detect the synthetic study markers in the file name or text.
def has_synthetic_signal(text: str, filename: str) -> bool:
    haystack = f"{filename}\n{text}"
    return bool(re.search(r"EXAMPLE002|20260228_SYNTH", haystack, re.IGNORECASE))


# Detect the 301 study markers in the file name or text.
def has_301_signal(text: str, filename: str) -> bool:
    haystack = f"{filename}\n{text}"
    return bool(re.search(r"EXAMPLE002-PROT|[ult]900", haystack,
                          re.IGNORECASE))

#: Where a startup insertion goes. The startup block of these programs is a run
#: of options / global-macro / include / libname statements near the top.
STARTUP_STATEMENT = re.compile(
    r"^\s*(?:"
    r"options\b|"
    r"%init\b|%setupanl\b|"
    r"%include\b|"
    r"libname\b|filename\b|"
    r"%let\b"
    r")", re.IGNORECASE)

#: Where the preamble ends and the program proper begins. `proc datasets ...
#: kill` is deliberately excluded: clearing WORK is housekeeping that these
#: programs do above their startup block, not the start of the analysis.
STOP_STATEMENT = re.compile(
    r"^\s*(?:%macro\b|data\b|proc\s+(?!datasets\b)\w+)", re.IGNORECASE)


def line_probes(text: str) -> list:
    """For each line, the code it contributes -- or None if it contributes none.

    Three cases, and getting them apart is the whole job:

      * a line with executable code returns that code, with any trailing
        comment stripped off
      * a line that is entirely one comment returns what is inside it, because
        a commented-out startup statement still marks the startup block -- that
        is exactly what R-003 and R-005 leave behind
      * a line inside a multi-line comment returns None, so a program's header
        block does not read as "the program has begun"

    The last case is why this cannot be done on line shape alone: the middle
    lines of a banner comment look like ordinary text.
    """
    sas = SasText(text)
    probes = []
    offset = 0

    for line in text.split("\n"):
        start, end = offset, offset + len(line)
        offset = end + 1

        active = "".join(ch for i, ch in enumerate(line, start)
                         if sas.is_active(i))
        if active.strip():
            probes.append(active.strip())
            continue

        stripped = line.strip()
        if stripped.startswith("/*") and stripped.endswith("*/") and len(stripped) > 3:
            probes.append(stripped[2:-2].strip())
        elif stripped.startswith("*") and stripped.endswith(";"):
            probes.append(stripped[1:].strip())
        else:
            probes.append(None)

    return probes


def startup_insert_at(text: str) -> int:
    """The line index to insert a startup statement at.

    After the last startup statement of the opening block. Only the opening
    block counts: these programs have startup-shaped statements further down
    too -- a `libname trans xport` before the transport copy, a `%let tlfkey`
    before the spec call -- and scanning the whole file for the last of them
    would put the insert at the bottom, after everything that depends on it.

    So the scan stops at the first statement that starts the program proper.
    """
    lines = text.split("\n")
    probes = line_probes(text)
    last = -1
    stopped_at = len(lines)

    # Track the last startup statement until the program proper begins.
    for i, probe in enumerate(probes):
        if not probe:
            continue
        if STARTUP_STATEMENT.match(probe):
            last = i
            continue
        if STOP_STATEMENT.match(probe):
            stopped_at = i
            break

    # Insert after the last startup statement, else at the stop point.
    if last >= 0:
        return last + 1
    return stopped_at


def fix_r003_init(text: str, ctx: Context) -> tuple[str, Result]:
    """R-003 -- comment out the standalone %init; startup call.

    Conditions: "Standalone startup statement only." So this is a line-level
    fix, not a text substitution: `%init;` appearing as an argument or inside a
    larger statement is not what the rule is about.
    """
    result = Result("R-003")
    # Skip programs the rule book excludes by name.
    if ctx.filename.lower() in EXCLUSIONS["R-003"]:
        result.skipped = "excluded by the rule's Exceptions column"
        return text, result
    # Skip programs outside this rule's evidence batch.
    if not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the synthetic evidence batches for this rule"
        return text, result

    lines = text.split("\n")
    standalone = re.compile(r"^\s*%init\s*;\s*$", re.IGNORECASE)

    # Comment out each active standalone %init; line.
    for i, line in enumerate(lines):
        if is_commented_line(line):
            continue                          # already done, or deliberately off
        if standalone.match(line):
            lines[i] = comment_out(line)
            result.changes += 1

    return "\n".join(lines), result


def fix_r005_sdtm_autoexec(text: str, ctx: Context) -> tuple[str, Result]:
    """R-005 -- replace the legacy SDTM autoexec include with the SCE one.

    The workbook's After column shows only the new include, but the paired
    programs show what the migration actually did: the legacy include is
    commented out and the SCE include added under it. The Exceptions column
    agrees -- "18 transformed programs also retain a non-executable commented
    copy of the old include as noise." Keeping the old line is the honest
    reading, and it leaves a record of what the program used to load.

    Variant 1 of this rule is an insertion with no legacy line to replace; it is
    handled by falling through to a startup insertion when nothing matched.
    """
    result = Result("R-005")
    # Skip programs the rule book excludes by name.
    if ctx.filename.lower() in EXCLUSIONS["R-005"]:
        result.skipped = "excluded by the rule's Exceptions column"
        return text, result
    # Skip programs outside this rule's evidence batch.
    if not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the synthetic evidence batch for this rule"
        return text, result
    # Leave TLF reports and listings to R-009.
    if is_tlf_report_listing(text, ctx.filename):
        result.skipped = "TLF reports/listings use R-009 instead"
        return text, result
    # Skip the SDTM autoexec itself.
    if file_key(ctx.filename) == "autoexec.sas" and \
            re.search(r'__SDTMLIB|libname\s+(?:source|raw)\s+["\']&targetData\.?\\Clinical',
                      text, re.IGNORECASE):
        result.skipped = "the SDTM autoexec does not include itself"
        return text, result

    # Skip programs that already have the SCE include.
    new_include = ctx.param("TARGET_SDTM_AUTOEXEC")
    if new_include in text:
        result.notes.append("SCE SDTM autoexec already present")
        return text, result

    # Match the legacy SDTM autoexec include.
    legacy = re.compile(
        r"^\s*%include\s+[\"'][^\"']*programs[/\\]sdtm[/\\][^\"']*autoexec\.sas[\"']\s*;",
        re.IGNORECASE)

    lines = text.split("\n")
    out: list[str] = []
    replaced = False

    # Comment out each legacy include and add the SCE include beneath it.
    for line in lines:
        if not is_commented_line(line) and legacy.match(line):
            indent = line[:len(line) - len(line.lstrip())]
            out.append(comment_out(line))
            out.append(indent + new_include)
            replaced = True
            result.changes += 1
            continue
        out.append(line)

    if replaced:
        return "\n".join(out), result

    # Variant 1: no legacy include to replace. Insert into the startup block.
    at = startup_insert_at(text)
    indent = leading_indent(lines, at)
    lines.insert(at, indent + new_include)
    result.changes += 1
    result.notes.append(f"inserted at line {at + 1} (variant 1, no legacy include)")
    return "\n".join(lines), result


def fix_r001_macro_autoexec(text: str, ctx: Context) -> tuple[str, Result]:
    """R-001 -- add the SCE macro autoexec include to program startup.

    An insertion rule. Its Before column reads "[no corresponding executable
    line]", which is not something to match on -- what makes it applicable is
    the anchor in its Conditions: "Insert in the startup/bootstrap section
    before migration-dependent macro calls. | Insert once in program startup."

    "Insert once" is the whole safety story: the rule is idempotent because it
    checks for its own line first, which is also what makes it safe to run over
    a folder that has already been migrated.
    """
    result = Result("R-001")
    include = ctx.param("TARGET_MACRO_AUTOEXEC")

    # Skip programs outside this rule's evidence batch.
    if not has_301_signal(text, ctx.filename):
        result.skipped = "outside the 301 evidence batch for this rule"
        return text, result
    # Skip programs that already have the include.
    if include in text:
        result.notes.append("already present")
        return text, result

    # Insert the include into the startup block.
    lines = text.split("\n")
    at = startup_insert_at(text)
    indent = leading_indent(lines, at)
    lines.insert(at, indent + include)
    result.changes += 1
    result.notes.append(f"inserted at line {at + 1}")
    return "\n".join(lines), result


def leading_indent(lines: list[str], at: int) -> str:
    """Match the indentation of the statement an insertion follows."""
    for i in range(at - 1, -1, -1):
        if lines[i].strip():
            return lines[i][:len(lines[i]) - len(lines[i].lstrip())]
    return ""


# Return the lowercase base file name.
def file_key(filename: str) -> str:
    return Path(str(filename or "")).name.lower()


# Return the first active line that matches a pattern, or -1.
def active_line_index(text: str, pattern: re.Pattern) -> int:
    sas = SasText(text)
    offset = 0
    for i, line in enumerate(text.split("\n")):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if first and not is_commented_line(line) and \
                sas.is_active(start + first.start()) and pattern.search(line):
            return i
    return -1


# Test whether an active line matches a pattern.
def has_active_line(text: str, pattern: re.Pattern) -> bool:
    return active_line_index(text, pattern) >= 0


# Test whether an active line equals a statement exactly.
def has_active_exact_line(text: str, exact: str) -> bool:
    return has_active_line(text, re.compile(r"^\s*" + re.escape(exact) + r"\s*$",
                                            re.IGNORECASE))


# Decide whether a program is a TLF report or listing.
def is_tlf_report_listing(text: str, filename: str) -> bool:
    name = file_key(filename)
    if name in {"autoexec.sas", "chk_log.sas"}:
        return False
    return bool(re.match(r"(?:l-|t-)", name, re.IGNORECASE)) or \
        bool(re.search(r"programs[/\\]tlf[/\\]", text, re.IGNORECASE)) or \
        has_active_line(text, re.compile(r"%mheadfoot\b", re.IGNORECASE))


def fix_r002_xudata_libref(text: str, ctx: Context) -> tuple[str, Result]:
    """R-002 -- point %util_getdata reads at the ADaM libref instead of DATA.

    Conditions: "preserve the remainder of the call." So this rewrites the one
    argument and nothing else. The workbook's After column spells out the whole
    call, and applying that literally would reformat every call site the rule
    touches -- normalising spacing the rule was never about, and losing options
    the pattern's "..." was standing in for.

    Only `libref=data` and `libref=DATA` are changed. A call with no libref, or
    with some other libref, is a different situation and is left alone.
    """
    result = Result("R-002")
    target = ctx.param("ADAM_LIBREF")
    # Collect call edits and apply them from the end so offsets stay valid.
    edits: list[tuple[int, int, str]] = []
    # Skip programs outside this rule's evidence batch.
    if not has_301_signal(text, ctx.filename):
        result.skipped = "outside the 301 evidence batch for this rule"
        return text, result

    # Find each util_getdata call that uses libref=data.
    sas = SasText(text)
    for call in find_macro_calls(sas, "util_getdata"):
        args_text = text[call.args_text_slice]
        args = split_args(args_text)
        if len(args) < 2:
            continue
        if not any(re.match(r"\s*libref\s*=\s*data\s*$", a, re.IGNORECASE)
                   for a in args):
            continue

        # Split mixed calls so only the ADaM members move.
        adam, other = adam_members(args[0])
        if not adam:
            continue

        # Emit a separate call for the non-ADaM members.
        if other:
            non_adam_args = [other[0]] + args[1:]
            adam_args = [adam[0]] + replace_libref_arg(args[1:], target)
            replacement = "%util_getdata(" + ",".join(non_adam_args) + ");\n" + \
                          "%util_getdata(" + ",".join(adam_args) + ")"
            edits.append((call.start, call.end, replacement))
        else:
            # Rewrite only the libref argument of an all-ADaM call.
            rewritten = [args[0]] + replace_libref_arg(args[1:], target)
            edits.append((call.args_start, call.args_end, ",".join(rewritten)))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
        result.changes += 1

    return text, result


def fix_r004_xucvtds_libref(text: str, ctx: Context) -> tuple[str, Result]:
    """R-004 -- add the explicit ADaM libref to %util_cvtds output calls.

    Conditions: "preserve spacing/options and review punctuation exceptions."
    The Exceptions column is specific about those: some call sites omit the
    terminal semicolon and one has a doubled semicolon. Rewriting the call as
    text would have to reproduce each of those; inserting one argument does not
    have to care, because the punctuation is outside the parentheses.

    A call that already names a libref is left alone, which is what makes this
    safe to run twice.
    """
    result = Result("R-004")
    target = ctx.param("ADAM_LIBREF")
    # Collect call edits and apply them from the end so offsets stay valid.
    edits: list[tuple[int, int, str]] = []
    # Skip programs outside this rule's evidence batch.
    if not has_301_signal(text, ctx.filename):
        result.skipped = "outside the 301 evidence batch for this rule"
        return text, result

    # Add a libref after the domain in each util_cvtds call that lacks one.
    sas = SasText(text)
    for call in find_macro_calls(sas, "util_cvtds"):
        args_text = text[call.args_text_slice]
        args = split_args(args_text)

        if any(re.match(r"\s*libref\s*=", a, re.IGNORECASE) for a in args):
            continue                          # already routed
        if not args or not args[0].strip():
            continue                          # %util_cvtds() -- nothing to route

        # After the domain, which is the first positional argument. That is
        # where the migrated programs put it, and it keeps the option order
        # the rule's After column shows.
        args.insert(1, f"libref={target}")
        edits.append((call.args_start, call.args_end, ",".join(args)))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
        result.changes += 1

    return text, result


def fix_r006_util_resize_xpt_resize(text: str, ctx: Context) -> tuple[str, Result]:
    """R-006 -- comment out only validated UTIL_RESIZE_XPT resize calls."""
    result = Result("R-006")
    # Skip programs outside this rule's evidence batch.
    if not has_301_signal(text, ctx.filename):
        result.skipped = "outside the 301 evidence batch for this rule"
        return text, result

    # Scan each active line for resize calls on the disabled domains.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    pattern = re.compile(r"^(\s*)%util_resize_xpt\s*\(\s*([^,\)\s]+)(.*)$",
                         re.IGNORECASE)

    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
            continue
        match = pattern.match(line)
        if not match:
            continue
        domain = match.group(2).lower()
        if domain not in R006_DISABLED_DOMAINS:
            continue
        # Comment out the call by prefixing an asterisk.
        lines[i] = match.group(1) + "*" + line[len(match.group(1)):]
        result.changes += 1

    return "\n".join(lines), result


def fix_r007_setupanl(text: str, ctx: Context) -> tuple[str, Result]:
    """R-007 -- comment out standalone %setupanl; for validated synthetic programs."""
    result = Result("R-007")
    # Skip programs the rule book excludes by name.
    if file_key(ctx.filename) in EXCLUSIONS["R-007"]:
        result.skipped = "excluded by the rule's Exceptions column"
        return text, result
    # Skip programs outside this rule's evidence batch.
    if not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the synthetic evidence batch for this rule"
        return text, result

    # Comment out each active standalone %setupanl; line.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    standalone = re.compile(r"^\s*%setupanl\s*;\s*$", re.IGNORECASE)
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
            continue
        if standalone.match(line):
            lines[i] = comment_out(line)
            result.changes += 1
    return "\n".join(lines), result


# Choose the MA_Testing or the standard TLF autoexec include.
def tlf_autoexec_include(ctx: Context) -> str:
    return ctx.param("TARGET_TLF_MA_AUTOEXEC") \
        if file_key(ctx.filename) in R009_MA_TESTING else ctx.param("TARGET_TLF_AUTOEXEC")


# Check whether either TLF autoexec include is already active.
def any_tlf_autoexec_present(text: str, ctx: Context) -> bool:
    return has_active_exact_line(text, ctx.param("TARGET_TLF_AUTOEXEC")) or \
        has_active_exact_line(text, ctx.param("TARGET_TLF_MA_AUTOEXEC"))


def fix_r009_tlf_autoexec(text: str, ctx: Context) -> tuple[str, Result]:
    """R-009 -- insert the correct SCE TLF autoexec include."""
    result = Result("R-009")
    # Skip programs outside the TLF report and listing context.
    if not has_synthetic_signal(text, ctx.filename) or not is_tlf_report_listing(text, ctx.filename):
        result.skipped = "outside the validated synthetic TLF report/listing context"
        return text, result
    # Skip programs that already have an SCE TLF autoexec.
    if any_tlf_autoexec_present(text, ctx):
        result.notes.append("SCE TLF autoexec already present")
        return text, result

    include = tlf_autoexec_include(ctx)
    lines = text.split("\n")
    # Insert after the legacy TLF include, or in the startup block.
    legacy = re.compile(
        r"%include\s+[\"'][^\"']*programs[/\\]tlf[/\\][^\"']*autoexec\.sas[\"']\s*;",
        re.IGNORECASE)
    at = active_line_index(text, legacy)
    if at < 0:
        at = startup_insert_at(text) - 1
    at = max(0, at + 1)
    lines.insert(at, leading_indent(lines, at) + include)
    result.changes += 1
    return "\n".join(lines), result


def fix_r008_mheadfoot(text: str, ctx: Context) -> tuple[str, Result]:
    """R-008 -- include the MHEADFOOT macro source for TLF reports/listings."""
    result = Result("R-008")
    # Skip programs outside the TLF report and listing context.
    if not has_synthetic_signal(text, ctx.filename) or not is_tlf_report_listing(text, ctx.filename):
        result.skipped = "outside the validated synthetic TLF report/listing context"
        return text, result
    # Skip programs that never call %mheadfoot.
    if not has_active_line(text, re.compile(r"%mheadfoot\b", re.IGNORECASE)):
        result.skipped = "no active %mheadfoot use"
        return text, result

    include = ctx.param("TARGET_MHEADFOOT")
    # Skip programs that already have the include.
    if has_active_exact_line(text, include):
        result.notes.append("MHEADFOOT include already present")
        return text, result

    lines = text.split("\n")
    # Insert after the TLF autoexec include, or in the startup block.
    tlf_include = re.compile(
        r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\TLF\\(?:MA_Testing\\)?autoexec\.sas[\"']\s*;",
        re.IGNORECASE)
    at = active_line_index(text, tlf_include)
    if at < 0:
        at = startup_insert_at(text) - 1
    at = max(0, at + 1)
    lines.insert(at, leading_indent(lines, at) + include)
    result.changes += 1
    return "\n".join(lines), result


def fix_r011_legacy_tlf_autoexec(text: str, ctx: Context) -> tuple[str, Result]:
    """R-011 -- retain the legacy TLF autoexec include as a SAS comment."""
    result = Result("R-011")
    # Skip programs the rule book excludes by name.
    if file_key(ctx.filename) in EXCLUSIONS["R-011"]:
        result.skipped = "excluded by the rule's Exceptions column"
        return text, result
    # Skip programs outside the TLF report and listing context.
    if not has_synthetic_signal(text, ctx.filename) or \
            not is_tlf_report_listing(text, ctx.filename):
        result.skipped = "outside the validated synthetic TLF report/listing context"
        return text, result

    # Comment out each active legacy TLF autoexec include.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    legacy = re.compile(
        r"^\s*%include\s+[\"']\.\./\.\./\.\./\.\./programs/tlf/"
        r"20260228_SYNTH/primary/autoexec\.sas[\"']\s*;\s*$",
        re.IGNORECASE)
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if first and not is_commented_line(line) and \
                sas.is_active(start + first.start()) and legacy.match(line):
            lines[i] = comment_out(line)
            result.changes += 1
    return "\n".join(lines), result


def fix_r012_setupanl_source(text: str, ctx: Context) -> tuple[str, Result]:
    """R-012 -- include SETUPANL only in the workbook's validated programs."""
    result = Result("R-012")
    name = file_key(ctx.filename)
    include = ctx.param("TARGET_SETUPANL")
    # Skip programs outside the validated R-012 list.
    if not has_synthetic_signal(text, ctx.filename) or \
            (name != "adpr.sas" and name not in R012_TLF_PROGRAMS):
        result.skipped = "outside the validated R-012 filename list"
        return text, result
    # Skip programs that already have the include.
    if has_active_exact_line(text, include):
        result.notes.append("SETUPANL include already present")
        return text, result

    # For adpr.sas, replace the standalone %setupanl; call with the include.
    if name == "adpr.sas":
        sas = SasText(text)
        lines = text.split("\n")
        offset = 0
        standalone = re.compile(r"^\s*%setupanl\s*;\s*$", re.IGNORECASE)
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if first and not is_commented_line(line) and \
                    sas.is_active(start + first.start()) and standalone.match(line):
                indent = line[:len(line) - len(line.lstrip())]
                lines[i] = indent + include
                result.changes += 1
                return "\n".join(lines), result

    # Otherwise insert after the best anchor: mheadfoot, the TLF autoexec, the legacy include, or the startup block.
    lines = text.split("\n")
    at = -1
    if name == "t-lb-lc-saf.sas":
        at = active_line_index(text, re.compile(
            r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\Macros\\mheadfoot\.sas[\"']\s*;",
            re.IGNORECASE))
        if at >= 0:
            at += 1
    if at < 0:
        at = active_line_index(text, re.compile(
            r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\TLF\\"
            r"(?:MA_Testing\\)?autoexec\.sas[\"']\s*;", re.IGNORECASE))
    if at < 0:
        legacy = re.compile(
            r"%include\s+[\"'][^\"']*programs[/\\]tlf[/\\][^\"']*autoexec\.sas[\"']\s*;",
            re.IGNORECASE)
        at = next((i for i, line in enumerate(lines) if legacy.search(line)), -1)
        if at >= 0:
            at += 1
    if at < 0:
        at = startup_insert_at(text)
    lines.insert(at, leading_indent(lines, at) + include)
    result.changes += 1
    return "\n".join(lines), result


# R-010 (SDTM autoexec): repoint SDTM libnames to the target folders and add the external libnames.
def fix_r010_sdtm_autoexec(text: str, ctx: Context) -> tuple[str, Result]:
    result = Result("R-010")
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0

    # Rewrite each legacy libname and %let statement to its target path.
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
            continue
        indent = line[:len(line) - len(line.lstrip())]
        if re.match(r"\s*libname\s+source\s+[\"']/placeholder/cdrdata/EXAMPLE002/prod/data/edc/20260228_SYNTH[\"']\s*;",
                    line, re.IGNORECASE):
            lines[i] = indent + r'libname source "&targetData\Clinical";'
            result.changes += 1
        elif re.match(r"\s*libname\s+raw\s+[\"']/placeholder/cdrdata/EXAMPLE002/prod/data/edc/20260228_SYNTH[\"']\s*;",
                      line, re.IGNORECASE):
            lines[i] = indent + r'libname raw    "&targetData\Clinical";'
            result.changes += 1
        elif re.match(r"\s*libname\s+SDTM\s+[\"']\.\./\.\./\.\./\.\./data/sdtm/20260228_SYNTH/primary[\"']\s*;",
                      line, re.IGNORECASE):
            lines[i] = indent + r'libname SDTM   "&targetData\SDTM";'
            result.changes += 1
        elif re.match(r"\s*libname\s+prod\s+[\"']\.\./\.\./\.\./\.\./data/sdtm/20260228_SYNTH/primary[\"']\s*;",
                      line, re.IGNORECASE):
            lines[i] = indent + r'libname prod "&targetData\SDTM";'
            result.changes += 1
        elif re.match(r"\s*%let\s+__SDTMLIB\s*=\s*%STR\(\.\./\.\./\.\./\.\./data/sdtm/20260228_SYNTH/primary\)\s*;",
                      line, re.IGNORECASE):
            lines[i] = indent + r"%let __SDTMLIB = %STR(&targetData\SDTM);"
            result.changes += 1

    # Add the ext and dEXT libnames after the SDTM libname when missing.
    next_text = "\n".join(lines)
    has_ext = has_active_line(next_text, re.compile(
        r"^\s*libname\s+ext\s+[\"']&targetData\\External Data[\"']\s*;",
        re.IGNORECASE))
    has_dext = has_active_line(next_text, re.compile(
        r"^\s*libname\s+dEXT\s+[\"']&targetData\\External Data[\"']\s*;",
        re.IGNORECASE))
    if not has_ext or not has_dext:
        lines = next_text.split("\n")
        at = active_line_index(next_text, re.compile(
            r"^\s*libname\s+SDTM\s+[\"']&targetData\\SDTM[\"']\s*;",
            re.IGNORECASE))
        if at >= 0:
            indent = leading_indent(lines, at + 1)
            insert = []
            if not has_ext:
                insert.append(indent + r'libname ext    "&targetData\External Data";')
            if not has_dext:
                insert.append(indent + r'libname dEXT   "&targetData\External Data";')
            lines[at + 1:at + 1] = insert
            result.changes += len(insert)

    return "\n".join(lines), result


# R-010 (TLF autoexec): repoint the padam and raw libnames and add the sdtm libname.
def fix_r010_tlf_autoexec(text: str, ctx: Context) -> tuple[str, Result]:
    result = Result("R-010")
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    raw_at = -1
    padam_at = -1

    # Rewrite the padam and raw libnames and note where each sits.
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
            continue
        indent = line[:len(line) - len(line.lstrip())]
        if re.match(r"\s*libname\s+padam\s+[\"']\.\./\.\./\.\./\.\./data/adam/20260228_SYNTH/primary[\"']\s+inencoding\s*=\s*any\s*;",
                    line, re.IGNORECASE):
            padam_at = i
            lines[i] = indent + r'libname padam "&targetData.\ADaM" inencoding=any;'
            result.changes += 1
        elif re.match(r"\s*libname\s+raw\s+[\"']/placeholder/cdrdata/EXAMPLE002/prod/data/edc/20260228_SYNTH[\"']\s+inencoding\s*=\s*any\s*;",
                      line, re.IGNORECASE):
            raw_at = i
            lines[i] = indent + r'libname raw   "&targetData.\Clinical" inencoding=any;'
            result.changes += 1

    # Add the sdtm libname after raw or padam when missing.
    next_text = "\n".join(lines)
    if not has_active_line(next_text, re.compile(
        r"^\s*libname\s+sdtm\s+[\"']&targetData\.\\SDTM[\"']\s+inencoding\s*=\s*any\s*;",
        re.IGNORECASE)):
        at = raw_at + 1 if raw_at >= 0 else (padam_at + 1 if padam_at >= 0 else -1)
        if at >= 0:
            lines.insert(at, leading_indent(lines, at) +
                         r'libname sdtm  "&targetData.\SDTM" inencoding=any;')
            result.changes += 1
    return "\n".join(lines), result


# R-010 (301 SDTM programs): insert the library bootstrap block.
def fix_r010_301_sdtm(text: str, ctx: Context) -> tuple[str, Result]:
    result = Result("R-010")
    if not has_301_signal(text, ctx.filename) or \
            file_key(ctx.filename) not in R010_301_SDTM_PROGRAMS:
        result.skipped = "outside the validated EXAMPLE003 SDTM bootstrap file list"
        return text, result
    # Skip programs that already have the bootstrap.
    if r'libname rawdata "&targetData\Clinical";' in text and \
            r'libname prod "&targetData\SDTM";' in text:
        result.notes.append("EXAMPLE003 SDTM bootstrap already present")
        return text, result

    # Define the standard library bootstrap block.
    block = [
        r'libname source "&targetData\Clinical";',
        r'libname rawdata "&targetData\Clinical";',
        r'libname SDTM "&targetData\SDTM";',
        r'libname data "&targetData\SDTM";',
        "",
        r'libname ext "&targetData\External Data";',
        r'libname dEXT "&targetData\External Data";',
        "",
        r'libname pg "&targetStudy.\Dev\Programs\SDTM\validation";',
        r'libname val "&targetStudy.\Dev\Data\SDTM\validation";',
        r'libname prod "&targetData\SDTM";',
    ]
    # Insert the block after the macro autoexec include, or in the startup block.
    lines = text.split("\n")
    include = r'%include "&targetStudy.\Programs\Macros\autoexec.sas";'
    at = next((i for i, line in enumerate(lines) if line.strip() == include), -1)
    if at < 0:
        at = startup_insert_at(text) - 1
    at = max(0, at + 1)
    lines[at:at] = block
    result.changes += 1
    return "\n".join(lines), result


def fix_r010_bootstrap(text: str, ctx: Context) -> tuple[str, Result]:
    """R-010 -- build the SCE core library bootstrap in its validated contexts."""
    name = file_key(ctx.filename)
    # Route autoexec files to the TLF or SDTM variant by their legacy libnames.
    if name == "autoexec.sas" and has_synthetic_signal(text, ctx.filename):
        if re.search(r"libname\s+padam\s+[\"']\.\./\.\./\.\./\.\./data/adam/20260228_SYNTH/primary",
                     text, re.IGNORECASE):
            return fix_r010_tlf_autoexec(text, ctx)
        if re.search(r"__SDTMLIB|libname\s+SDTM\s+[\"']\.\./\.\./\.\./\.\./data/sdtm/20260228_SYNTH/primary",
                     text, re.IGNORECASE):
            return fix_r010_sdtm_autoexec(text, ctx)
    # Fall back to the 301 SDTM bootstrap.
    return fix_r010_301_sdtm(text, ctx)


def fix_r013_adam_xudata(text: str, ctx: Context) -> tuple[str, Result]:
    """R-013 -- add ADaM libref to bare UTIL_GETDATA calls in validated files."""
    result = Result("R-013")
    # Skip programs outside the validated R-013 list.
    if not has_301_signal(text, ctx.filename) or \
            file_key(ctx.filename) not in R013_PROGRAMS:
        result.skipped = "outside the validated R-013 filename list"
        return text, result

    target = ctx.param("ADAM_LIBREF")
    # Collect call edits and apply them from the end so offsets stay valid.
    edits: list[tuple[int, int, str]] = []
    sas = SasText(text)
    # Add the ADaM libref to calls that name only ADaM members and no libref.
    for call in find_macro_calls(sas, "util_getdata"):
        args = split_args(text[call.args_text_slice])
        if not args or any(re.match(r"\s*libref\s*=", arg, re.IGNORECASE)
                           for arg in args):
            continue
        adam, other = adam_members(args[0])
        if not adam or other:
            continue
        # Match the spacing style the file already uses.
        spacing = " " if file_key(ctx.filename).startswith("l900") or len(args) == 1 \
            else re.match(r"\s*", args[1]).group(0)
        args.insert(1, spacing + f"libref={target}")
        edits.append((call.args_start, call.args_end, ",".join(args)))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
        result.changes += 1
    return text, result


def fix_r015_mtrim(text: str, ctx: Context) -> tuple[str, Result]:
    """R-015 -- insert the MTRIM source include in eight synthetic ADaM programs."""
    result = Result("R-015")
    include = ctx.param("TARGET_MTRIM")
    # Skip programs outside the validated ADaM list.
    if not has_synthetic_signal(text, ctx.filename) or \
            file_key(ctx.filename) not in R014_R015_ADAM_PROGRAMS:
        result.skipped = "outside the validated synthetic ADaM filename list"
        return text, result
    # Skip programs that already have the include.
    if has_active_exact_line(text, include):
        result.notes.append("MTRIM include already present")
        return text, result

    # Insert after the setupanl include, the SDTM autoexec, or the startup block.
    lines = text.split("\n")
    at = active_line_index(text, re.compile(
        r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\Macros\\setupanl\.sas[\"']\s*;",
        re.IGNORECASE))
    if at < 0:
        at = active_line_index(text, re.compile(
            r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\SDTM\\autoexec\.sas[\"']\s*;",
            re.IGNORECASE))
    at = at + 1 if at >= 0 else startup_insert_at(text)
    lines.insert(at, leading_indent(lines, at) + include)
    result.changes += 1
    return "\n".join(lines), result


def fix_r014_padam(text: str, ctx: Context) -> tuple[str, Result]:
    """R-014 -- assign PADAM from SCEDATA in eight synthetic ADaM programs."""
    result = Result("R-014")
    statement = ctx.param("TARGET_PADAM")
    # Skip programs outside the validated ADaM list.
    if not has_synthetic_signal(text, ctx.filename) or \
            file_key(ctx.filename) not in R014_R015_ADAM_PROGRAMS:
        result.skipped = "outside the validated synthetic ADaM filename list"
        return text, result
    # Skip programs that already have the statement.
    if has_active_exact_line(text, statement):
        result.notes.append("PADAM assignment already present")
        return text, result

    # Insert after the mtrim include, the SDTM autoexec, or the startup block.
    lines = text.split("\n")
    at = active_line_index(text, re.compile(
        r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\Macros\\mtrim\.sas[\"']\s*;",
        re.IGNORECASE))
    if at < 0:
        at = active_line_index(text, re.compile(
            r"%include\s+[\"']&targetStudy\.\\Dev\\Programs\\SDTM\\autoexec\.sas[\"']\s*;",
            re.IGNORECASE))
    at = at + 1 if at >= 0 else startup_insert_at(text)
    lines.insert(at, leading_indent(lines, at) + statement)
    result.changes += 1
    return "\n".join(lines), result


def fix_r034_validation_libname(text: str, ctx: Context) -> tuple[str, Result]:
    """R-034 -- repoint the validation LIBNAME at the SCE study root."""
    result = Result("R-034")
    # Skip programs outside the validated synthetic batch.
    if not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the validated synthetic batch"
        return text, result

    # Match the CDR-rooted validation libname and capture its tail.
    root = ctx.param("SOURCE_STUDY_ROOT").rstrip("/")
    pattern = re.compile(
        r'^([ \t]*)(libname\s+vadam\s+)(["\'])' +
        re.escape(root) + r'/([^"\']*)\3(\s*;.*)$',
        re.IGNORECASE)

    # Repoint each active match to &targetStudy, keeping its tail and trailing text.
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if is_commented_line(line):
            continue
        match = pattern.match(line)
        if not match:
            continue
        indent, head, quote, tail, close = match.groups()
        lines[i] = f'{indent}{head}{quote}&targetStudy./{tail}{quote}{close}'
        result.changes += 1

    # Note when no matching libname was found.
    if not result.changes:
        result.notes.append("no CDR-rooted validation LIBNAME found")
    return "\n".join(lines), result


def fix_r016_adam_xpt(text: str, ctx: Context) -> tuple[str, Result]:
    """R-016 -- redirect the eight validated synthetic ADaM XPT exports."""
    result = Result("R-016")
    name = file_key(ctx.filename)
    rebuilt = name in R016_REBUILT_PROGRAMS
    # Skip programs outside the validated XPT exports.
    if not has_synthetic_signal(text, ctx.filename) or \
            (not rebuilt and name != "adpr.sas"):
        result.skipped = "outside the validated synthetic ADaM XPT exports"
        return text, result

    # Match the legacy relative-path XPT libname.
    legacy = re.compile(
        r"^\s*libname\s+trans\s+xport\s+[\"']"
        r"\.\./\.\./\.\./\.\./data/adam/20260228_SYNTH/primary/"
        r"[^\"']*\.xpt[\"']\s*;\s*$", re.IGNORECASE)
    lines = text.split("\n")

    # For adpr.sas, repoint the legacy libname in place.
    if name == "adpr.sas":
        sas = SasText(text)
        offset = 0
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if first and sas.is_active(start + first.start()) and legacy.match(line):
                indent = line[:len(line) - len(line.lstrip())]
                lines[i] = indent + \
                    r'libname trans xport "&targetStudy.\Dev\Data\ADaM\&tlfkey..xpt";'
                result.changes = 1
                break
        return "\n".join(lines), result

    # Skip programs that already have the SCE export.
    if has_active_line(text, re.compile(
            r"^\s*libname\s+trans\s+xport\s+[\"']"
            r"&targetStudy\.\\Dev\\Data\\ADAM\\&tlfkey\.\.xpt[\"']\s*;",
            re.IGNORECASE)):
        result.notes.append("SCE XPT export already present")
        return text, result

    # Locate the legacy export block: libname, proc copy, and run.
    legacy_at = active_line_index(text, legacy)
    if legacy_at < 0:
        return text, result
    proc_at = run_at = -1
    for i in range(legacy_at + 1, min(len(lines), legacy_at + 10)):
        if proc_at < 0 and re.match(
                r"^\s*proc\s+copy\s+in\s*=\s*PADAM\s+out\s*=\s*trans\s*;",
                lines[i], re.IGNORECASE):
            proc_at = i
        elif proc_at >= 0 and re.match(r"^\s*run\s*;\s*$", lines[i],
                                       re.IGNORECASE):
            run_at = i
            break
    if proc_at < 0 or run_at < 0:
        result.skipped = "legacy XPT export block was incomplete"
        return text, result

    # Comment out the old tlfkey assignment when it names this dataset.
    dataset = name.removesuffix(".sas")
    for i in range(legacy_at - 1, -1, -1):
        match = re.match(r"^\s*%let\s+tlfkey\s*=\s*([^;]+)\s*;\s*$",
                         lines[i], re.IGNORECASE)
        if not match:
            continue
        if match.group(1).strip().lower() == dataset:
            lines[i] = comment_out(lines[i])
        break

    # Comment out the legacy export block.
    for i in range(legacy_at, run_at + 1):
        if lines[i].strip() and not is_commented_line(lines[i]):
            lines[i] = comment_out(lines[i])

    # Write the rebuilt export block after the legacy one.
    block = [
        "",
        f"%let tlfkey={dataset};",
        "",
        r'libname trans xport "&targetStudy.\Dev\Data\ADAM\&tlfkey..xpt";',
        "",
        "proc copy in=padam out=trans;",
        f"   select {dataset};",
        "run;",
        "",
        "libname trans clear;",
    ]
    lines[run_at + 1:run_at + 1] = block
    result.changes = 1
    return "\n".join(lines), result


# Match the legacy transport libname that points at &__SDTMLIB.
R035_TRANS_XPT = re.compile(
    r'^(\s*)libname\s+trans\s+xport\s+"&__SDTMLIB/&data\.\.xpt"\s*;(.*)$',
    re.IGNORECASE)

# Define the replacement libname at the SCE study root.
R035_TARGET_TRANS_XPT = \
    r'libname trans xport "&targetStudy.\Dev\Data\SDTM\&data..xpt";'


def fix_r035_sdtm_xpt(text: str, ctx: Context) -> tuple[str, Result]:
    """R-035 -- repoint the SDTM XPT transport LIBNAME at the SCE study root."""
    result = Result("R-035")
    # Skip programs other than the validated SDTM autoexec.
    if file_key(ctx.filename) != "autoexec.sas" or \
            not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the validated synthetic SDTM autoexec"
        return text, result

    # Skip programs that already have the SCE transport libname.
    if has_active_exact_line(text, R035_TARGET_TRANS_XPT):
        result.notes.append("SCE transport LIBNAME already present")
        return text, result

    # Replace each active legacy transport libname, keeping its indent and trailing text.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or \
                not sas.is_active(start + first.start()):
            continue
        match = R035_TRANS_XPT.match(line)
        if not match:
            continue
        lines[i] = match.group(1) + R035_TARGET_TRANS_XPT + match.group(2)
        result.changes += 1

    # Note when no transport libname was found.
    if not result.changes:
        result.notes.append("no &__SDTMLIB transport LIBNAME found")
    return "\n".join(lines), result


# Match curly double quotes.
SMART_DQUOTE = re.compile("[\u201c\u201d]")


def fix_r037_comment_smart_quotes(text: str, ctx: Context) -> tuple[str, Result]:
    """R-037 -- straighten curly double quotes inside comments."""
    result = Result("R-037")
    sas = SasText(text)
    # Limit the work to comment spans so string literals stay unchanged.
    spans = sas.comment_spans()
    if not spans:
        return text, result

    # Rebuild the text, straightening quotes only inside comments.
    pieces: list[str] = []
    at = 0
    for start, end in spans:
        body = text[start:end]
        hits = len(SMART_DQUOTE.findall(body))
        if not hits:
            continue
        pieces.append(text[at:start])
        pieces.append(SMART_DQUOTE.sub('"', body))
        at = end
        result.changes += hits
        if len(result.notes) < 20:
            result.notes.append(body.split("\n")[0].strip())

    # Return the text unchanged when no curly quotes were found.
    if not result.changes:
        return text, result

    pieces.append(text[at:])
    return "".join(pieces), result


def fix_r017_workbook_inputs(text: str, ctx: Context) -> tuple[str, Result]:
    """R-017 -- relocate only the five documented workbook input contexts."""
    result = Result("R-017")
    name = file_key(ctx.filename)
    lines = text.split("\n")
    sas = SasText(text)
    offset = 0

    # Relocate the SDTM spec workbook paths in the autoexec.
    if name == "autoexec.sas" and has_synthetic_signal(text, ctx.filename):
        tdpath = re.compile(
            r"^\s*%let\s+tdpath\s*=\s*%str\([\"']"
            r"\.\./\.\./\.\./\.\./programs/sdtm/20260228_SYNTH/"
            r"documents/EXAMPLE002 SDTM Specs_v1\.0\.xlsx[\"']\)\s*;\s*$",
            re.IGNORECASE)
        spec_import = re.compile(
            r"^\s*proc\s+import\s+out\s*=\s*spec\s+datafile\s*=\s*[\"']"
            r"\.\./\.\./\.\./\.\./programs/sdtm/documents/"
            r"EXAMPLE002 SDTM Specs_v1\.0\.xlsx[\"']\s+"
            r"dbms\s*=\s*xlsx\s+replace\s*;\s*$", re.IGNORECASE)
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if not first or not sas.is_active(start + first.start()):
                continue
            indent = line[:len(line) - len(line.lstrip())]
            if tdpath.match(line):
                lines[i] = indent + \
                    r'%let tdpath=%str("&targetStudy.\Documents\EXAMPLE002 SDTM Specs_v1.0.xlsx");'
                result.changes += 1
            elif spec_import.match(line):
                lines[i] = indent + \
                    r'proc import out=spec datafile="&targetStudy.\Documents\EXAMPLE002 SDTM Specs_v1.0.xlsx" dbms=xlsx replace;'
                result.changes += 1

    elif has_301_signal(text, ctx.filename) and name in R017_301_ADAM_PROGRAMS:
        # Relocate the prior and post therapy workbook inputs in the ADaM programs.
        source = re.compile(
            r'''["']//placeholder/clinicalstudies/projects/&client/&project/&study/final/rawdata/'''
            r'''&(prior_therapy|post_therapy)\.\.xlsx["']''', re.IGNORECASE)
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if not first or not sas.is_active(start + first.start()):
                continue
            lines[i], changed = source.subn(
                lambda match: rf'"&targetStudy.\Docs\&{match.group(1)}..xlsx"',
                line)
            result.changes += changed

    elif has_301_signal(text, ctx.filename) and name == "t900dv.sas":
        # Relocate the protocol deviation transfer workbook in t900dv.sas.
        source = re.compile(
            r"^\s*proc\s+import\s+datafile\s*=\s*[\"']"
            r"//placeholder/clinicalstudies/projects/&client/&project/&study/final/rawdata/"
            r"&dev_ext_dataset\.[\"']", re.IGNORECASE)
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if first and sas.is_active(start + first.start()) and source.match(line):
                indent = line[:len(line) - len(line.lstrip())]
                lines[i] = indent + \
                    r'proc import datafile= "&targetStudy.\Docs\EXAMPLE002_VendorTransfer_v1.0_Protocol_Deviations.xlsx"'
                result.changes = 1
                break

    elif has_301_signal(text, ctx.filename) and name == "t900lb.sas":
        # Relocate the lbtest import in t900lb.sas and switch its dbms to XLS.
        converted = False
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if not first or not sas.is_active(start + first.start()):
                continue
            if re.match(r"^\s*proc\s+import\s+datafile\s*=\s*[\"']&lbtestfile\.[\"']",
                        line, re.IGNORECASE):
                indent = line[:len(line) - len(line.lstrip())]
                lines[i] = indent + r'proc import datafile="&targetStudy.\Docs\lbtest.xls"'
                result.changes = 1
                converted = True
            elif converted and re.match(r"^\s*out\s*=\s*check_lb\b", line,
                                        re.IGNORECASE):
                lines[i] = re.sub(r"dbms\s*=\s*XLSX", "dbms=XLS", line,
                                  flags=re.IGNORECASE)
                converted = False

    return "\n".join(lines), result


def fix_r018_xpt_output(text: str, ctx: Context) -> tuple[str, Result]:
    """R-018 -- disable eight exact XPT calls while retaining SAS outputs."""
    result = Result("R-018")
    allowed = R018_OUTPUTS.get(file_key(ctx.filename))
    # Skip programs outside the validated R-018 list.
    if not has_301_signal(text, ctx.filename) or not allowed:
        result.skipped = "outside the four validated R-018 programs"
        return text, result

    # Comment out util_cvtds calls for the allowed outputs only.
    sas = SasText(text)
    offset = 0
    pattern = re.compile(
        r"^(\s*)%util_cvtds\s*\(\s*([a-z0-9_]+)\s*\)\s*;(.*)$",
        re.IGNORECASE)
    lines = text.split("\n")
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        match = pattern.match(line)
        if not first or not match or not sas.is_active(start + first.start()) or \
                match.group(2).lower() not in allowed:
            continue
        lines[i] = match.group(1) + "*" + line[len(match.group(1)):]
        result.changes += 1
    return "\n".join(lines), result


def fix_r019_rescreen(text: str, ctx: Context) -> tuple[str, Result]:
    """R-019 -- replace the seven validated RESCREEN workbook imports."""
    result = Result("R-019")
    name = file_key(ctx.filename)
    # Skip programs outside the validated RESCREEN list.
    if not has_301_signal(text, ctx.filename) or name not in R019_PROGRAMS:
        result.skipped = "outside the seven validated RESCREEN programs"
        return text, result

    # Match the full five-line rescreen import step.
    pattern = re.compile(
        r"^([ \t]*)proc\s+import\s+datafile\s*=\s*[\"']&rescreen\.[\"']\s*\r?\n"
        r"[ \t]*out\s*=\s*rescr\b[^\r\n]*\r?\n"
        r"[ \t]*sheet\s*=\s*[\"']rescreen[\"']\s*;\s*\r?\n"
        r"[ \t]*getnames\s*=\s*yes\s*;\s*\r?\n"
        r"[ \t]*run\s*;[^\r\n]*$", re.IGNORECASE | re.MULTILINE)
    sas = SasText(text)

    # Comment out the import and add a data step that reads Ext.rescreen.
    def replace(match: re.Match) -> str:
        first = match.start() + len(match.group(1))
        if not sas.is_active(first):
            return match.group(0)
        newline = "\r\n" if "\r\n" in match.group(0) else "\n"
        commented = newline.join(comment_out(line)
                                 for line in re.split(r"\r?\n", match.group(0)))
        set_line = r"    set Ext.rescreen(rename=(old_subject_id=old_subject_id1));" \
            if name == "t900sv.sas" else r"    set Ext.rescreen;"
        result.changes += 1
        return commented + newline * 2 + match.group(1) + "data rescr;" + newline + \
            match.group(1) + set_line + newline + match.group(1) + "run;"

    return pattern.sub(replace, text), result


def fix_l032_rescreen_identifiers(text: str, ctx: Context) -> tuple[str, Result]:
    """L-032 -- apply character-aware RESCREEN subject/site identifier logic.

    This is intentionally a separate linked logic finding rather than part of
    R-019.  R-019 only redirects the RESCREEN source to Ext.rescreen; L-032
    reproduces the program-specific identifier/type changes observed in the
    seven validated EXAMPLE003 SDTM destination programs.

    The transformations are file-specific, idempotent, and limited to active
    SAS statements.  One L-032 occurrence is reported per program when one or
    more of its linked edits are applied.
    """
    result = Result("L-032")
    name = file_key(ctx.filename)
    # Skip programs outside the validated RESCREEN list.
    if not has_301_signal(text, ctx.filename) or name not in R019_PROGRAMS:
        result.skipped = "outside the seven validated L-032 RESCREEN programs"
        return text, result

    # Count linked edits so one finding is reported per program.
    edit_count = 0

    # Rewrite each active line that matches a pattern.
    def replace_active_line(source: str, pattern: re.Pattern, replacement) -> tuple[str, int]:
        sas = SasText(source)
        offset = 0
        lines = source.split("\n")
        changed = 0
        for i, line in enumerate(lines):
            start = offset
            offset += len(line) + 1
            first = re.search(r"\S", line)
            if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
                continue
            match = pattern.match(line)
            if not match:
                continue
            lines[i] = replacement(match) if callable(replacement) else replacement
            changed += 1
        return "\n".join(lines), changed

    def insert_rescreen_line(source: str, statement: str) -> tuple[str, int]:
        # Insert immediately after the active SET Ext.rescreen statement in the
        # DATA RESCR block, but only when the target statement is not already
        # present.  This makes reruns safe over already-migrated programs.
        if re.search(r"^\s*" + re.escape(statement) + r"\s*$", source,
                     re.IGNORECASE | re.MULTILINE):
            return source, 0
        pattern = re.compile(
            r"(^([ \t]*)data\s+rescr\s*;\s*\r?\n"
            r"[ \t]*set\s+Ext\.rescreen(?:\s*\([^\r\n]*\))?\s*;\s*\r?\n)",
            re.IGNORECASE | re.MULTILINE)
        sas = SasText(source)
        match = pattern.search(source)
        if not match or not sas.is_active(match.start() + len(match.group(2))):
            return source, 0
        newline = "\r\n" if "\r\n" in match.group(1) else "\n"
        indent = match.group(2) + "    "
        replacement = match.group(1) + indent + statement + newline
        return source[:match.start()] + replacement + source[match.end():], 1

    if name == "t900dm.sas":
        # Convert numeric subject and site identifiers to character in t900dm.sas.
        patterns = [
            (re.compile(r"^(\s*)new_subject_id\s*=\s*input\s*\(\s*subjid\s*,\s*best\.?\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "new_subject_id=kstrip(subjid);/*input(subjid,best.);*/"),
            (re.compile(r"^(\s*)where\s+input\s*\(\s*a\.subjid\s*,\s*best\.?\s*\)\s*=\s*b\.old_subject_id\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "/*where input(a.subjid,best.)=b.old_subject_id;*/\n" +
                       m.group(1) + "where a.subjid = kstrip(b.old_subject_id);"),
            (re.compile(r"^(\s*select\s+a\.\*\s*,\s*)kstrip\s*\(\s*put\s*\(\s*b\.old_site_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsite\s*,\s*kstrip\s*\(\s*put\s*\(\s*b\.old_subject_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsubj\s*,\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "kstrip(b.old_site_id) as oldsite,\n" +
                       (re.match(r"^\s*", m.group(0)).group(0) + "       ") +
                       "kstrip(b.old_subject_id) as oldsubj,"),
            (re.compile(r"^(\s*where\s+subjid\s*\^in\s*\(\s*select\s+)kstrip\s*\(\s*put\s*\(\s*old_subject_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+subjid(.*)$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "kstrip(old_subject_id) as subjid" + m.group(2)),
            (re.compile(r"^(\s*if\s+oldsubj\s+ne\s+[\"']{2}\s+then\s+siteid\s*=\s*)kstrip\s*\(\s*put\s*\(\s*new_site_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "kstrip(new_site_id);"),
        ]
        for pattern, replacement in patterns:
            text, changed = replace_active_line(text, pattern, replacement)
            edit_count += changed

    elif name in {"t900ds.sas", "t900ie.sas"}:
        # Add a numeric old subject ID and keep the site ID character (t900ds, t900ie).
        text, changed = insert_rescreen_line(
            text, "old_subject_idn = input(old_subject_id, best.);")
        edit_count += changed
        for pattern, replacement in [
            (re.compile(r"^(\s*select\s+a\.\*\s*,\s*)kstrip\s*\(\s*put\s*\(\s*b\.old_site_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsite(.*)$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "kstrip(b.old_site_id) as oldsite" + m.group(2)),
            (re.compile(r"^(\s*on\s+a\.old_subject_id\s*=\s*)b\.old_subject_id\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "b.old_subject_idn;"),
        ]:
            text, changed = replace_active_line(text, pattern, replacement)
            edit_count += changed

    elif name == "t900lb.sas":
        # Add a numeric old subject ID and convert the subject logic to character (t900lb).
        text, changed = insert_rescreen_line(
            text, "old_subject_idn = input(old_subject_id, best.);")
        edit_count += changed
        patterns = [
            (re.compile(r"^(\s*select\s+a\.\*\s*,\s*)kstrip\s*\(\s*put\s*\(\s*b\.old_site_id\s*,\s*best\.?\s*\)\s*\)\s+as\s+oldsite(.*)$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "kstrip(b.old_site_id) as oldsite" + m.group(2)),
            (re.compile(r"^(\s*on\s+a\.old_subject_id\s*=\s*)b\.old_subject_id\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "b.old_subject_idn;"),
            (re.compile(r"^(\s*)if\s+new_subject_id\s+ne\s+\.\s+and\s+new_subject_id\s+ne\s+old_subject_id\s+then\s+do\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "if new_subject_id ne '' and input(new_subject_id,best.) ne old_subject_id then do;"),
            (re.compile(r"^(\s*)subject\s*=\s*kstrip\s*\(\s*put\s*\(\s*new_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "subject=kstrip(new_subject_id);"),
        ]
        for pattern, replacement in patterns:
            text, changed = replace_active_line(text, pattern, replacement)
            edit_count += changed

    elif name == "t900mb.sas":
        # Convert the subject logic from numeric to character (t900mb).
        patterns = [
            (re.compile(r"^(\s*)old_subject_id\s*=\s*input\s*\(\s*subjid\s*,\s*best\.?\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "old_subject_id=kstrip(subjid)/*input(subjid,best.)*/;"),
            (re.compile(r"^(\s*)if\s+new_subject_id\s+ne\s+\.\s+and\s+new_subject_id\s+ne\s+old_subject_id\s+then\s+do\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "if not missing(new_subject_id) /*new_subject_id ne .*/ and new_subject_id ne old_subject_id then do;"),
            (re.compile(r"^(\s*)subject\s*=\s*kstrip\s*\(\s*put\s*\(\s*new_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "subject=kstrip(new_subject_id); /*kstrip(put(new_subject_id,best.));*/"),
            (re.compile(r"^(\s*)oldsubj\s*=\s*kstrip\s*\(\s*put\s*\(\s*old_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "oldsubj=kstrip(old_subject_id); /*kstrip(put(old_subject_id,best.));*/"),
        ]
        for pattern, replacement in patterns:
            text, changed = replace_active_line(text, pattern, replacement)
            edit_count += changed

    elif name == "t900se.sas":
        # Treat the subject as character in t900se.sas.
        pattern = re.compile(
            r"^(\s*)new_subject_id\s*=\s*input\s*\(\s*subject\s*,\s*best\.?\s*\)\s*;\s*$",
            re.IGNORECASE)
        text, changed = replace_active_line(
            text, pattern,
            lambda m: m.group(1) + "new_subject_id=strip(subject);/*input(subject,best.); as new_subject_id is string in the source*/")
        edit_count += changed

    elif name == "t900sv.sas":
        # Derive the old subject ID from the character rescreen field (t900sv).
        text, changed = insert_rescreen_line(
            text, "old_subject_id = input(old_subject_id1, best.);")
        edit_count += changed
        for pattern, replacement in [
            (re.compile(r"^(\s*)if\s+new_subject_id\s+ne\s+\.\s+and\s+old_subject_id\s+ne\s+new_subject_id\s+then\s+do\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "if new_subject_id ne '' and strip(put(old_subject_id, best.)) ne new_subject_id then do;"),
            (re.compile(r"^(\s*)subject\s*=\s*kstrip\s*\(\s*put\s*\(\s*new_subject_id\s*,\s*best\.?\s*\)\s*\)\s*;\s*$",
                        re.IGNORECASE),
             lambda m: m.group(1) + "subject=strip(new_subject_id);"),
        ]:
            text, changed = replace_active_line(text, pattern, replacement)
            edit_count += changed

    if edit_count:
        # The evidence records L-032 once per program even when several lines
        # participate in the same identifier/type migration.
        result.changes = 1
        result.notes.append(f"applied {edit_count} linked identifier edit(s)")
    return text, result


def fix_r020_adam_spec(text: str, ctx: Context) -> tuple[str, Result]:
    """R-020 -- disable the validated ADAM_SPEC metadata blocks."""
    result = Result("R-020")
    name = file_key(ctx.filename)
    # Skip programs outside the validated ADAM_SPEC list.
    if not has_synthetic_signal(text, ctx.filename) or name not in R020_PROGRAMS:
        result.skipped = "outside the six validated ADAM_SPEC programs"
        return text, result

    # Comment out the adam_spec call and the %put lines that follow it.
    sas = SasText(text)
    offset = 0
    in_block = False
    lines = text.split("\n")
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        active = bool(first and sas.is_active(start + first.start()))
        if active and re.match(
                r"^\s*%adam_spec\s*\(\s*sheet\s*=\s*&tlfkey\s*\)\s*;\s*$",
                line, re.IGNORECASE):
            lines[i] = comment_out(line)
            in_block = True
            result.changes += 1
        elif in_block and re.match(r"^\s*%put\b[^;]*;\s*$", line,
                                   re.IGNORECASE):
            lines[i] = comment_out(line)
        elif in_block and re.match(r"^\s*%\*put\b[^;]*;\s*$", line,
                                   re.IGNORECASE):
            if name != "adpr.sas":
                lines[i] = comment_out(line)
        elif in_block:
            in_block = False
    return "\n".join(lines), result


def fix_r021_data_case(text: str, ctx: Context) -> tuple[str, Result]:
    """R-021 -- normalize one exact DATA libref call in six 301 programs."""
    result = Result("R-021")
    spec = R021_CALLS.get(file_key(ctx.filename))
    # Skip programs outside the validated R-021 calls.
    if not has_301_signal(text, ctx.filename) or not spec:
        result.skipped = "outside the six validated R-021 calls"
        return text, result

    # Change libref=data to libref=Data in the matching calls.
    macro, member, needs_engine = spec
    edits: list[tuple[int, int, str]] = []
    sas = SasText(text)
    for call in find_macro_calls(sas, macro):
        args = split_args(text[call.args_text_slice])
        if not args or args[0].strip().lower() != member:
            continue
        if needs_engine and not any(re.match(r"\s*engine\s*=\s*V9\s*$", arg,
                                             re.IGNORECASE) for arg in args):
            continue
        if not any(re.match(r"\s*libref\s*=\s*data\s*$", arg) for arg in args):
            continue
        edits.append((call.args_start, call.args_end,
                      ",".join([args[0]] + replace_libref_arg(args[1:], "Data"))))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
        result.changes += 1
    return text, result


def fix_r022_sdtm_xudata(text: str, ctx: Context) -> tuple[str, Result]:
    """R-022 -- make six validated native SDTM UTIL_GETDATA reads explicit."""
    result = Result("R-022")
    name = file_key(ctx.filename)
    # Skip programs outside the validated R-022 list.
    if not has_301_signal(text, ctx.filename) or name not in R022_PROGRAMS:
        result.skipped = "outside the five validated R-022 programs"
        return text, result

    sas = SasText(text)
    edits: list[tuple[int, int, str]] = []

    # Make each validated read explicit with its libref, sort, and engine options.
    for call in find_macro_calls(sas, "util_getdata"):
        args = split_args(text[call.args_text_slice])
        if not args:
            continue
        member = args[0].strip().lower()
        replacement = None

        # u900addv.sas: add libref=DATA to dv and suppdv reads that have sort and engine.
        if name == "u900addv.sas" and member in {"dv", "suppdv"}:
            has_sort = any(re.match(r"\s*sort\s*=\s*usubjid\s*$", a, re.I) for a in args[1:])
            has_engine = any(re.match(r"\s*engine\s*=\s*V9\s*$", a, re.I) for a in args[1:])
            has_libref = any(re.match(r"\s*libref\s*=", a, re.I) for a in args[1:])
            if has_sort and has_engine and not has_libref:
                replacement = ",".join([args[0], "libref=DATA"] + args[1:])

        elif name == "t900mb.sas" and member == "dm" and len(args) == 1:
            # t900mb.sas: spell out the full dm read.
            replacement = "dm, libref=Data, sort=usubjid, engine=V9"

        elif name == "t900mh.sas" and member == "dm":
            # t900mh.sas: point the dm read at SDTM.
            has_sort = any(re.match(r"\s*sort\s*=\s*usubjid\s*$", a, re.I) for a in args[1:])
            has_engine = any(re.match(r"\s*engine\s*=\s*V9\s*$", a, re.I) for a in args[1:])
            if has_sort and has_engine and any(re.match(r"\s*libref\s*=\s*data\s*$", a, re.I) for a in args[1:]):
                replacement = ",".join([args[0]] + replace_libref_arg(args[1:], "SDTM"))

        elif name == "t900pr.sas" and member == "dm":
            # t900pr.sas: point the dm read at SDTM and add the V9 engine.
            has_sort = any(re.match(r"\s*sort\s*=\s*usubjid\s*$", a, re.I) for a in args[1:])
            has_engine = any(re.match(r"\s*engine\s*=\s*V9\s*$", a, re.I) for a in args[1:])
            if has_sort and not has_engine and any(re.match(r"\s*libref\s*=\s*data\s*$", a, re.I) for a in args[1:]):
                new_args = [args[0]] + replace_libref_arg(args[1:], "SDTM")
                if not has_engine:
                    new_args.append(" engine=V9")
                replacement = ",".join(new_args)

        elif name == "t900rs.sas" and member == "sv" and len(args) == 1:
            # t900rs.sas: spell out the full sv read.
            replacement = "sv, libref=data, sort=usubjid, engine=V9"

        # Queue an edit only when the call actually changes.
        if replacement is not None and replacement != text[call.args_text_slice]:
            edits.append((call.args_start, call.args_end, replacement))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
        result.changes += 1
    return text, result


# Return the index of the first matching line from start, or -1.
def _find_line(lines: list[str], pattern: re.Pattern, start: int = 0) -> int:
    for i in range(start, len(lines)):
        if pattern.search(lines[i]):
            return i
    return -1


# Comment out a range of lines, keeping blank lines as empty comments.
def _comment_lines(lines: list[str], start: int, end: int) -> list[str]:
    return [comment_out(line) if line.strip() else "/**/" for line in lines[start:end + 1]]


def fix_r023_vendorpk_ext(text: str, ctx: Context) -> tuple[str, Result]:
    """R-023 -- route the four validated VENDORPK vendor-input contexts through Ext."""
    result = Result("R-023")
    name = file_key(ctx.filename)
    # Skip programs outside the validated R-023 list.
    if not has_301_signal(text, ctx.filename) or name not in R023_PROGRAMS:
        result.skipped = "outside the three validated R-023 programs"
        return text, result

    lines = text.split("\n")

    if name == "t900pc.sas":
        # Replace the CSV import in the pk macro with a set statement.
        if not any(re.search(r"^\s*set\s+&ins\.\s*;", x, re.I) for x in lines):
            macro_at = _find_line(lines, re.compile(r"^\s*%macro\s+pk\s*\(", re.I))
            infile_at = _find_line(lines, re.compile(r"^\s*infile\s+[\"'].*&&ins\.\.csv", re.I), macro_at + 1 if macro_at >= 0 else 0)
            run_at = _find_line(lines, re.compile(r"^\s*run\s*;", re.I), infile_at + 1 if infile_at >= 0 else 0)
            length_at = _find_line(lines, re.compile(r"^\s*length\b", re.I), infile_at + 1 if infile_at >= 0 else 0)
            input_at = _find_line(lines, re.compile(r"^\s*input\b", re.I), length_at + 1 if length_at >= 0 else 0)
            if 0 <= infile_at < length_at < input_at < run_at:
                length_end = length_at
                while length_end < input_at and lines[length_end].strip() != ";":
                    length_end += 1
                input_end = input_at
                while input_end < run_at and lines[input_end].strip() != ";":
                    input_end += 1
                if length_end < input_at and input_end < run_at:
                    active_length = lines[length_at:length_end + 1]
                    legacy = lines[infile_at:input_end + 1]
                    legacy[0] = re.match(r"^\s*", legacy[0]).group(0) + "/*" + legacy[0].lstrip()
                    legacy[-1] = legacy[-1] + "*/"
                    indent = re.match(r"^\s*", lines[infile_at]).group(0)
                    lines[infile_at:input_end + 1] = active_length + legacy + [indent + "set &ins.;"]
                    result.changes = 1

        # Define the Ext dataset macro variables the pk calls need.
        lets = [
            "%let payload_ext_dataset = ext.vendorpk_pk_payload;",
            "%let intact_ext_dataset  = ext.vendorpk_pk_intact;",
            "%let total_ext_dataset   = ext.vendorpk_pk_total;",
        ]
        # Insert any missing Ext macro variables before the first pk call.
        if not all(any(x.strip().lower() == stmt.lower() for x in lines) for stmt in lets):
            call_at = _find_line(lines, re.compile(r"^\s*%pk\s*\(\s*ins\s*=\s*&payload_ext_dataset", re.I))
            if call_at >= 0:
                missing = [stmt for stmt in lets if not any(x.strip().lower() == stmt.lower() for x in lines)]
                lines[call_at:call_at] = missing + ([""] if missing else [])
                result.changes = 1

    elif name == "t900is.sas":
        # Replace the nab CSV import with a set of the Ext dataset.
        proc_at = _find_line(lines, re.compile(r"^\s*proc\s+import\s+datafile=.*&nab_ext_dataset\.\.csv", re.I))
        if proc_at >= 0:
            run_at = _find_line(lines, re.compile(r"^\s*run\s*;", re.I), proc_at + 1)
            if run_at >= 0:
                indent = re.match(r"^\s*", lines[proc_at]).group(0)
                block = _comment_lines(lines, proc_at, run_at) + ["", indent + "data pkN;", indent + "    set Ext.Vendorpk_nab_final;", indent + "run;"]
                lines[proc_at:run_at + 1] = block
                result.changes += 1

        # Replace the haha CSV import with a set of the Ext dataset.
        data_at = _find_line(lines, re.compile(r"^\s*data\s+pk4\s*;", re.I))
        if data_at >= 0 and not any(re.search(r"^\s*set\s+Ext\.Vendorpk_haha\s*;", x, re.I) for x in lines[data_at:data_at + 25]):
            infile_at = _find_line(lines, re.compile(r"&haha_ext_dataset\.\.csv", re.I), data_at + 1)
            run_at = _find_line(lines, re.compile(r"^\s*run\s*;", re.I), infile_at + 1 if infile_at >= 0 else data_at + 1)
            if infile_at >= 0 and run_at >= 0:
                indent = re.match(r"^\s*", lines[data_at]).group(0)
                block = _comment_lines(lines, data_at, run_at) + ["", indent + "data pk4;", indent + "    set Ext.Vendorpk_haha;", indent + "run;"]
                lines[data_at:run_at + 1] = block
                result.changes += 1

    elif name == "t900sv.sas":
        # Replace the first pk macro's CSV read with a set of the Ext dataset.
        macro_starts = [i for i, x in enumerate(lines) if re.search(r"^\s*%macro\s+pk\s*\(", x, re.I)]
        if macro_starts:
            first = macro_starts[0]
            mend = _find_line(lines, re.compile(r"^\s*%mend\s*;", re.I), first + 1)
            infile_at = _find_line(lines, re.compile(r"^\s*infile\s+[\"'].*&&ins\.\.csv", re.I), first + 1)
            if infile_at >= 0 and mend >= 0 and infile_at < mend:
                run_at = _find_line(lines, re.compile(r"^\s*run\s*;", re.I), infile_at + 1)
                input_at = _find_line(lines, re.compile(r"^\s*input\b", re.I), infile_at + 1)
                if input_at >= 0 and run_at >= 0:
                    input_end = input_at
                    while input_end < run_at and lines[input_end].strip() != ";":
                        input_end += 1
                    if input_end < run_at:
                        commented = _comment_lines(lines, infile_at, input_end)
                        indent = re.match(r"^\s*", lines[infile_at]).group(0)
                        lines[infile_at:input_end + 1] = commented + [indent + "set Ext.&ins;"]
                        result.changes = 1

        # Point the pk calls at the Ext member names.
        replacements = {
            "payload_ext_dataset": "Vendorpk_pk_payload",
            "intact_ext_dataset": "Vendorpk_pk_intact",
            "total_ext_dataset": "Vendorpk_pk_total",
        }
        for i, line in enumerate(lines):
            for macro_name, member in replacements.items():
                if re.search(r"%pk\s*\(\s*ins\s*=\s*&" + re.escape(macro_name) + r"\b", line, re.I):
                    lines[i] = re.sub(r"&" + re.escape(macro_name) + r"\b", member, line, flags=re.I)
                    result.changes = 1

        # Comment out the second pk macro definition.
        macro_starts = [i for i, x in enumerate(lines) if re.search(r"^\s*%macro\s+pk\s*\(", x, re.I)]
        if len(macro_starts) >= 2 and not (macro_starts[1] > 0 and lines[macro_starts[1] - 1].strip() == "/*"):
            second = macro_starts[1]
            mend = _find_line(lines, re.compile(r"^\s*%mend\s*;", re.I), second + 1)
            if mend >= 0:
                body = [x.replace("/*TIMEPOINT $40*/", "").replace("/*TIMEPOINT*/", "") for x in lines[second:mend + 1]]
                lines[second:mend + 1] = ["/*"] + body + ["*/"]
                result.changes = 1

        # Replace the nab call with calls for the haha and nab Ext datasets.
        nab_at = _find_line(lines, re.compile(r"^\s*%pk\s*\(\s*ins\s*=\s*&nab_ext_dataset", re.I))
        if nab_at >= 0:
            indent = re.match(r"^\s*", lines[nab_at]).group(0)
            lines[nab_at:nab_at + 1] = [indent + "%pk(ins=Vendorpk_haha, outs=pk4);", indent + "%pk(ins=Vendorpk_nab_final, outs=pk5);"]
            result.changes = 1

        # Comment out the legacy pk4 build.
        data_at = _find_line(lines, re.compile(r"^\s*data\s+pk4\s*;", re.I))
        if data_at >= 0:
            kup_at = _find_line(lines, re.compile(r"^\s*%util_fetchdata\s*\(\s*pk4\b", re.I), data_at + 1)
            if kup_at >= 0:
                lines[data_at:kup_at + 1] = _comment_lines(lines, data_at, kup_at)
                result.changes = 1

        # Report one change per program.
        if result.changes:
            result.changes = 1

    return "\n".join(lines), result


def fix_r024_sdtm_qc(text: str, ctx: Context) -> tuple[str, Result]:
    """R-024 -- disable the three validated XTSCPCK1 SDTM QC calls."""
    result = Result("R-024")
    name = file_key(ctx.filename)
    domain = R024_QC_DOMAINS.get(name)
    # Skip programs outside the validated R-024 list.
    if not has_301_signal(text, ctx.filename) or not domain:
        result.skipped = "outside the three validated R-024 programs"
        return text, result

    # Comment out the first active util_tscheck call for this domain.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    pattern = re.compile(r"^(\s*)%util_tscheck\s*\(\s*" + re.escape(domain) + r"\s*,", re.I)
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or not sas.is_active(start + first.start()) or is_commented_line(line):
            continue
        m = pattern.search(line)
        if m:
            lines[i] = m.group(1) + "*" + line[len(m.group(1)):]
            result.changes = 1
            break
    return "\n".join(lines), result


def fix_r025_vendorlab_ext(text: str, ctx: Context) -> tuple[str, Result]:
    """R-025 -- reroute the three retained Vendorlab loads through Ext."""
    result = Result("R-025")
    name = file_key(ctx.filename)
    # Skip programs outside the validated R-025 list, noting the t900mb.sas exception.
    if not has_301_signal(text, ctx.filename) or name not in R025_PROGRAMS:
        if name == "t900mb.sas":
            result.skipped = "t900mb.sas is the documented R-025 exception; its Vendorlab load is disabled instead"
        else:
            result.skipped = "outside the three validated R-025 programs"
        return text, result

    # Point the vendor lab fetch at the Ext dataset.
    sas = SasText(text)
    edits: list[tuple[int, int, str]] = []
    for call in find_macro_calls(sas, "util_fetchdata"):
        args = split_args(text[call.args_text_slice])
        if not args or not re.fullmatch(r"\s*&vendor_lab_source\.?\s*", args[0], re.I):
            continue
        if not any(re.match(r"\s*libref\s*=\s*rawdata\s*$", a, re.I) for a in args[1:]):
            continue
        new_args = [re.sub(r"&vendor_lab_source\.?,?", "Vendorlab_lab", args[0], flags=re.I)]
        for arg in args[1:]:
            m = re.match(r"(\s*libref\s*=\s*)rawdata(\s*)$", arg, re.I)
            new_args.append((m.group(1) + "Ext" + m.group(2)) if m else arg)
        edits.append((call.args_start, call.args_end, ",".join(new_args)))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
        result.changes += 1
    return text, result


def fix_l034_disable_vendorlab_mb(text: str, ctx: Context) -> tuple[str, Result]:
    """L-034 -- disable the study-specific Vendorlab load in t900mb.sas."""
    result = Result("L-034")
    # Skip every program except t900mb.sas.
    if not has_301_signal(text, ctx.filename) or file_key(ctx.filename) != "t900mb.sas":
        result.skipped = "outside the validated L-034 program"
        return text, result

    # Comment out the first active vendor lab fetch.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    pattern = re.compile(r"^(\s*)%util_fetchdata\s*\(\s*&vendor_lab_source\.?\s*,\s*libref\s*=\s*rawdata\s*,\s*sort\s*=\s*subjid\s*\)\s*;", re.I)
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or not sas.is_active(start + first.start()) or is_commented_line(line):
            continue
        m = pattern.search(line)
        if m:
            lines[i] = m.group(1) + "*" + line[len(m.group(1)):]
            result.changes = 1
            break
    return "\n".join(lines), result


def fix_r026_direct_adam(text: str, ctx: Context) -> tuple[str, Result]:
    """R-026 -- redirect three validated direct DATA.AD* references to ADaM."""
    result = Result("R-026")
    name = file_key(ctx.filename)
    allowed = R026_DIRECT_MEMBERS.get(name)
    # Skip programs outside the validated R-026 list.
    if not has_301_signal(text, ctx.filename) or not allowed:
        result.skipped = "outside the two validated R-026 programs"
        return text, result

    # Redirect direct DATA references to the ADaM libref on active lines.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or not sas.is_active(start + first.start()) or is_commented_line(line):
            continue

        # Pick the statement pattern and libref for this program.
        if name == "u900adae.sas":
            pattern = re.compile(r"(\bproc\s+contents\s+data\s*=\s*)data\.(adae)\b", re.I)
            repl_lib = "ADaM"
        else:
            pattern = re.compile(r"(\bproc\s+sort\s+data\s*=\s*)data\.(adae|adsl)\b", re.I)
            repl_lib = "adam"

        # Rewrite only the allowed members.
        def repl(m):
            if m.group(2).lower() not in allowed:
                return m.group(0)
            result.changes += 1
            return m.group(1) + repl_lib + "." + m.group(2)

        lines[i] = pattern.sub(repl, line)

    return "\n".join(lines), result


def _prefix_statement_comments(lines: list[str], start: int, end: int) -> None:
    """Disable a legacy DATA-step block without nesting /* ... */ comments.

    The Vendortreatment import blocks contain their own block comments (for example
    /*BLOCKNO*/), so wrapping the whole block in another block comment would
    close early in SAS. Prefixing each executable line with `*` preserves the
    source as documentation and is safe across those embedded comments.
    """
    for i in range(start, end + 1):
        line = lines[i]
        if not line.strip():
            continue
        indent = line[:len(line) - len(line.lstrip())]
        body = line[len(indent):]
        if body.startswith("*"):
            continue
        lines[i] = indent + "*" + body


def fix_r027_vendortreatment_ext(text: str, ctx: Context) -> tuple[str, Result]:
    """R-027 -- replace three validated Vendortreatment CSV input blocks with Ext data."""
    result = Result("R-027")
    name = file_key(ctx.filename)
    # Skip programs outside the validated R-027 list.
    if not has_301_signal(text, ctx.filename) or name not in R027_PROGRAMS:
        result.skipped = "outside the two validated R-027 programs"
        return text, result

    lines = text.split("\n")
    # Walk the file for DATA steps that read the vendor treatment CSV.
    i = 0
    while i < len(lines):
        sas = SasText("\n".join(lines))
        # Recompute offsets because earlier replacements may have inserted lines.
        offsets = []
        off = 0
        for line in lines:
            offsets.append(off)
            off += len(line) + 1

        m = re.match(r"^(\s*)data\s+(vendortreatment|strati)\s*;\s*$", lines[i], re.I)
        if not m or is_commented_line(lines[i]):
            i += 1
            continue
        first = re.search(r"\S", lines[i])
        if not first or not sas.is_active(offsets[i] + first.start()):
            i += 1
            continue

        # Find the step's run statement and its CSV infile.
        run_at = _find_line(lines, re.compile(r"^\s*run\s*;\s*$", re.I), i + 1)
        if run_at < 0:
            break
        infile_at = -1
        for j in range(i + 1, run_at + 1):
            if re.search(r"^\s*infile\s+[\"'][^\"']*&vendortreatment_trt\.\.csv[\"']",
                         lines[j], re.I):
                infile_at = j
                break
        if infile_at < 0:
            i = run_at + 1
            continue

        # Disable the legacy step without nesting block comments.
        source_ds = m.group(2).lower()
        _prefix_statement_comments(lines, i, run_at)

        if source_ds == "vendortreatment":
            # The paired DM and SE programs retain their downstream derivation
            # from VENDORTREATMENT, so recreate that work dataset from the SCE Ext source.
            indent = m.group(1)
            replacement = [
                "",
                indent + "data vendortreatment;",
                indent + "    set ext.Vendortreatment_treatment_code;",
                indent + "run;",
            ]
            lines[run_at + 1:run_at + 1] = replacement
            i = run_at + len(replacement) + 1
        else:
            # In the second DM block, SCE reads the Ext dataset directly in
            # STRATI_1 rather than recreating the intermediate STRATI table.
            set_at = _find_line(lines, re.compile(r"^\s*set\s+strati\s*;\s*$", re.I),
                                run_at + 1)
            if set_at >= 0:
                indent = re.match(r"^\s*", lines[set_at]).group(0)
                lines[set_at] = indent + "set ext.Vendortreatment_treatment_code;"
            i = run_at + 1

        result.changes += 1

    return "\n".join(lines), result


def fix_r028_data_sdtm(text: str, ctx: Context) -> tuple[str, Result]:
    """R-028 -- add the two validated point-of-use DATA -> SCE SDTM aliases."""
    result = Result("R-028")
    name = file_key(ctx.filename)
    domain = R028_PROGRAMS.get(name)
    # Skip programs outside the validated R-028 list.
    if not has_301_signal(text, ctx.filename) or not domain:
        result.skipped = "outside the two validated R-028 programs"
        return text, result

    target = r'libname data "&targetData\SDTM";'
    # Skip programs that already assign DATA to SCE SDTM.
    if re.search(r'^\s*libname\s+data\s+["\']&targetData\\SDTM["\']\s*;',
                 text, re.I | re.M):
        result.notes.append("DATA libref already assigned to SCE SDTM")
        return text, result

    lines = text.split("\n")
    # Insert the libname after the domain's jcepoch1 call.
    anchor = re.compile(
        r"^\s*%jcepoch1\s*\([^;\n]*\bdomain\s*=\s*" + re.escape(domain) +
        r"\b[^;\n]*\)\s*;\s*$", re.I)
    at = _find_line(lines, anchor)
    if at < 0:
        result.skipped = "validated JCEPOCH1 insertion anchor was not found"
        return text, result

    indent = re.match(r"^\s*", lines[at]).group(0)
    lines.insert(at + 1, indent + target)
    result.changes = 1
    return "\n".join(lines), result


def fix_r029_setup_driver(text: str, ctx: Context) -> tuple[str, Result]:
    """R-029 -- disable the standalone %setup; driver in validated chk_log.sas."""
    result = Result("R-029")
    # Skip programs other than the validated chk_log.sas files.
    if file_key(ctx.filename) != "chk_log.sas" or not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the two validated synthetic chk_log.sas programs"
        return text, result

    # Comment out the first active standalone %setup; line, keeping any carriage return.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
            continue
        if re.match(r"^\s*%setup\s*;\s*$", line, re.I):
            had_cr = line.endswith("\r")
            core = line[:-1] if had_cr else line
            indent = re.match(r"^\s*", core).group(0)
            body = core[len(indent):]
            lines[i] = indent + "/*" + body + "*/" + ("\r" if had_cr else "")
            result.changes = 1
            break
    return "\n".join(lines), result


def fix_r030_log_checker(text: str, ctx: Context) -> tuple[str, Result]:
    """R-030 -- rebuild the two validated synthetic SDTM/TLF chk_log drivers."""
    result = Result("R-030")
    # Skip programs other than the validated chk_log.sas files.
    if file_key(ctx.filename) != "chk_log.sas" or not has_synthetic_signal(text, ctx.filename):
        result.skipped = "outside the two validated synthetic chk_log.sas programs"
        return text, result

    # Idempotency: an SCE CHK_LOG path and reset PROC PRINTTO identify a rebuilt
    # driver even if the caller selected R-030 without the other startup rules.
    if re.search(r"%chk_log\s*\(\s*path\s*=\s*&targetStudy\.\\Dev\\Programs\\(?:SDTM|TLF)\s*\)",
                 text, re.I):
        result.notes.append("SCE log checker already present")
        return text, result

    lines = text.split("\n")
    sdtm_inc = r'%include "&targetStudy.\Dev\Programs\SDTM\autoexec.sas";'

    # R-005 may already have inserted this dependency into the generic startup
    # block. The paired chk_log programs place it with the rebuilt driver, so
    # carry that already-selected dependency into the R-030 block instead of
    # leaving a second startup fragment above it.
    had_sdtm_inc = False
    kept = []
    for line in lines:
        if line.strip().lower() == sdtm_inc.lower():
            had_sdtm_inc = True
            continue
        kept.append(line)
    lines = kept

    # Match the legacy PROC PRINTTO log-check start.
    legacy = re.compile(
        r'^\s*proc\s+printto\s+file\s*=\s*["\'][^"\']*programs[/\\]'
        r'(sdtm|tlf)[/\\][^"\']*check_log_result_(?:sdtm|tlf)\.lst["\']\s*;\s*$',
        re.I)

    # Find the legacy block and note whether it is SDTM or TLF.
    start = -1
    kind = ""
    for i, line in enumerate(lines):
        m = legacy.match(line)
        if m and not is_commented_line(line):
            start = i
            kind = m.group(1).lower()
            break
    if start < 0:
        result.skipped = "legacy SDTM/TLF PROC PRINTTO block was not found"
        return text, result

    # Confirm the block has the validated three-line shape.
    chk = start + 1
    run_at = start + 2
    if run_at >= len(lines) or not re.match(r"^\s*%chk_log\s*\(", lines[chk], re.I) \
            or not re.match(r"^\s*run\s*;\s*$", lines[run_at], re.I):
        result.skipped = "legacy three-line log-check block did not match the validated shape"
        return text, result

    # Keep the legacy block as comments and add the rebuilt driver after it.
    old = [comment_out(lines[start]), comment_out(lines[chk]), comment_out(lines[run_at])]

    list_inc = r'%include "&targetStudy.\Dev\Programs\Macros\list_files.sas";'
    chk_inc = r'%include "&targetStudy.\Dev\Programs\Macros\chk_log.sas";'
    # Build the SDTM driver block.
    if kind == "sdtm":
        new_block = old + [
            "",
            "",
            list_inc,
            chk_inc,
            sdtm_inc,
        ]
        new_block += [
            "",
            r'    print="&targetStudy.\Dev\Programs\SDTM\check_log_result_sdtm.lst";',
            "run;",
            "",
            r"%chk_log(path=&targetStudy.\Dev\Programs\SDTM);",
            "",
            "proc printto;",
            "run;",
        ]
    else:
        # R-005 supplies the SDTM autoexec include for the TLF driver. Keeping
        # it separate preserves the rule-book provenance and lets either rule
        # be tested independently.
        new_block = old + [
            "",
            "",
            list_inc,
            chk_inc,
        ]
        if had_sdtm_inc:
            new_block.append(sdtm_inc)
        new_block += [
            "proc printto",
            r'    print="&targetStudy.\Dev\Programs\ADaM\check_log_result_TLF.lst";',
            "run;",
            r"%chk_log(path=&targetStudy.\Dev\Programs\TLF);",
            "proc printto;",
            "run;",
        ]

    lines[start:run_at + 1] = new_block
    result.changes = 1
    return "\n".join(lines), result


def _replace_imaging_macro_calls(text: str, domains: set[str]) -> tuple[str, int]:
    """Replace validated X/UTIL_FETCHDATA imaging source calls and return edit count."""
    sas = SasText(text)
    edits: list[tuple[int, int, str]] = []
    # Replace rawdata fetches of imaging datasets with Ext datasets.
    for macro in ("util_getdata", "util_fetchdata"):
        for call in find_macro_calls(sas, macro):
            args = split_args(text[call.args_text_slice])
            if not args:
                continue
            m = re.fullmatch(r"\s*&([a-z0-9_]+)_ext_dataset\.?\s*", args[0], re.I)
            if not m:
                continue
            domain = m.group(1).lower()
            if domain not in domains:
                continue
            if not any(re.match(r"\s*libref\s*=\s*rawdata\s*$", a, re.I)
                       for a in args[1:]):
                continue
            new_args = ["Vendorimaginga_imaging_" + domain]
            for arg in args[1:]:
                lm = re.match(r"(\s*libref\s*=\s*)rawdata(\s*)$", arg, re.I)
                new_args.append((lm.group(1) + "Ext" + lm.group(2)) if lm else arg)
            edits.append((call.args_start, call.args_end, ",".join(new_args)))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
    return text, len(edits)


def fix_r031_vendorimaginga(text: str, ctx: Context) -> tuple[str, Result]:
    """R-031 -- resolve retained imaging sources to Vendorimaginga Ext datasets."""
    result = Result("R-031")
    name = file_key(ctx.filename)
    domains = R031_IMAGING_DOMAINS.get(name)
    # Skip programs outside the validated R-031 list, noting the t900rs.sas exception.
    if not has_301_signal(text, ctx.filename) or not domains:
        if name == "t900rs.sas":
            result.skipped = "t900rs.sas is the documented R-031 exception; L-035 disables its source calls"
        else:
            result.skipped = "outside the two validated R-031 programs"
        return text, result

    # Reroute the imaging macro calls first, then the direct set statements.
    original = text
    text, macro_edits = _replace_imaging_macro_calls(text, domains)

    lines = text.split("\n")
    if name == "t900co.sas":
        # UTIL_GETDATA materializes the selected source for the following work DATA step.
        for i, line in enumerate(lines):
            if re.search(r"^\s*set\s+&co_ext_dataset\.?\s*;\s*$", line, re.I):
                indent = re.match(r"^\s*", line).group(0)
                lines[i] = indent + "set Vendorimaginga_imaging_co;"
                break
    else:
        # TUVEND reads the three Ext datasets directly.
        data_at = _find_line(lines, re.compile(r"^\s*data\s+tuvend\s*;\s*$", re.I))
        run_at = _find_line(lines, re.compile(r"^\s*run\s*;\s*$", re.I),
                            data_at + 1 if data_at >= 0 else 0)
        if data_at >= 0 and run_at >= 0:
            for i in range(data_at, run_at + 1):
                for domain in ("rs", "tr", "tu"):
                    lines[i] = re.sub(
                        r"&" + domain + r"_ext_dataset\.?",
                        "Ext.Vendorimaginga_imaging_" + domain,
                        lines[i], flags=re.I)

        # The later TR loader creates a local work table named after the Ext
        # member, matching the paired SCE program.
        tr_at = _find_line(lines, re.compile(r"^\s*data\s+tr_uvis\s*;\s*$", re.I))
        tr_run = _find_line(lines, re.compile(r"^\s*run\s*;\s*$", re.I),
                            tr_at + 1 if tr_at >= 0 else 0)
        if tr_at >= 0 and tr_run >= 0:
            for i in range(tr_at, tr_run + 1):
                lines[i] = re.sub(r"&tr_ext_dataset\.?",
                                  "Vendorimaginga_imaging_tr", lines[i],
                                  flags=re.I)

    text = "\n".join(lines)
    # The workbook counts R-031 at the program/context level (two evidence rows),
    # although each validated context can contain several coordinated line edits.
    if text != original or macro_edits:
        result.changes = 1
    return text, result


def fix_l035_disable_rs_external(text: str, ctx: Context) -> tuple[str, Result]:
    """L-035 -- apply the documented t900rs.sas exception to R-031."""
    result = Result("L-035")
    # Skip every program except t900rs.sas.
    if not has_301_signal(text, ctx.filename) or file_key(ctx.filename) != "t900rs.sas":
        result.skipped = "outside the validated L-035 program"
        return text, result

    # Comment out the two external-source calls in t900rs.sas.
    sas = SasText(text)
    lines = text.split("\n")
    offset = 0
    patterns = [
        re.compile(r"^(\s*)%util_fetchdata\s*\(\s*&adj_ext_dataset\.?\s*,\s*libref\s*=\s*rawdata\s*,\s*sort\s*=\s*usubjid\s*\)\s*;", re.I),
        re.compile(r"^(\s*)%util_getdata\s*\(\s*&rs_ext_dataset\.?\s*,\s*libref\s*=\s*rawdata\s*,\s*sort\s*=\s*usubjid\s*,\s*engine\s*=\s*V9\s*\)\s*;", re.I),
    ]
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(start + first.start()):
            continue
        for pattern in patterns:
            m = pattern.search(line)
            if m:
                lines[i] = m.group(1) + "*" + line[len(m.group(1)):]
                result.changes += 1
                break
    return "\n".join(lines), result


def fix_r032_ild_ext(text: str, ctx: Context) -> tuple[str, Result]:
    """R-032 -- replace the two validated ILD CSV imports with SCE Ext data."""
    result = Result("R-032")
    name = file_key(ctx.filename)
    dataset = R032_ILD_DATASETS.get(name)
    # Skip programs outside the validated R-032 list.
    if not has_301_signal(text, ctx.filename) or not dataset:
        result.skipped = "outside the two validated R-032 programs"
        return text, result

    # The mapping is intentionally keyed by program: the consolidated rule book
    # records Vendorimaginga_ild for t900ae.sas and Vendorimagingb_ild for t900dd.sas.
    target_set = f"Ext.{dataset}"
    # Skip programs already routed through Ext.
    if re.search(r"^\s*set\s+" + re.escape(target_set) + r"\s*;\s*$",
                 text, re.I | re.M):
        result.notes.append("ILD source already routed through Ext")
        return text, result

    # Index each line's offset so comment-aware checks can run.
    lines = text.split("\n")
    sas = SasText(text)
    offsets = []
    off = 0
    for line in lines:
        offsets.append(off)
        off += len(line) + 1

    # Find the active ILD proc import.
    start = -1
    for i, line in enumerate(lines):
        first = re.search(r"\S", line)
        if not first or is_commented_line(line) or not sas.is_active(offsets[i] + first.start()):
            continue
        if re.search(r"^\s*proc\s+import\s+datafile\s*=\s*[\"'][^\"']*&ild_ext_dataset\.\.csv[\"']",
                     line, re.I):
            start = i
            break
    if start < 0:
        result.skipped = "validated active ILD PROC IMPORT was not found"
        return text, result

    # Find the import's run statement.
    run_at = _find_line(lines, re.compile(r"^\s*run\s*;\s*$", re.I), start + 1)
    if run_at < 0:
        result.skipped = "ILD PROC IMPORT RUN terminator was not found"
        return text, result

    # Preserve the legacy import as non-executable documentation, matching the
    # paired SCE examples, then materialize the same work dataset from Ext.
    out_name = "ILD"
    for j in range(start, run_at + 1):
        m = re.search(r"\bout\s*=\s*([A-Za-z_][A-Za-z0-9_]*)", lines[j], re.I)
        if m:
            out_name = m.group(1)
            break
    for j in range(start, run_at + 1):
        if lines[j].strip() and not is_commented_line(lines[j]):
            lines[j] = comment_out(lines[j])

    indent = re.match(r"^\s*", lines[start]).group(0)
    # comment_out() preserves leading indentation; for the new DATA step use the
    # original statement indentation, not the indentation inside the comment.
    indent = re.match(r"^\s*", text.split("\n")[start]).group(0)
    block = [
        "",
        indent + f"data {out_name};",
        indent + f"    set {target_set};",
        indent + "run;",
    ]
    lines[run_at + 1:run_at + 1] = block

    # t900ae.sas also disables the ILD-specific JCCHRP1 call in the paired SCE
    # program after replacing the CSV import. Treat this as a coordinated part
    # of the same validated R-032 context so the migrated source is functionally
    # aligned with the destination example.
    if name == "t900ae.sas":
        for i in range(run_at + 1 + len(block), min(len(lines), run_at + 1 + len(block) + 8)):
            if re.match(r"^\s*%jcchrp1\s*\(\s*indsn\s*=\s*ILD\s*,\s*outdsn\s*=\s*ILD\s*,\s*debug\s*=\s*N\s*\)\s*;\s*$",
                        lines[i], re.I):
                indent = re.match(r"^\s*", lines[i]).group(0)
                lines[i] = indent + "*" + lines[i][len(indent):]
                break

    result.changes = 1
    return "\n".join(lines), result


def fix_r033_vendorlabb_ext(text: str, ctx: Context) -> tuple[str, Result]:
    """R-033 -- route the two validated VendorLabB laboratory loads through Ext."""
    result = Result("R-033")
    name = file_key(ctx.filename)
    # Skip programs outside the validated R-033 list.
    if not has_301_signal(text, ctx.filename) or name not in R033_PROGRAMS:
        result.skipped = "outside the two validated R-033 programs"
        return text, result

    # Point the VendorLabB fetch at the Ext dataset.
    sas = SasText(text)
    edits: list[tuple[int, int, str]] = []
    for call in find_macro_calls(sas, "util_fetchdata"):
        args = split_args(text[call.args_text_slice])
        if not args or not re.fullmatch(r"\s*&vendor_labb_source\.?\s*", args[0], re.I):
            continue
        if not any(re.match(r"\s*libref\s*=\s*rawdata\s*$", a, re.I) for a in args[1:]):
            continue

        new_args = ["VendorLabB_lab"]
        for arg in args[1:]:
            m = re.match(r"(\s*libref\s*=\s*)rawdata(\s*)$", arg, re.I)
            new_args.append((m.group(1) + "Ext" + m.group(2)) if m else arg)
        edits.append((call.args_start, call.args_end, ",".join(new_args)))

    # Apply the edits from the end of the text.
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]

    # The paired SCE programs also update the downstream reference to the VendorLabB
    # source created/selected by the rerouted loader. Keep this coordinated with
    # R-033 so the generated program remains internally consistent.
    if edits:
        lines = text.split("\n")
        if name == "t900lb.sas":
            for i, line in enumerate(lines):
                if re.match(r"^\s*set\s+&vendor_labb_source\.?\s*;\s*$", line, re.I):
                    indent = re.match(r"^\s*", line).group(0)
                    lines[i] = indent + "set VendorLabB_lab;"
                    break
        elif name == "t900sv.sas":
            for i, line in enumerate(lines):
                if re.match(r"^\s*set\s+&vendor_labb_source\.?\s*\(", line, re.I):
                    lines[i] = re.sub(r"&vendor_labb_source\.?", "Ext.VendorLabB_lab", line, count=1, flags=re.I)
                    break
        text = "\n".join(lines)
        # R-033 is counted at the validated program/context level (two total
        # occurrences), not by every coordinated line edit within the context.
        result.changes = 1
    return text, result


# Map each rule ID to its fixer function.
FIXERS = {
    "R-001": fix_r001_macro_autoexec,
    "R-002": fix_r002_xudata_libref,
    "R-003": fix_r003_init,
    "R-004": fix_r004_xucvtds_libref,
    "R-005": fix_r005_sdtm_autoexec,
    "R-006": fix_r006_util_resize_xpt_resize,
    "R-007": fix_r007_setupanl,
    "R-008": fix_r008_mheadfoot,
    "R-009": fix_r009_tlf_autoexec,
    "R-010": fix_r010_bootstrap,
    "R-011": fix_r011_legacy_tlf_autoexec,
    "R-012": fix_r012_setupanl_source,
    "R-013": fix_r013_adam_xudata,
    "R-014": fix_r014_padam,
    "R-034": fix_r034_validation_libname,
    "R-015": fix_r015_mtrim,
    "R-016": fix_r016_adam_xpt,
    "R-035": fix_r035_sdtm_xpt,
    "R-017": fix_r017_workbook_inputs,
    "R-018": fix_r018_xpt_output,
    "R-019": fix_r019_rescreen,
    "L-032": fix_l032_rescreen_identifiers,
    "R-020": fix_r020_adam_spec,
    "R-021": fix_r021_data_case,
    "R-022": fix_r022_sdtm_xudata,
    "R-023": fix_r023_vendorpk_ext,
    "R-024": fix_r024_sdtm_qc,
    "R-025": fix_r025_vendorlab_ext,
    "L-034": fix_l034_disable_vendorlab_mb,
    "R-026": fix_r026_direct_adam,
    "R-027": fix_r027_vendortreatment_ext,
    "R-028": fix_r028_data_sdtm,
    "R-029": fix_r029_setup_driver,
    "R-030": fix_r030_log_checker,
    "R-031": fix_r031_vendorimaginga,
    "L-035": fix_l035_disable_rs_external,
    "R-032": fix_r032_ild_ext,
    "R-033": fix_r033_vendorlabb_ext,
    "R-037": fix_r037_comment_smart_quotes,
}


# ---------------------------------------------------------------------------
# Applying to a program
# ---------------------------------------------------------------------------

def apply_to_text(text: str, rule_ids: list[str], ctx: Context) -> tuple[str, list[Result]]:
    """Run selected rules and their linked logic over one program."""
    results = []
    ran_linked = set()
    # Run the selected rules in dependency order.
    for rule_id in [r for r in IMPLEMENTED if r in rule_ids]:
        fixer = FIXERS[rule_id]
        text, result = fixer(text, ctx)
        results.append(result)

        # Keep high-risk manual logic visible as its own result instead of
        # silently folding it into the parent rule.  R-019 therefore reports
        # source redirection and L-032 reports identifier/type adaptation.
        for logic_id in LINKED_LOGIC.get(rule_id, ()):
            logic_fixer = FIXERS[logic_id]
            text, logic_result = logic_fixer(text, ctx)
            results.append(logic_result)
            ran_linked.add(logic_id)

    # Also permit an explicit --rules L-032 run for focused regression testing.
    for logic_id in [r for r in ("L-032", "L-034", "L-035") if r in rule_ids and r not in ran_linked]:
        text, logic_result = FIXERS[logic_id](text, ctx)
        results.append(logic_result)
    return text, results


def read_text(path: Path) -> tuple[str, str]:
    """Read a program, returning its text and the encoding it was read with.

    Legacy SAS is often cp1252 rather than UTF-8 -- a Windows en dash in a title
    is enough to make a strict UTF-8 read fail. The file is written back in the
    encoding it was read in, so a program that was cp1252 stays cp1252.
    """
    raw = path.read_bytes()
    for encoding in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace"), "latin-1"


# List .sas files for a program or folder, skipping earlier output.
def collect_programs(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    if not target.is_dir():
        raise SystemExit(f"No such program or folder: {target}")
    # Never descend into an output folder from an earlier run.
    return sorted(p for p in target.glob("*.sas") if p.parent.name != OUTPUT_DIRNAME)


# Apply the rules to one program, write the result, and build its report row.
def apply_to_program(path: Path, rule_ids: list[str], params: dict,
                     out_dir: Path, dry_run: bool, show_diff: bool) -> dict:
    # Read the program and run the selected rules.
    original, encoding = read_text(path)
    ctx = Context(filename=path.name, params=params)
    fixed, results = apply_to_text(original, rule_ids, ctx)

    # Start the report row with per-rule change counts.
    total = sum(r.changes for r in results)
    row = {
        "program": path.name,
        "folder": str(path.parent),
        "total": total,
        "encoding": encoding,
        "output": "",
    }
    for result in results:
        row[result.rule_id] = result.changes

    # Write the fixed program to the output folder unless this is a dry run.
    if total and not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        destination = out_dir / path.name
        # newline="" so the program's own line endings survive the round trip;
        # a CRLF program rewritten with LF shows as a whole-file diff in Git.
        with open(destination, "w", encoding=encoding, newline="") as handle:
            handle.write(fixed)
        row["output"] = str(destination)

    # Collect skip reasons and notes for the report.
    notes = []
    for result in results:
        if result.skipped:
            notes.append(f"{result.rule_id}: skipped, {result.skipped}")
        for note in result.notes:
            notes.append(f"{result.rule_id}: {note}")
    row["notes"] = " | ".join(notes)

    # Print a unified diff of the changes.
    if show_diff and total:
        print(f"\n--- {path.name} " + "-" * max(0, 60 - len(path.name)))
        diff = difflib.unified_diff(
            original.splitlines(), fixed.splitlines(),
            fromfile=f"{path.name} (original)", tofile=f"{path.name} (Migrate Studio)",
            lineterm="", n=2)
        for line in diff:
            print(line)

    return row


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# Parse NAME=VALUE overrides into a dictionary.
def parse_params(pairs: list[str]) -> dict:
    params = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise SystemExit(f"--param needs NAME=VALUE, got: {pair}")
        name, value = pair.split("=", 1)
        params[name.strip()] = value
    return params


# Parse options, then run the MC rules and the legacy workbook rules.
def main(argv=None) -> int:
    # Define the command-line options.
    parser = argparse.ArgumentParser(
        prog="mig_apply.py",
        description="Apply Migrate Studio migration rules to SAS programs, writing the "
                    "results into a Migrate_Studio subfolder.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    parser.add_argument("target", type=Path, nargs="?",
                        help="a .sas program, or a folder of them")
    parser.add_argument("--rules", default=",".join(IMPLEMENTED),
                        help=f"rules to apply (default: {','.join(IMPLEMENTED)})")
    parser.add_argument("--rules-file", type=Path, default=DEFAULT_RULES_FILE,
                        help="Migrate_Studio_Rules.xlsx (default: beside this tool)")
    parser.add_argument("--out", default=OUTPUT_DIRNAME,
                        help=f"output subfolder name (default: {OUTPUT_DIRNAME})")
    parser.add_argument("--param", action="append", metavar="NAME=VALUE",
                        help="a value for an After-pattern parameter, "
                             "e.g. --param ADAM_LIBREF=adam")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change without writing anything")
    parser.add_argument("--diff", action="store_true",
                        help="print a unified diff of every changed program")
    parser.add_argument("--list", action="store_true",
                        help="list the rules in the workbook and exit")
    args = parser.parse_args(sys.argv[1:] if argv is None else list(argv))

    # Load the legacy rule book when it exists.
    rules = load_rules(args.rules_file) if args.rules_file.exists() else []

    # List the legacy rules and mark the implemented ones.
    if args.list:
        if not rules:
            print(f"No rule book at {args.rules_file}", file=sys.stderr)
            return 1
        print(f"{args.rules_file.name} — {len(rules)} rules\n")
        for rule in rules:
            mark = "*" if rule.implemented else " "
            print(f" {mark} {rule.id:<8} {rule.name[:46]:<46} {rule.category[:28]}")
        print("\n  * implemented by mig_apply")
        return 0

    # Require a target unless listing.
    if args.target is None:
        parser.error("a program or folder is required (or use --list)")

    # Validate the requested rule IDs.
    requested = [r.strip().upper() for r in args.rules.split(",") if r.strip()]
    unknown = [r for r in requested if r not in FIXERS]
    if unknown:
        print(f"mig_apply does not implement: {', '.join(unknown)}\n"
              f"Implemented: {', '.join(IMPLEMENTED)}", file=sys.stderr)
        return 2

    # Collect parameters and programs.
    by_id = {rule.id: rule for rule in rules}
    params = parse_params(args.param)
    programs = collect_programs(args.target)

    if not programs:
        print(f"No .sas programs in {args.target}", file=sys.stderr)
        return 1

    # Print the run header.
    print(f"Migrate Studio — {len(programs)} program{'' if len(programs) == 1 else 's'} "
          f"from {args.target}")
    for rule_id in requested:
        rule = by_id.get(rule_id)
        print(f"    {rule_id}  {rule.name if rule else '(not in the workbook)'}")
    if params:
        print("  parameters: " +
              ", ".join(f"{k}={v}" for k, v in sorted(params.items())))
    print()

    # Apply the rules to each program.
    base = args.target.parent if args.target.is_file() else args.target
    out_dir = base / args.out

    rows = []
    for program in programs:
        rows.append(apply_to_program(program, requested, params, out_dir,
                                     args.dry_run, args.diff))

    # Print the per-program change table.
    changed = [r for r in rows if r["total"]]
    print(f"\n{'program':<28}{'total':>6}  " +
          "".join(f"{r:>7}" for r in requested))
    print("-" * (36 + 7 * len(requested)))
    for row in rows:
        if not row["total"]:
            continue
        print(f"{row['program']:<28}{row['total']:>6}  " +
              "".join(f"{row.get(r, 0):>7}" for r in requested))
    print("-" * (36 + 7 * len(requested)))
    print(f"{'':<28}{sum(r['total'] for r in rows):>6}")

    print(f"\n{len(changed)} of {len(programs)} programs changed"
          f"{' (dry run, nothing written)' if args.dry_run else ''}.")

    # Write the CSV report.
    if changed and not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        report = out_dir / "mig_report.csv"
        columns = ["program", "folder", "total"] + requested + ["encoding",
                                                                "output", "notes"]
        with open(report, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow({c: row.get(c, "") for c in columns})
        print(f"Written to {out_dir}")
        print(f"Report:    {report}")

    # Print the skip reasons and notes.
    notes = [r["notes"] for r in rows if r.get("notes")]
    if notes:
        print("\nNotes:")
        for row in rows:
            if row.get("notes"):
                print(f"  {row['program']}: {row['notes']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
