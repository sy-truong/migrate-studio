#!/usr/bin/env Rscript
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Migrate Studio (Shiny edition) -- start here. The R twin of
# `python migrate_studio.py`.
#
#   Rscript run_migrate_studio.R
#   Rscript run_migrate_studio.R --port 9100
#   Rscript run_migrate_studio.R --host 0.0.0.0
#   Rscript run_migrate_studio.R --programs /studies/EXAMPLE001 --programs /studies/EXAMPLE002
#   Rscript run_migrate_studio.R --no-open
#   Rscript run_migrate_studio.R --check
#   Rscript run_migrate_studio.R --engine r            # skip Python entirely
#   Rscript run_migrate_studio.R --folder-mode server --server-roots /studies
#   Rscript run_migrate_studio.R --data-dir D:/ms_data # keep data elsewhere
#   Rscript run_migrate_studio.R --import-legacy-history
#
# history.json, current_selections.json and backup_roots.json are kept in a
# per-user folder: %LOCALAPPDATA%\Migrate Studio (Windows),
# ~/Library/Application Support/Migrate Studio (macOS),
# $XDG_DATA_HOME or ~/.local/share/Migrate Studio (Linux).
#
# From an R console: source("run_migrate_studio.R") with the working directory
# set to this folder, or call ms_run(port = 8820).

# Define the port range to scan.
MS_START_PORT <- 8820L    # TLF Studio owns 8770-8819, as in the Python app
MS_END_PORT <- 8869L
# List the files the app needs to start.
MS_REQUIRED <- c("app.R", "R/config.R", "R/api_native.R", "R/py_bridge.R",
                 "R/fs_server.R", "R/api_dispatch.R", "www/index.html",
                 "www/css/migrate-studio.css", "www/css/theme.css",
                 "www/js/mig-excel.js", "www/js/mig-rules.js", "www/js/mig-diff.js",
                 "www/js/migrate-studio.js", "www/js/mig-shiny-bridge.js",
                 "www/js/mig-server-fs.js", "www/js/vendor/fflate.min.js",
                 "python/migrate_studio.py", "rules/Migrate_Studio_Rules.xlsx")

# Locate the folder holding this script, falling back to the working directory.
ms_script_dir <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  file_arg <- sub("^--file=", "", args[grepl("^--file=", args)])
  if (length(file_arg)) return(dirname(normalizePath(file_arg[[1]])))
  ofile <- tryCatch(sys.frames()[[1]]$ofile, error = function(e) NULL)
  if (!is.null(ofile)) return(dirname(normalizePath(ofile)))
  getwd()
}

# Parse command-line flags into a settings list.
ms_parse_args <- function(args) {
  out <- list(port = NULL, host = "127.0.0.1", programs = character(),
              open = TRUE, check = FALSE, engine = NULL, folder_mode = NULL,
              server_roots = character(), data = NULL,
              import_legacy = NULL)
  i <- 1L
  # Read the next argument as a flag's value.
  value <- function() { i <<- i + 1L; if (i > length(args)) stop("missing value for ", args[[i - 1L]]); args[[i]] }
  # Match each flag to its setting.
  while (i <= length(args)) {
    switch(args[[i]],
      "--port"         = out$port <- as.integer(value()),
      "--host"         = out$host <- value(),
      "--programs"     = out$programs <- c(out$programs, value()),
      "--no-open"      = out$open <- FALSE,
      "--check"        = out$check <- TRUE,
      "--engine"       = out$engine <- value(),
      "--folder-mode"  = out$folder_mode <- value(),
      "--server-roots" = out$server_roots <- c(out$server_roots, value()),
      "--data-dir"     = out$data <- value(),
      # Accept an optional legacy history path.
      "--import-legacy-history" = {
        nxt <- if (i < length(args)) args[[i + 1L]] else ""
        if (nzchar(nxt) && !startsWith(nxt, "--")) {
          out$import_legacy <- nxt; i <- i + 1L
        } else {
          out$import_legacy <- ""
        }
      },
      stop("unknown argument: ", args[[i]]))
    i <- i + 1L
  }
  out
}

# Test whether a port can be bound.
ms_port_available <- function(host, port) {
  tryCatch({
    server <- httpuv::startServer(host, port, list(call = function(req) NULL))
    httpuv::stopServer(server)
    TRUE
  }, error = function(e) FALSE)
}

# Use the requested port, or the first free port in the range.
ms_select_port <- function(host, wanted) {
  if (!is.null(wanted)) {
    if (ms_port_available(host, wanted)) return(wanted)
    message("ERROR: port ", wanted, " is already in use.")
    return(NULL)
  }
  for (port in MS_START_PORT:MS_END_PORT) {
    if (ms_port_available(host, port)) return(port)
    message("Port ", port, " is in use. Checking the next available port.")
  }
  message("ERROR: all ports ", MS_START_PORT, "-", MS_END_PORT, " are in use. ",
          "Close another Migrate Studio, or pass --port.")
  NULL
}

