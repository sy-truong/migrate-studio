"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0
"""

# Verify backup-originals handling and Migrate Studio rules against synthetic samples.
import os
import io
import json
import sys
import re
import tempfile
import time
import unittest
import zipfile
from pathlib import Path


# Make the edition root and python folder importable.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "python"))

import migrate_studio as studio  # noqa: E402
import mig_apply as mig  # noqa: E402


# Define rule IDs and target values reused across tests.
RULES_001_021 = [f"R-{number:03d}" for number in range(1, 22)]
TLF_AUTOEXEC = mig.DEFAULT_PARAMS["TARGET_TLF_AUTOEXEC"]
TLF_MA_AUTOEXEC = mig.DEFAULT_PARAMS["TARGET_TLF_MA_AUTOEXEC"]
MHEADFOOT = mig.DEFAULT_PARAMS["TARGET_MHEADFOOT"]
SETUPANL = mig.DEFAULT_PARAMS["TARGET_SETUPANL"]
MTRIM = mig.DEFAULT_PARAMS["TARGET_MTRIM"]
PADAM = mig.DEFAULT_PARAMS["TARGET_PADAM"]
SDTM_AUTOEXEC = mig.DEFAULT_PARAMS["TARGET_SDTM_AUTOEXEC"]
LEGACY_TLF = '%include "../../../../programs/tlf/20260131_SYNTH/primary/autoexec.sas";'


# Decode a SAS program by trying common encodings in turn.
def read_program(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise AssertionError(f"Cannot decode {path}")


# Run the selected rules (default all) on program text.
def apply(text: str, filename: str, rules=None):
    selected = rules or RULES_001_021
    return mig.apply_to_text(text, selected, mig.Context(filename=filename))


# Read one file from a sample archive.
def read_zip(archive_name: str, filename: str) -> str:
    with zipfile.ZipFile(ROOT / "samples" / archive_name) as archive:
        return archive.read(filename).decode("cp1252")


# Check backup-originals copying, root resolution, and request validation.
class BackupOriginalsTest(unittest.TestCase):
    # Isolate the backup cache and root tokens for each test.
    def setUp(self):
        self._real_cache = studio.BACKUP_RESOLUTION_CACHE
        self._cache_tmp = tempfile.TemporaryDirectory()
        studio.BACKUP_RESOLUTION_CACHE = Path(self._cache_tmp.name) / "backup_roots.json"
        studio.BACKUP_ROOT_TOKENS.clear()

    # Restore global backup state after each test.
    def tearDown(self):
        studio.configure_program_roots([])
        studio.BACKUP_ROOT_TOKENS.clear()
        studio.BACKUP_RESOLUTION_CACHE = self._real_cache
        self._cache_tmp.cleanup()

    # Create a program root folder and register it as allowed.
    def make_root(self, tmp: str, name: str = "EXAMPLE001") -> Path:
        root = Path(tmp) / name
        root.mkdir()
        studio.configure_program_roots([str(root)])
        return root

    # Write SAS files with a fixed modification time.
    def write_sas_tree(self, root: Path, rows: dict[str, dict[str, str]],
                       mtime: int = 946684800) -> None:
        for folder, files in rows.items():
            directory = root / folder
            directory.mkdir(parents=True, exist_ok=True)
            for name, text in files.items():
                path = directory / name
                path.write_text(text, encoding="utf-8")
                os.utime(path, (mtime, mtime))

    # Build a name, size, and mtime fingerprint for the written files.
    def fingerprint(self, root: Path, rows: dict[str, dict[str, str]]) -> dict:
        out = {}
        for folder, files in rows.items():
            directory = root / folder
            out[folder] = []
            for name in sorted(files):
                path = directory / name
                stat = path.stat()
                out[folder].append({
                    "name": name,
                    "size": stat.st_size,
                    "lastModified": int(stat.st_mtime * 1000),
                })
        return out

    # Check backups keep mtimes and are written only once.
    def test_backup_preserves_mtime_and_is_write_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            source = root / "dm.sas"
            source.write_text("original text\n", encoding="utf-8")
            os.utime(source, (946684800, 946684800))

            first = studio.backup_originals(str(root), [
                {"folder": "", "files": ["dm.sas"]}
            ])
            backup = root / studio.BACKUP_DIR / "dm.sas"
            self.assertTrue(first["ok"])
            self.assertEqual(first["copied"], 1)
            self.assertEqual(backup.stat().st_mtime_ns, source.stat().st_mtime_ns)

            original_bytes = backup.read_bytes()
            original_mtime = backup.stat().st_mtime_ns
            source.write_text("fixed text\n", encoding="utf-8")
            os.utime(source, (1609459200, 1609459200))

            second = studio.backup_originals(str(root), [
                {"folder": "", "files": ["dm.sas"]}
            ])
            self.assertTrue(second["ok"])
            self.assertEqual(second["copied"], 0)
            self.assertEqual(second["skipped"], 1)
            self.assertEqual(backup.read_bytes(), original_bytes)
            self.assertEqual(backup.stat().st_mtime_ns, original_mtime)
            self.assertEqual(first["index"], {"": ["dm.sas"]})
            self.assertEqual(second["index"], {"": ["dm.sas"]})

    # Check a root resolves by token and the token copy preserves mtimes.
    def test_programs_root_resolves_and_token_copy_preserves_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp, "EXAMPLE001")
            rows = {"": {"dm.sas": "original\n"}}
            self.write_sas_tree(root, rows)
            result = studio.resolve_backup_folder("EXAMPLE001", self.fingerprint(root, rows))
            self.assertTrue(result["resolved"])
            self.assertEqual(result["resolution"], "programs-flag")
            backup = studio.backup_originals_for_token(result["rootToken"], [
                {"folder": "", "files": ["dm.sas"]}
            ])
            source = root / "dm.sas"
            copied = root / studio.BACKUP_DIR / "dm.sas"
            self.assertTrue(backup["ok"])
            self.assertEqual(copied.stat().st_mtime_ns, source.stat().st_mtime_ns)

    # Check stamping repairs the mtime of a browser-made copy.
    def test_backup_stamp_for_token_repairs_browser_copy_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp, "EXAMPLE001")
            rows = {"": {"dm.sas": "original\n"}}
            self.write_sas_tree(root, rows)
            result = studio.resolve_backup_folder("EXAMPLE001", self.fingerprint(root, rows))
            self.assertTrue(result["resolved"])
            backup_dir = root / studio.BACKUP_DIR
            backup_dir.mkdir()
            backup = backup_dir / "dm.sas"
            backup.write_text("original\n", encoding="utf-8")
            os.utime(backup, (1700000000, 1700000000))

            source = root / "dm.sas"
            expected_ms = int(source.stat().st_mtime * 1000)
            stamped = studio.backup_stamp_for_token(result["rootToken"], [
                {"folder": "", "name": "dm.sas", "lastModified": expected_ms}
            ])

            self.assertTrue(stamped["ok"])
            self.assertEqual(stamped["stamped"], 1)
            self.assertEqual(stamped["dateFailed"], [])
            self.assertLessEqual(abs(backup.stat().st_mtime_ns -
                                     source.stat().st_mtime_ns), 2_000_000_000)

    # Check a folder resolves through the search roots.
    def test_search_resolution_finds_matching_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root = parent / "Test2"
            root.mkdir()
            rows = {"": {"dm.sas": "data x; run;\n"}}
            self.write_sas_tree(root, rows)
            real_search = studio.candidate_search_roots
            studio.candidate_search_roots = lambda: [(parent, "search")]
            try:
                result = studio.resolve_backup_folder("Test2", self.fingerprint(root, rows))
            finally:
                studio.candidate_search_roots = real_search
            self.assertTrue(result["resolved"])
            self.assertEqual(result["resolution"], "search")
            self.assertEqual(Path(result["path"]).resolve(), root.resolve())

    # Check the fingerprint rejects a different same-named folder.
    def test_search_rejects_different_same_named_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            match = parent / "a" / "Test2"
            other = parent / "b" / "Test2"
            match.mkdir(parents=True)
            other.mkdir(parents=True)
            rows = {"": {"dm.sas": "match\n"}}
            self.write_sas_tree(match, rows)
            self.write_sas_tree(other, {"": {"ae.sas": "different\n"}})
            real_search = studio.candidate_search_roots
            studio.candidate_search_roots = lambda: [(parent, "search")]
            try:
                result = studio.resolve_backup_folder("Test2", self.fingerprint(match, rows))
            finally:
                studio.candidate_search_roots = real_search
            self.assertTrue(result["resolved"])
            self.assertEqual(Path(result["path"]).resolve(), match.resolve())

    # Check identical same-named folders are reported as ambiguous.
    def test_identical_same_named_folders_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            one = parent / "a" / "Test2"
            two = parent / "b" / "Test2"
            one.mkdir(parents=True)
            two.mkdir(parents=True)
            rows = {"": {"dm.sas": "same\n"}}
            self.write_sas_tree(one, rows)
            self.write_sas_tree(two, rows)
            real_search = studio.candidate_search_roots
            studio.candidate_search_roots = lambda: [(parent, "search")]
            try:
                result = studio.resolve_backup_folder("Test2", self.fingerprint(one, rows))
            finally:
                studio.candidate_search_roots = real_search
            self.assertFalse(result["resolved"])
            self.assertEqual(result["reason"], "ambiguous")

    # Check a fingerprint with an extra file fails verification.
    def test_missing_extra_fingerprint_file_fails_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root = parent / "Test2"
            root.mkdir()
            rows = {"": {"dm.sas": "data x; run;\n"}}
            self.write_sas_tree(root, rows)
            fp = self.fingerprint(root, rows)
            fp[""].append({"name": "ae.sas", "size": 10, "lastModified": fp[""][0]["lastModified"]})
            real_search = studio.candidate_search_roots
            studio.candidate_search_roots = lambda: [(parent, "search")]
            try:
                result = studio.resolve_backup_folder("Test2", fp)
            finally:
                studio.candidate_search_roots = real_search
            self.assertFalse(result["resolved"])
            self.assertEqual(result["reason"], "not-found")

    # Check the mtime tolerance accepts one second and rejects ten.
    def test_mtime_tolerance_is_two_seconds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Test2"
            root.mkdir()
            rows = {"": {"dm.sas": "data x; run;\n"}}
            self.write_sas_tree(root, rows, mtime=946684800)
            fp = self.fingerprint(root, rows)
            fp[""][0]["lastModified"] += 1000
            self.assertTrue(studio.verify_backup_candidate(root, studio.normalized_fingerprint(fp)))
            fp[""][0]["lastModified"] += 9000
            self.assertFalse(studio.verify_backup_candidate(root, studio.normalized_fingerprint(fp)))

    # Check backups are created only in program directories.
    def test_nested_fixture_creates_only_program_directory_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp, "samples")
            folders = [
                "",
                "STUDY_SRC_ADAM",
                "STUDY_SRC_SDTM",
                "STUDY_SRC_TLF",
                "STUDY_DST_SDTM",
                "STUDY_DST_SDTM/test_tool",
                "STUDY_DST_TLF",
                "STUDY_DST_TLF/MA_Testing",
            ]
            empty_folders = [
                "STUDY_DST_SDTM/test_tool/std",
                "STUDY_DST_SDTM/test_tool/crf",
                "STUDY_DST_SDTM/test_tool/acrf",
                "STUDY_DST_SDTM/test_tool/utils",
                "STUDY_DST_TLF/MA_Testing/Output",
                "STUDY_SRC_ADAM/Migrate_Studio",
                "STUDY_SRC_ADAM/PortFix",
            ]
            for folder in folders + empty_folders:
                (root / folder).mkdir(parents=True, exist_ok=True)
            files_by_folder = {
                "": ["root.sas"],
                "STUDY_SRC_ADAM": ["adsl.sas"],
                "STUDY_SRC_SDTM": ["dm.sas", "ae.sas"],
                "STUDY_SRC_TLF": ["t-ae.sas"],
                "STUDY_DST_SDTM": ["dm.sas"],
                "STUDY_DST_SDTM/test_tool": ["tool_dm.sas"],
                "STUDY_DST_TLF": ["t-demog.sas"],
                "STUDY_DST_TLF/MA_Testing": ["t-ae.sas"],
            }
            for folder, names in files_by_folder.items():
                for name in names:
                    (root / folder / name).write_text(name + "\n", encoding="utf-8")

            result = studio.backup_originals(str(root), [
                {"folder": folder, "files": names}
                for folder, names in files_by_folder.items()
            ])
            self.assertTrue(result["ok"])
            self.assertEqual(result["copied"], 9)
            actual_backup_dirs = sorted(
                str(path.parent.relative_to(root))
                for path in root.rglob(studio.BACKUP_DIR)
                if path.is_dir()
            )
            self.assertEqual(actual_backup_dirs, sorted(
                folder if folder else "."
                for folder in folders
            ))
            for folder in empty_folders:
                self.assertFalse((root / folder / studio.BACKUP_DIR).exists())
            self.assertEqual(result["index"], {
                folder: sorted(names)
                for folder, names in files_by_folder.items()
            })

    # Check an unlisted root returns 403 and copies nothing.
    def test_unlisted_root_is_forbidden_and_copies_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            allowed = self.make_root(tmp, "allowed")
            other = Path(tmp) / "other"
            other.mkdir()
            (other / "dm.sas").write_text("data x; run;\n", encoding="utf-8")
            with self.assertRaises(studio.BackupRequestError) as caught:
                studio.backup_originals(str(other), [
                    {"folder": "", "files": ["dm.sas"]}
                ])
            self.assertEqual(caught.exception.status, 403)
            self.assertFalse((other / studio.BACKUP_DIR).exists())
            self.assertFalse((allowed / studio.BACKUP_DIR).exists())

    # Check unsafe folder paths are rejected before any copy.
    def test_invalid_folder_paths_are_rejected_before_copying(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            (root / "dm.sas").write_text("data x; run;\n", encoding="utf-8")
            for folder in ("../..", "/absolute/path", "missing/folder"):
                with self.subTest(folder=folder):
                    with self.assertRaises(studio.BackupRequestError) as caught:
                        studio.backup_originals(str(root), [
                            {"folder": folder, "files": ["dm.sas"]}
                        ])
                    self.assertEqual(caught.exception.status, 400)
                    self.assertFalse((root / studio.BACKUP_DIR).exists())

    # Check non-SAS and path-like file names are rejected.
    def test_invalid_filename_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            for name in ("notes.txt", "../dm.sas", "nested/dm.sas", r"nested\dm.sas"):
                with self.subTest(name=name):
                    with self.assertRaises(studio.BackupRequestError) as caught:
                        studio.backup_originals(str(root), [
                            {"folder": "", "files": [name]}
                        ])
                    self.assertEqual(caught.exception.status, 400)

    # Check symlinked source files are rejected.
    def test_source_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            real = root / "real.sas"
            real.write_text("data x; run;\n", encoding="utf-8")
            link = root / "link.sas"
            link.symlink_to(real)
            with self.assertRaises(studio.BackupRequestError) as caught:
                studio.backup_originals(str(root), [
                    {"folder": "", "files": ["link.sas"]}
                ])
            self.assertEqual(caught.exception.status, 400)
            self.assertFalse((root / studio.BACKUP_DIR).exists())

    # Check remote clients get 403 from the backup endpoint.
    def test_non_local_backup_endpoint_is_forbidden(self):
        # Stub the handler so do_POST runs without a socket.
        class FakeHandler(studio.Handler):
            def __init__(self):
                pass
            path = "/api/backup/originals"
            client_address = ("203.0.113.10", 55220)
            headers = {}
            server = type("Server", (), {"server_address": ("127.0.0.1", 8820)})()

            def client_is_local(self):
                return studio.Handler.client_is_local(self)

            def send_json(self, status, payload):
                self.status = status
                self.payload = payload

        handler = FakeHandler()
        studio.Handler.do_POST(handler)
        self.assertEqual(handler.status, 403)
        self.assertEqual(handler.payload["ok"], False)

    # Check an unknown root token returns 403.
    def test_unknown_root_token_is_rejected(self):
        with self.assertRaises(studio.BackupRequestError) as caught:
            studio.backup_originals_for_token("not-a-real-token", [])
        self.assertEqual(caught.exception.status, 403)

    # Check the endpoint uses the token's root and ignores the raw root path.
    def test_originals_endpoint_ignores_raw_root_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / "real" / "Test2"
            decoy = Path(tmp) / "decoy" / "Test2"
            real.mkdir(parents=True)
            decoy.mkdir(parents=True)
            (real / "dm.sas").write_text("real\n", encoding="utf-8")
            (decoy / "dm.sas").write_text("decoy\n", encoding="utf-8")
            token = studio.mint_root_token(real)

            body = json.dumps({
                "rootToken": token,
                "root": str(decoy),
                "directories": [{"folder": "", "files": ["dm.sas"]}],
            }).encode("utf-8")

            # Stub a local handler that serves the prepared request body.
            class FakeHandler(studio.Handler):
                def __init__(self):
                    pass
                path = "/api/backup/originals"
                client_address = ("127.0.0.1", 55220)
                headers = {"Content-Length": str(len(body)), "Host": "localhost:8820"}
                server = type("Server", (), {"server_address": ("127.0.0.1", 8820)})()
                connection = type("Connection", (), {"settimeout": lambda self, n: None})()
                rfile = io.BytesIO(body)

                def client_is_local(self):
                    return studio.Handler.client_is_local(self)

                def read_json_body(self):
                    return studio.Handler.read_json_body(self)

                def send_json(self, status, payload):
                    self.status = status
                    self.payload = payload

            handler = FakeHandler()
            studio.Handler.do_POST(handler)
            self.assertEqual(handler.status, 200)
            self.assertTrue(handler.payload["ok"])
            self.assertTrue((real / studio.BACKUP_DIR / "dm.sas").exists())
            self.assertFalse((decoy / studio.BACKUP_DIR / "dm.sas").exists())

    # Check searches skip backup and output directories.
    def test_search_prunes_backup_and_output_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            wanted = parent / "visible" / "Test2"
            skipped = parent / studio.BACKUP_DIR / "Test2"
            wanted.mkdir(parents=True)
            skipped.mkdir(parents=True)
            rows = {"": {"dm.sas": "wanted\n"}}
            self.write_sas_tree(wanted, rows)
            self.write_sas_tree(skipped, rows)
            found = studio.find_named_directories(parent, "Test2", "search",
                                                  time.monotonic(), {"count": 0})
            self.assertEqual([path.resolve() for path, _source in found],
                             [wanted.resolve()])

    # Check a copy failure is reported per file.
    def test_copy_failure_reports_failed_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            (root / "dm.sas").write_text("data x; run;\n", encoding="utf-8")

            real_copy2 = studio.shutil.copy2

            def fail_copy2(_src, _dst, follow_symlinks=True):
                raise OSError("forced copy failure")

            studio.shutil.copy2 = fail_copy2
            try:
                result = studio.backup_originals(str(root), [
                    {"folder": "", "files": ["dm.sas"]}
                ])
            finally:
                studio.shutil.copy2 = real_copy2

            self.assertFalse(result["ok"])
            self.assertEqual(result["copied"], 0)
            self.assertEqual(result["failed"][0]["folder"], "")
            self.assertEqual(result["failed"][0]["name"], "dm.sas")


# Check context-sensitive rules R-008 through R-021 on synthetic samples.
class SyntheticContextualRulesTest(unittest.TestCase):
    sample_root = ROOT / "samples" / "EXAMPLE001_windows_to_linux"

    def test_fixture_pack_exercises_core_rule_families(self):
        # Map sample programs to the rules expected to fire.
        cases = {
            "adam/adae.sas": {"R-014", "R-015", "R-016"},
            "adam/adpr.sas": {"R-012", "R-014", "R-015", "R-016"},
            "sdtm/autoexec.sas": {"R-010"},
            "tlf/t-ae-overall.sas": {"R-008", "R-009", "R-011"},
        }
        for relative, expected in cases.items():
            path = self.sample_root / relative
            _, results = apply(read_program(path), path.name)
            changed = {result.rule_id for result in results if result.changes}
            self.assertTrue(expected <= changed, relative)

    # Check TLF startup rules apply in the required order.
    def test_r011_r012_and_tlf_startup_order(self):
        source = read_program(self.sample_root / "tlf" / "t-ae-overall.sas")
        fixed, results = apply(source, "t-ae-overall-saf.sas",
                               ["R-009", "R-011", "R-008", "R-012"])
        self.assertEqual([r.rule_id for r in results if r.changes],
                         ["R-009", "R-011", "R-008", "R-012"])
        self.assertIn(f"/*{LEGACY_TLF}*/", fixed)
        self.assertLess(fixed.index(TLF_AUTOEXEC), fixed.index(MHEADFOOT))
        self.assertIn(SETUPANL, fixed)

    # Check R-013 adds the ADaM libref and is idempotent.
    def test_r013_adds_adam_libref_to_301_macro_call(self):
        source = "* EXAMPLE001-PROT synthetic signal;\n%util_getdata(adsl);\n"
        fixed, results = apply(source, "u900addv.sas", ["R-013"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("%util_getdata(adsl, libref=ADaM)", fixed)
        self.assertEqual(apply(fixed, "u900addv.sas", ["R-013"])[1][0].changes, 0)

    # Check R-016 rebuilds the ADaM export and is idempotent.
    def test_r016_rebuilds_adam_export_and_is_idempotent(self):
        source = read_program(self.sample_root / "adam" / "adae.sas")
        fixed, results = apply(source, "adae.sas", ["R-016"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("%let tlfkey=adae;", fixed)
        self.assertIn(r'&targetStudy.\Dev\Data\ADAM\&tlfkey..xpt', fixed)
        self.assertEqual(apply(fixed, "adae.sas", ["R-016"])[1][0].changes, 0)

    # Check R-017 relocates workbook inputs.
    def test_r017_relocates_workbook_inputs(self):
        source = (
            "* EXAMPLE001 synthetic signal;\n"
            "%let tdpath=%str(\"../../../../programs/sdtm/20260131_SYNTH/documents/EXAMPLE001 SDTM Specs_v1.0.xlsx\");\n"
            "proc import out=spec datafile=\"../../../../programs/sdtm/documents/EXAMPLE001 SDTM Specs_v1.0.xlsx\" dbms=xlsx replace;\n"
        )
        fixed, results = apply(source, "autoexec.sas", ["R-017"])
        self.assertEqual(results[0].changes, 2)
        self.assertEqual(
            fixed.count(r'&targetStudy.\Documents\EXAMPLE001 SDTM Specs_v1.0.xlsx'),
            2,
        )

    # Check R-018 disables only the targeted calls.
    def test_r018_disables_only_targeted_xpt_calls(self):
        source = "* EXAMPLE001-PROT synthetic signal;\n%util_cvtds(dm);\n%util_cvtds(suppdm);\n%util_cvtds(ae);\n"
        fixed, results = apply(source, "t900dm.sas", ["R-018"])
        self.assertEqual(results[0].changes, 2)
        self.assertRegex(fixed, r"(?m)^\*%util_cvtds\(dm\);$")
        self.assertRegex(fixed, r"(?m)^\*%util_cvtds\(suppdm\);$")
        self.assertRegex(fixed, r"(?m)^%util_cvtds\(ae\);$")

    # Check R-019 replaces the rescreen import.
    def test_r019_replaces_rescreen_import(self):
        source = (
            "* EXAMPLE001-PROT synthetic signal;\n"
            "proc import datafile=\"&rescreen.\"\n"
            "  out=rescr dbms=xlsx replace;\n"
            "  sheet=\"rescreen\";\n"
            "  getnames=yes;\n"
            "run;\n"
        )
        fixed, results = apply(source, "t900sv.sas", ["R-019"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("data rescr;", fixed)
        self.assertIn("rename=(old_subject_id=old_subject_id1)", fixed)
        self.assertEqual(apply(fixed, "t900sv.sas", ["R-019"])[1][0].changes, 0)

    # Check R-020 comments out the ADaM spec block.
    def test_r020_comments_adam_spec_block(self):
        source = (
            "* EXAMPLE001 synthetic signal;\n"
            "%adam_spec(sheet=&tlfkey);\n"
            "%put &attribadsl.;\n"
            "data adlb; run;\n"
        )
        fixed, results = apply(source, "adlb.sas", ["R-020"])
        self.assertEqual(results[0].changes, 1)
        self.assertNotRegex(fixed, r"(?im)^\s*%adam_spec\s*\(")
        self.assertIn("/*%adam_spec(sheet=&tlfkey);*/", fixed)

    # Check R-021 normalizes the data libref casing.
    def test_r021_normalizes_data_libref_case(self):
        source = "* EXAMPLE001-PROT synthetic signal;\n%util_getdata(dm, engine=V9, libref=data);\n"
        fixed, results = apply(source, "t900pr.sas", ["R-021"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("libref=Data", fixed)

    # Confirm a second pass makes no changes on any sample.
    def test_synthetic_samples_are_idempotent(self):
        for path in self.sample_root.rglob("*.sas"):
            source = read_program(path)
            fixed, _ = apply(source, path.name)
            second, repeated = apply(fixed, path.name)
            self.assertEqual(sum(result.changes for result in repeated), 0,
                             str(path.relative_to(ROOT)))
            self.assertEqual(second, fixed, str(path.relative_to(ROOT)))


if __name__ == "__main__":
    unittest.main()
