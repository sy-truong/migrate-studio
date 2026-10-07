#!/usr/bin/env python3
"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0

Migrate Studio -- start here.

    python migrate_studio.py

That is the whole command. It serves this folder on localhost and opens Migrate Studio
in your browser. Pick a folder of SAS programs, choose which rules to apply on
the Rules tab, and press Apply Fix.

Why a server at all, when index.html is a static page? Because the browser API
Migrate Studio uses to read and write a folder of programs only works in a secure
context, and a page opened straight off disk over file:// is not one. Served
from localhost it is, so the Folder button can do the whole job -- read the
programs and write the fixed ones back -- instead of falling back to a download.
Serving also lets Migrate Studio load Migrate_Studio_Rules.xlsx from this folder at startup,
so the rule book is there before you pick anything.

Other things you can do:

    python migrate_studio.py --port 9100      # serve on a particular port
    python migrate_studio.py --host 0.0.0.0   # let another machine reach it
    python migrate_studio.py --programs /studies/EXAMPLE001  # find this study root quickly
    python migrate_studio.py --no-open        # serve without opening a browser
    python migrate_studio.py --check          # summarise the rule book and exit
    python migrate_studio.py --data-dir D:/ms_data   # keep history elsewhere
    python migrate_studio.py --import-legacy-history # bring in an old history.json

Run history, the last folder picked and the backup cache are written to a
per-user folder, not beside this script:

    Windows  %LOCALAPPDATA%\\Migrate Studio
    macOS    ~/Library/Application Support/Migrate Studio
    Linux    $XDG_DATA_HOME/Migrate Studio  (else ~/.local/share/Migrate Studio)

Requires Python 3.9+ and nothing else. `--check` reads the workbook, which
needs openpyxl; it says so and stops if that is missing, rather than installing
anything behind your back.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import http.server
import json
import os
import platform
import secrets
import shutil
import socket
import socketserver
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional
from urllib.parse import urlsplit, unquote

# Locate the edition folder and its web, rules, and workbook paths.
ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "www"
RULES_DIR = ROOT / "rules"
RULES = RULES_DIR / "Migrate_Studio_Rules.xlsx"
MC_RULES = RULES_DIR / "migration_rules.json"
HOUSE_RULES = RULES_DIR / "migrate_studio_rules.json"

# Name the app and the per-user data files it writes.
APP_NAME = "Migrate Studio"
DATA_DIR_ENV = "MIGRATE_STUDIO_DATA_DIR"
HISTORY_NAME = "history.json"
SELECTIONS_NAME = "current_selections.json"
BACKUP_CACHE_NAME = "backup_roots.json"
LEGACY_HISTORY = ROOT / HISTORY_NAME


