#!/usr/bin/env Rscript
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Run the unchanged Node tests from tests/js against the Shiny layout.
#
# The tests expect the Python app's layout (index.html, js/, css/ and
# migrate_studio.py side by side), so this copies the pieces into a temporary
# folder in that shape and runs each test with Node. Needs `node` on PATH.
#
#   Rscript tools/run_js_tests.R

# Locate this script and the app folder.
args <- commandArgs(FALSE)
script_arg <- sub("^--file=", "", grep("^--file=", args, value = TRUE)[1])
script_candidates <- c(
  script_arg,
  file.path(getwd(), script_arg),
  file.path(getwd(), "migrate-studio-r-shiny", "tools", basename(script_arg))
)
script_path <- script_candidates[file.exists(script_candidates)][1]
if (is.na(script_path)) stop("Could not locate run_js_tests.R")
app <- normalizePath(file.path(dirname(script_path), ".."), winslash = "/")
# Require Node on the PATH.
node <- Sys.which("node")
if (!nzchar(node)) stop("node is not on PATH")

# Build a temporary tree in the layout the JavaScript tests expect.
tree <- file.path(tempdir(), "migrate-studio-js-tests")
unlink(tree, recursive = TRUE)
dir.create(file.path(tree, "tests"), recursive = TRUE)
dir.create(file.path(tree, "rules"), recursive = TRUE)
file.copy(file.path(app, "www", c("js", "css")), tree, recursive = TRUE)
file.copy(file.path(app, "www", "index.html"), tree)
file.copy(file.path(app, "samples"), tree, recursive = TRUE)
file.copy(file.path(app, "rules", "Migrate_Studio_Rules.xlsx"),
          file.path(tree, "rules"))
file.copy(file.path(app, "CHANGELOG.md"), tree)
file.copy(file.path(app, "python", "migrate_studio.py"), tree)
tests <- list.files(file.path(app, "tests", "js"), pattern = "\\.js$", full.names = TRUE)
file.copy(tests, file.path(tree, "tests"))

# Run each test with Node and report failures.
failed <- character()
for (test in basename(tests)) {
  out <- suppressWarnings(system2(node, file.path(tree, "tests", test),
                                  stdout = TRUE, stderr = TRUE))
  status <- attr(out, "status")
  ok <- is.null(status) || identical(status, 0L)
  cat(if (ok) "ok  " else "FAIL", test, "\n")
  if (!ok) { failed <- c(failed, test); cat(utils::tail(out, 5), sep = "\n") }
}
if (length(failed)) quit(status = 1L)
