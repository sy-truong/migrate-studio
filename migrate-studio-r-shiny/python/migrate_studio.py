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
    python migrate_studio.py --programs /studies/EXAMPLE001
                                              # speed backup path resolution
    python migrate_studio.py --no-open        # serve without opening a browser
    python migrate_studio.py --check          # summarise the rule book and exit

Requires Python 3.9+ and nothing else. `--check` reads the workbook, which
needs openpyxl; it says so and stops if that is missing, rather than installing
anything behind your back.
"""

from __future__ import annotations

import argparse
import filecmp
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
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, unquote

# Locate the edition folder and the files the server reads and writes.
ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "www"
RULES = ROOT / "rules" / "Migrate_Studio_Rules.xlsx"
SELECTIONS = ROOT / "current_selections.json"
HISTORY = ROOT / "history.json"
# Guard shared history and backup state, and identify this server session.
HISTORY_LOCK = threading.Lock()
MAX_HISTORY_RUNS = 500
SESSION_ID = uuid.uuid4().hex[:12]
SERVER_STARTED_AT = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
# Name the backup folder and track allowed roots, tokens, and cached resolutions.
BACKUP_DIRNAME = "_migrate_original"
PROGRAM_ROOTS: list[Path] = []
BACKUP_LOCK = threading.Lock()
BACKUP_ROOT_CACHE = ROOT / "backup_roots.json"
ROOT_TOKENS: dict[str, Path] = {}
BACKUP_RESOLUTIONS: dict[str, str] = {}
# Bound the folder search by depth, directory count, time, and mtime tolerance.
SEARCH_MAX_DEPTH = 4
SEARCH_MAX_DIRS = 20000
SEARCH_SECONDS = 2.0
FINGERPRINT_MTIME_TOLERANCE_MS = 2000
# List folder names the search never enters.
SEARCH_PRUNE = {
    BACKUP_DIRNAME, "Migrate_Studio", "PortFix", "node_modules", ".git",
}

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
    "www/js/mig-diff.js",
    "www/js/migrate-studio.js",
    "www/js/vendor/fflate.min.js",
    "rules/Migrate_Studio_Rules.xlsx",
]


def append_history_run(run):
    """Append one Apply Fix run to history.json."""
    # Serialize history writes across request threads.
    with HISTORY_LOCK:
        book = {
            "schema": "migrate-studio/history",
            "version": 1,
            "runs": [],
        }
        # Load existing history, accepting an envelope or a bare list.
        if HISTORY.exists():
            try:
                loaded = json.loads(HISTORY.read_text(encoding="utf-8"))
                if (isinstance(loaded, dict) and
                        isinstance(loaded.get("runs"), list)):
                    book = loaded
                elif isinstance(loaded, list):
                    book["runs"] = loaded
            # Set aside an unreadable history file.
            except (json.JSONDecodeError, OSError):
                HISTORY.replace(HISTORY.with_suffix(".corrupt.json"))

        # Skip a run whose ID appears in the last 50 runs.
        if any(r.get("runId") == run["runId"] for r in book["runs"][-50:]):
            return {"ok": True, "duplicate": True}

        # Append the run and trim to the newest MAX_HISTORY_RUNS.
        book["runs"].append(run)
        if len(book["runs"]) > MAX_HISTORY_RUNS:
            book["runs"] = book["runs"][-MAX_HISTORY_RUNS:]

        # Write atomically through a temp file.
        tmp = HISTORY.with_name(HISTORY.name + ".tmp")
        tmp.write_text(json.dumps(book, indent=2) + "\n", encoding="utf-8")
        tmp.replace(HISTORY)

    return {"ok": True, "runs": len(book["runs"])}


def whoami() -> dict:
    """Return the OS account this local server process is running as."""
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
    }


def set_program_roots(paths) -> None:
    """Set the roots this server is allowed to back up for the browser."""
    global PROGRAM_ROOTS
    PROGRAM_ROOTS = [Path(path).expanduser().resolve() for path in (paths or [])]


# Test whether a path resolves inside a parent folder.
def path_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


# Match a requested root against the --programs allowlist.
def resolve_allowed_root(root_value) -> Path:
    try:
        root = Path(str(root_value or "")).expanduser().resolve()
    except (OSError, RuntimeError):
        raise PermissionError("root is not allowlisted")
    for allowed in PROGRAM_ROOTS:
        if root == allowed.resolve():
            return allowed.resolve()
    raise PermissionError("root is not allowlisted")


# Detect POSIX and Windows drive-letter absolute paths.
def looks_absolute(value: str) -> bool:
    return value.startswith("/") or (
        len(value) > 2 and value[1] == ":" and value[2] in ("/", "\\"))


# Join a folder to the base and reject absolute, escaping, or missing folders.
def safe_join(base: Path, folder_value) -> Path:
    folder = str(folder_value or "").replace("\\", "/")
    if looks_absolute(folder):
        raise ValueError("absolute folders are not allowed")
    target = (base / folder).resolve()
    if not path_inside(target, base):
        raise ValueError("folder is outside the allowed root")
    if not target.is_dir():
        raise ValueError("folder is not a directory")
    return target


# Validate a bare .sas file name and return its resolved path.
def safe_child(directory: Path, name_value) -> Path:
    name = str(name_value or "").strip()
    if (not name or "/" in name or "\\" in name or name in (".", "..")
            or ".." in Path(name).parts):
        raise ValueError("file name must be a bare .sas file")
    if looks_absolute(name):
        raise ValueError("absolute file names are not allowed")
    if Path(name).suffix.lower() != ".sas":
        raise ValueError("only .sas files can be backed up")
    target = (directory / name).resolve()
    if not path_inside(target, directory):
        raise ValueError("file is outside the requested directory")
    if not target.is_file() or target.is_symlink():
        raise ValueError("source is not a regular .sas file")
    return target


# Validate and normalize a folder fingerprint from the browser.
def normalize_fingerprint(fingerprint) -> dict[str, list[dict]]:
    if not isinstance(fingerprint, dict):
        raise ValueError("fingerprint must be an object")
    normalized: dict[str, list[dict]] = {}
    for folder, files in fingerprint.items():
        folder_key = str(folder or "").replace("\\", "/").strip("/")
        if looks_absolute(folder_key) or ".." in Path(folder_key).parts:
            raise ValueError("fingerprint folder is unsafe")
        if not isinstance(files, list):
            raise ValueError("fingerprint files must be lists")
        seen = set()
        entries = []
        for item in files:
            if not isinstance(item, dict):
                raise ValueError("fingerprint file entries must be objects")
            name = str(item.get("name", "")).strip()
            if (not name or "/" in name or "\\" in name or name in (".", "..")
                    or ".." in Path(name).parts):
                raise ValueError("fingerprint file names must be bare names")
            if Path(name).suffix.lower() != ".sas":
                raise ValueError("fingerprint files must be .sas programs")
            if name in seen:
                raise ValueError("duplicate fingerprint file")
            seen.add(name)
            entries.append({
                "name": name,
                "size": int(item.get("size", 0)),
                "lastModified": int(float(item.get("lastModified", 0))),
            })
        normalized[folder_key] = sorted(entries, key=lambda entry: entry["name"])
    return dict(sorted(normalized.items()))


# Hash the folder name and fingerprint into a cache key.
def fingerprint_hash(folder_name: str, fingerprint: dict) -> str:
    payload = {
        "folderName": folder_name,
        "fingerprint": fingerprint,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


# Load the folder resolution cache, or start an empty one.
def load_backup_root_cache() -> dict:
    try:
        loaded = json.loads(BACKUP_ROOT_CACHE.read_text(encoding="utf-8"))
        if isinstance(loaded, dict) and isinstance(loaded.get("entries"), dict):
            return loaded
    except (OSError, json.JSONDecodeError):
        pass
    return {"schema": "migrate-studio/backup-roots", "version": 1, "entries": {}}


# Save the resolution cache atomically.
def save_backup_root_cache(cache: dict) -> None:
    tmp = BACKUP_ROOT_CACHE.with_name(BACKUP_ROOT_CACHE.name + ".tmp")
    tmp.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    tmp.replace(BACKUP_ROOT_CACHE)


# Issue an opaque token for a resolved folder and remember how it was found.
def root_token_for(path: Path, resolution: str) -> str:
    token = secrets.token_urlsafe(18)
    ROOT_TOKENS[token] = path.resolve()
    BACKUP_RESOLUTIONS[token] = resolution
    return token


# Return the folder for a token and refuse unknown tokens.
def root_from_token(token_value) -> Path:
    token = str(token_value or "")
    root = ROOT_TOKENS.get(token)
    if not root:
        raise PermissionError("rootToken is not valid for this server session")
    return root.resolve()


# Confirm a folder holds exactly the fingerprinted files, sizes, and times.
def verify_fingerprint(candidate: Path, fingerprint: dict) -> bool:
    candidate = candidate.resolve()
    for folder, expected_files in fingerprint.items():
        try:
            directory = safe_join(candidate, folder)
        except ValueError:
            return False
        actual = sorted(
            p.name for p in directory.iterdir()
            if p.is_file() and p.suffix.lower() == ".sas"
        )
        expected_names = sorted(entry["name"] for entry in expected_files)
        if actual != expected_names:
            return False
        for entry in expected_files:
            path = directory / entry["name"]
            try:
                stat = path.stat()
            except OSError:
                return False
            if stat.st_size != entry["size"]:
                return False
            mtime_ms = stat.st_mtime_ns / 1_000_000
            if abs(mtime_ms - entry["lastModified"]) > FINGERPRINT_MTIME_TOLERANCE_MS:
                return False
    return True


# Skip hidden folders and the pruned names during search.
def should_prune_dir(name: str) -> bool:
    return name.startswith(".") or name in SEARCH_PRUNE


# List unique folders to search, allowlisted roots first.
def candidate_search_roots() -> list[tuple[Path, str]]:
    roots: list[tuple[Path, str]] = []
    for root in PROGRAM_ROOTS:
        roots.append((root, "programs-flag"))
    roots.extend([
        (Path.cwd(), "search"),
        (ROOT.parent, "search"),
        (Path.home(), "search"),
    ])
    seen = set()
    unique: list[tuple[Path, str]] = []
    for root, source in roots:
        try:
            resolved = root.expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        if resolved in seen or not resolved.is_dir():
            continue
        seen.add(resolved)
        unique.append((resolved, source))
    return unique


# Search the candidate roots for folders with a given name within the limits.
def find_named_directories(folder_name: str) -> list[tuple[Path, str]]:
    started = time.monotonic()
    visited = 0
    matches: list[tuple[Path, str]] = []
    seen = set()

    for base, source in candidate_search_roots():
        if visited >= SEARCH_MAX_DIRS or time.monotonic() - started >= SEARCH_SECONDS:
            break
        base_parts = len(base.parts)
        if base.name == folder_name:
            matches.append((base, source))
            seen.add(base)
        # Walk each tree, prune folders, and stop at the depth limit.
        for current, dirnames, _filenames in os.walk(base):
            visited += 1
            if visited >= SEARCH_MAX_DIRS or time.monotonic() - started >= SEARCH_SECONDS:
                break
            path = Path(current)
            depth = max(0, len(path.parts) - base_parts)
            dirnames[:] = [name for name in dirnames if not should_prune_dir(name)]
            if depth >= SEARCH_MAX_DEPTH:
                dirnames[:] = []
            if path.name == folder_name and path not in seen:
                matches.append((path, source))
                seen.add(path)
    return matches


# Resolve a folder name and fingerprint to one verified folder and issue a token.
def resolve_backup_root_response(body) -> tuple[int, dict]:
    folder_name = str((body or {}).get("folderName", "")).strip()
    if not folder_name:
        return 400, {"ok": False, "error": "folderName is required"}
    try:
        fingerprint = normalize_fingerprint((body or {}).get("fingerprint"))
    except ValueError as exc:
        return 400, {"ok": False, "error": str(exc)}
    key = fingerprint_hash(folder_name, fingerprint)

    # Reuse a cached path when it still matches the fingerprint.
    cache = load_backup_root_cache()
    cached_path = cache.get("entries", {}).get(key)
    if cached_path:
        try:
            candidate = Path(cached_path).expanduser().resolve()
            if candidate.name == folder_name and verify_fingerprint(candidate, fingerprint):
                token = root_token_for(candidate, "cache")
                return 200, {"ok": True, "resolved": True, "rootToken": token,
                             "path": str(candidate), "resolution": "cache"}
        except (OSError, RuntimeError):
            pass

    # Collect search matches that pass fingerprint verification.
    verified: dict[Path, str] = {}
    for candidate, source in find_named_directories(folder_name):
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError):
            continue
        if resolved.name != folder_name:
            continue
        if verify_fingerprint(resolved, fingerprint) and resolved not in verified:
            verified[resolved] = source

    # Report ambiguous or missing matches instead of guessing.
    if len(verified) != 1:
        reason = "ambiguous" if len(verified) > 1 else "not-found"
        print(f"Migrate Studio backup resolve: {reason} for {folder_name}")
        return 200, {"ok": True, "resolved": False, "reason": reason}

    # Cache and return the single verified match.
    path, resolution = next(iter(verified.items()))
    cache.setdefault("entries", {})[key] = str(path)
    try:
        save_backup_root_cache(cache)
    except OSError:
        pass
    token = root_token_for(path, resolution)
    return 200, {"ok": True, "resolved": True, "rootToken": token,
                 "path": str(path), "resolution": resolution}


# Set the timestamp tolerance used when verifying copies.
MTIME_TOLERANCE_NS = 2_000_000_000


# Choose the OS copy command and its success test.
def _os_copy_command(src: Path, dst: Path):
    system = platform.system()
    if system == "Windows":
        return (["robocopy", str(src.parent), str(dst.parent), src.name,
                 "/COPY:DAT", "/R:1", "/W:1", "/NP", "/NJH", "/NJS", "/NFL", "/NDL"],
                lambda rc: rc < 8)
    if system == "Linux":
        return (["cp", "--preserve=mode,timestamps", "--", str(src), str(dst)],
                lambda rc: rc == 0)
    return (["cp", "-p", "--", str(src), str(dst)], lambda rc: rc == 0)


def copy_preserving(src: Path, dst: Path) -> tuple[str, bool]:
    """Copy with the OS tool so the modified date survives; verify it."""
    # Copy with the OS tool, falling back to copy2 on failure.
    cmd, ok = _os_copy_command(src, dst)
    method = "os"
    try:
        extra = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, **extra)
        good = ok(result.returncode) and dst.exists()
    except (OSError, subprocess.TimeoutExpired):
        good = False
    if not good:
        method = "copy2"
        if dst.exists():
            dst.unlink()
        shutil.copy2(src, dst)

    # Reapply the source timestamps and verify the result.
    s, d = src.stat(), dst.stat()
    os.utime(dst, ns=(s.st_atime_ns, s.st_mtime_ns))
    d = dst.stat()
    return method, abs(s.st_mtime_ns - d.st_mtime_ns) <= MTIME_TOLERANCE_NS


def backup_originals_for_root(base: Path, directories: list) -> dict:
    """Copy each directory's originals into _migrate_original.

    A destination that already exists is never rewritten; after Apply Fix the
    live source holds fixed text, and overwriting the backup would destroy the
    only original.
    """
    base = base.resolve()
    copied = 0
    skipped = 0
    failed: list[dict] = []
    date_failed: list[dict] = []
    index: dict[str, list[str]] = {}

    # Serialize backups so concurrent requests cannot collide.
    with BACKUP_LOCK:
        for entry in directories or []:
            folder = str((entry or {}).get("folder", "")).replace("\\", "/").strip("/")
            src_dir = safe_join(base, folder)
            dst_dir = src_dir / BACKUP_DIRNAME
            dst_dir.mkdir(exist_ok=True)

            # Copy each file once, verify its content, and record failures.
            for name in (entry or {}).get("files", []):
                try:
                    src = safe_child(src_dir, name)
                    dst = dst_dir / src.name
                    if dst.exists():
                        skipped += 1
                        continue
                    _method, date_ok = copy_preserving(src, dst)
                    if not filecmp.cmp(src, dst, shallow=False):
                        dst.unlink()
                        raise OSError("backup content does not match the source")
                    copied += 1
                    if not date_ok:
                        date_failed.append({"folder": folder, "name": str(name)})
                except Exception as exc:    # noqa: BLE001 - per-file result
                    failed.append({"folder": folder, "name": str(name),
                                   "error": str(exc)})

            # Index the .sas files now present in the backup folder.
            index[folder] = sorted(
                p.name for p in dst_dir.iterdir()
                if p.is_file() and p.suffix.lower() == ".sas"
            )

    return {"ok": not failed, "copied": copied, "skipped": skipped,
            "failed": failed, "datesPreserved": not date_failed,
            "dateFailed": date_failed, "copyMethod": platform.system().lower(),
            "index": index}


# Back up originals for an allowlisted root.
def backup_originals(root: str, directories: list) -> dict:
    return backup_originals_for_root(resolve_allowed_root(root), directories)


# Validate a backup request, run it, and return an HTTP status and payload.
def backup_originals_response(body) -> tuple[int, dict]:
    try:
        root = root_from_token((body or {}).get("rootToken"))
    except PermissionError as exc:
        return 403, {"ok": False, "error": str(exc)}
    directories = (body or {}).get("directories")
    if not isinstance(directories, list):
        return 400, {"ok": False, "error": "directories must be a list"}
    # Validate every folder and file name before copying.
    try:
        for entry in directories:
            src_dir = safe_join(root, (entry or {}).get("folder", ""))
            files = (entry or {}).get("files")
            if not isinstance(files, list):
                raise ValueError("files must be a list")
            for name in files:
                safe_child(src_dir, name)
    except ValueError as exc:
        return 400, {"ok": False, "error": str(exc)}
    # Run the backup and report 500 when any file failed.
    try:
        result = backup_originals_for_root(root, directories)
        token = str((body or {}).get("rootToken") or "")
        result["resolution"] = BACKUP_RESOLUTIONS.get(token, "")
        return (500 if result["failed"] else 200), result
    except Exception as exc:                # noqa: BLE001 - unexpected server issue
        return 500, {"ok": False, "copied": 0, "skipped": 0,
                     "failed": [{"folder": "", "name": "",
                                 "error": str(exc)}], "index": {}}


# Reapply original modification times to existing backup files.
def backup_stamp_for_root(base: Path, entries: list) -> dict:
    base = base.resolve()
    failed: list[dict] = []
    stamped = 0
    # Stamp each entry and report failures per file.
    for entry in entries or []:
        folder = str((entry or {}).get("folder", "")).replace("\\", "/").strip("/")
        name = str((entry or {}).get("name", ""))
        try:
            last_modified = float((entry or {}).get("lastModified", 0))
            if last_modified <= 0:
                raise ValueError("lastModified is required")
            src_dir = safe_join(base, folder)
            backup_dir = src_dir / BACKUP_DIRNAME
            if not backup_dir.is_dir():
                raise ValueError("backup folder does not exist")
            path = safe_child(backup_dir, name)
            mtime_ns = int(last_modified * 1_000_000)
            os.utime(path, ns=(mtime_ns, mtime_ns))
            if abs(path.stat().st_mtime_ns - mtime_ns) > MTIME_TOLERANCE_NS:
                raise OSError("timestamp verification failed")
            stamped += 1
        except Exception as exc:  # noqa: BLE001 - per-file result
            failed.append({"folder": folder, "name": name, "error": str(exc)})
    return {"ok": not failed, "stamped": stamped,
            "datesPreserved": not failed, "dateFailed": failed}


# Validate a stamp request, run it, and return an HTTP status and payload.
def backup_stamp_response(body) -> tuple[int, dict]:
    try:
        root = root_from_token((body or {}).get("rootToken"))
    except PermissionError as exc:
        return 403, {"ok": False, "error": str(exc)}
    entries = (body or {}).get("entries")
    if not isinstance(entries, list):
        return 400, {"ok": False, "error": "entries must be a list"}
    try:
        result = backup_stamp_for_root(root, entries)
        return (500 if result["dateFailed"] else 200), result
    except Exception as exc:  # noqa: BLE001 - unexpected server issue
        return 500, {"ok": False, "stamped": 0, "datesPreserved": False,
                     "dateFailed": [{"folder": "", "name": "",
                                     "error": str(exc)}]}


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files out of the Migrate Studio folder, plus local JSON APIs.

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
                                    or "history.json" in self.requestline):
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
        return self.client_address[0] in ("127.0.0.1", "::1", "localhost")

    # Serve whoami to local clients and static files otherwise.
    def do_GET(self):                               # noqa: N802 - stdlib hook
        if not self.request_is_local():
            self.send_json(403, {"ok": False, "error": "local requests only"})
            return
        if urlsplit(self.path).path == "/api/whoami":
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
                if not isinstance(run, dict) or not run.get("runId"):
                    self.send_json(400, {"ok": False,
                                         "error": "runId is required"})
                    return

                self.send_json(200, append_history_run(run))
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Back up originals for a root token (/api/backup/originals).
        if path == "/api/backup/originals":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            try:
                status, payload = backup_originals_response(self.read_json_body())
                self.send_json(status, payload)
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Restore original timestamps on backup files (/api/backup/stamp).
        if path == "/api/backup/stamp":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            try:
                status, payload = backup_stamp_response(self.read_json_body())
                self.send_json(status, payload)
            except Exception as exc:                # noqa: BLE001 - report JSON
                self.send_json(500, {"ok": False, "error": "Operation failed; check permissions and configuration"})
            return

        # Resolve a folder fingerprint to a root token (/api/backup/resolve).
        if path == "/api/backup/resolve":
            if not self.client_is_local():
                self.send_json(403, {"ok": False, "error": "local requests only"})
                return
            try:
                status, payload = resolve_backup_root_response(self.read_json_body())
                self.send_json(status, payload)
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


def select_port(host: str, wanted: int | None) -> int | None:
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
          f"to css/ and js/. Looked in: {ROOT}", file=sys.stderr)
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


def check_only() -> int:
    """--check: summarise the rule book and stop. Serves no page."""
    if not RULES.exists():
        print(f"No rule book at {RULES}", file=sys.stderr)
        return 1
    try:
        import openpyxl                            # noqa: F401 - presence check
    except ImportError:
        print("--check reads the workbook, which needs openpyxl:\n"
              f'    {sys.executable} -m pip install openpyxl', file=sys.stderr)
        return 2
    describe_rules()
    return 0


# Start the server, print the address, and run until interrupted.
def serve(host: str, port: int, open_browser: bool, program_roots=None) -> int:
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"
    # Register the allowlisted program roots.
    set_program_roots(program_roots)

    # Bind the server and exit if the port is taken.
    try:
        server = Server((host, port), Handler)
    except OSError as exc:
        print(f"ERROR: could not serve on {host}:{port} — {exc}", file=sys.stderr)
        return 2

    # Print the startup banner and rule summary.
    print()
    print(f"Migrate Studio is serving {ROOT}")
    describe_rules()
    if PROGRAM_ROOTS:
        print("Backup search roots:")
        for root in PROGRAM_ROOTS:
            print(f"    {root}")
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


# Parse options and dispatch to check or serve.
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
    parser.add_argument("--programs", action="append", type=Path, default=[],
                        help="program folder root to search first for "
                             "date-preserving backups; may be passed more "
                             "than once")
    parser.add_argument("--no-open", action="store_true",
                        help="serve without opening a browser")
    parser.add_argument("--check", action="store_true",
                        help="summarise Migrate_Studio_Rules.xlsx and exit")
    args = parser.parse_args(sys.argv[1:] if argv is None else list(argv))

    # Summarize the rule book and exit.
    if args.check:
        return check_only()

    # Verify the required files exist before serving.
    if not check_layout():
        return 2

    # Pick a port and start serving.
    port = select_port(args.host, args.port)
    if port is None:
        return 2

    return serve(args.host, port, not args.no_open, args.programs)


if __name__ == "__main__":
    raise SystemExit(main())
