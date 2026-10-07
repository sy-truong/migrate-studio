"""
Migrate Studio

Copyright (c) 2026 Meta-Xceed, Inc.
SPDX-License-Identifier: Apache-2.0
"""

# Verify Migrate Studio rules against synthetic SAS samples.
import sys
import re
import unittest
import zipfile
from pathlib import Path


# Make the python folder importable.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

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
LEGACY_TLF = '%include "../../../../programs/tlf/20260228_SYNTH/primary/autoexec.sas";'


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


# Check core rule families against the synthetic fixture pack.
class SyntheticFixtureRulesTest(unittest.TestCase):
    sample_root = ROOT / "samples" / "EXAMPLE002_linux_to_windows"

    def test_fixture_pack_exercises_core_rule_families(self):
        # Map sample programs to the rules expected to fire.
        cases = {
            "adam/adae.sas": {"R-014", "R-015"},
            "adam/adlb.sas": {"R-014", "R-015"},
            "tlf/t-ae-overall-saf.sas": {"R-008", "R-009", "R-012"},
            "tlf/checklog.sas": {"R-009"},
        }
        for relative, expected in cases.items():
            path = self.sample_root / relative
            _, results = apply(read_program(path), path.name)
            changed = {result.rule_id for result in results if result.changes}
            self.assertTrue(expected <= changed, relative)

    # Check that TLF startup statements land in the required order.
    def test_tlf_startup_order_for_synthetic_report(self):
        source = read_program(self.sample_root / "tlf" / "t-ae-overall-saf.sas")
        fixed, results = apply(source, "t-ae-overall-saf.sas",
                               ["R-009", "R-008", "R-012"])
        self.assertEqual([r.rule_id for r in results if r.changes],
                         ["R-009", "R-008", "R-012"])
        self.assertNotIn(SDTM_AUTOEXEC, fixed)
        self.assertLess(fixed.index(TLF_AUTOEXEC), fixed.index(MHEADFOOT))
        self.assertIn(SETUPANL, fixed)

    # Check R-013 adds the ADaM libref and is idempotent.
    def test_r013_adds_adam_libref_to_301_macro_call(self):
        source = "* EXAMPLE002-PROT synthetic signal;\n%util_getdata(adsl);\n"
        fixed, results = apply(source, "u900addv.sas", ["R-013"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("%util_getdata(adsl, libref=ADaM)", fixed)
        self.assertEqual(apply(fixed, "u900addv.sas", ["R-013"])[1][0].changes, 0)


# Check R-034 repoints validation libnames and preserves line endings.
class ValidationLibnameRuleTest(unittest.TestCase):
    def test_r034_repoints_validation_libname_preserving_tail_and_crlf(self):
        source = (
            "data _null_;\r\n"
            "libname vadam "
            "\"/placeholder/linux/projects/EXAMPLE002/dev/data/adam/"
            "20260228_SYNTH/validation\";\r\n"
            "run;\r\n"
        )

        fixed, results = apply(source, "adlb.sas", ["R-034"])

        self.assertEqual(results[0].changes, 1)
        self.assertIn(
            "libname vadam "
            "\"&targetStudy./dev/data/adam/20260228_SYNTH/validation\";\r\n",
            fixed,
        )
        self.assertIn("data _null_;\r\n", fixed)
        self.assertIn("run;\r\n", fixed)
        second, second_results = apply(fixed, "adlb.sas", ["R-034"])
        self.assertEqual(second_results[0].changes, 0)
        self.assertEqual(second, fixed)

    def test_r034_skips_commented_validation_libname(self):
        source = (
            "*libname vadam "
            "\"/placeholder/linux/projects/EXAMPLE002/dev/data/adam/"
            "20260228_SYNTH/validation\";\r\n"
        )

        fixed, results = apply(source, "adlb.sas", ["R-034"])

        self.assertEqual(results[0].changes, 0)
        self.assertEqual(fixed, source)

    def test_r034_ignores_other_validation_roots(self):
        source = (
            "libname vadam "
            "\"/placeholder/linux/projects/OTHER_STUDY/dev/data/adam/"
            "20260228_SYNTH/validation\";\r\n"
        )

        fixed, results = apply(source, "adlb.sas", ["R-034"])

        self.assertEqual(results[0].changes, 0)
        self.assertEqual(fixed, source)


# Check context-sensitive rules R-016 through R-037.
class SyntheticContextualRulesTest(unittest.TestCase):
    sample_root = ROOT / "samples" / "EXAMPLE002_linux_to_windows"

    def test_r016_rebuilds_adam_export_and_is_idempotent(self):
        source = (
            "* EXAMPLE002 synthetic signal;\n"
            "%let tlfkey=adae;\n"
            "libname trans xport \"../../../../data/adam/20260228_SYNTH/primary/adae.xpt\";\n"
            "proc copy in=PADAM out=trans;\n"
            "run;\n"
        )
        fixed, results = apply(source, "adae.sas", ["R-016"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("%let tlfkey=adae;", fixed)
        self.assertIn(r'&targetStudy.\Dev\Data\ADAM\&tlfkey..xpt', fixed)
        self.assertEqual(apply(fixed, "adae.sas", ["R-016"])[1][0].changes, 0)

    def test_r035_repoints_sdtm_transport_libname(self):
        source = (
            "%let __SDTMLIB = %STR(../../../../data/sdtm/20260228_SYNTH/primary);\r\n"
            "libname trans xport \"&__SDTMLIB/&data..xpt\";\r\n"
        )
        fixed, results = apply(source, "autoexec.sas", ["R-035"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn(mig.R035_TARGET_TRANS_XPT + "\r\n", fixed)
        self.assertEqual(apply(fixed, "autoexec.sas", ["R-035"])[1][0].changes, 0)

    def test_r035_skips_block_commented_transport_libname(self):
        source = (
            "%let __SDTMLIB = %STR(../../../../data/sdtm/20260228_SYNTH/primary);\r\n"
            "/*\r\n"
            "libname trans xport \"&__SDTMLIB/&data..xpt\";\r\n"
            "*/\r\n"
        )
        fixed, results = apply(source, "autoexec.sas", ["R-035"])
        self.assertEqual(results[0].changes, 0)
        self.assertEqual(fixed, source)

    def test_r017_relocates_workbook_inputs(self):
        source = (
            "* EXAMPLE002 synthetic signal;\n"
            "%let tdpath=%str(\"../../../../programs/sdtm/20260228_SYNTH/documents/EXAMPLE002 SDTM Specs_v1.0.xlsx\");\n"
            "proc import out=spec datafile=\"../../../../programs/sdtm/documents/EXAMPLE002 SDTM Specs_v1.0.xlsx\" dbms=xlsx replace;\n"
        )
        fixed, results = apply(source, "autoexec.sas", ["R-017"])
        self.assertEqual(results[0].changes, 2)
        self.assertEqual(
            fixed.count(r'&targetStudy.\Documents\EXAMPLE002 SDTM Specs_v1.0.xlsx'),
            2,
        )

    def test_r018_disables_only_targeted_xpt_calls(self):
        source = "* EXAMPLE002-PROT synthetic signal;\n%util_cvtds(dm);\n%util_cvtds(suppdm);\n%util_cvtds(ae);\n"
        fixed, results = apply(source, "t900dm.sas", ["R-018"])
        self.assertEqual(results[0].changes, 2)
        self.assertRegex(fixed, r"(?m)^\*%util_cvtds\(dm\);$")
        self.assertRegex(fixed, r"(?m)^\*%util_cvtds\(suppdm\);$")
        self.assertRegex(fixed, r"(?m)^%util_cvtds\(ae\);$")

    def test_r019_replaces_rescreen_import(self):
        source = (
            "* EXAMPLE002-PROT synthetic signal;\n"
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

    def test_r020_comments_adam_spec_block(self):
        source = (
            "* EXAMPLE002 synthetic signal;\n"
            "%adam_spec(sheet=&tlfkey);\n"
            "%put &attribadsl.;\n"
            "data adlb; run;\n"
        )
        fixed, results = apply(source, "adlb.sas", ["R-020"])
        self.assertEqual(results[0].changes, 1)
        self.assertNotRegex(fixed, r"(?im)^\s*%adam_spec\s*\(")
        self.assertIn("/*%adam_spec(sheet=&tlfkey);*/", fixed)

    def test_r021_normalizes_data_libref_case(self):
        source = "* EXAMPLE002-PROT synthetic signal;\n%util_getdata(dm, engine=V9, libref=data);\n"
        fixed, results = apply(source, "t900pr.sas", ["R-021"])
        self.assertEqual(results[0].changes, 1)
        self.assertIn("libref=Data", fixed)

    def test_r037_updates_comments_but_not_strings(self):
        source = 'data _null_;\n  text = "smart “quote” in string";\n/* comment “quote” */\nrun;\n'
        fixed, results = apply(source, "notes.sas", ["R-037"])
        self.assertEqual(results[0].changes, 2)
        self.assertIn('text = "smart “quote” in string";', fixed)
        self.assertIn('/* comment "quote" */', fixed)

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
