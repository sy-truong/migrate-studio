# Migrate Studio (Shiny) -- configuration.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Every setting can come from an R option (set in run_migrate_studio.R or
# .Rprofile) or an environment variable (handy on Posit Connect / Shiny Server).
# Options win over environment variables.

# Read a setting from an R option, then an environment variable, then the default.
ms_opt <- function(option, env, default) {
  value <- getOption(option, NULL)
  if (!is.null(value)) return(value)
  value <- Sys.getenv(env, "")
  if (nzchar(value)) return(value)
  default
}

# Split a path list on the platform separator, dropping blanks.
ms_split_paths <- function(value) {
  if (is.null(value) || !length(value)) return(character())
  value <- unlist(strsplit(as.character(value), .Platform$path.sep, fixed = TRUE))
  value <- trimws(value)
  value[nzchar(value)]
}

# Interpret a value as a boolean flag.
ms_flag <- function(value) {
  isTRUE(value) || tolower(as.character(value)) %in% c("1", "true", "yes", "y")
}

# Return the first element as text, or an empty string.
ms_scalar_text <- function(value) {
  if (is.null(value) || !length(value)) return("")
  as.character(value[[1]])
}

# Name the per-user data folder.
MS_APP_NAME <- "Migrate Studio"

# Return the OS-specific default folder for history and settings.
ms_default_data_dir <- function(sysname = Sys.info()[["sysname"]],
                                getenv = function(name) Sys.getenv(name, ""),
                                home = path.expand("~")) {
  if (identical(sysname, "Windows")) {
    # Use the local application-data folder on Windows.
    base <- getenv("LOCALAPPDATA")
    if (!nzchar(base)) {
      profile <- getenv("USERPROFILE")
      base <- file.path(if (nzchar(profile)) profile else home, "AppData", "Local")
    }
  } else if (identical(sysname, "Darwin")) {
    # Use Application Support on macOS.
    base <- file.path(home, "Library", "Application Support")
  } else {
    # Use XDG_DATA_HOME or ~/.local/share on Linux.
    xdg <- getenv("XDG_DATA_HOME")
    base <- if (nzchar(xdg) && startsWith(xdg, "/")) xdg
            else file.path(home, ".local", "share")
  }
  file.path(base, MS_APP_NAME)
}

# Resolve the data folder: option, environment variable, then OS default.
ms_resolve_data_dir <- function() {
  value <- ms_scalar_text(getOption("migrate_studio.data_dir", ""))
  if (is.null(value) || !nzchar(value)) value <- Sys.getenv("MIGRATE_STUDIO_DATA_DIR", "")
  if (!nzchar(value)) value <- ms_default_data_dir()
  path.expand(value)
}

# Report which setting supplied the data folder.
ms_data_dir_source <- function() {
  opt <- ms_scalar_text(getOption("migrate_studio.data_dir", ""))
  if (!is.null(opt) && nzchar(opt)) return("option")
  if (nzchar(Sys.getenv("MIGRATE_STUDIO_DATA_DIR", ""))) return("environment")
  "os-default"
}

# Build the configuration list used by the whole app.
ms_load_config <- function(app_dir = getwd()) {
  app_dir <- normalizePath(app_dir, winslash = "/", mustWork = TRUE)
  data_source <- ms_data_dir_source()
  data_dir <- ms_resolve_data_dir()
  # Create the data folder, failing with guidance when it is unwritable.
  dir.create(data_dir, recursive = TRUE, showWarnings = FALSE)
  if (!dir.exists(data_dir)) {
    stop("cannot create the data folder ", data_dir, ". Pass --data-dir, or set ",
         "MIGRATE_STUDIO_DATA_DIR or options(migrate_studio.data_dir = ...) ",
         "to a folder you can write.", call. = FALSE)
  }
  data_dir <- normalizePath(data_dir, winslash = "/", mustWork = TRUE)

  # Collect the program roots that exist.
  roots <- ms_split_paths(ms_opt("migrate_studio.programs",
                                 "MIGRATE_STUDIO_PROGRAMS", character()))
  roots <- normalizePath(path.expand(roots), winslash = "/", mustWork = FALSE)
  roots <- roots[dir.exists(roots)]

  # Collect the server roots that exist.
  server_roots <- ms_split_paths(ms_opt("migrate_studio.server_roots",
                                        "MIGRATE_STUDIO_SERVER_ROOTS", character()))
  server_roots <- normalizePath(path.expand(server_roots), winslash = "/",
                                mustWork = FALSE)
  server_roots <- server_roots[dir.exists(server_roots)]

  # Default to browser folder mode unless server mode is requested.
  folder_mode <- tolower(ms_opt("migrate_studio.folder_mode",
                                "MIGRATE_STUDIO_FOLDER_MODE", "browser"))
  if (!folder_mode %in% c("browser", "server")) folder_mode <- "browser"

  # Assemble the paths, engine choice and feature flags.
  list(
    app_dir       = app_dir,
    www_dir       = file.path(app_dir, "www"),
    python_dir    = file.path(app_dir, "python"),
    data_dir      = data_dir,
    data_dir_source = data_source,
    history_file  = file.path(data_dir, "history.json"),
    selection_file = file.path(data_dir, "current_selections.json"),
    backup_cache  = file.path(data_dir, "backup_roots.json"),
    rules_file    = file.path(app_dir, "rules", "Migrate_Studio_Rules.xlsx"),
    # "python" = reuse migrate_studio.py through reticulate,
    # "r"      = the R port in R/api_native.R,
    # "auto"   = python when a usable Python 3.9+ is found, otherwise r.
    engine        = tolower(ms_opt("migrate_studio.engine",
                                   "MIGRATE_STUDIO_ENGINE", "auto")),
    python        = ms_opt("migrate_studio.python", "MIGRATE_STUDIO_PYTHON", ""),
    program_roots = roots,
    # "browser" = the File System Access API picks folders on the user's PC
    #             (same as the Python app).
    # "server"  = folders live on the machine running R (Posit Workbench,
    #             Connect, Shiny Server); see R/fs_server.R.
    folder_mode   = folder_mode,
    server_roots  = server_roots,
    # Keep the pre-fix modified date on programs rewritten in server mode.
    # Off by default: a migrated program normally *should* show a new date.
    keep_live_mtime = ms_flag(ms_opt("migrate_studio.keep_live_mtime",
                                     "MIGRATE_STUDIO_KEEP_LIVE_MTIME", FALSE)),
    # Stop the R process on File > Log out (desktop use). Leave FALSE on a
    # shared server so one user cannot stop everybody's session.
    stop_on_logout = ms_flag(ms_opt("migrate_studio.stop_on_logout",
                                    "MIGRATE_STUDIO_STOP_ON_LOGOUT", FALSE)),
    # Files the page may fetch from the app folder (not from www/).
    published_files = c("rules/Migrate_Studio_Rules.xlsx",
                        "rules/PortFix_Rules.xlsx",
                        "CHANGELOG.md"),
    session_id    = substr(gsub("-", "", ms_uuid()), 1, 12),
    started_at    = ms_utc_now()
  )
}

# Generate a random 32-character hex id.
ms_uuid <- function() {
  hex <- c(0:9, letters[1:6])
  paste(sample(hex, 32, replace = TRUE), collapse = "")
}

# Return the current UTC time as an ISO-8601 string.
ms_utc_now <- function() {
  # Same shape as Python's isoformat().replace("+00:00", "Z").
  format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%OS6Z", tz = "UTC")
}
