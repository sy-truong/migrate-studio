# Third-Party Notices

This file records every non-standard-library dependency declared by the Python
edition (test tools are in requirements-dev.txt), every CRAN package used by the R Shiny edition, and every third-party
asset loaded or bundled by the `www/` clients. Python version ranges are taken
from `migrate-studio-python/requirements.txt` and `requirements-dev.txt`; R package versions and roles are declared in
`migrate-studio-r-shiny/DESCRIPTION`. No third-party Python or R packages
are vendored in this repository; they are installed separately by the user.

| Component | Version | Use and location | License / attribution |
|---|---:|---|---|
| openpyxl | `>=3.1,<4` | Python workbook import and rule-book processing (`migrate-studio-python/migrate_studio.py`, `migrate-studio-python/python/mc_rules.py`, and `migrate-studio-python/python/mig_apply.py`) | MIT License; see the [openpyxl project](https://openpyxl.readthedocs.io/) for its copyright notice. |
| pytest | `>=8,<10` | Python test runner (`migrate-studio-python/tests/` and `migrate-studio-python/python/test_mig_apply.py`) | MIT License; see the [pytest project](https://pytest.org/) for its copyright notice. |
| fflate | 0.8.2 | Bundled ZIP/XLSX support in `migrate-studio-python/www/js/vendor/fflate.min.js` and `migrate-studio-r-shiny/www/js/vendor/fflate.min.js` | MIT License, Copyright (c) 2023 Arjun Barrett. Full license text is included beside each bundled file as `fflate.LICENSE`. |
| IBM Plex Sans and IBM Plex Mono | Google Fonts delivery; versions selected by the service | Remote font stylesheets loaded by `migrate-studio-python/www/index.html` and `migrate-studio-r-shiny/www/index.html`; the font files are not bundled in this repository. | SIL Open Font License 1.1; copyright and full license are provided by the font distribution. |
| shiny | >=1.12.1 (minimum) | R Shiny web application server (`migrate-studio-r-shiny/app.R`, `migrate-studio-r-shiny/R/`) | GPL-3; see the [shiny package](https://cran.r-project.org/package=shiny) for its copyright notice. Not bundled. |
| htmltools | >=0.5.8.1 | HTML generation for the Shiny edition (required) | GPL (>= 2); see the [htmltools package](https://cran.r-project.org/package=htmltools). Not bundled. |
| httpuv | >=1.6.15 | Web server underneath shiny; also used for free-port probing in `migrate-studio-r-shiny/run_migrate_studio.R` (required) | GPL (>= 2); see the [httpuv package](https://cran.r-project.org/package=httpuv). Not bundled. |
| jsonlite | >=1.8.9 | JSON handling in `migrate-studio-r-shiny/R/` (required) | MIT License; see the [jsonlite package](https://cran.r-project.org/package=jsonlite). Not bundled. |
| digest | >=0.6.37 | Hashing in `migrate-studio-r-shiny/R/api_native.R` (required) | GPL (>= 2); see the [digest package](https://cran.r-project.org/package=digest). Not bundled. |
| reticulate | >=1.40.0 | Optional bridge to the Python engine (`migrate-studio-r-shiny/R/py_bridge.R`) | Apache License 2.0; see the [reticulate package](https://cran.r-project.org/package=reticulate). Not bundled. |
| readxl | >=1.4.3 | Optional native workbook reading in `migrate-studio-r-shiny/R/batch.R` | MIT License; see the [readxl package](https://cran.r-project.org/package=readxl). Not bundled. |
| testthat | >=3.2.3 | Optional R test runner (`migrate-studio-r-shiny/tests/testthat/`) | MIT License; see the [testthat package](https://cran.r-project.org/package=testthat). Not bundled. |

The remainder of the Python runtime uses only the Python standard library. The R Shiny edition also uses base R packages (`utils`, `tools`, `stats`). Dependencies bring their own transitive packages and notices.

## Bundled source and assets

The fflate upstream license is [MIT](https://github.com/101arrowz/fflate/blob/v0.8.2/LICENSE).
The upstream IBM Plex project distributes its fonts under the
[Open Font License](https://github.com/IBM/plex); these fonts are fetched remotely
and have local system-font fallbacks. No font binaries are bundled.

The arrow logo is defined by the local `www/favicon.svg` and matching inline SVG.
PNG/ICO variants, CSS, UI templates, rule examples and synthetic SAS fixtures
are supplied under the repository's existing Apache-2.0 notices. Screenshots
and historical internal design documents have been removed. No patient datasets
or executable vendor macro libraries are bundled. Example macro names describe
text patterns only.

Existing source declarations establish the intended license, but this review
cannot independently establish authorship or contractual rights. The copyright
owner must confirm permission to publish the first-party code, rule examples,
macro source and image assets. Install R/Python dependencies from their original
distributions; their licenses and transitive notices remain applicable. This
source review does not approve a bundled binary distribution of those packages.