def default_data_dir(platform: Optional[str] = None,
                     env: Optional[dict] = None,
                     home: Optional[Path] = None) -> Path:
    """Per-user, per-OS folder for the files Migrate Studio writes."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    if platform.startswith("win"):
        base = str(env.get("LOCALAPPDATA") or "").strip()
        root = Path(base) if base else home / "AppData" / "Local"
    elif platform == "darwin":
        root = home / "Library" / "Application Support"
    else:
        xdg = str(env.get("XDG_DATA_HOME") or "").strip()
        root = Path(xdg) if xdg and PurePosixPath(xdg).is_absolute() \
            else home / ".local" / "share"
    return root / APP_NAME


def resolve_data_dir(cli_value: Optional[str] = None,
                     env: Optional[dict] = None) -> Path:
    """--data-dir wins, then MIGRATE_STUDIO_DATA_DIR, then the OS default."""
    env = os.environ if env is None else env
    chosen = str(cli_value or env.get(DATA_DIR_ENV) or "").strip()
    path = Path(chosen).expanduser() if chosen else default_data_dir(env=env)
    return path.resolve()


def configure_data_dir(path: Path) -> Path:
    """Create the data folder and point the three data files at it."""
    global DATA_DIR, HISTORY, SELECTIONS, BACKUP_RESOLUTION_CACHE
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    DATA_DIR = path
    HISTORY = path / HISTORY_NAME
    SELECTIONS = path / SELECTIONS_NAME
    BACKUP_RESOLUTION_CACHE = path / BACKUP_CACHE_NAME
    return path


# Paths only -- nothing is created until main() calls configure_data_dir().
DATA_DIR = resolve_data_dir()
HISTORY = DATA_DIR / HISTORY_NAME
SELECTIONS = DATA_DIR / SELECTIONS_NAME
BACKUP_RESOLUTION_CACHE = DATA_DIR / BACKUP_CACHE_NAME

# Guard shared state: history writes, backups, allowed roots, and root tokens.
HISTORY_LOCK = threading.Lock()
BACKUP_DIR = "_migrate_original"
BACKUP_LOCK = threading.Lock()
ALLOWED_PROGRAM_ROOTS: list[Path] = []
BACKUP_ROOT_TOKENS: dict[str, Path] = {}
# Bound the folder search by skipped names, depth, directory count, and time.
SEARCH_PRUNE_DIRS = {
    BACKUP_DIR, "Migrate_Studio", "PortFix", "node_modules", ".git",
}
SEARCH_MAX_DEPTH = 4
SEARCH_MAX_DIRS = 20000
SEARCH_TIME_BUDGET = 2.0
# Cap history size and identify this server session.
MAX_HISTORY_RUNS = 500
SESSION_ID = uuid.uuid4().hex[:12]
SERVER_STARTED_AT = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

# Set the minimum supported Python version.
MIN_PYTHON = (3, 9)

#: TLF Studio owns 8770-8819. Migrate Studio takes the next block so both can run at
#: once, which is the normal state of affairs on a migration.
START_PORT = 8820
END_PORT = 8869

#: Files that must exist for the page to work at all. Checked before serving,
#: because "it opened but the screen is blank" is a much worse error message
#: than "js/migrate-studio.js is missing".
REQUIRED = [
    "www/index.html",
    "www/css/migrate-studio.css",
    "www/css/theme.css",
    "www/js/mig-excel.js",
    "www/js/mig-rules.js",
    "www/js/mig-mc-rules.js",
    "www/js/mig-diff.js",
    "www/js/migrate-studio.js",
    "rules/Migrate_Studio_Rules.xlsx",
    "rules/migration_rules.json",
    "rules/migrate_studio_rules.json",
    "www/js/vendor/fflate.min.js",
]


# Append a run to history.json, recovering from a corrupt file and ignoring duplicates.
def append_history_run(run: dict, history_path: Optional[Path] = None,
                       max_runs: int = MAX_HISTORY_RUNS) -> dict:
    # Reject runs that lack a run ID.
    if not isinstance(run, dict) or not run.get("runId"):
        return {"ok": False, "status": 400, "error": "runId is required"}
    history_path = Path(history_path or HISTORY)
    history_path.parent.mkdir(parents=True, exist_ok=True)
    # Start with an empty history envelope.
    book = {"schema": "migrate-studio/history", "version": 1, "runs": []}
    # Load existing history, accepting the envelope or a bare list.
    if history_path.exists():
        try:
            loaded = json.loads(history_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and isinstance(loaded.get("runs"), list):
                book = loaded
            elif isinstance(loaded, list):
                book["runs"] = loaded
        # Set aside an unreadable history file under a unique name.
        except (json.JSONDecodeError, OSError):
            corrupt = history_path.with_suffix(".corrupt.json")
            if corrupt.exists():
                suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                corrupt = history_path.with_name(
                    f"{history_path.stem}.corrupt-{suffix}.json"
                )
            history_path.replace(corrupt)
    # Skip a run whose ID appears in the last 50 runs.
    if any(r.get("runId") == run["runId"] for r in book["runs"][-50:]):
        return {"ok": True, "duplicate": True, "runs": len(book["runs"])}
    # Append the run and trim to the newest max_runs.
    book["runs"].append(run)
    if len(book["runs"]) > max_runs:
        book["runs"] = book["runs"][-max_runs:]
    # Write atomically through a temp file.
    tmp = history_path.with_name(history_path.name + ".tmp")
    tmp.write_text(json.dumps(book, indent=2) + "\n", encoding="utf-8")
    tmp.replace(history_path)
    return {"ok": True, "runs": len(book["runs"])}


# Read the run list from a history file, if it exists.
def _history_runs(path: Path) -> list:
    if not path.is_file():
        return []
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(loaded, dict) and isinstance(loaded.get("runs"), list):
        return loaded["runs"]
    return loaded if isinstance(loaded, list) else []


def import_legacy_history(legacy: Path, target: Optional[Path] = None,
                          max_runs: int = MAX_HISTORY_RUNS) -> dict:
    """Merge runs from an old app-folder history.json into this user's file.

    Explicit and one-way: copies, never moves or edits the legacy file, skips
    runs already present (by runId), and is safe to run more than once.
    """
    legacy = Path(legacy)
    target = Path(target or HISTORY)
    if not legacy.is_file():
        return {"ok": False, "error": f"no history file at {legacy}"}
    if legacy.resolve() == target.resolve():
        return {"ok": False, "error": "legacy and target are the same file"}
    legacy_runs = _history_runs(legacy)
    # Merge runs not already present, ordered by time, and write atomically.
    with HISTORY_LOCK:
        current = _history_runs(target)
        seen = {r.get("runId") for r in current if isinstance(r, dict)}
        added = []
        for run in legacy_runs:
            if isinstance(run, dict) and run.get("runId") and run["runId"] not in seen:
                seen.add(run["runId"])
                added.append(run)
        merged = sorted(current + added,
                        key=lambda r: str(r.get("appliedAt", "")))[-max_runs:]
        target.parent.mkdir(parents=True, exist_ok=True)
        book = {"schema": "migrate-studio/history", "version": 1, "runs": merged}
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(book, indent=2) + "\n", encoding="utf-8")
        tmp.replace(target)
    return {"ok": True, "imported": len(added),
            "skipped": len(legacy_runs) - len(added), "target": str(target)}


def whoami() -> dict:
    """Return the OS account that started this local Migrate Studio server."""
    try:
        account = getpass.getuser()
    except Exception:                       # noqa: BLE001 - identity is optional
        account = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    account = str(account).strip()
    return {
        "ok": True,
        "userId": account,
        "userKey": account.lower(),
        "source": "os" if account else "unknown",
        "host": socket.gethostname(),
        "os": platform.system(),
        "sessionId": SESSION_ID,
        "serverStartedAt": SERVER_STARTED_AT,
        "dataDir": str(DATA_DIR),
    }


# Carry an HTTP status with a backup request error.
class BackupRequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def configure_program_roots(paths: list[str] | tuple[str, ...]) -> None:
    """Set the source roots the browser is allowed to ask the server to back up."""
    global ALLOWED_PROGRAM_ROOTS
    ALLOWED_PROGRAM_ROOTS = [Path(path).expanduser().resolve() for path in paths]


# Hash a fingerprint into a stable key.
def fingerprint_hash(fingerprint: dict) -> str:
    canonical = json.dumps(fingerprint or {}, sort_keys=True,
                           separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# Combine the folder name and fingerprint hash into a cache key.
def cache_key(folder_name: str, fingerprint: dict) -> str:
    return f"{str(folder_name or '').strip()}:{fingerprint_hash(fingerprint)}"


# Load the folder resolution cache, ignoring unreadable files.
def load_backup_resolution_cache() -> dict:
    try:
        loaded = json.loads(BACKUP_RESOLUTION_CACHE.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


# Save the resolution cache atomically.
def save_backup_resolution_cache(cache: dict) -> None:
    BACKUP_RESOLUTION_CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = BACKUP_RESOLUTION_CACHE.with_name(BACKUP_RESOLUTION_CACHE.name + ".tmp")
    tmp.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    tmp.replace(BACKUP_RESOLUTION_CACHE)


# Issue an opaque token that stands for a resolved folder.
def mint_root_token(path: Path) -> str:
    token = secrets.token_urlsafe(18)
    BACKUP_ROOT_TOKENS[token] = path.resolve()
    return token


# Reject absolute paths and dot segments in a relative folder.
def clean_rel_folder(folder: str) -> str:
    text = str(folder or "").strip().replace("\\", "/")
    rel = Path(text)
    if rel.is_absolute():
        raise BackupRequestError(400, "folder must be relative")
    if any(part in ("", ".", "..") for part in rel.parts):
        raise BackupRequestError(400, "folder contains an invalid path segment")
    return text


# Match a requested root against the --programs allowlist.
def resolve_allowed_root(root: str) -> Path:
    try:
        requested = Path(str(root or "")).expanduser().resolve()
    except (OSError, RuntimeError) as exc:
        raise BackupRequestError(400, f"invalid root: {exc}") from exc
    for allowed in ALLOWED_PROGRAM_ROOTS:
        if requested == allowed.resolve():
            return allowed.resolve()
    raise BackupRequestError(403, "root is not in the --programs allowlist")


# Join a folder to the base and reject escapes or missing folders.
def safe_join(base: Path, folder: str) -> Path:
    text = clean_rel_folder(folder)
    rel = Path(text)
    try:
        target = (base / rel).resolve() if text else base.resolve()
        target.relative_to(base.resolve())
    except (OSError, RuntimeError, ValueError) as exc:
        raise BackupRequestError(400, "folder escapes the selected root") from exc
    if not target.is_dir():
        raise BackupRequestError(400, "folder does not exist")
    return target


# Validate a bare .sas file name and return its resolved path.
def safe_child(directory: Path, name: str) -> Path:
    text = str(name or "").strip()
    if not text or "/" in text or "\\" in text or text in (".", ".."):
        raise BackupRequestError(400, "file name must be a bare filename")
    path = Path(text)
    if path.name != text or path.suffix.lower() != ".sas":
        raise BackupRequestError(400, "file name must be a .sas filename")
    candidate = directory / path.name
    if candidate.is_symlink():
        raise BackupRequestError(400, "source symlinks are not supported")
    try:
        src = candidate.resolve()
        src.relative_to(directory.resolve())
    except (OSError, RuntimeError, ValueError) as exc:
        raise BackupRequestError(400, "file escapes the requested folder") from exc
    if not src.is_file():
        raise BackupRequestError(400, "source file does not exist")
    return src


# Validate and normalize a folder fingerprint from the browser.
def normalized_fingerprint(fingerprint: dict) -> dict:
    if not isinstance(fingerprint, dict):
        raise BackupRequestError(400, "fingerprint must be an object")
    out = {}
    for folder, records in fingerprint.items():
        clean = clean_rel_folder(folder)
        if not isinstance(records, list):
            raise BackupRequestError(400, "fingerprint entries must be lists")
        rows = []
        seen = set()
        for record in records:
            if not isinstance(record, dict):
                raise BackupRequestError(400, "fingerprint file entry must be an object")
            name = str(record.get("name", "")).strip()
            if not name or "/" in name or "\\" in name or name in (".", ".."):
                raise BackupRequestError(400, "fingerprint file name must be bare")
            path = Path(name)
            if path.name != name or path.suffix.lower() != ".sas":
                raise BackupRequestError(400, "fingerprint file name must be .sas")
            if name in seen:
                raise BackupRequestError(400, "duplicate fingerprint file")
            seen.add(name)
            try:
                size = int(record.get("size", 0))
                mtime = float(record.get("lastModified", record.get("modified", 0)))
            except (TypeError, ValueError) as exc:
                raise BackupRequestError(400, "invalid fingerprint metadata") from exc
            rows.append({"name": name, "size": size, "lastModified": mtime})
        out[clean] = sorted(rows, key=lambda row: row["name"].lower())
    return dict(sorted(out.items()))


# Confirm a folder holds exactly the fingerprinted files, sizes, and times.
def verify_backup_candidate(candidate: Path, fingerprint: dict) -> bool:
    try:
        base = candidate.resolve()
    except (OSError, RuntimeError):
        return False
    if not base.is_dir():
        return False
    for folder, records in fingerprint.items():
        try:
            directory = safe_join(base, folder)
        except BackupRequestError:
            return False
        expected = {record["name"]: record for record in records}
        try:
            actual = {
                path.name: path
                for path in directory.iterdir()
                if path.is_file() and not path.is_symlink() and path.suffix.lower() == ".sas"
            }
        except OSError:
            return False
        if set(actual) != set(expected):
            return False
        for name, path in actual.items():
            try:
                stat = path.stat()
            except OSError:
                return False
            want = expected[name]
            if stat.st_size != want["size"]:
                return False
            # Allow a two-second modification time tolerance.
            if abs((stat.st_mtime * 1000) - want["lastModified"]) > 2000:
                return False
    return True


# List unique folders to search, allowlisted roots first.
def candidate_search_roots() -> list[tuple[Path, str]]:
    pairs: list[tuple[Path, str]] = []
    for root in ALLOWED_PROGRAM_ROOTS:
        pairs.append((root, "programs-flag"))
    pairs.extend([
        (Path.cwd(), "search"),
        (ROOT.parent, "search"),
        (Path.home(), "search"),
    ])
    out: list[tuple[Path, str]] = []
    seen = set()
    for root, source in pairs:
        try:
            resolved = root.expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        if resolved in seen or not resolved.is_dir():
            continue
        seen.add(resolved)
        out.append((resolved, source))
    return out


# Search for folders with a given name within depth, count, and time limits.
def find_named_directories(root: Path, folder_name: str, source: str,
                           started: float, budget: dict) -> list[tuple[Path, str]]:
    found: list[tuple[Path, str]] = []

    # Walk one directory level and stop when a limit is hit.
    def walk(directory: Path, depth: int) -> None:
        if budget["count"] >= SEARCH_MAX_DIRS:
            return
        if time.monotonic() - started >= SEARCH_TIME_BUDGET:
            return
        try:
            resolved = directory.resolve()
        except (OSError, RuntimeError):
            return
        if depth > SEARCH_MAX_DEPTH:
            return
        budget["count"] += 1
        if resolved.name == folder_name:
            found.append((resolved, source))
        if depth == SEARCH_MAX_DEPTH:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda path: path.name.lower())
        except OSError:
            return
        for child in children:
            if budget["count"] >= SEARCH_MAX_DIRS:
                return
            if time.monotonic() - started >= SEARCH_TIME_BUDGET:
                return
            if not child.is_dir() or child.is_symlink():
                continue
            if child.name.startswith(".") or child.name in SEARCH_PRUNE_DIRS:
                continue
            walk(child, depth + 1)

    walk(root, 0)
    return found


# Resolve a folder name and fingerprint to one verified local folder.
def resolve_backup_folder(folder_name: str, fingerprint: dict) -> dict:
    folder = str(folder_name or "").strip()
    if not folder:
        raise BackupRequestError(400, "folderName is required")
    normalized = normalized_fingerprint(fingerprint)
    key = cache_key(folder, normalized)
    cache = load_backup_resolution_cache()
    # Reuse a cached path when it still matches the fingerprint.
    cached = cache.get(key)
    if isinstance(cached, str):
        path = Path(cached)
        if verify_backup_candidate(path, normalized):
            return {
                "resolved": True,
                "rootToken": mint_root_token(path),
                "path": str(path.resolve()),
                "resolution": "cache",
            }
        cache.pop(key, None)
        save_backup_resolution_cache(cache)

    # Search the candidate roots for same-named folders.
    started = time.monotonic()
    budget = {"count": 0}
    candidates: list[tuple[Path, str]] = []
    seen = set()
    for root, source in candidate_search_roots():
        for path, found_source in find_named_directories(root, folder, source,
                                                         started, budget):
            try:
                resolved = path.resolve()
            except (OSError, RuntimeError):
                continue
            if resolved in seen:
                continue
            seen.add(resolved)
            candidates.append((resolved, found_source))

    # Keep only candidates that match the fingerprint.
    verified: list[tuple[Path, str]] = [
        (path, source) for path, source in candidates
        if verify_backup_candidate(path, normalized)
    ]
    # Report ambiguous or missing matches instead of guessing.
    if len(verified) != 1:
        return {
            "resolved": False,
            "reason": "ambiguous" if len(verified) > 1 else "not-found",
            "visited": budget["count"],
        }
    # Cache and return the single verified match.
    path, resolution = verified[0]
    cache[key] = str(path.resolve())
    save_backup_resolution_cache(cache)
    return {
        "resolved": True,
        "rootToken": mint_root_token(path),
        "path": str(path.resolve()),
        "resolution": resolution,
    }


# Copy each listed program into a write-once backup folder beside it.
def _backup_originals_at(base: Path, directories: list) -> dict:
    if not isinstance(directories, list):
        raise BackupRequestError(400, "directories must be a list")

    # Validate every request entry before copying anything.
    plan = []
    for entry in directories:
        if not isinstance(entry, dict):
            raise BackupRequestError(400, "directory entry must be an object")
        folder = str(entry.get("folder", ""))
        files = entry.get("files", [])
        if not isinstance(files, list):
            raise BackupRequestError(400, "files must be a list")
        src_dir = safe_join(base, folder)
        names = []
        for name in files:
            src = safe_child(src_dir, name)
            names.append((src.name, src))
        plan.append((folder, src_dir, names))

    # Track results for the response.
    copied = 0
    skipped = 0
    failed = []
    date_failed = []
    index = {}

    # Serialize backups so concurrent requests cannot collide.
    with BACKUP_LOCK:
        for folder, src_dir, names in plan:
            dst_dir = src_dir / BACKUP_DIR
            # Create the backup folder, refusing a symlink or an escape.
            try:
                if dst_dir.exists() and dst_dir.is_symlink():
                    raise OSError(f"{BACKUP_DIR} is a symlink")
                dst_dir.mkdir(exist_ok=True)
                dst_dir.resolve().relative_to(src_dir.resolve())
            except Exception as exc:  # noqa: BLE001
                for name, _src in names:
                    failed.append({"folder": folder, "name": name, "error": str(exc)})
                continue

            # Copy each file once, preserve its timestamps, and skip existing backups.
            for name, src in names:
                try:
                    dst = dst_dir / name
                    if dst.exists():
                        skipped += 1
                        continue
                    shutil.copy2(src, dst, follow_symlinks=False)
                    stat = src.stat()
                    os.utime(dst, ns=(stat.st_atime_ns, stat.st_mtime_ns))
                    if abs(dst.stat().st_mtime_ns - stat.st_mtime_ns) > 2_000_000_000:
                        date_failed.append({"folder": folder, "name": name})
                    copied += 1
                except Exception as exc:  # noqa: BLE001
                    failed.append({"folder": folder, "name": name, "error": str(exc)})

            # Index the .sas files now present in the backup folder.
            if dst_dir.exists():
                index[folder] = sorted(
                    p.name for p in dst_dir.iterdir()
                    if p.is_file() and not p.is_symlink() and p.suffix.lower() == ".sas"
                )

    return {
        "ok": not failed,
        "copied": copied,
        "skipped": skipped,
        "failed": failed,
        "datesPreserved": not date_failed,
        "dateFailed": date_failed,
        "copyMethod": "copy2",
        "index": index,
    }


def backup_originals(root: str, directories: list) -> dict:
    """Create write-once original backups using shutil.copy2 for metadata."""
    return _backup_originals_at(resolve_allowed_root(root), directories)


# Back up programs under the root stored for a token.
def backup_originals_for_token(token: str, directories: list) -> dict:
    base = BACKUP_ROOT_TOKENS.get(str(token or ""))
    if not base:
        raise BackupRequestError(403, "unknown backup root token")
    return _backup_originals_at(base, directories)


# Reapply original modification times to existing backup files.
def backup_stamp_for_token(token: str, entries: list) -> dict:
    base = BACKUP_ROOT_TOKENS.get(str(token or ""))
    if not base:
        raise BackupRequestError(403, "unknown backup root token")
    if not isinstance(entries, list):
        raise BackupRequestError(400, "entries must be a list")
    failed = []
    stamped = 0
    # Stamp each entry and report failures per file.
    for entry in entries:
        folder = str((entry or {}).get("folder", "")).replace("\\", "/").strip("/")
        name = str((entry or {}).get("name", ""))
        try:
            last_modified = float((entry or {}).get("lastModified", 0))
            if last_modified <= 0:
                raise BackupRequestError(400, "lastModified is required")
            src_dir = safe_join(base, folder)
            backup_dir = src_dir / BACKUP_DIR
            if not backup_dir.is_dir():
                raise BackupRequestError(400, "backup folder does not exist")
            path = safe_child(backup_dir, name)
            mtime_ns = int(last_modified * 1_000_000)
            os.utime(path, ns=(mtime_ns, mtime_ns))
            if abs(path.stat().st_mtime_ns - mtime_ns) > 2_000_000_000:
                raise OSError("timestamp verification failed")
            stamped += 1
        except Exception as exc:  # noqa: BLE001 - per-file result
            failed.append({"folder": folder, "name": name, "error": str(exc)})
    return {"ok": not failed, "stamped": stamped,
            "datesPreserved": not failed, "dateFailed": failed}


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files out of the Migrate Studio folder, and nothing else.

    Two departures from the stock handler. Content types: Python's mimetypes
    database does not know .sas at all and, on some Windows installs, has been
    taught by another program that .js is text/plain -- which makes the browser
    refuse to run it and the page come up blank. Both are pinned here rather
    than trusted to the machine.

    And caching: this is a tool somebody is editing. A 304 on a stylesheet you
    just changed reads as "my edit did nothing", so nothing is cached.
    """

    # Pin content types so the browser never relies on machine settings.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".sas": "text/plain",
        ".md": "text/markdown; charset=utf-8",
        ".xlsx": ("application/vnd.openxmlformats-officedocument"
                  ".spreadsheetml.sheet"),
        "": "application/octet-stream",
    }

    # Serve files from the web root.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def translate_path(self, path):
        """Reject decoded traversal and symlinks outside published directories."""
        url_path = unquote(urlsplit(path).path)
        rel = PurePosixPath(url_path.lstrip("/"))
        if ".." in rel.parts or "\\" in url_path or "\x00" in url_path:
            return str(WEB_ROOT / "__missing__")
        if url_path == "/CHANGELOG.md":
            base, target = ROOT, ROOT / "CHANGELOG.md"
        elif rel.parts and rel.parts[0] in ("rules", "docs"):
            base = ROOT / rel.parts[0]
            target = ROOT / Path(*rel.parts)
        else:
            base, target = WEB_ROOT, WEB_ROOT / Path(*rel.parts)
        try:
            target.resolve().relative_to(base.resolve())
        except (ValueError, OSError):
            return str(WEB_ROOT / "__missing__")
        return str(target)

    # Disable directory listings.
    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def request_is_local(self):
        """Loopback peer and Host checks block remote access and DNS rebinding."""
        host = self.headers.get("Host", "")
        port = self.server.server_address[1]
        return self.client_is_local() and host.lower() in {
            f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}"
        }

    # Reject cross-site writes by checking Origin and Fetch Metadata.
    def mutation_is_same_origin(self):
        origin = self.headers.get("Origin")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return False
        return origin is None or origin == "http://" + self.headers.get("Host", "")

    # Apply the local-only check to HEAD requests.
    def do_HEAD(self):
        if not self.request_is_local():
            self.send_json(403, {"ok": False, "error": "local requests only"})
            return
        super().do_HEAD()

    # Add no-cache and hardening headers to every response.
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt, *args):
        """One line per request, without the date stamp the base class adds.

        A 404 is worth seeing -- it is usually a moved file. A 200 on every
        favicon is not, so the log stays quiet unless something went wrong.
        """
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            if status == "404" and ("current_selections.json" in self.requestline
                                    or "history.json" in self.requestline
                                    or "backup_roots.json" in self.requestline):
                return
            sys.stderr.write(f"  Request failed -> {status}\n")

    # Read and cache a size-limited JSON object from the request.
    def read_json_body(self):
        if hasattr(self, "_json_body"):
            return self._json_body
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("Transfer-Encoding is unsupported")
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > 8 * 1024 * 1024:
            raise ValueError("Request exceeds the 8 MiB limit")
        self.connection.settimeout(15)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("Incomplete request")
        self._json_body = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(self._json_body, dict):
            raise ValueError("JSON object required")
        return self._json_body

    # Send a JSON response with the given status.
    def send_json(self, status, payload):
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Check that the peer is a loopback address.
    def client_is_local(self) -> bool:
        return self.client_address[0] in (
            "127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"
        )

    def send_data_file(self, url_path: str) -> None:
        """Serve a per-user data file from DATA_DIR, never from ROOT."""
        target = {
            f"/{HISTORY_NAME}": HISTORY,
            f"/{SELECTIONS_NAME}": SELECTIONS,
        }.get(url_path)
        if target is None or not target.is_file():
            self.send_json(404, {"ok": False, "error": "Not found"})
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Serve data files and whoami to local clients, and static files otherwise.
    def do_GET(self):                               # noqa: N802 - stdlib hook
        if not self.request_is_local():
            self.send_json(403, {"ok": False, "error": "local requests only"})
            return
        path = urlsplit(self.path).path
        if path in (f"/{HISTORY_NAME}", f"/{SELECTIONS_NAME}",
                    f"/{BACKUP_CACHE_NAME}"):
            self.send_data_file(path)
            return
        if path == "/api/whoami":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            self.send_json(200, whoami())
            return
        super().do_GET()

    # Route local same-origin POST requests to the API endpoints.
    def do_POST(self):                              # noqa: N802 - stdlib hook
        if not self.request_is_local() or not self.mutation_is_same_origin():
            self.send_json(403, {"ok": False, "error": "local same-origin requests only"})
            return
        # Parse the JSON body once and reject invalid or oversized input.
        try:
            self.read_json_body()
        except (ValueError, UnicodeError, OSError):
            self.send_json(400, {"ok": False, "error": "Invalid or oversized JSON request"})
            return
        path = urlsplit(self.path).path

        # Save the selected program folder (/api/current-selection).
        if path == "/api/current-selection":
            try:
                body = self.read_json_body()
                program_folder = str(body.get("program_folder", "")).strip()
                handle_key = str(body.get("handle_key",
                                           "migratestudio_program_folder")).strip()
                selected_at = str(body.get("selected_at", "")).strip()
                if not selected_at:
                    selected_at = datetime.now(timezone.utc).isoformat()
                    selected_at = selected_at.replace("+00:00", "Z")
                if not program_folder:
                    self.send_json(400, {"ok": False,
                                         "error": "program_folder is required"})
                    return

                metadata = {
                    "program_folder": program_folder,
                    "handle_key": handle_key or "migratestudio_program_folder",
                    "selected_at": selected_at,
                }
                SELECTIONS.parent.mkdir(parents=True, exist_ok=True)
                tmp = SELECTIONS.with_name(SELECTIONS.name + ".tmp")
                tmp.write_text(json.dumps(metadata, indent=2) + "\n",
                               encoding="utf-8")
                tmp.replace(SELECTIONS)
                self.send_json(200, {"ok": True, "selection": metadata})
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Append a run to the history file (/api/history).
        if path == "/api/history":
            try:
                run = self.read_json_body()
                with HISTORY_LOCK:
                    result = append_history_run(run)
                if not result.get("ok"):
                    self.send_json(result.get("status", 500), result)
                    return
                self.send_json(200, result)
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Resolve a folder fingerprint to a root token (/api/backup/resolve).
        if path == "/api/backup/resolve":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            try:
                body = self.read_json_body()
                result = resolve_backup_folder(body.get("folderName", ""),
                                               body.get("fingerprint", {}))
                self.send_json(200, result)
            except BackupRequestError as exc:
                self.send_json(exc.status, {"ok": False, "error": exc.message})
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Back up originals for a root token (/api/backup/originals).
        if path == "/api/backup/originals":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            try:
                body = self.read_json_body()
                result = backup_originals_for_token(body.get("rootToken", ""),
                                                    body.get("directories", []))
                self.send_json(200, result)
            except BackupRequestError as exc:
                self.send_json(exc.status, {"ok": False, "error": exc.message})
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Restore original timestamps on backup files (/api/backup/stamp).
        if path == "/api/backup/stamp":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            try:
                body = self.read_json_body()
                result = backup_stamp_for_token(body.get("rootToken", ""),
                                                body.get("entries", []))
                self.send_json(500 if result.get("dateFailed") else 200, result)
            except BackupRequestError as exc:
                self.send_json(exc.status, {"ok": False, "error": exc.message})
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Reply, then shut the server down on a background thread (/api/logout).
        if path == "/api/logout":
            body = b'{"ok": true}\n'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()

            def stop_server():
                self.server.shutdown()

            threading.Thread(target=stop_server, daemon=True).start()
            return

        # Return 404 for unknown endpoints.
        self.send_json(404, {"ok": False, "error": "Not found"})


