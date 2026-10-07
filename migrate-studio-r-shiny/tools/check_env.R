#!/usr/bin/env Rscript
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Rscript tools/check_env.R -- report whether this machine matches the target
# (R 4.2.3, shiny 1.12.1) and which optional pieces are available.
# Define the reference R and shiny versions.
target <- list(R = "4.2.3", shiny = "1.12.1")
# Print one aligned report row.
row <- function(item, have, want = "", note = "") {
  cat(sprintf("%-12s %-12s %-10s %s\n", item, have, want, note))
}
# Return a package's installed version, or missing.
ver <- function(pkg) if (requireNamespace(pkg, quietly = TRUE))
  as.character(utils::packageVersion(pkg)) else "missing"
# Print the report header and the core version rows.
cat(sprintf("%-12s %-12s %-10s %s\n", "component", "installed", "target", "note"))
row("R", as.character(getRversion()), target$R,
    if (getRversion() == target$R) "ok" else "differs from the reference version")
row("shiny", ver("shiny"), target$shiny,
    if (ver("shiny") == target$shiny) "ok" else "differs from the reference version")
# Report required and optional packages.
for (pkg in c("jsonlite", "digest", "httpuv", "htmltools")) row(pkg, ver(pkg), "", "required")
for (pkg in c("reticulate", "readxl", "testthat")) row(pkg, ver(pkg), "", "optional")
# Report Python and openpyxl when the Python engine is selected.
if (identical(Sys.getenv("MIGRATE_STUDIO_ENGINE"), "python") &&
    requireNamespace("reticulate", quietly = TRUE)) {
  py <- Sys.getenv("MIGRATE_STUDIO_PYTHON", "")
  if (nzchar(py)) try(reticulate::use_python(py, required = TRUE), silent = TRUE)
  if (reticulate::py_available(initialize = TRUE)) {
    cfg <- reticulate::py_config()
    row("python", as.character(cfg$version), "3.9+", cfg$python)
    row("openpyxl", if (reticulate::py_module_available("openpyxl")) "found" else "missing",
        "", "needed only by mig_apply.py / --check")
  } else row("python", "none", "3.9+", "R engine will be used")
}
# Report whether Node is available for the JavaScript tests.
row("node", if (nzchar(Sys.which("node"))) "found" else "missing", "", "only for tools/run_js_tests.R")

# Exit with an error when a required package is missing.
required <- c("shiny", "jsonlite", "digest", "httpuv", "htmltools")
if (any(!vapply(required, requireNamespace, logical(1), quietly = TRUE))) quit(status = 1L)

# Check installed package versions against the minimums in DESCRIPTION.
description <- read.dcf("DESCRIPTION")
constraints <- strsplit(description[1, "Imports"], ",")[[1]]
for (constraint in constraints) {
  pkg <- trimws(sub("\\s*\\(.*", "", constraint))
  minimum <- sub(".*>=\\s*([^)]*)\\).*", "\\1", constraint)
  if (ver(pkg) != "missing" && utils::compareVersion(ver(pkg), minimum) < 0) {
    stop(pkg, " must be at least ", minimum)
  }
}
