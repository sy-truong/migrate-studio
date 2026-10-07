"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0
"""

# Verify data directory resolution, redirected writes, legacy import, and file serving.
import contextlib
import json
import pathlib
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import unittest

# Add the edition root to sys.path so migrate_studio imports.
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import migrate_studio as studio  # noqa: E402


# Load a JSON file from disk.
def read_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


# Ask the OS for an unused loopback port.
def free_port() -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


# Cover data directory defaults, overrides, redirection, import, and serving.
class DataDirTest(unittest.TestCase):
    # Check per-OS default locations and fallbacks.
    def test_os_default_locations(self):
        home = pathlib.Path("/home/tester")
        self.assertEqual(
            studio.default_data_dir("win32", {"LOCALAPPDATA": "C:/Users/tester/AppData/Local"}, home),
            pathlib.Path("C:/Users/tester/AppData/Local") / studio.APP_NAME,
        )
        self.assertEqual(
            studio.default_data_dir("win32", {}, home),
            home / "AppData" / "Local" / studio.APP_NAME,
        )
        self.assertEqual(
            studio.default_data_dir("darwin", {}, pathlib.Path("/Users/tester")),
            pathlib.Path("/Users/tester/Library/Application Support") / studio.APP_NAME,
        )
        self.assertEqual(
            studio.default_data_dir("linux", {"XDG_DATA_HOME": "/xdg/data"}, home),
            pathlib.Path("/xdg/data") / studio.APP_NAME,
        )
        self.assertEqual(
            studio.default_data_dir("linux", {"XDG_DATA_HOME": "relative"}, home),
            home / ".local" / "share" / studio.APP_NAME,
        )

    # Check that the CLI path beats the environment variable.
    def test_override_order(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            cli = tmp / "cli"
            env = {"MIGRATE_STUDIO_DATA_DIR": str(tmp / "env")}
            self.assertEqual(studio.resolve_data_dir(str(cli), env), cli.resolve())
            self.assertEqual(studio.resolve_data_dir(None, env), (tmp / "env").resolve())

    # Check that configure_data_dir redirects history, selection, and cache files.
    def test_configure_and_redirected_writes(self):
        # Save module globals so they can be restored afterward.
        old = (studio.DATA_DIR, studio.HISTORY, studio.SELECTIONS,
               studio.BACKUP_RESOLUTION_CACHE)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                data = pathlib.Path(tmpdir) / "nested" / "data"
                studio.configure_data_dir(data)
                self.assertTrue(data.is_dir())
                self.assertEqual(studio.HISTORY, data / studio.HISTORY_NAME)
                self.assertEqual(studio.SELECTIONS, data / studio.SELECTIONS_NAME)
                self.assertEqual(studio.BACKUP_RESOLUTION_CACHE,
                                 data / studio.BACKUP_CACHE_NAME)

                # Confirm history writes land in the configured directory.
                result = studio.append_history_run({"runId": "r1"})
                self.assertTrue(result["ok"])
                self.assertEqual(read_json(studio.HISTORY)["runs"][0]["runId"], "r1")

                # Confirm the backup cache writes to the configured directory.
                studio.save_backup_resolution_cache({"key": {"path": "/tmp/study"}})
                self.assertEqual(read_json(studio.BACKUP_RESOLUTION_CACHE)["key"]["path"],
                                 "/tmp/study")
        # Restore the original module globals.
        finally:
            (studio.DATA_DIR, studio.HISTORY, studio.SELECTIONS,
             studio.BACKUP_RESOLUTION_CACHE) = old

    # Check legacy import merges new runs and skips duplicates.
    def test_import_legacy_history(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = pathlib.Path(tmpdir)
            legacy = tmp / "legacy.json"
            target = tmp / "data" / "history.json"
            legacy.write_text(json.dumps({
                "runs": [
                    {"runId": "a", "appliedAt": "2026-09-01T00:00:00Z"},
                    {"runId": "a", "appliedAt": "2026-09-01T00:00:00Z"},
                    {"runId": "b", "appliedAt": "2026-09-02T00:00:00Z"},
                ]
            }), encoding="utf-8")
            target.parent.mkdir()
            target.write_text(json.dumps({"runs": [
                {"runId": "b", "appliedAt": "2026-09-02T00:00:00Z"}
            ]}), encoding="utf-8")

            # Import and confirm the legacy file is left untouched.
            original = legacy.read_text(encoding="utf-8")
            result = studio.import_legacy_history(legacy, target)
            self.assertTrue(result["ok"])
            self.assertEqual(result["imported"], 1)
            self.assertEqual(result["skipped"], 2)
            self.assertEqual(legacy.read_text(encoding="utf-8"), original)
            self.assertEqual([r["runId"] for r in read_json(target)["runs"]],
                             ["a", "b"])

            # Re-import to confirm the operation is idempotent.
            again = studio.import_legacy_history(legacy, target)
            self.assertEqual(again["imported"], 0)
            self.assertEqual(again["skipped"], 3)
            missing = studio.import_legacy_history(tmp / "missing.json", target)
            self.assertFalse(missing["ok"])

    # Check the server serves history and selection files but hides private ones.
    def test_http_serves_data_dir_files(self):
        # Save module globals so they can be restored afterward.
        old = (studio.DATA_DIR, studio.HISTORY, studio.SELECTIONS,
               studio.BACKUP_RESOLUTION_CACHE)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                data = pathlib.Path(tmpdir) / "data"
                studio.configure_data_dir(data)
                studio.HISTORY.write_text(json.dumps({"runs": [
                    {"runId": "served"}
                ]}), encoding="utf-8")
                studio.BACKUP_RESOLUTION_CACHE.write_text('{"secret": true}',
                                                          encoding="utf-8")

                # Start a real server on a free port.
                port = free_port()
                server = studio.Server(("127.0.0.1", port), studio.Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{port}"

                # Fetch JSON from the running server.
                def get(path):
                    with urllib.request.urlopen(base + path, timeout=5) as response:
                        return response.status, json.loads(response.read().decode("utf-8"))

                try:
                    # Confirm history.json is served.
                    status, body = get("/history.json")
                    self.assertEqual(status, 200)
                    self.assertEqual(body["runs"][0]["runId"], "served")

                    # Confirm an unwritten selections file returns 404.
                    with self.assertRaises(urllib.error.HTTPError) as missing:
                        urllib.request.urlopen(base + "/current_selections.json", timeout=5)
                    self.assertEqual(missing.exception.code, 404)

                    # Save a selection through the API and read it back.
                    req = urllib.request.Request(
                        base + "/api/current-selection",
                        data=json.dumps({"program_folder": "/tmp/study"}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as response:
                        self.assertEqual(response.status, 200)
                    status, body = get("/current_selections.json")
                    self.assertEqual(status, 200)
                    self.assertEqual(body["program_folder"], "/tmp/study")

                    # Confirm the backup roots file stays hidden.
                    with self.assertRaises(urllib.error.HTTPError) as hidden:
                        urllib.request.urlopen(base + "/backup_roots.json", timeout=5)
                    self.assertEqual(hidden.exception.code, 404)

                    # Confirm whoami reports the data directory.
                    status, body = get("/api/whoami")
                    self.assertEqual(status, 200)
                    self.assertEqual(body["dataDir"], str(data))
                # Stop the server and join its thread.
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)
        # Restore the original module globals.
        finally:
            (studio.DATA_DIR, studio.HISTORY, studio.SELECTIONS,
             studio.BACKUP_RESOLUTION_CACHE) = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
