#!/usr/bin/env python3
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Build the bundled synthetic history fixture for tests."""

from __future__ import annotations

import json
from pathlib import Path


# Resolve the edition root and the fixture output path.
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "history.sample.json"
# Define the synthetic timezone and user recorded in each run.
TZ = "America/Los_Angeles"
USER = {"name": "Test User", "email": "test@example.com"}


# List synthetic program names for each study folder.
PROGRAMS = {
    "sdtm": ["dm.sas", "ae.sas", "suppae.sas", "autoexec.sas"],
    "adam": ["adsl.sas", "adae.sas", "adlb.sas", "autoexec.sas"],
    "tlf": ["t-ae-overall.sas", "t-lb-shift.sas", "autoexec.sas"],
}


# Build one synthetic rule-change record.
def detail(rule: str, idx: int) -> dict:
    # Create paired Windows and Linux example paths.
    win = rf"C:\ClinicalStudies\EXAMPLE001\programs\input{idx}.sas"
    lin = f"/clinicalstudies/EXAMPLE001/programs/input{idx}.sas"
    return {
        "ruleId": rule,
        "ruleName": {
            "S5": "Windows path backslash",
            "O4": "Standard setup macro",
            "F1": "TOC Casing",
            "R-003": "Library path update",
        }.get(rule, "Synthetic rule"),
        "category": "Synthetic",
        "severity": "Auto-fix",
        "type": "Changed",
        "originalLine": idx + 4,
        "fixedLine": idx + 4,
        "before": f'filename src "{win}";',
        "after": f'filename src "{lin}";',
    }


# Build a synthetic program entry with its rule applications.
def program(name: str, folder: str, run_idx: int, rules: list[str]) -> dict:
    applications = len(rules)
    return {
        "name": name,
        "folder": folder,
        "versionId": f"v{run_idx}",
        "applications": applications,
        "lines": applications,
        "rules": rules,
        "ruleCounts": {rule: 1 for rule in rules},
        "details": [detail(rule, i + run_idx) for i, rule in enumerate(rules)],
    }


# Build one synthetic apply-fix run record.
def run(run_idx: int, folder: str, stamp: str, names: list[str], source: str) -> dict:
    # Choose rule IDs by folder type.
    rules = ["S5", "O4"] if folder != "tlf" else ["F1", "S5"]
    programs = [
        program(name, folder, run_idx + i, rules[: 1 + (i % len(rules))])
        for i, name in enumerate(names)
    ]
    # Total the applications and list the targeted programs.
    total_apps = sum(item["applications"] for item in programs)
    targeted = [{"name": item["name"], "folder": folder} for item in programs]
    # Assemble the run record with metadata and totals.
    return {
        "runId": f"run-{run_idx:03d}",
        "action": "apply-fix",
        "appliedAt": stamp,
        "appliedAtLocal": stamp.replace("T", " ").replace(".000Z", " PDT"),
        "timezone": TZ,
        "user": dict(USER),
        "client": "browser",
        "osFamily": "Windows" if folder == "sdtm" else "Linux",
        "pathRoot": f"/clinicalstudies/EXAMPLE001/{folder}",
        "rootFolder": folder,
        "folders": [folder],
        "migrationLabel": f"EXAMPLE001 {folder.upper()} migration",
        "ruleBook": "Migrate_Studio_Rules.xlsx",
        "ruleSource": source,
        "rulesSelected": sorted(set(r for item in programs for r in item["rules"])),
        "rules": sorted(set(r for item in programs for r in item["rules"])),
        "targetedPrograms": targeted,
        "programs": programs,
        "totals": {
            "applications": total_apps,
            "programs": len(programs),
            "lines": total_apps,
            "added": sum(
                1
                for item in programs
                for change in item["details"]
                if change["type"] == "Added"
            ),
            "changed": total_apps,
            "removed": 0,
        },
    }


# Create seven runs across the sdtm, adam, and tlf folders.
def build() -> dict:
    runs = [
        run(1, "sdtm", "2026-09-04T16:00:00.000Z", ["dm.sas", "ae.sas"], "mc"),
        run(2, "adam", "2026-09-06T17:30:00.000Z", ["adsl.sas"], "mc"),
        run(3, "tlf", "2026-09-09T18:45:00.000Z", ["t-ae-overall.sas"], "workbook"),
        run(4, "sdtm", "2026-09-12T15:15:00.000Z", ["suppae.sas", "autoexec.sas"], "mc"),
        run(5, "adam", "2026-09-15T19:20:00.000Z", ["adae.sas", "adlb.sas"], "mc"),
        run(6, "tlf", "2026-09-19T20:05:00.000Z", ["t-lb-shift.sas"], "workbook"),
        run(7, "adam", "2026-09-22T21:10:00.000Z", ["autoexec.sas"], "mc"),
    ]
    return {"schema": "migrate-studio/history", "version": 1, "runs": runs}


# Write the fixture JSON to disk.
def main() -> None:
    OUT.write_text(json.dumps(build(), indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
