# Contributing

Rule contributions go to one edition only and are never mirrored automatically.
Windows to Linux rules belong in `migrate-studio-python/`; Linux to Windows
rules belong in `migrate-studio-r-shiny/`.

Every rule must be safe to run twice and must never fire inside a SAS comment.
`%init;` becoming `/*%init;*/` must not become `/*/*%init;*/*/`.

For workbook-only rules, add or update a row in that edition's
`rules/Migrate_Studio_Rules.xlsx`. For contextual rules, add the workbook row
and the matching implementation in that edition's `mig_apply.py` and
`mig-rules.js`.

Every new rule ships with a paired synthetic fixture in that edition's
`samples/` folder and focused tests for the behavior. Do not add real study
programs, logs, histories, screenshots, or internal paths.

Sample IDs must use the `EXAMPLE###` convention (for example `EXAMPLE003`) and
must not contain real sponsor, vendor, or study identifiers.

Test placement is edition-local. Browser tests live under `tests/js/`; general
server/API tests live under `tests/python/`; engine parity tests may stay next
to the engine source in `python/` when they import private helpers directly.

New source files should include the project SPDX header. When modifying a file
for redistribution, keep a clear notice of the change as required by Apache-2.0
section 4(b); a focused changelog entry, commit message, or file-local note is
acceptable when it names the changed file and purpose.

## Running tests

Run `python tools/check_release.py --tests` from the repository root, or follow
the Tests section of each edition's README. Run `python tools/check_release.py`
before opening a pull request to scan for credentials and non-source files.

## Pull requests

Open pull requests against `main`. Keep each pull request focused on one edition
unless the change is genuinely shared, describe the rule or behavior change, and
confirm that tests pass. By contributing, you agree your contribution is licensed
under Apache-2.0.
