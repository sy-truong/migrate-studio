#!/usr/bin/env python3
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Scan publishable files without printing potential credential values.

Uses Git's file inventory so ignored user data and dependency caches never enter
an exported source tree. Pattern scanning is a review aid, not a secret detector
with complete coverage. Put organization-specific patterns in `.release-scan-private.txt` (git-ignored)
before each release.
"""
from __future__ import annotations
import argparse
import fnmatch
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

# Resolve the repository root from this script's location.
ROOT = Path(__file__).resolve().parents[1]
# Name directories that must never ship in a source release.
FORBIDDEN_PARTS = {".git", "__pycache__", ".pytest_cache", ".venv", "venv", "node_modules", "dist", "build", ".idea", ".vscode", "manual_assets"}
# Name files that indicate local state or credentials.
FORBIDDEN_NAMES = {".DS_Store", ".Rhistory", ".RData", ".Rapp.history", ".Renviron", ".env", "history.json", "backup_roots.json", "current_selections.json"}
# Define generic regexes that detect credentials. Organization-specific patterns
# (client names, personal paths) live in an untracked private file; see below.
PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "provider credential": re.compile(r"\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{32,})\b"),
    "credential URL": re.compile(r"(?:https?|sftp)://[^\s/]+:[^\s/@]+@|[?&](?:access_token|client_secret|password|api_key)=[^\s&\"<>]+", re.I),
    "credential assignment": re.compile(r'''["']?(?:password|client_secret|api_key|access_token)["']?\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']''', re.I),
}


# Load private regexes (one per line, # comments allowed) from an untracked file so
# client names and personal paths never appear in the public repository.
PRIVATE_PATTERNS_FILE = Path(os.environ.get("RELEASE_SCAN_PRIVATE_PATTERNS", ROOT / ".release-scan-private.txt"))
if PRIVATE_PATTERNS_FILE.is_file():
    for number, line in enumerate(PRIVATE_PATTERNS_FILE.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if line and not line.startswith("#"):
            PATTERNS[f"private pattern (line {number})"] = re.compile(line, re.I)


# List publishable files, preferring Git's inventory.
def source_files():
    if (ROOT / ".git").exists():
        result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, check=True, capture_output=True)
        return sorted({ROOT / name for name in result.stdout.decode().split("\0") if name and (ROOT / name).is_file()})
    # Downloaded source archives have no Git metadata. Apply this project's
    # simple ignore rules in order, including its explicit .gitkeep exceptions.
    rules = [line.strip() for line in (ROOT / ".gitignore").read_text().splitlines()
             if line.strip() and not line.startswith("#")]
    files = []
    # Walk the tree and prune forbidden directories.
    for folder, dirs, names in os.walk(ROOT, followlinks=False):
        dirs[:] = [d for d in dirs if d not in FORBIDDEN_PARTS]
        for name in names:
            path = Path(folder) / name
            rel = path.relative_to(ROOT).as_posix()
            ignored = False
            # Apply ignore rules in order so later negations win.
            for rule in rules:
                negate = rule.startswith("!")
                pattern = rule.lstrip("!").rstrip("/")
                matches = fnmatch.fnmatch(rel, pattern) if "/" in pattern else any(fnmatch.fnmatch(part, pattern) for part in path.relative_to(ROOT).parts)
                if matches: ignored = not negate
            if not ignored: files.append(path)
    return sorted(files)


# Flag symlinks, sensitive files, oversized files, and pattern matches.
def scan(files):
    failures = []
    for path in files:
        rel = path.relative_to(ROOT)
        if path.is_symlink():
            failures.append((str(rel), "symlink must be reviewed before publishing"))
            continue
        if set(rel.parts) & FORBIDDEN_PARTS or path.name in FORBIDDEN_NAMES or path.name.startswith('.env.') or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".exe", ".dll", ".log", ".pyc"}:
            failures.append((str(rel), "non-source or sensitive file"))
        if path.stat().st_size > 5 * 1024 * 1024:
            failures.append((str(rel), "file exceeds 5 MiB; review before publishing"))
        # Read workbook XML parts because xlsx files are zip archives.
        if path.suffix == ".xlsx":
            with zipfile.ZipFile(path) as workbook:
                texts = [(name, workbook.read(name).decode("utf-8", errors="replace")) for name in workbook.namelist() if name.endswith((".xml", ".rels"))]
        else:
            data = path.read_bytes()
            if b"\0" in data: continue
            texts = [("", data.decode("utf-8", errors="replace"))]
        # Match every credential pattern against each text part.
        for member, text in texts:
            for label, pattern in PATTERNS.items():
                if pattern.search(text): failures.append((str(rel) + (":" + member if member else ""), label))
    return failures


# Run each edition's Python, JavaScript, and R test suites.
def run_tests():
    for edition in ("migrate-studio-python", "migrate-studio-r-shiny"):
        folder = ROOT / edition
        suite = ["tests/python", "python/test_mig_apply.py"] if edition.endswith("python") else ["python"]
        subprocess.run([sys.executable, "-m", "pytest", "-q", *suite], cwd=folder, check=True)
        for test in sorted((folder / "tests/js").glob("*.js")):
            subprocess.run(["node", str(test)], cwd=folder, check=True)
    # Point reticulate at the current interpreter for the R tests.
    env = dict(os.environ, RETICULATE_PYTHON=sys.executable)
    subprocess.run(["Rscript", "tools/run_r_tests.R"], cwd=ROOT / "migrate-studio-r-shiny", env=env, check=True)


# Parse options, scan files, and optionally run tests and build an archive.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tests", action="store_true")
    parser.add_argument("--archive", type=Path, help="write a source ZIP without Git history or ignored files")
    args = parser.parse_args()
    files = source_files()
    # Scan every file and report findings without echoing matched values.
    failures = scan(files)
    for path, label in failures: print(f"{path}: {label}", file=sys.stderr)
    if failures: return 1
    print(f"Release scan passed: {len(files)} publishable files (including workbook XML).")
    if args.tests: run_tests()
    # Write a source ZIP outside the inventory when requested.
    if args.archive:
        target = args.archive.resolve()
        if target in files: raise ValueError("Archive output must be outside the source inventory")
        target.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in files: archive.write(path, "migrate-studio/" + path.relative_to(ROOT).as_posix())
        print(f"Source archive written to {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
