# Migrate Studio

Migrate Studio scans SAS source programs, applies configurable example migration
rules, and lets you review changes and recover originals. It does not execute SAS
or establish that the resulting programs are clinically or statistically correct.

| Edition | Direction | Runtime | Setup |
|---|---|---|---|
| Python | Windows to Linux | Python 3.9+ | [Python instructions](migrate-studio-python/README.md) |
| R Shiny | Linux to Windows | R 4.2.3+ | [R instructions](migrate-studio-r-shiny/README.md) |

Both editions run on Windows, macOS and Linux. Chrome or Edge on localhost is
required for folder access and in-place editing. Other browsers have limited
file selection and download support. Node.js 22+ is used only for browser tests.

## Quick start (Python)

Download the source repository and open a terminal in its root:

```sh
cd migrate-studio-python
python -m venv .venv
# macOS/Linux:
. .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python migrate_studio.py --data-dir ./local-data
```

Copy `samples/EXAMPLE001_windows_to_linux` to a temporary working folder. Select
that copy with **Folder**, inspect the example rules, apply a fix, then review
**Fixed SAS** and **Fix Compare**. Originals are saved in `_migrate_original/`
beside the programs. Rule examples reference invented macros and paths; supply
your own reviewed rule book for real projects. Sample programs contain no patient
records and do not include an executable macro library.

## Release and security status

Version 0.3 Beta. See [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and
[validation limitations](docs/VALIDATION.md).

Keep the Python server on localhost. Shiny hosting requires authentication and
restricted filesystem permissions. History records contain user identities and
file paths; keep them private. Neither edition provides an immutable audit trail.

## License

Apache-2.0; see [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Existing ownership and required
third-party attribution notices are retained. Dependencies are installed separately.
