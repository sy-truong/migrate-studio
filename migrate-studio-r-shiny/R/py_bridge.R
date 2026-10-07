# Migrate Studio (Shiny) -- reuse python/migrate_studio.py through reticulate.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# The module is imported unchanged. Its path globals (ROOT, HISTORY, ...) are
# repointed at the Shiny app's data/ folder, which is exactly what
# python/test_history_api.py already does, and every call crosses the
# language boundary as JSON text so dict/list shapes survive untouched.

# Load migrate_studio.py through reticulate, or return NULL to use the R engine.
ms_py_load <- function(cfg) {
  if (identical(cfg$engine, "r")) return(NULL)
  # Report a problem and fall back to the R engine unless Python is required.
  fail <- function(msg) {
    if (identical(cfg$engine, "python")) stop(msg, call. = FALSE)
    message("Migrate Studio: ", msg, " -- using the R engine.")
    NULL
  }
  # Check that reticulate, Python, and a supported version are available.
  if (!requireNamespace("reticulate", quietly = TRUE)) {
    return(fail("package 'reticulate' is not installed"))
  }
  if (nzchar(cfg$python)) {
    ok <- tryCatch({ reticulate::use_python(cfg$python, required = TRUE); TRUE },
                   error = function(e) FALSE)
    if (!ok) return(fail(paste("cannot use Python at", cfg$python)))
  }
  if (!reticulate::py_available(initialize = TRUE)) {
    return(fail("no Python interpreter found"))
  }
  version <- as.character(reticulate::py_config()$version)
  if (utils::compareVersion(version, "3.9") < 0) {
    return(fail(paste0("Python ", version, " found; 3.9 or newer is required")))
  }

  # Import the module without converting its results.
  ms <- tryCatch(reticulate::import_from_path("migrate_studio",
                                              path = cfg$python_dir,
                                              convert = FALSE),
                 error = function(e) e)
  if (inherits(ms, "error")) {
    return(fail(paste("could not import migrate_studio.py:", conditionMessage(ms))))
  }
  # Import the helper modules used to build Python values.
  pathlib <- reticulate::import("pathlib", convert = FALSE)
  json <- reticulate::import("json", convert = FALSE)
  builtins <- reticulate::import_builtins(convert = FALSE)

  # Repoint the module's path globals at the Shiny data folder.
  set <- function(name, value) reticulate::py_set_attr(ms, name, value)
  set("ROOT", pathlib$Path(cfg$app_dir))
  set("RULES", pathlib$Path(cfg$rules_file))
  set("HISTORY", pathlib$Path(cfg$history_file))
  set("SELECTIONS", pathlib$Path(cfg$selection_file))
  set("BACKUP_ROOT_CACHE", pathlib$Path(cfg$backup_cache))
  ms$set_program_roots(reticulate::r_to_py(as.list(cfg$program_roots)))

  # Announce the Python engine and its interpreter.
  message("Migrate Studio: Python engine ", version, " (",
          reticulate::py_config()$python, ")")
  list(ms = ms, json = json, builtins = builtins, pathlib = pathlib)
}

# Call a module function with a JSON body; return list(status, json_text).
ms_py_call <- function(py, fn, body_json = NULL) {
  f <- py$ms[[fn]]            # `[[` returns a callable wrapper, like `$`
  result <- if (is.null(body_json)) f() else f(py$json$loads(body_json))
  # Unpack a (status, payload) tuple, or treat a bare result as status 200.
  is_tuple <- reticulate::py_to_r(py$builtins$isinstance(result, py$builtins$tuple))
  if (is_tuple) {
    status <- as.integer(reticulate::py_to_r(reticulate::py_get_item(result, 0L)))
    payload <- reticulate::py_get_item(result, 1L)
  } else {
    status <- 200L
    payload <- result
  }
  # Return the status and the payload as JSON text.
  list(status = status, json = reticulate::py_to_r(py$json$dumps(payload)))
}

# Hand a server-chosen folder to the Python token table (server folder mode).
ms_py_register_root <- function(py, path, resolution) {
  reticulate::py_to_r(py$ms$root_token_for(py$pathlib$Path(path), resolution))
}