class Server(socketserver.ThreadingTCPServer):
    """Threaded, so one slow request cannot block the page from loading.

    allow_reuse_address matters on restart: without it, stopping and starting
    Migrate Studio inside the TCP linger window fails with "address already in use" on
    a port nothing is actually listening on.
    """

    allow_reuse_address = True
    daemon_threads = True


# Test whether a port can be bound on the host.
def port_available(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, port))
        return True
    except OSError:
        return False


def select_port(host: str, wanted: Optional[int]) -> Optional[int]:
    """Find a port to serve on.

    An explicitly requested port is used or refused -- never quietly swapped
    for another, because the person who passed --port has a reason and a
    different port would silently defeat it. The default scans the block.
    """
    if wanted is not None:
        if port_available(host, wanted):
            return wanted
        print(f"ERROR: port {wanted} is already in use.", file=sys.stderr)
        return None

    for port in range(START_PORT, END_PORT + 1):
        if port_available(host, port):
            return port
        print(f"Port {port} is in use. Checking the next available port.")

    print(f"ERROR: all ports {START_PORT}-{END_PORT} are in use. Close another "
          f"Migrate Studio, or pass --port.", file=sys.stderr)
    return None


def check_layout() -> bool:
    """Report missing files before serving rather than after."""
    missing = [name for name in REQUIRED if not (ROOT / name).exists()]
    if not missing:
        return True
    print("Migrate Studio is missing files it needs:", file=sys.stderr)
    for name in missing:
        print(f"    {name}", file=sys.stderr)
    print(f"\nRun this script from inside the Migrate Studio folder, and keep it next "
          f"with its www/ and rules/ folders. Looked in: {ROOT}", file=sys.stderr)
    return False