# Verify that every required file is present.
ms_check_layout <- function(app_dir) {
  missing <- MS_REQUIRED[!file.exists(file.path(app_dir, MS_REQUIRED))]
  if (!length(missing)) return(TRUE)
  message("Migrate Studio is missing files it needs:\n    ",
          paste(missing, collapse = "\n    "), "\nLooked in: ", app_dir)
  FALSE
}

# Report the rule book's sheet and rule count.
ms_describe_rules <- function(app_dir) {
  rules <- file.path(app_dir, "rules", "Migrate_Studio_Rules.xlsx")
  if (!file.exists(rules)) {
    message("No Migrate_Studio_Rules.xlsx in this folder. Migrate Studio will start ",
            "without a rule book; use Import Rules.")
    return(invisible(FALSE))
  }
  # Count the rows below the header when readxl is available.
  if (requireNamespace("readxl", quietly = TRUE)) {
    sheets <- readxl::excel_sheets(rules)
    sheet <- if ("Rules" %in% sheets) "Rules" else sheets[[1]]
    grid <- readxl::read_excel(rules, sheet = sheet, col_names = FALSE,
                               .name_repair = "minimal")
    filled <- rowSums(!is.na(grid) & trimws(as.matrix(grid)) != "")
    grid <- grid[filled > 0, , drop = FALSE]; filled <- filled[filled > 0]
    header <- which(filled >= 4)[1]; if (is.na(header)) header <- 1L
    count <- nrow(grid) - header
    message("Rule book: ", basename(rules), " - ", sheet, " sheet - ",
            count, " rule", if (count == 1) "" else "s")
  } else {
    message("Rule book: ", basename(rules))
  }
  invisible(TRUE)
}

# Apply options, pick a port and launch the Shiny app.
ms_run <- function(port = NULL, host = "127.0.0.1", programs = character(),
                   open = TRUE, engine = NULL, folder_mode = NULL,
                   server_roots = character(), data = NULL,
                   app_dir = ms_script_dir()) {
  app_dir <- normalizePath(app_dir, winslash = "/")
  if (!ms_check_layout(app_dir)) return(invisible(2L))
  # Pass the settings to the app as R options.
  sep <- .Platform$path.sep
  if (length(programs)) options(migrate_studio.programs = paste(programs, collapse = sep))
  if (length(server_roots)) {
    options(migrate_studio.server_roots = paste(server_roots, collapse = sep))
  }
  if (!is.null(engine)) options(migrate_studio.engine = engine)
  if (!is.null(folder_mode)) options(migrate_studio.folder_mode = folder_mode)
  if (!is.null(data)) options(migrate_studio.data_dir = data)
  options(migrate_studio.app_dir = app_dir)

  # Pick a free port.
  port <- ms_select_port(host, port)
  if (is.null(port)) return(invisible(2L))
  # Same origin as the Python app (http://localhost:<port>), so the browser's
  # remembered folder and local version history carry over.
  url_host <- if (host %in% c("127.0.0.1", "0.0.0.0")) "localhost" else host
  url <- sprintf("http://%s:%d/", url_host, port)

  # Announce the address to the user.
  message("\nMigrate Studio is serving ", app_dir)
  ms_describe_rules(app_dir)
  message("\n    ", url, "\n\nPress Ctrl+C (Esc in RStudio) to stop.\n")

  # Start the server and open the browser when requested.
  shiny::runApp(app_dir, port = port, host = host,
                launch.browser = if (open) function(u) utils::browseURL(url) else FALSE)
  invisible(0L)
}

# Run as a script: parse flags, then import, check or serve.
if (sys.nframe() == 0L || !interactive()) {
  args <- ms_parse_args(commandArgs(trailingOnly = TRUE))
  app_dir <- ms_script_dir()
  # Merge a legacy history file into the data folder and exit.
  if (!is.null(args$import_legacy)) {
    for (f in c("config.R", "api_native.R")) source(file.path(app_dir, "R", f))
    if (!is.null(args$data)) options(migrate_studio.data_dir = args$data)
    cfg <- ms_load_config(app_dir)
    legacy <- if (nzchar(args$import_legacy)) args$import_legacy
              else file.path(app_dir, "data", "history.json")
    res <- tryCatch(ms_import_legacy_history(legacy, cfg$history_file),
                    error = function(e) list(ok = FALSE, error = conditionMessage(e)))
    if (!isTRUE(res$ok)) {
      message("ERROR: ", res$error)
      quit(status = 2L)
    }
    message("Imported ", res$imported, " run(s), skipped ", res$skipped,
            " already present, into ", res$target)
    quit(status = 0L)
  }
  # Check for the rule book and exit.
  if (isTRUE(args$check)) {
    ok <- file.exists(file.path(app_dir, "rules", "Migrate_Studio_Rules.xlsx"))
    if (ok) ms_describe_rules(app_dir) else message("No rule book in ", app_dir)
    quit(status = if (ok) 0L else 1L)
  }
  # Start the app and exit with its status.
  status <- ms_run(port = args$port, host = args$host, programs = args$programs,
                   open = args$open, engine = args$engine,
                   folder_mode = args$folder_mode, server_roots = args$server_roots,
                   data = args$data, app_dir = app_dir)
  quit(status = status)
}
