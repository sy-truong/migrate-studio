# Migrate Studio R Shiny

Version 0.3 Beta. Review and migrate SAS source from Linux to Windows using
example rules. Supports Windows, macOS and Linux with R 4.2.3+ and Shiny 1.12.1+.
Use Chrome or Edge for browser folder access. SAS is not executed by the app.

## Install and start

From this directory, install the dependencies declared with minimum versions in
`DESCRIPTION`, then start with the native R backend:

```sh
Rscript tools/install_dependencies.R
Rscript tools/check_env.R
Rscript run_migrate_studio.R --engine r --data-dir ./local-data
```

The native backend needs no Python. `--engine python` uses reticulate to call the
Python module in process; install reticulate and the optional bridge dependencies:

```sh
Rscript -e 'install.packages("reticulate", repos="https://cloud.r-project.org")'
python -m venv .venv
# Activate as in the Python edition's README, then:
python -m pip install -r requirements.txt
```

Set `MIGRATE_STUDIO_PYTHON` to that environment's Python executable and use
`--engine python`. `--engine auto` chooses Python if available, otherwise R.
Use `--engine r` for predictable operation without interpreter discovery.

## Configuration and example

`--folder-mode browser` (default) selects folders on your computer.
`--folder-mode server --server-roots PATH` allows access only under the specified
server roots; `--server-roots` and `--programs` are repeatable. `--data-dir PATH`
or `MIGRATE_STUDIO_DATA_DIR` controls history and caches. `--no-open`, `--port`,
`--host`, `--check`, and `--import-legacy-history PATH` are also available.

Copy `samples/EXAMPLE002_linux_to_windows` to a disposable folder. Select it with
**Folder**, review **Rules**, run **Apply Fix**, and review **Fixed SAS** and
**Fix Compare**. Recover originals from `_migrate_original/` or revert controls.
Macros and paths in the samples are invented examples; no SAS macro library or
patient data is included. See the [user manual](docs/user_manual.html),
[rule book](docs/rule-book.md) and [deployment guide](docs/deployment.md).

## Tests and dependencies

```sh
Rscript tools/install_dependencies.R --dev
Rscript tools/run_r_tests.R
Rscript tools/run_js_tests.R
python -m pip install -r requirements-dev.txt
python -m pytest -q python
```

Node.js 22+ is needed for JavaScript tests. `DESCRIPTION` documents minimum R
package versions; it is not a frozen dependency lock. The publication review
records the exact versions tested. Create a reviewed renv lock for deployments
that require identical package resolution.

## Limitations and troubleshooting

Hosted Shiny requires authentication configured by the hosting service. All users
in one process share its data directory and allowlisted roots. Use separate
processes/accounts for isolated workspaces; limit a shared deployment to one
process because history has no inter-process lock. Log out closes the session by
default; `MIGRATE_STUDIO_STOP_ON_LOGOUT=true` may stop a desktop process.

For folder-picker issues, use Chrome/Edge over localhost or server folder mode.
For missing packages, rerun the installer in the same R environment. For Python
bridge issues, select `--engine r` or point `MIGRATE_STUDIO_PYTHON` at the intended
interpreter. Choose writable data and program folders for permission errors.
Workbook limits are 16 MiB compressed, 16 MiB per entry and 64 MiB expanded; API
JSON is limited to 8 MiB. Fonts fall back to system fonts when offline.

Rules are examples, not validated clinical transformations. Review changes and
execute appropriate SAS checks before using migrated programs.

Licensed under Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

Bundled rules are examples. Configure your own reviewed rule book for real projects.