def describe_rules() -> None:
    """Say what the rule book holds, or that there isn't one.

    A one-line summary at startup, on the theory that the most common surprise
    in a tool like this is running against a rule book you did not mean. Needs
    openpyxl; without it the line is skipped, because the browser reads the
    workbook itself and startup does not depend on this.
    """
    if not RULES.exists():
        print("No Migrate_Studio_Rules.xlsx in this folder. Migrate Studio will start without "
              "a rule book;\nuse Import Rules, or drop one in the program "
              "folder.")
        return

    try:
        import openpyxl
    except ImportError:
        print(f"Rule book: {RULES.name}")
        return

    try:
        book = openpyxl.load_workbook(RULES, read_only=True, data_only=True)
        sheet = book["Rules"] if "Rules" in book.sheetnames else book.worksheets[0]
        rows = [r for r in sheet.iter_rows(values_only=True) if any(
            c is not None and str(c).strip() for c in r)]
        # The header is the first row with several populated cells; anything
        # above it is the workbook's title block.
        header = next((i for i, r in enumerate(rows)
                       if sum(1 for c in r if c not in (None, "")) >= 4), 0)
        count = len(rows) - header - 1
        print(f"Rule book: {RULES.name} · {sheet.title} sheet · "
              f"{count} rule{'' if count == 1 else 's'}")
        book.close()
    except Exception as exc:                       # noqa: BLE001 - report, continue
        print(f"Rule book: {RULES.name} (could not be summarised: {exc})")

