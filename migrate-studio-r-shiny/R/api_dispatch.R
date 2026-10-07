# Migrate Studio (Shiny) -- one entry point for every request the page used to
# send to migrate_studio.py over HTTP. www/js/mig-shiny-bridge.js turns those
# fetch() calls into Shiny messages; this file answers them.
#
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Every handler returns list(status = <int>, json = <text>) or, for files,
# list(status, base64, contentType).

# Wrap a status code and body as a JSON reply.
ms_reply_json <- function(status, body) {
  list(status = as.integer(status), json = ms_to_json(body))
}

# Reply with a file's bytes base64-encoded, or 404 when it is missing.
ms_reply_file <- function(path, content_type) {
  if (!file.exists(path)) {
    return(ms_reply_json(404L, list(ok = FALSE, error = "Not found")))
  }
  # Read the file as raw bytes for transport.
  bytes <- readBin(path, "raw", n = file.info(path)$size)
  list(status = 200L, base64 = gsub("\\s", "", jsonlite::base64_enc(bytes)),
       contentType = content_type)
}

# Map a file extension to its HTTP content type.
ms_content_type <- function(name) {
  ext <- tolower(tools::file_ext(name))
  switch(ext,
         json = "application/json",
         md   = "text/markdown; charset=utf-8",
         xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         sas  = "text/plain",
         "application/octet-stream")
}

# migrate_studio.py only answered whoami and the backup APIs for loopback
# clients. Keep that rule in browser mode; in server folder mode the app sits
# behind the server's own sign-in, and requests arrive from its proxy.
ms_client_is_local <- function(session) {
  addr <- tryCatch(session$request$REMOTE_ADDR, error = function(e) NULL)
  is.null(addr) || addr %in% c("127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1")
}

# Route one request to its handler and return a reply list.
ms_dispatch <- function(ctx, method, path, body_json, session) {
  cfg <- ctx$cfg; py <- ctx$py
  # Strip the leading slashes and query string from the path.
  path <- sub("\\?.*$", "", sub("^/+", "", path))
  # Reject bodies larger than 8 MiB.
  if (nchar(body_json, type = "bytes") > 8 * 1024 * 1024) {
    return(ms_reply_json(413L, list(ok = FALSE, error = "Request exceeds the 8 MiB limit")))
  }
  # Parse the JSON body lazily.
  body <- function() ms_from_json(body_json)
  # Run a handler on the Python engine when present, else on the native R one.
  engine_call <- function(py_fn, r_fn) {
    if (!is.null(py)) return(ms_py_call(py, py_fn, body_json))
    out <- r_fn(cfg, body())
    ms_reply_json(out$status, out$body)
  }

  # Restrict identity and backup routes to loopback clients in browser mode.
  local_only <- c("api/whoami", "api/backup/resolve", "api/backup/originals",
                  "api/backup/stamp")
  if (path %in% local_only && identical(cfg$folder_mode, "browser") &&
      !ms_client_is_local(session)) {
    return(ms_reply_json(403L, list(ok = FALSE, error = "local requests only")))
  }

  # Answer whoami with the user identity and data directory.
  if (method == "GET" && path == "api/whoami") {
    who <- if (!is.null(py)) ms_from_json(ms_py_call(py, "whoami")$json)
           else ms_native_whoami(cfg, session)
    # On Posit Connect / Shiny Server the process account is a service
    # account; the signed-in user is the one who should be recorded.
    if (!is.null(session$user) && nzchar(session$user)) {
      who$userId <- session$user
      who$userKey <- tolower(session$user)
    }
    who$dataDir <- cfg$data_dir
    return(ms_reply_json(200L, who))
  }

  # Save the user's current selection.
  if (method == "POST" && path == "api/current-selection") {
    out <- ms_save_current_selection(cfg, body())
    return(ms_reply_json(out$status, out$body))
  }

  # Validate a run record and append it to the history.
  if (method == "POST" && path == "api/history") {
    run <- body()
    if (!is.list(run) || is.null(run$runId) || !nzchar(as.character(run$runId))) {
      return(ms_reply_json(400L, list(ok = FALSE, error = "runId is required")))
    }
    if (!is.null(py)) {
      result <- ms_py_call(py, "append_history_run", body_json)
      return(list(status = 200L, json = result$json))
    }
    return(ms_reply_json(200L, ms_native_append_history_run(cfg, run)))
  }

  # Resolve the backup root, preferring a server folder when one applies.
  if (method == "POST" && path == "api/backup/resolve") {
    server_root <- ms_server_folder_resolution(ctx, session, body())
    if (!is.null(server_root)) return(ms_reply_json(200L, server_root))
    return(engine_call("resolve_backup_root_response",
                       ms_native_resolve_backup_root))
  }

  # Back up the original input files.
  if (method == "POST" && path == "api/backup/originals") {
    return(engine_call("backup_originals_response", ms_native_backup_originals))
  }

  # Stamp the backup with run details.
  if (method == "POST" && path == "api/backup/stamp") {
    return(engine_call("backup_stamp_response", ms_native_backup_stamp))
  }

  # Close the session, or stop the app, once the reply is flushed.
  if (method == "POST" && path == "api/logout") {
    session$onFlushed(function() {
      if (isTRUE(cfg$stop_on_logout)) shiny::stopApp() else session$close()
    }, once = TRUE)
    return(ms_reply_json(200L, list(ok = TRUE)))
  }

  # Serve the history and current-selection files.
  if (method == "GET" && path == "history.json") {
    return(ms_reply_file(cfg$history_file, "application/json"))
  }
  if (method == "GET" && path == "current_selections.json") {
    return(ms_reply_file(cfg$selection_file, "application/json"))
  }
  # Serve the published static files.
  if (method == "GET" && path %in% cfg$published_files) {
    return(ms_reply_file(file.path(cfg$app_dir, path), ms_content_type(path)))
  }

  # Delegate server-folder requests to the fs handler.
  if (startsWith(path, "fs/")) {
    return(ms_fs_dispatch(ctx, sub("^fs/", "", path), body(), session))
  }

  # Return 404 for any unmatched route.
  ms_reply_json(404L, list(ok = FALSE, error = "Not found"))
}

# Wrap ms_dispatch so an R error becomes a JSON 500, like the Python server.
# Handle a request, converting any R error into a JSON 500.
ms_handle_request <- function(ctx, request, session) {
  tryCatch(
    ms_dispatch(ctx, toupper(request$method %||% "GET"), request$path %||% "",
                request$body %||% "", session),
    error = function(e) ms_reply_json(500L, list(ok = FALSE,
                                                 error = "Operation failed; check input, permissions and configuration")))
}
