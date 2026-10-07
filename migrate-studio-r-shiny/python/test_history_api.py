"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0
"""

# Verify run history, backup originals, and root resolution in migrate_studio.
import json
import os
import threading
from pathlib import Path

import migrate_studio


# Redirect history storage to a temp path and restore it on exit.
class HistoryRoot:
    def __init__(self, tmp_path):
        self.old_history = migrate_studio.HISTORY
        self.old_max = migrate_studio.MAX_HISTORY_RUNS
        self.old_lock = migrate_studio.HISTORY_LOCK
        migrate_studio.HISTORY = Path(tmp_path) / "history.json"
        migrate_studio.MAX_HISTORY_RUNS = 500
        migrate_studio.HISTORY_LOCK = threading.Lock()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        migrate_studio.HISTORY = self.old_history
        migrate_studio.MAX_HISTORY_RUNS = self.old_max
        migrate_studio.HISTORY_LOCK = self.old_lock


# Point the program roots and backup caches at test folders, then restore them.
class ProgramRoots:
    def __init__(self, roots, cache_dir=None):
        self.roots = roots
        self.cache_dir = cache_dir
        self.old_roots = migrate_studio.PROGRAM_ROOTS
        self.old_cache = migrate_studio.BACKUP_ROOT_CACHE
        self.old_tokens = migrate_studio.ROOT_TOKENS
        self.old_resolutions = migrate_studio.BACKUP_RESOLUTIONS

    def __enter__(self):
        migrate_studio.set_program_roots(self.roots)
        cache_base = Path(self.cache_dir or (self.roots[0] if self.roots else "."))
        migrate_studio.BACKUP_ROOT_CACHE = cache_base / "backup_roots.json"
        migrate_studio.ROOT_TOKENS = {}
        migrate_studio.BACKUP_RESOLUTIONS = {}
        return self

    def __exit__(self, exc_type, exc, tb):
        migrate_studio.PROGRAM_ROOTS = self.old_roots
        migrate_studio.BACKUP_ROOT_CACHE = self.old_cache
        migrate_studio.ROOT_TOKENS = self.old_tokens
        migrate_studio.BACKUP_RESOLUTIONS = self.old_resolutions


# Switch the working directory temporarily.
class WorkingDirectory:
    def __init__(self, path):
        self.path = Path(path)
        self.old = Path.cwd()

    def __enter__(self):
        os.chdir(self.path)
        return self

    def __exit__(self, exc_type, exc, tb):
        os.chdir(self.old)


# Load the saved history file.
def read_history():
    return json.loads(migrate_studio.HISTORY.read_text(encoding="utf-8"))


# Set a file's access and modification times in nanoseconds.
def set_mtime_ns(path: Path, value: int):
    os.utime(path, ns=(value, value))


# Build a name, size, and mtime fingerprint for files under a root.
def fingerprint_for(root: Path, mapping: dict[str, list[str]]) -> dict:
    out = {}
    for folder, names in mapping.items():
        entries = []
        for name in names:
            path = root / folder / name if folder else root / name
            stat = path.stat()
            entries.append({
                "name": name,
                "size": stat.st_size,
                "lastModified": stat.st_mtime_ns // 1_000_000,
            })
        out[folder] = sorted(entries, key=lambda entry: entry["name"])
    return out


# Resolve a folder fingerprint to a root token and assert success.
def resolve_token(folder_name: str, fingerprint: dict):
    status, payload = migrate_studio.resolve_backup_root_response({
        "folderName": folder_name,
        "fingerprint": fingerprint,
    })
    assert status == 200
    assert payload["resolved"] is True
    return payload["rootToken"], payload


# Check the first append creates the envelope and later runs follow.
def test_history_append_creates_envelope_and_appends(tmp_path):
    with HistoryRoot(tmp_path):
        assert migrate_studio.append_history_run({"runId": "run-1"})["ok"]
        first = read_history()["runs"][0]
        assert first == {"runId": "run-1"}

        assert migrate_studio.append_history_run({"runId": "run-2"})["ok"]
        runs = read_history()["runs"]
        assert runs[0] == first
        assert [run["runId"] for run in runs] == ["run-1", "run-2"]


# Check a repeated run ID is stored once.
def test_history_duplicate_run_id_appends_once(tmp_path):
    with HistoryRoot(tmp_path):
        assert migrate_studio.append_history_run({"runId": "same"})["ok"]
        result = migrate_studio.append_history_run({"runId": "same"})
        assert result["duplicate"] is True
        assert len(read_history()["runs"]) == 1


# Check an unreadable history file is set aside and replaced.
def test_corrupt_history_is_set_aside(tmp_path):
    with HistoryRoot(tmp_path):
        migrate_studio.HISTORY.write_text("{not json", encoding="utf-8")
        assert migrate_studio.append_history_run({"runId": "fresh"})["ok"]
        assert migrate_studio.HISTORY.with_suffix(".corrupt.json").exists()
        assert [run["runId"] for run in read_history()["runs"]] == ["fresh"]


# Check the history cap drops the oldest runs.
def test_history_cap_keeps_newest(tmp_path):
    with HistoryRoot(tmp_path):
        migrate_studio.MAX_HISTORY_RUNS = 3
        for i in range(5):
            assert migrate_studio.append_history_run({"runId": f"run-{i}"})["ok"]
        assert [run["runId"] for run in read_history()["runs"]] == [
            "run-2", "run-3", "run-4"]


# Check concurrent appends from 20 threads are all kept.
def test_concurrent_history_appends_are_all_kept(tmp_path):
    with HistoryRoot(tmp_path):
        threads = []
        for i in range(20):
            thread = threading.Thread(
                target=migrate_studio.append_history_run,
                args=({"runId": f"run-{i}"},),
            )
            threads.append(thread)
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

        runs = read_history()["runs"]
        assert len(runs) == 20
        assert {run["runId"] for run in runs} == {
            f"run-{i}" for i in range(20)}


# Check backups copy file content and keep nanosecond mtimes.
def test_backup_originals_preserves_mtime_ns(tmp_path):
    root = tmp_path / "EXAMPLE001"
    source_dir = root / "sdtm"
    source_dir.mkdir(parents=True)
    source = source_dir / "dm.sas"
    source.write_text("data dm; run;\n", encoding="utf-8")
    original_ns = 1725900000123456789
    set_mtime_ns(source, original_ns)

    with ProgramRoots([root], tmp_path):
        token, resolved = resolve_token(root.name, fingerprint_for(root, {
            "sdtm": ["dm.sas"],
        }))
        assert resolved["resolution"] == "programs-flag"
        status, payload = migrate_studio.backup_originals_response({
            "rootToken": token,
            "directories": [{"folder": "sdtm", "files": ["dm.sas"]}],
        })

    assert status == 200
    assert payload["copied"] == 1
    assert payload["skipped"] == 0
    assert payload["failed"] == []
    backup = source_dir / migrate_studio.BACKUP_DIRNAME / "dm.sas"
    assert backup.read_text(encoding="utf-8") == "data dm; run;\n"
    assert backup.stat().st_mtime_ns == source.stat().st_mtime_ns
    assert backup.stat().st_mtime_ns == original_ns


# Check stamping repairs the mtime of a browser-made copy.
def test_backup_stamp_repairs_browser_copy_mtime(tmp_path):
    root = tmp_path / "EXAMPLE001"
    source_dir = root / "sdtm"
    source_dir.mkdir(parents=True)
    source = source_dir / "dm.sas"
    source.write_text("data dm; run;\n", encoding="utf-8")
    original_ns = 1725900000123456789
    set_mtime_ns(source, original_ns)
    backup_dir = source_dir / migrate_studio.BACKUP_DIRNAME
    backup_dir.mkdir()
    backup = backup_dir / "dm.sas"
    backup.write_text("data dm; run;\n", encoding="utf-8")
    set_mtime_ns(backup, 1700000000000000000)

    with ProgramRoots([root], tmp_path):
        token, _resolved = resolve_token(root.name, fingerprint_for(root, {
            "sdtm": ["dm.sas"],
        }))
        status, payload = migrate_studio.backup_stamp_response({
            "rootToken": token,
            "entries": [{"folder": "sdtm", "name": "dm.sas",
                         "lastModified": original_ns / 1_000_000}],
        })

    assert status == 200
    assert payload["ok"] is True
    assert payload["stamped"] == 1
    assert payload["dateFailed"] == []
    assert abs(backup.stat().st_mtime_ns - original_ns) <= migrate_studio.MTIME_TOLERANCE_NS


# Check the copy falls back to copy2 when the OS command fails.
def test_copy_preserving_falls_back_to_copy2(tmp_path, monkeypatch):
    source = tmp_path / "dm.sas"
    dest = tmp_path / "backup" / "dm.sas"
    dest.parent.mkdir()
    source.write_text("data dm; run;\n", encoding="utf-8")
    original_ns = 1725900000123456789
    set_mtime_ns(source, original_ns)

    # Simulate an unavailable OS copy command.
    def fail_run(*_args, **_kwargs):
        raise OSError("cp unavailable")

    monkeypatch.setattr(migrate_studio.subprocess, "run", fail_run)
    method, date_ok = migrate_studio.copy_preserving(source, dest)

    assert method == "copy2"
    assert date_ok is True
    assert dest.read_text(encoding="utf-8") == "data dm; run;\n"
    assert dest.stat().st_mtime_ns == original_ns


# Check Windows copies use robocopy with date-preserving flags.
def test_os_copy_command_uses_robocopy_shape_on_windows(monkeypatch):
    monkeypatch.setattr(migrate_studio.platform, "system", lambda: "Windows")
    cmd, ok = migrate_studio._os_copy_command(
        Path("C:/study/prog.sas"),
        Path("C:/study/_migrate_original/prog.sas"),
    )

    assert cmd[:4] == [
        "robocopy",
        str(Path("C:/study")),
        str(Path("C:/study/_migrate_original")),
        "prog.sas",
    ]
    assert "/COPY:DAT" in cmd
    assert ok(7) is True
    assert ok(8) is False


# Check a second backup run never overwrites the saved original.
def test_backup_originals_write_once_survives_second_run_and_source_overwrite(tmp_path):
    root = tmp_path / "EXAMPLE001"
    root.mkdir()
    source = root / "dm.sas"
    source.write_text("original\n", encoding="utf-8")
    original_ns = 1725900000123456789
    set_mtime_ns(source, original_ns)
    request = {
        "root": str(root),
        "directories": [{"folder": "", "files": ["dm.sas"]}],
    }

    with ProgramRoots([root], tmp_path):
        token, _resolved = resolve_token(root.name, fingerprint_for(root, {
            "": ["dm.sas"],
        }))
        request["rootToken"] = token
        request.pop("root", None)
        status, first = migrate_studio.backup_originals_response(request)
        source.write_text("fixed\n", encoding="utf-8")
        set_mtime_ns(source, 1825900000123456789)
        second_status, second = migrate_studio.backup_originals_response(request)

    backup = root / migrate_studio.BACKUP_DIRNAME / "dm.sas"
    assert status == 200
    assert first["copied"] == 1
    assert second_status == 200
    assert second["copied"] == 0
    assert second["skipped"] == 1
    assert backup.read_text(encoding="utf-8") == "original\n"
    assert backup.stat().st_mtime_ns == original_ns


# Check backups index every program directory and skip output folders.
def test_backup_originals_samples_shape_indexes_program_directories(tmp_path):
    root = tmp_path / "samples"
    program_paths = [
        "adam_t_demog.sas",
        "root_a.sas",
        "root_b.sas",
        "STUDY_SRC_ADAM/adae.sas",
        "STUDY_SRC_ADAM/adsl.sas",
        "STUDY_SRC_SDTM/dm.sas",
        "STUDY_SRC_TLF/t-ae.sas",
        "STUDY_DST_SDTM/dm.sas",
        "STUDY_DST_SDTM/test_tool/check.sas",
        "STUDY_DST_TLF/t-demog.sas",
        "STUDY_DST_TLF/MA_Testing/t-ae.sas",
    ]
    # Create each sample program file.
    for rel in program_paths:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rel + "\n", encoding="utf-8")
    (root / "STUDY_DST_SDTM/test_tool/std").mkdir(parents=True)
    (root / "STUDY_DST_TLF/MA_Testing/Output").mkdir(parents=True)
    directories = [
        {"folder": "", "files": ["adam_t_demog.sas", "root_a.sas", "root_b.sas"]},
        {"folder": "STUDY_SRC_ADAM", "files": ["adae.sas", "adsl.sas"]},
        {"folder": "STUDY_SRC_SDTM", "files": ["dm.sas"]},
        {"folder": "STUDY_SRC_TLF", "files": ["t-ae.sas"]},
        {"folder": "STUDY_DST_SDTM", "files": ["dm.sas"]},
        {"folder": "STUDY_DST_SDTM/test_tool", "files": ["check.sas"]},
        {"folder": "STUDY_DST_TLF", "files": ["t-demog.sas"]},
        {"folder": "STUDY_DST_TLF/MA_Testing", "files": ["t-ae.sas"]},
    ]

    with ProgramRoots([root], tmp_path):
        token, _resolved = resolve_token(root.name, fingerprint_for(root, {
            entry["folder"]: entry["files"] for entry in directories
        }))
        status, payload = migrate_studio.backup_originals_response({
            "rootToken": token,
            "directories": directories,
        })

    assert status == 200
    assert payload["copied"] == len(program_paths)
    assert sorted(payload["index"]) == sorted(entry["folder"] for entry in directories)
    assert not (root / "STUDY_DST_SDTM/test_tool/std/_migrate_original").exists()
    assert not (root / "STUDY_DST_TLF/MA_Testing/Output/_migrate_original").exists()


# Check a forged root token is refused and the raw root is ignored.
def test_backup_originals_rejects_invalid_root_token_and_ignores_raw_root(tmp_path):
    allowed = tmp_path / "EXAMPLE001"
    other = tmp_path / "STUDY999"
    allowed.mkdir()
    other.mkdir()
    (other / "dm.sas").write_text("data dm; run;\n", encoding="utf-8")
    with ProgramRoots([allowed], tmp_path):
        status, payload = migrate_studio.backup_originals_response({
            "root": str(other),
            "rootToken": "fabricated",
            "directories": [{"folder": "", "files": ["dm.sas"]}],
        })

    assert status == 403
    assert payload["ok"] is False
    assert not (other / migrate_studio.BACKUP_DIRNAME).exists()


# Check a folder resolves when it sits under a configured programs root.
def test_backup_resolve_finds_folder_under_programs_root(tmp_path):
    studies = tmp_path / "studies"
    root = studies / "Test2"
    root.mkdir(parents=True)
    source = root / "dm.sas"
    source.write_text("data dm; run;\n", encoding="utf-8")
    original_ns = 1725900000123456789
    set_mtime_ns(source, original_ns)

    with ProgramRoots([studies], tmp_path):
        token, payload = resolve_token("Test2", fingerprint_for(root, {
            "": ["dm.sas"],
        }))
        assert payload["resolution"] == "programs-flag"
        status, copied = migrate_studio.backup_originals_response({
            "rootToken": token,
            "directories": [{"folder": "", "files": ["dm.sas"]}],
        })

    backup = root / migrate_studio.BACKUP_DIRNAME / "dm.sas"
    assert status == 200
    assert copied["copied"] == 1
    assert backup.stat().st_mtime_ns == original_ns


# Check a folder resolves by searching from the working directory.
def test_backup_resolve_finds_folder_by_search(tmp_path):
    root = tmp_path / "EXAMPLE001"
    root.mkdir()
    source = root / "dm.sas"
    source.write_text("data dm; run;\n", encoding="utf-8")
    original_ns = 1725900000123456789
    set_mtime_ns(source, original_ns)

    with WorkingDirectory(tmp_path):
        with ProgramRoots([], tmp_path):
            token, payload = resolve_token("EXAMPLE001", fingerprint_for(root, {
                "": ["dm.sas"],
            }))
            assert payload["resolution"] == "search"
            status, copied = migrate_studio.backup_originals_response({
                "rootToken": token,
                "directories": [{"folder": "", "files": ["dm.sas"]}],
            })

    assert status == 200
    assert copied["copied"] == 1
    assert (root / migrate_studio.BACKUP_DIRNAME / "dm.sas").stat().st_mtime_ns == original_ns


# Check the fingerprint picks the right same-named folder.
def test_backup_resolve_selects_matching_same_named_folder(tmp_path):
    a = tmp_path / "a" / "Test2"
    b = tmp_path / "b" / "Test2"
    a.mkdir(parents=True)
    b.mkdir(parents=True)
    (a / "dm.sas").write_text("right\n", encoding="utf-8")
    (b / "ae.sas").write_text("wrong\n", encoding="utf-8")

    with ProgramRoots([tmp_path], tmp_path):
        _token, payload = resolve_token("Test2", fingerprint_for(a, {
            "": ["dm.sas"],
        }))

    assert payload["path"] == str(a.resolve())


# Check identical same-named folders are reported as ambiguous.
def test_backup_resolve_ambiguous_for_identical_same_named_folders(tmp_path):
    a = tmp_path / "a" / "Test2"
    b = tmp_path / "b" / "Test2"
    a.mkdir(parents=True)
    b.mkdir(parents=True)
    for root in (a, b):
        (root / "dm.sas").write_text("same\n", encoding="utf-8")
        set_mtime_ns(root / "dm.sas", 1725900000000000000)

    with ProgramRoots([tmp_path], tmp_path):
        status, payload = migrate_studio.resolve_backup_root_response({
            "folderName": "Test2",
            "fingerprint": fingerprint_for(a, {"": ["dm.sas"]}),
        })

    assert status == 200
    assert payload["resolved"] is False
    assert payload["reason"] == "ambiguous"


# Check extra or missing files fail the fingerprint match.
def test_backup_resolve_rejects_extra_or_missing_fingerprint_files(tmp_path):
    root = tmp_path / "Test2"
    root.mkdir()
    (root / "dm.sas").write_text("dm\n", encoding="utf-8")
    (root / "ae.sas").write_text("ae\n", encoding="utf-8")

    with ProgramRoots([tmp_path], tmp_path):
        status, payload = migrate_studio.resolve_backup_root_response({
            "folderName": "Test2",
            "fingerprint": fingerprint_for(root, {"": ["dm.sas"]}),
        })

    assert status == 200
    assert payload["resolved"] is False
    assert payload["reason"] == "not-found"


# Check the mtime tolerance accepts one second and rejects ten.
def test_backup_resolve_mtime_tolerance_is_two_seconds(tmp_path):
    root = tmp_path / "Test2"
    root.mkdir()
    source = root / "dm.sas"
    source.write_text("dm\n", encoding="utf-8")
    set_mtime_ns(source, 1725900000000000000)
    fingerprint = fingerprint_for(root, {"": ["dm.sas"]})

    set_mtime_ns(source, 1725900001000000000)
    assert migrate_studio.verify_fingerprint(root, fingerprint)

    set_mtime_ns(source, 1725900010000000000)
    assert not migrate_studio.verify_fingerprint(root, fingerprint)


# Check a stale cache entry is verified and then re-searched.
def test_backup_resolve_stale_cache_verifies_then_searches_again(tmp_path):
    old = tmp_path / "old" / "Test2"
    new = tmp_path / "new" / "Test2"
    old.mkdir(parents=True)
    (old / "dm.sas").write_text("dm\n", encoding="utf-8")
    fingerprint = fingerprint_for(old, {"": ["dm.sas"]})

    with ProgramRoots([tmp_path], tmp_path):
        _token, first = resolve_token("Test2", fingerprint)
        assert first["path"] == str(old.resolve())
        new.parent.mkdir(parents=True)
        old.rename(new)
        _token, second = resolve_token("Test2", fingerprint)

    assert second["path"] == str(new.resolve())
    assert second["resolution"] == "programs-flag"


# Check backup folders are pruned and the search depth is capped.
def test_backup_resolve_prunes_backup_dirs_and_respects_depth_cap(tmp_path):
    pruned = tmp_path / migrate_studio.BACKUP_DIRNAME / "Test2"
    too_deep = tmp_path / "a" / "b" / "c" / "d" / "e" / "Test2"
    for root in (pruned, too_deep):
        root.mkdir(parents=True)
        (root / "dm.sas").write_text("dm\n", encoding="utf-8")

    with ProgramRoots([tmp_path], tmp_path):
        status, payload = migrate_studio.resolve_backup_root_response({
            "folderName": "Test2",
            "fingerprint": fingerprint_for(pruned, {"": ["dm.sas"]}),
        })

    assert status == 200
    assert payload["resolved"] is False
    assert payload["reason"] == "not-found"


# Check traversal and non-SAS names are rejected with 400.
def test_backup_originals_rejects_unsafe_folders_and_names(tmp_path):
    root = tmp_path / "EXAMPLE001"
    root.mkdir()
    (root / "dm.sas").write_text("data dm; run;\n", encoding="utf-8")
    # List unsafe folder and file requests.
    cases = [
        {"folder": "../..", "files": ["dm.sas"]},
        {"folder": str(tmp_path), "files": ["dm.sas"]},
        {"folder": "", "files": ["../dm.sas"]},
        {"folder": "", "files": ["sub/dm.sas"]},
        {"folder": "", "files": ["dm.txt"]},
    ]

    with ProgramRoots([root], tmp_path):
        token, _payload = resolve_token(root.name, fingerprint_for(root, {
            "": ["dm.sas"],
        }))
        for case in cases:
            status, payload = migrate_studio.backup_originals_response({
                "rootToken": token,
                "directories": [case],
            })
            assert status == 400
            assert payload["ok"] is False


# Check only loopback clients pass the local guard.
def test_backup_whoami_style_local_guard():
    class FakeHandler:
        def __init__(self, address):
            self.client_address = (address, 8820)

    assert migrate_studio.Handler.client_is_local(FakeHandler("127.0.0.1"))
    assert not migrate_studio.Handler.client_is_local(FakeHandler("10.0.0.5"))


# Check a failing file is reported while other files still copy.
def test_backup_originals_reports_failed_file_without_copying_it(tmp_path):
    root = tmp_path / "EXAMPLE001"
    root.mkdir()
    good = root / "good.sas"
    bad = root / "bad.sas"
    good.write_text("good\n", encoding="utf-8")
    bad.write_text("bad\n", encoding="utf-8")

    # Wrap the copy function so one file fails.
    old_copy_preserving = migrate_studio.copy_preserving

    def fake_copy_preserving(src, dst):
        if Path(src).name == "bad.sas":
            raise OSError("cannot read")
        return old_copy_preserving(src, dst)

    migrate_studio.copy_preserving = fake_copy_preserving
    try:
        with ProgramRoots([root], tmp_path):
            token, _payload = resolve_token(root.name, fingerprint_for(root, {
                "": ["good.sas", "bad.sas"],
            }))
            request = {
                "rootToken": token,
                "directories": [{"folder": "", "files": ["good.sas", "bad.sas"]}],
            }
            status, result = migrate_studio.backup_originals_response(request)
    finally:
        migrate_studio.copy_preserving = old_copy_preserving

    assert status == 500
    assert result["ok"] is False
    assert result["copied"] == 1
    assert result["failed"][0]["name"] == "bad.sas"
    assert (root / migrate_studio.BACKUP_DIRNAME / "good.sas").exists()
    assert not (root / migrate_studio.BACKUP_DIRNAME / "bad.sas").exists()