def describe_mc_rules() -> bool:
    """Summarise the MC JSON pack, which is now the default browser rule book."""
    if not MC_RULES.exists():
        print(f"MC pack: missing at {MC_RULES}", file=sys.stderr)
        return False
    try:
        data = json.loads(MC_RULES.read_text(encoding="utf-8"))
        rules = data.get("rules", [])
        version = data.get("source", {}).get("macro_version", "unknown")
        visible = [r for r in rules if r.get("rule_id") != "S6"]
        house = json.loads(HOUSE_RULES.read_text(encoding="utf-8")) if HOUSE_RULES.exists() else {}
        house_extends = {r.get("rule_id") for r in house.get("extends", []) if r.get("rule_id")}
        house_rules = house.get("rules", [])
        autofix = [
            r for r in visible
            if (r.get("update", {}).get("supported") or r.get("rule_id") in house_extends) and
            r.get("rule_id") != "F4"
        ]
        autofix.extend(r for r in house_rules if r.get("update", {}).get("supported"))
        print(f"MC pack: {MC_RULES.relative_to(ROOT)} · v{version} · "
              f"{len(rules)} rules ({len(visible)} visible) · "
              f"{len(autofix)} auto-fix with house rules")
        return True
    except Exception as exc:                       # noqa: BLE001 - report, fail check
        print(f"MC pack: could not be parsed: {exc}", file=sys.stderr)
        return False


