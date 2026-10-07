#!/usr/bin/env python3
"""Check the local Python edition runtime.

Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


# Locate the edition root one level above tools/.
ROOT = Path(__file__).resolve().parent.parent
# Set the minimum supported Python version.
MIN_PYTHON = (3, 9)


# Report whether a module can be imported.
def module_status(name: str) -> str:
    return "ok" if importlib.util.find_spec(name) else "missing"


# Print runtime and file checks and return a process exit code.
def main() -> int:
    ok = True
    print(f"Python: {sys.version.split()[0]}")
    # Fail when the interpreter is older than the minimum.
    if sys.version_info < MIN_PYTHON:
        print(f"ERROR: Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required")
        ok = False
    # Verify required third-party modules are installed.
    for module in ("openpyxl",):
        status = module_status(module)
        print(f"{module}: {status}")
        ok = ok and status == "ok"
    # Verify the bundled web and rule files exist.
    for rel in (
        "www/index.html",
        "www/js/migrate-studio.js",
        "rules/Migrate_Studio_Rules.xlsx",
        "rules/migration_rules.json",
    ):
        exists = (ROOT / rel).exists()
        print(f"{rel}: {'ok' if exists else 'missing'}")
        ok = ok and exists
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
