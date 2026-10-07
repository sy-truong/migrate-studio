"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0
"""

# Verify history persistence and the whoami API in migrate_studio.
import json
import pathlib
import sys
import tempfile
import threading

# Add the edition root to sys.path so migrate_studio imports.
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import migrate_studio  # noqa: E402


# Build a minimal run record.
def run(run_id):
    return {"runId": run_id, "action": "apply-fix"}


# Build a run record that carries OS-derived user identity.
def identity_run(run_id):
    item = run(run_id)
    item["user"] = {
        "id": "ExampleUser",
        "key": "exampleuser",
        "source": "os",
        "name": "",
        "email": "",
    }
    return item


# Load a JSON file from disk.
def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


# Cover append, duplicate, validation, and identity handling.
with tempfile.TemporaryDirectory() as tmpdir:
    history = pathlib.Path(tmpdir) / "history.json"

    # Append a first run and check the saved schema.
    result = migrate_studio.append_history_run(run("r1"), history)
    assert result["ok"] is True
    book = read(history)
    assert book["schema"] == "migrate-studio/history"
    assert book["version"] == 1
    assert [r["runId"] for r in book["runs"]] == ["r1"]

    # Append a second run and confirm order is kept.
    migrate_studio.append_history_run(run("r2"), history)
    assert [r["runId"] for r in read(history)["runs"]] == ["r1", "r2"]

    # Re-append an existing run ID and expect a duplicate flag.
    result = migrate_studio.append_history_run(run("r2"), history)
    assert result["duplicate"] is True
    assert [r["runId"] for r in read(history)["runs"]] == ["r1", "r2"]

    # Reject a run that has no run ID.
    bad = migrate_studio.append_history_run({}, history)
    assert bad["ok"] is False
    assert bad["status"] == 400

    # Preserve the user identity fields on save.
    result = migrate_studio.append_history_run(identity_run("r3"), history)
    assert result["ok"] is True
    saved = read(history)["runs"][-1]
    assert saved["user"]["id"] == "ExampleUser"
    assert saved["user"]["key"] == "exampleuser"
    assert saved["user"]["source"] == "os"

    # Accept legacy runs that only carry name and email.
    legacy = {"runId": "legacy", "user": {"name": "Legacy", "email": ""}}
    result = migrate_studio.append_history_run(legacy, history)
    assert result["ok"] is True
    assert read(history)["runs"][-1]["user"]["name"] == "Legacy"

# Quarantine a corrupt history file and start a fresh one.
with tempfile.TemporaryDirectory() as tmpdir:
    history = pathlib.Path(tmpdir) / "history.json"
    history.write_text("{not json", encoding="utf-8")
    migrate_studio.append_history_run(run("fresh"), history)
    assert (pathlib.Path(tmpdir) / "history.corrupt.json").exists()
    assert [r["runId"] for r in read(history)["runs"]] == ["fresh"]

# Trim history to the newest max_runs entries.
with tempfile.TemporaryDirectory() as tmpdir:
    history = pathlib.Path(tmpdir) / "history.json"
    for i in range(7):
        migrate_studio.append_history_run(run(f"r{i}"), history, max_runs=5)
    assert [r["runId"] for r in read(history)["runs"]] == [
        "r2", "r3", "r4", "r5", "r6"
    ]

# Append from 20 threads and confirm no run is lost.
with tempfile.TemporaryDirectory() as tmpdir:
    history = pathlib.Path(tmpdir) / "history.json"
    lock = threading.Lock()

    def append(i):
        with lock:
            migrate_studio.append_history_run(run(f"t{i}"), history)

    threads = [threading.Thread(target=append, args=(i,)) for i in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(read(history)["runs"]) == 20

# Check that whoami returns a consistent user identity.
who = migrate_studio.whoami()
assert who["ok"] is True
assert who["userId"]
assert who["userKey"] == who["userId"].lower()
assert who["source"] in ("os", "unknown")


# Stub the HTTP handler so GET /api/whoami runs without a socket.
class FakeWhoamiHandler(migrate_studio.Handler):
    def __init__(self, address):
        self.client_address = (address, 12345)
        self.path = "/api/whoami"
        self.headers = {"Host": "localhost:8820"}
        self.server = type("Server", (), {"server_address": ("127.0.0.1", 8820)})()
        self.status = None
        self.payload = None

    def send_json(self, status, payload):
        self.status = status
        self.payload = payload

    def client_is_local(self):
        return migrate_studio.Handler.client_is_local(self)


# Allow whoami for a loopback client.
local_handler = FakeWhoamiHandler("127.0.0.1")
migrate_studio.Handler.do_GET(local_handler)
assert local_handler.status == 200
assert local_handler.payload["userId"] == who["userId"]

# Refuse whoami for a remote client and leak no identity.
remote_handler = FakeWhoamiHandler("192.0.2.10")
migrate_studio.Handler.do_GET(remote_handler)
assert remote_handler.status == 403
assert "userId" not in remote_handler.payload
assert who["userId"] not in json.dumps(remote_handler.payload)

print("History API tests passed.")