def check_only() -> int:
    """--check: summarise the rule book and stop. Serves no page."""
    if not check_layout():
        return 1
    if RULES.exists():
        try:
            import openpyxl                        # noqa: F401 - presence check
        except ImportError:
            print("--check reads the workbook, which needs openpyxl:\n"
                  f'    {sys.executable} -m pip install openpyxl', file=sys.stderr)
            return 2
    describe_rules()
    return 0 if describe_mc_rules() else 1


# Start the server, print the address, and run until interrupted.
def serve(host: str, port: int, open_browser: bool) -> int:
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"

    # Bind the server and exit if the port is taken.
    try:
        server = Server((host, port), Handler)
    except OSError as exc:
        print(f"ERROR: could not serve on {host}:{port} — {exc}", file=sys.stderr)
        return 2

    # Print the startup banner and rule summaries.
    print()
    print(f"Migrate Studio is serving {ROOT}")
    print(f"User data folder: {DATA_DIR}")
    describe_rules()
    describe_mc_rules()
    print()
    print(f"    {url}")
    print()
    print("Press Ctrl+C to stop.")
    print()

    if open_browser:
        # After a short delay and on its own thread: opening the browser before
        # the server is accepting connections is a race some browsers lose, and
        # webbrowser.open can block for seconds while a browser cold-starts.
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    # Serve until Ctrl+C, then close the socket.
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


