# Migrate Studio Python

Version 0.3 Beta. Review and migrate SAS source from Windows to Linux using
configurable example rules. Supports Windows, macOS and Linux with Python 3.9+.
Use Chrome or Edge on localhost for direct folder writes. SAS is not needed to
run the app; it is needed to validate migrated programs.

## Install and start

From this directory:

```sh
python -m venv .venv
# macOS/Linux:
. .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python migrate_studio.py --check --data-dir ./local-data
python migrate_studio.py --data-dir ./local-data
```

The app opens in your browser. `--no-open` suppresses browser launch. `--port 8820`
selects a port. Keep `--host` at its default, `127.0.0.1`: APIs accept only local
requests with a loopback Host header. `--programs PATH` is repeatable and scopes
backup folder discovery. `--data-dir PATH` or `MIGRATE_STUDIO_DATA_DIR` sets the
writable history/cache directory. Without it, data goes into the operating
system's per-user application data directory, outside the source tree.
`--import-legacy-history PATH` imports an existing history and exits.

## Example

Copy `samples/EXAMPLE001_windows_to_linux` into a disposable directory. Select
it with **Folder**, load or review the bundled rule book in **Rules**, choose
programs, and use **Apply Fix**. Review **Fixed SAS**, **Fix Compare** and history.
Recover originals from `_migrate_original/` or the revert controls. Example paths
and macro names are placeholders, not an executable SAS macro library.

`rules/` contains the example workbook and MC rule pack; `python/` contains the
batch engines; `www/` contains the browser client. See the
[user manual](docs/user_manual.html) and [rule book](docs/rule-book.md).

## Tests

Install development dependencies and Node.js 22+:

```sh
python -m pip install -r requirements-dev.txt
python tools/check_env.py
python -m pytest -q tests/python python/test_mig_apply.py
```

Run every `tests/js/*.js` file with Node.js, or use the repository's
`python tools/check_release.py --tests` command from the repository root.

## Limitations and troubleshooting

Rules are examples and can change program meaning. Review diffs and validate
results in SAS before use. Workbook uploads are limited to 16 MiB compressed,
16 MiB per XML entry, and 64 MiB expanded; API JSON is limited to 8 MiB.
If a folder picker is unavailable, use Chrome/Edge over localhost. If the port
is busy, choose another with `--port`. For permission errors, choose a writable
`--data-dir` and program folder. A missing workbook dependency is fixed by
installing `requirements.txt` in the same interpreter used to start the app.
The UI uses optional Google Fonts with system-font fallbacks when offline.

Licensed under Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

Bundled rules are examples. Configure your own reviewed rule book for real projects.
