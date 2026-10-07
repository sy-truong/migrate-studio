# Migrate Studio (Shiny edition) -- the command-line batch fixer from R.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# python/mig_apply.py is unchanged. It writes fixed copies into a
# Migrate_Studio/ subfolder and never touches the originals.
#
#   source("R/batch.R")
#   ms_batch_fix("samples/STUDY_SRC_ADAM", dry_run = TRUE)
#   ms_batch_fix("samples/STUDY_SRC_SDTM/dm.sas", rules = c("R-003", "R-005"))
#   ms_batch_fix("samples/STUDY_SRC_ADAM", params = c(ADAM_LIBREF = "adam"), diff = TRUE)

# Build the mig_apply.py arguments and run it through reticulate or system2.
ms_batch_fix <- function(target = NULL, rules = NULL, rules_file = NULL,
                         out = NULL, params = NULL, dry_run = FALSE,
                         diff = FALSE, list_rules = FALSE,
                         app_dir = getOption("migrate_studio.app_dir", getwd()),
                         python = Sys.getenv("MIGRATE_STUDIO_PYTHON", "")) {
  # Translate the R arguments into command-line options.
  argv <- character()
  if (!is.null(target)) argv <- c(argv, normalizePath(target, mustWork = TRUE))
  if (length(rules)) argv <- c(argv, "--rules", paste(rules, collapse = ","))
  if (!is.null(rules_file)) argv <- c(argv, "--rules-file", normalizePath(rules_file))
  if (!is.null(out)) argv <- c(argv, "--out", out)
  for (name in names(params)) argv <- c(argv, "--param", paste0(name, "=", params[[name]]))
  if (dry_run) argv <- c(argv, "--dry-run")
  if (diff) argv <- c(argv, "--diff")
  if (list_rules) argv <- c(argv, "--list")

  # Prefer reticulate when it is installed and a Python is found.
  script <- file.path(app_dir, "python", "mig_apply.py")
  if (requireNamespace("reticulate", quietly = TRUE) &&
      (nzchar(python) || reticulate::py_available(initialize = TRUE))) {
    if (nzchar(python)) reticulate::use_python(python, required = TRUE)
    mig <- reticulate::import_from_path("mig_apply", dirname(script))
    status <- NULL
    output <- reticulate::py_capture_output(status <- mig$main(as.list(argv)))
    cat(output)
    return(invisible(as.integer(status)))
  }
  # Fall back to running the script with a Python executable.
  exe <- if (nzchar(python)) python else Sys.which(c("python3", "python"))[[1]]
  if (!nzchar(exe)) stop("mig_apply.py needs Python 3.9+ with openpyxl")
  invisible(system2(exe, c(shQuote(script), shQuote(argv))))
}