# Parse options, configure paths, and dispatch to import, check, or serve.
def main(argv=None) -> int:
    # Stop early on unsupported Python versions.
    if sys.version_info < MIN_PYTHON:
        print(f"Migrate Studio needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer; "
              f"this is {sys.version.split()[0]}.", file=sys.stderr)
        return 2

    # Define the command-line options.
    parser = argparse.ArgumentParser(
        prog="migrate_studio.py",
        description="Serve Migrate Studio and open it in a browser.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    parser.add_argument("--port", type=int, default=None,
                        help=f"port to serve on (default: first free in "
                             f"{START_PORT}-{END_PORT})")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--programs", action="append", default=[],
                        help="study root to search first for metadata-preserving backups; repeat for multiple folders")
    parser.add_argument("--no-open", action="store_true",
                        help="serve without opening a browser")
    parser.add_argument("--check", action="store_true",
                        help="summarise Migrate_Studio_Rules.xlsx and exit")
    parser.add_argument("--data-dir", default=None,
                        help=f"folder for history.json, current_selections.json "
                             f"and backup_roots.json (default: per-user app "
                             f"data folder; or set {DATA_DIR_ENV})")
    parser.add_argument("--import-legacy-history", nargs="?", metavar="PATH",
                        const=str(LEGACY_HISTORY), default=None,
                        help="merge runs from an old history.json (default: the "
                             "one beside index.html) into your data folder, then exit")
    args = parser.parse_args(sys.argv[1:] if argv is None else list(argv))

    # Create the per-user data folder.
    try:
        configure_data_dir(resolve_data_dir(args.data_dir))
    except OSError as exc:
        print(f"ERROR: cannot create the data folder "
              f"{resolve_data_dir(args.data_dir)} -- {exc}\n"
              f"Pass --data-dir or set {DATA_DIR_ENV} to a folder you can write.",
              file=sys.stderr)
        return 2

    # Import legacy history and exit.
    if args.import_legacy_history:
        try:
            result = import_legacy_history(Path(args.import_legacy_history))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"ERROR: import failed -- {exc}", file=sys.stderr)
            return 2
        if not result.get("ok"):
            print(f"ERROR: {result['error']}", file=sys.stderr)
            return 2
        print(f"Imported {result['imported']} run(s), skipped "
              f"{result['skipped']} already present, into {result['target']}")
        return 0

    # Summarize the rule book and exit.
    if args.check:
        print(f"User data folder: {DATA_DIR}")
        return check_only()

    # Verify the required files exist before serving.
    if not check_layout():
        return 2

    # Register allowlisted program roots for backups.
    configure_program_roots(args.programs)

    # Pick a port and start serving.
    port = select_port(args.host, args.port)
    if port is None:
        return 2

    return serve(args.host, port, not args.no_open)


if __name__ == "__main__":
    raise SystemExit(main())
