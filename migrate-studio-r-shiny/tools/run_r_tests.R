#!/usr/bin/env Rscript
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Rscript tools/run_r_tests.R   (needs testthat; reticulate optional)
# Locate this script from the likely paths.
args <- commandArgs(FALSE)
script_arg <- sub("^--file=", "", grep("^--file=", args, value = TRUE)[1])
script_candidates <- c(
  script_arg,
  file.path(getwd(), script_arg),
  file.path(getwd(), "migrate-studio-r-shiny", "tools", basename(script_arg))
)
script_path <- script_candidates[file.exists(script_candidates)][1]
if (is.na(script_path)) stop("Could not locate run_r_tests.R")
# Run the testthat suite and stop on failure.
app <- normalizePath(file.path(dirname(script_path), ".."))
testthat::test_dir(file.path(app, "tests", "testthat"), stop_on_failure = TRUE)
