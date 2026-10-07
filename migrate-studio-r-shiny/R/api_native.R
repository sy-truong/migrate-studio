# Migrate Studio (Shiny) -- R port of the local API in python/migrate_studio.py.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Used when engine = "r" (or "auto" finds no usable Python). Each function
# mirrors the Python function of the same name and returns the same JSON shape,
# so the browser code cannot tell the two engines apart.

# Hold per-session state: backup root tokens and how each was resolved.
ms_native <- new.env(parent = emptyenv())
ms_native$root_tokens <- list()       # token -> absolute path
ms_native$resolutions <- list()       # token -> "programs-flag" | "search" | ...

# Define the names and limits shared by history, search and backup code.
MS_BACKUP_DIRNAME <- "_migrate_original"
MS_MAX_HISTORY_RUNS <- 500L
MS_SEARCH_MAX_DEPTH <- 4L
MS_SEARCH_MAX_DIRS <- 20000L
MS_SEARCH_SECONDS <- 2
MS_MTIME_TOLERANCE_MS <- 2000
MS_SEARCH_PRUNE <- c(MS_BACKUP_DIRNAME, "Migrate_Studio", "PortFix",
                     "node_modules", ".git")

# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

# Parse JSON text into R lists, treating empty input as an empty list.
ms_from_json <- function(text) {
  if (is.null(text) || !nzchar(text)) return(list())
  jsonlite::fromJSON(text, simplifyVector = FALSE)
}

# A small serializer instead of jsonlite::toJSON for containers: jsonlite
# rewrites an empty object key ("" = the root program folder) as "1".
ms_to_json <- function(x, pretty = FALSE, indent = 0L) {
  nl <- if (pretty) paste0("\n", strrep("  ", indent + 1L)) else ""
  end <- if (pretty) paste0("\n", strrep("  ", indent)) else ""
  colon <- if (pretty) ": " else ":"
  scalar <- function(v) as.character(jsonlite::toJSON(v, auto_unbox = TRUE,
                                                      digits = NA, na = "null"))
  if (is.null(x)) return("null")
  if (is.list(x)) {
    if (!length(x)) return(if (is.null(names(x))) "[]" else "{}")
    items <- vapply(x, ms_to_json, character(1), pretty = pretty,
                    indent = indent + 1L)
    if (is.null(names(x))) {
      return(paste0("[", nl, paste(items, collapse = paste0(",", nl)), end, "]"))
    }
    keys <- vapply(names(x), scalar, character(1))
    return(paste0("{", nl, paste0(keys, colon, items, collapse = paste0(",", nl)),
                  end, "}"))
  }
  if (inherits(x, "AsIs") || length(x) != 1L) {
    x <- unclass(x)
    if (!length(x)) return("[]")
    return(paste0("[", paste(vapply(x, scalar, character(1)), collapse = ","), "]"))
  }
  scalar(x)
}

# Write JSON to a temp file, then rename it over the target.
ms_write_json_atomic <- function(x, path) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  tmp <- paste0(path, ".tmp")
  writeLines(ms_to_json(x, pretty = TRUE), tmp, useBytes = TRUE)
  if (!file.rename(tmp, path)) {
    # file.rename can refuse to replace across volumes; fall back to copy.
    file.copy(tmp, path, overwrite = TRUE)
    unlink(tmp)
  }
}

# Python json.dumps(..., ensure_ascii=True) for one string.
ms_py_json_string <- function(s) {
  cps <- utf8ToInt(enc2utf8(as.character(s)))
  out <- vapply(cps, function(cp) {
    if (cp == 34L) return("\\\"")
    if (cp == 92L) return("\\\\")
    if (cp == 10L) return("\\n")
    if (cp == 13L) return("\\r")
    if (cp == 9L)  return("\\t")
    if (cp == 8L)  return("\\b")
    if (cp == 12L) return("\\f")
    if (cp < 32L || (cp > 126L && cp <= 0xFFFF)) return(sprintf("\\u%04x", cp))
    if (cp > 0xFFFF) {
      v <- cp - 0x10000
      return(sprintf("\\u%04x\\u%04x", 0xD800 + v %/% 0x400, 0xDC00 + v %% 0x400))
    }
    intToUtf8(cp)
  }, character(1))
  paste0("\"", paste(out, collapse = ""), "\"")
}

# Format a number as a plain integer string.
ms_int_string <- function(x) formatC(x, format = "f", digits = 0, big.mark = "")

# Python sorted() / sort_keys order is code-point order, not locale order.
ms_sort_codepoint <- function(x) {
  if (!length(x)) return(x)
  x[order(vapply(x, function(s) {
    paste(sprintf("%08x", utf8ToInt(enc2utf8(s))), collapse = "")
  }, character(1)), method = "radix")]
}

# ---------------------------------------------------------------------------
# whoami, history, current selection
# ---------------------------------------------------------------------------

# Report the signed-in user, host and operating system.
ms_native_whoami <- function(cfg, session = NULL) {
  # Resolve the account from the session user, then the OS.
  account <- ""
  if (!is.null(session) && !is.null(session$user) && nzchar(session$user)) {
    account <- session$user                 # Posit Connect / Shiny Server Pro
  }
  if (!nzchar(account)) account <- Sys.info()[["user"]]
  if (!nzchar(account) || identical(account, "unknown")) {
    account <- Sys.getenv("USERNAME", Sys.getenv("USER", ""))
  }
  account <- trimws(account)
  list(ok = TRUE, userId = account, userKey = tolower(account),
       source = if (nzchar(account)) "os" else "unknown",
       host = Sys.info()[["nodename"]],
       os = switch(Sys.info()[["sysname"]], Darwin = "Darwin",
                   Windows = "Windows", Linux = "Linux", Sys.info()[["sysname"]]),
       sessionId = cfg$session_id, serverStartedAt = cfg$started_at,
       dataDir = cfg$data_dir)
}

# Append a run to history.json, skipping duplicates and capping the size.
ms_native_append_history_run <- function(cfg, run) {
  path <- cfg$history_file
  book <- list(schema = "migrate-studio/history", version = 1L, runs = list())
  # Load the existing history, setting aside a corrupt file.
  if (file.exists(path)) {
    loaded <- tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE),
                       error = function(e) e)
    if (inherits(loaded, "error")) {
      file.rename(path, sub("\\.json$", ".corrupt.json", path))
    } else if (is.list(loaded) && !is.null(names(loaded)) &&
               is.list(loaded$runs)) {
      book <- loaded
    } else if (is.list(loaded) && is.null(names(loaded))) {
      book$runs <- loaded
    }
  }
  # Ignore a run whose id was recorded recently.
  recent <- utils::tail(book$runs, 50)
  if (any(vapply(recent, function(r) identical(r$runId, run$runId), logical(1)))) {
    return(list(ok = TRUE, duplicate = TRUE))
  }
  # Append the run and trim to the maximum count.
  book$runs[[length(book$runs) + 1L]] <- run
  if (length(book$runs) > MS_MAX_HISTORY_RUNS) {
    book$runs <- utils::tail(book$runs, MS_MAX_HISTORY_RUNS)
  }
  ms_write_json_atomic(book, path)
  list(ok = TRUE, runs = length(book$runs))
}

# Merge runs from a legacy history file into the target, de-duplicated by run id.
ms_import_legacy_history <- function(legacy, target,
                                     max_runs = MS_MAX_HISTORY_RUNS) {
  # Read the run list from a history file in either format.
  runs_in <- function(path) {
    if (!file.exists(path)) return(list())
    x <- jsonlite::fromJSON(path, simplifyVector = FALSE)
    if (is.list(x) && !is.null(names(x)) && is.list(x$runs)) return(x$runs)
    if (is.list(x) && is.null(names(x))) return(x)
    list()
  }
  # Refuse a missing legacy file or one identical to the target.
  if (!file.exists(legacy)) {
    return(list(ok = FALSE, error = paste("no history file at", legacy)))
  }
  if (identical(normalizePath(legacy, winslash = "/", mustWork = FALSE),
                normalizePath(target, winslash = "/", mustWork = FALSE))) {
    return(list(ok = FALSE, error = "legacy and target are the same file"))
  }
  # Collect legacy runs that the target does not already hold.
  old <- runs_in(legacy)
  current <- runs_in(target)
  run_id <- function(r) as.character(r$runId %||% "")
  seen <- vapply(current, run_id, character(1))
  added <- list()
  for (r in old) {
    id <- run_id(r)
    if (nzchar(id) && !id %in% seen) {
      seen <- c(seen, id)
      added[[length(added) + 1L]] <- r
    }
  }
  # Sort by applied time, cap the count and write the result.
  merged <- c(current, added)
  at <- vapply(merged, function(r) as.character(r$appliedAt %||% ""), character(1))
  merged <- utils::tail(merged[order(at)], max_runs)
  dir.create(dirname(target), recursive = TRUE, showWarnings = FALSE)
  ms_write_json_atomic(list(schema = "migrate-studio/history", version = 1L,
                            runs = merged), target)
  list(ok = TRUE, imported = length(added),
       skipped = length(old) - length(added), target = target)
}

# The Python server does this inline in do_POST; both engines use this port.
ms_save_current_selection <- function(cfg, body) {
  # Require a program folder and default the other fields.
  folder <- trimws(as.character(body$program_folder %||% ""))
  if (!nzchar(folder)) {
    return(list(status = 400L,
                body = list(ok = FALSE, error = "program_folder is required")))
  }
  handle_key <- trimws(as.character(body$handle_key %||%
                                      "migratestudio_program_folder"))
  selected_at <- trimws(as.character(body$selected_at %||% ""))
  if (!nzchar(selected_at)) selected_at <- ms_utc_now()
  meta <- list(program_folder = folder,
               handle_key = if (nzchar(handle_key)) handle_key
                            else "migratestudio_program_folder",
               selected_at = selected_at)
  # Persist the selection.
  ms_write_json_atomic(meta, cfg$selection_file)
  list(status = 200L, body = list(ok = TRUE, selection = meta))
}

# Return the fallback when the value is NULL.
`%||%` <- function(a, b) if (is.null(a)) b else a

# ---------------------------------------------------------------------------
# Path safety (safe_join / safe_child / path_inside)
# ---------------------------------------------------------------------------

# Normalize a path to forward slashes without requiring it to exist.
ms_norm <- function(path) normalizePath(path, winslash = "/", mustWork = FALSE)

# Test whether a path equals or sits under a parent folder.
ms_path_inside <- function(child, parent) {
  child <- ms_norm(child); parent <- sub("/+$", "", ms_norm(parent))
  # Compare case-insensitively on Windows.
  sensitive <- .Platform$OS.type != "windows"
  if (!sensitive) { child <- tolower(child); parent <- tolower(parent) }
  identical(child, parent) || startsWith(child, paste0(parent, "/"))
}

# Detect POSIX and drive-letter absolute paths.
ms_looks_absolute <- function(value) {
  grepl("^/", value) || grepl("^[A-Za-z]:[/\\\\]", value)
}

# Join a relative folder to a base, rejecting escapes and non-directories.
ms_safe_join <- function(base, folder) {
  folder <- gsub("\\\\", "/", as.character(folder %||% ""))
  if (ms_looks_absolute(folder)) stop("absolute folders are not allowed")
  target <- ms_norm(if (nzchar(folder)) file.path(base, folder) else base)
  if (!ms_path_inside(target, base)) stop("folder is outside the allowed root")
  if (!dir.exists(target)) stop("folder is not a directory")
  target
}

# Accept only plain file names with no separators or dot segments.
ms_bare_name_ok <- function(name) {
  nzchar(name) && !grepl("[/\\\\]", name) && !name %in% c(".", "..")
}

# Validate a .sas file name and return its path inside a directory.
ms_safe_child <- function(directory, name) {
  name <- trimws(as.character(name %||% ""))
  if (!ms_bare_name_ok(name)) stop("file name must be a bare .sas file")
  if (ms_looks_absolute(name)) stop("absolute file names are not allowed")
  if (!grepl("\\.sas$", name, ignore.case = TRUE)) {
    stop("only .sas files can be backed up")
  }
  target <- ms_norm(file.path(directory, name))
  if (!ms_path_inside(target, directory)) {
    stop("file is outside the requested directory")
  }
  # Reject directories, symlinks and missing files.
  info <- file.info(target)
  if (is.na(info$isdir) || info$isdir || nzchar(Sys.readlink(target))) {
    stop("source is not a regular .sas file")
  }
  target
}

# ---------------------------------------------------------------------------
# Fingerprints and the backup_roots.json cache
# ---------------------------------------------------------------------------

# Validate a folder-to-files fingerprint and return it in sorted canonical form.
ms_normalize_fingerprint <- function(fingerprint) {
  if (!is.list(fingerprint) || (length(fingerprint) && is.null(names(fingerprint)))) {
    stop("fingerprint must be an object")
  }
  keys <- character(); values <- list()
  for (i in seq_along(fingerprint)) {        # by position: "" is a valid folder
    files <- fingerprint[[i]]
    key <- gsub("^/+|/+$", "", gsub("\\\\", "/", names(fingerprint)[[i]]))
    if (ms_looks_absolute(key) || ".." %in% strsplit(key, "/")[[1]]) {
      stop("fingerprint folder is unsafe")
    }
    if (!is.list(files) || (length(files) && !is.null(names(files)))) {
      stop("fingerprint files must be lists")
    }
    # Validate each file entry and keep its name, size and modified time.
    entries <- list(); seen <- character()
    for (item in files) {
      if (!is.list(item) || is.null(names(item))) {
        stop("fingerprint file entries must be objects")
      }
      name <- trimws(as.character(item$name %||% ""))
      if (!ms_bare_name_ok(name)) stop("fingerprint file names must be bare names")
      if (!grepl("\\.sas$", name, ignore.case = TRUE)) {
        stop("fingerprint files must be .sas programs")
      }
      if (name %in% seen) stop("duplicate fingerprint file")
      seen <- c(seen, name)
      entries[[length(entries) + 1L]] <- list(
        name = name,
        size = trunc(as.numeric(item$size %||% 0)),
        lastModified = trunc(as.numeric(item$lastModified %||% 0)))
    }
    # Sort the entries by file name.
    entries <- entries[match(ms_sort_codepoint(seen), seen)]
    keys <- c(keys, key); values[[length(values) + 1L]] <- entries
  }
  # Sort the folders by key.
  ord <- match(ms_sort_codepoint(keys), keys)
  structure(values[ord], names = keys[ord])
}

# Byte-for-byte the string Python hashes, so backup_roots.json keys are
# interchangeable between the Python and R engines.
ms_fingerprint_hash <- function(folder_name, fingerprint) {
  folders <- vapply(seq_along(fingerprint), function(i) {
    folder <- names(fingerprint)[[i]]
    files <- vapply(fingerprint[[i]], function(e) {
      paste0("{\"lastModified\":", ms_int_string(e$lastModified),
             ",\"name\":", ms_py_json_string(e$name),
             ",\"size\":", ms_int_string(e$size), "}")
    }, character(1))
    paste0(ms_py_json_string(folder), ":[", paste(files, collapse = ","), "]")
  }, character(1))
  payload <- paste0("{\"fingerprint\":{", paste(folders, collapse = ","),
                    "},\"folderName\":", ms_py_json_string(folder_name), "}")
  digest::digest(charToRaw(payload), algo = "sha256", serialize = FALSE)
}

# Load the backup-root cache, or start an empty one.
ms_load_backup_cache <- function(cfg) {
  loaded <- tryCatch(jsonlite::fromJSON(cfg$backup_cache, simplifyVector = FALSE),
                     error = function(e) NULL)
  if (is.list(loaded) && is.list(loaded$entries)) return(loaded)
  list(schema = "migrate-studio/backup-roots", version = 1L,
       entries = structure(list(), names = character()))
}

# Issue a random token for a resolved root and remember its path.
ms_root_token_for <- function(path, resolution) {
  chars <- c(letters, LETTERS, 0:9, "-", "_")
  token <- paste(sample(chars, 24, replace = TRUE), collapse = "")
  ms_native$root_tokens[[token]] <- ms_norm(path)
  ms_native$resolutions[[token]] <- resolution
  token
}

# Look up the path behind a token, or fail.
ms_root_from_token <- function(token) {
  token <- as.character(token %||% "")
  root <- if (nzchar(token)) ms_native$root_tokens[[token]] else NULL
  if (is.null(root)) stop("rootToken is not valid for this server session")
  root
}

# List the .sas files directly inside a directory.
ms_sas_files <- function(directory) {
  files <- list.files(directory, all.files = TRUE, no.. = TRUE)
  files <- files[grepl(".\\.sas$", files, ignore.case = TRUE)]
  files[!dir.exists(file.path(directory, files))]
}

# Confirm a candidate folder matches the fingerprint's names, sizes and dates.
ms_verify_fingerprint <- function(candidate, fingerprint) {
  for (i in seq_along(fingerprint)) {
    directory <- tryCatch(ms_safe_join(candidate, names(fingerprint)[[i]]),
                          error = function(e) NULL)
    if (is.null(directory)) return(FALSE)
    expected <- fingerprint[[i]]
    actual <- ms_sort_codepoint(ms_sas_files(directory))
    wanted <- ms_sort_codepoint(vapply(expected, `[[`, character(1), "name"))
    if (!identical(actual, wanted)) return(FALSE)
    for (entry in expected) {
      info <- file.info(file.path(directory, entry$name), extra_cols = FALSE)
      if (is.na(info$size) || info$size != entry$size) return(FALSE)
      mtime_ms <- as.numeric(info$mtime) * 1000
      if (abs(mtime_ms - entry$lastModified) > MS_MTIME_TOLERANCE_MS) return(FALSE)
    }
  }
  TRUE
}

# Collect the existing base folders to search, tagged by source.
ms_candidate_search_roots <- function(cfg) {
  roots <- c(stats::setNames(cfg$program_roots,
                             rep("programs-flag", length(cfg$program_roots))),
             search = getwd(), search = dirname(cfg$app_dir),
             search = path.expand("~"))
  out <- character(); src <- character()
  for (i in seq_along(roots)) {
    path <- ms_norm(roots[[i]])
    if (!dir.exists(path) || path %in% out) next
    out <- c(out, path); src <- c(src, names(roots)[[i]])
  }
  stats::setNames(out, src)
}

# Search the base folders for a named directory within a time and count budget.
ms_find_named_directories <- function(cfg, folder_name) {
  started <- Sys.time(); visited <- 0L
  matches <- character(); sources <- character()
  # Stop when the directory or time budget is spent.
  out_of_budget <- function() {
    visited >= MS_SEARCH_MAX_DIRS ||
      as.numeric(difftime(Sys.time(), started, units = "secs")) >= MS_SEARCH_SECONDS
  }
  bases <- ms_candidate_search_roots(cfg)
  for (i in seq_along(bases)) {
    if (out_of_budget()) break
    base <- bases[[i]]; source <- names(bases)[[i]]
    base_depth <- length(strsplit(base, "/")[[1]])
    stack <- base                           # depth-first, like os.walk
    # Walk depth-first, recording matches and queuing child folders.
    while (length(stack)) {
      current <- stack[[1]]; stack <- stack[-1]
      visited <- visited + 1L
      if (out_of_budget()) break
      if (basename(current) == folder_name && !current %in% matches) {
        matches <- c(matches, current); sources <- c(sources, source)
      }
      depth <- length(strsplit(current, "/")[[1]]) - base_depth
      if (depth >= MS_SEARCH_MAX_DEPTH) next
      # List child folders, skipping hidden, pruned and linked ones.
      kids <- tryCatch(list.dirs(current, full.names = TRUE, recursive = FALSE),
                       error = function(e) character())
      kids <- enc2utf8(kids)
      kids <- kids[!is.na(kids)]
      kids <- kids[!startsWith(basename(kids), ".") &
                     !basename(kids) %in% MS_SEARCH_PRUNE &
                     !nzchar(Sys.readlink(kids))]   # os.walk does not follow links
      stack <- c(sort(kids, method = "radix"), stack)
    }
  }
  stats::setNames(matches, sources)
}

# Locate the local folder behind a fingerprint, trying the cache first.
ms_native_resolve_backup_root <- function(cfg, body) {
  # Validate the folder name and fingerprint.
  folder_name <- trimws(as.character(body$folderName %||% ""))
  if (!nzchar(folder_name)) {
    return(list(status = 400L, body = list(ok = FALSE, error = "folderName is required")))
  }
  fingerprint <- tryCatch(ms_normalize_fingerprint(body$fingerprint),
                          error = function(e) e)
  if (inherits(fingerprint, "error")) {
    return(list(status = 400L,
                body = list(ok = FALSE, error = conditionMessage(fingerprint))))
  }
  # Reuse the cached path for this fingerprint when it still matches.
  key <- ms_fingerprint_hash(folder_name, fingerprint)
  cache <- ms_load_backup_cache(cfg)
  cached <- cache$entries[[key]]
  if (!is.null(cached)) {
    candidate <- ms_norm(cached)
    if (basename(candidate) == folder_name && dir.exists(candidate) &&
        ms_verify_fingerprint(candidate, fingerprint)) {
      token <- ms_root_token_for(candidate, "cache")
      return(list(status = 200L, body = list(ok = TRUE, resolved = TRUE,
        rootToken = token, path = candidate, resolution = "cache")))
    }
  }
  # Search the disk and keep candidates that match the fingerprint.
  found <- ms_find_named_directories(cfg, folder_name)
  verified <- character()
  for (i in seq_along(found)) {
    path <- ms_norm(found[[i]])
    if (basename(path) != folder_name || path %in% verified) next
    if (ms_verify_fingerprint(path, fingerprint)) {
      verified <- c(verified, stats::setNames(path, names(found)[[i]]))
    }
  }
  # Report an ambiguous or missing match instead of guessing.
  if (length(verified) != 1L) {
    reason <- if (length(verified) > 1L) "ambiguous" else "not-found"
    message("Migrate Studio backup resolve: ", reason, " for ", folder_name)
    return(list(status = 200L, body = list(ok = TRUE, resolved = FALSE,
      reason = reason)))
  }
  # Cache the unique match and issue a token for it.
  cache$entries[[key]] <- unname(verified[[1]])
  try(ms_write_json_atomic(cache, cfg$backup_cache), silent = TRUE)
  token <- ms_root_token_for(verified[[1]], names(verified)[[1]])
  list(status = 200L, body = list(ok = TRUE, resolved = TRUE, rootToken = token,
    path = unname(verified[[1]]), resolution = names(verified)[[1]]))
}

# ---------------------------------------------------------------------------
# Backups -- OS-aware copy plus a content check
# ---------------------------------------------------------------------------

# Tolerate small modified-time differences, in seconds.
MS_MTIME_TOLERANCE_SECS <- 2

# Name the OS family used to choose a copy command.
ms_os_name <- function() {
  if (.Platform$OS.type == "windows") return("windows")
  if (identical(Sys.info()[["sysname"]], "Linux")) return("linux")
  "unix"
}

# Format a directory path for robocopy.
ms_robocopy_dir <- function(path) {
  p <- normalizePath(path, winslash = "\\", mustWork = TRUE)
  p <- sub("\\\\+$", "", p)
  if (grepl("^[A-Za-z]:$", p)) p <- paste0(p, "\\.")
  p
}

# Copy a file with the OS tool (robocopy or cp) to keep dates and modes.
ms_os_copy <- function(src, dst) {
  os <- ms_os_name()
  # Run a copy command and report success when the destination exists.
  run_copy <- function(cmd, args, ok_status) {
    if (!nzchar(Sys.which(cmd))) return(FALSE)
    out <- tryCatch(suppressWarnings(system2(cmd, args, stdout = TRUE, stderr = TRUE)),
                    error = function(e) structure(conditionMessage(e), status = 99L))
    status <- attr(out, "status")
    if (is.null(status)) status <- 0L
    isTRUE(ok_status(as.integer(status))) && file.exists(dst)
  }
  # Use robocopy on Windows.
  if (os == "windows") {
    if (!identical(basename(src), basename(dst))) return(FALSE)
    args <- c(shQuote(ms_robocopy_dir(dirname(src)), type = "cmd"),
              shQuote(ms_robocopy_dir(dirname(dst)), type = "cmd"),
              shQuote(basename(src), type = "cmd"),
              "/COPY:DAT", "/R:1", "/W:1", "/NP", "/NJH", "/NJS", "/NFL", "/NDL")
    return(run_copy("robocopy", args, function(s) s < 8L))
  }
  # Prefer cp with preserved mode and timestamps on Linux.
  if (os == "linux") {
    args <- c("--preserve=mode,timestamps", "--", shQuote(src), shQuote(dst))
    if (run_copy("cp", args, function(s) s == 0L)) return(TRUE)
    if (file.exists(dst)) unlink(dst)
  }
  # Fall back to cp -p.
  run_copy("cp", c("-p", "--", shQuote(src), shQuote(dst)), function(s) s == 0L)
}

# Copy src -> dst keeping modified time and permission bits. Never overwrites.
# Returns list(status = "copied"|"skipped", method = "os"|"r",
#              datePreserved = TRUE/FALSE), or stops with an error.
ms_copy_preserving <- function(src, dst) {
  # Skip when the backup already exists.
  if (file.exists(dst)) {
    return(list(status = "skipped", method = "", datePreserved = TRUE))
  }
  # Copy with the OS tool, falling back to R's file.copy.
  method <- "os"
  if (!ms_os_copy(src, dst)) {
    method <- "r"
    if (file.exists(dst)) unlink(dst)
    ok <- file.copy(src, dst, overwrite = FALSE, copy.mode = TRUE, copy.date = TRUE)
    if (!isTRUE(ok)) stop("copy failed")
  }
  # Verify the copy by checksum.
  if (!identical(unname(tools::md5sum(src)), unname(tools::md5sum(dst)))) {
    unlink(dst); stop("backup content does not match the source")
  }
  # Reset the backup's modified time and check it matches the source.
  src_mtime <- file.info(src)$mtime
  off <- function() abs(as.numeric(src_mtime) - as.numeric(file.info(dst)$mtime))
  set_ok <- isTRUE(Sys.setFileTime(dst, src_mtime))
  list(status = "copied", method = method,
       datePreserved = set_ok && off() <= MS_MTIME_TOLERANCE_SECS)
}

# Back up the listed files under each folder and build a per-folder index.
ms_native_backup_for_root <- function(base, directories) {
  copied <- 0L; skipped <- 0L; failed <- list(); date_failed <- list()
  index_names <- character(); index <- list()
  # Create each folder's backup directory.
  for (entry in directories) {
    folder <- gsub("^/+|/+$", "", gsub("\\\\", "/", as.character(entry$folder %||% "")))
    src_dir <- ms_safe_join(base, folder)
    dst_dir <- file.path(src_dir, MS_BACKUP_DIRNAME)
    dir.create(dst_dir, showWarnings = FALSE)
    # Copy each file, tallying copied, skipped and failed.
    for (name in entry$files) {
      result <- tryCatch({
        src <- ms_safe_child(src_dir, name)
        ms_copy_preserving(src, file.path(dst_dir, basename(src)))
      }, error = function(e) e)
      if (inherits(result, "error")) {
        failed[[length(failed) + 1L]] <- list(folder = folder,
          name = as.character(name), error = conditionMessage(result))
      } else if (identical(result$status, "copied")) {
        copied <- copied + 1L
        if (!isTRUE(result$datePreserved)) {
          date_failed[[length(date_failed) + 1L]] <-
            list(folder = folder, name = as.character(name))
        }
      } else {
        skipped <- skipped + 1L
      }
    }
    # Record the backups now present in the folder.
    index_names <- c(index_names, folder)
    index[[length(index) + 1L]] <- I(ms_sort_codepoint(ms_sas_files(dst_dir)))
  }
  list(ok = !length(failed), copied = copied, skipped = skipped,
       failed = failed, datesPreserved = !length(date_failed),
       dateFailed = date_failed, copyMethod = ms_os_name(),
       index = structure(index, names = index_names))
}

# Validate the request, then back up the original programs.
ms_native_backup_originals <- function(cfg, body) {
  # Resolve the root token.
  root <- tryCatch(ms_root_from_token(body$rootToken), error = function(e) e)
  if (inherits(root, "error")) {
    return(list(status = 403L, body = list(ok = FALSE, error = conditionMessage(root))))
  }
  # Require a list of directories.
  directories <- body$directories
  if (!is.list(directories) || (length(directories) && !is.null(names(directories)))) {
    return(list(status = 400L,
                body = list(ok = FALSE, error = "directories must be a list")))
  }
  # Validate every path before copying anything.
  check <- tryCatch({
    for (entry in directories) {
      src_dir <- ms_safe_join(root, entry$folder %||% "")
      if (!is.list(entry$files) && !is.character(entry$files)) {
        stop("files must be a list")
      }
      for (name in entry$files) ms_safe_child(src_dir, name)
    }
    NULL
  }, error = function(e) e)
  if (inherits(check, "error")) {
    return(list(status = 400L, body = list(ok = FALSE, error = conditionMessage(check))))
  }
  # Run the backup and map failures to an HTTP status.
  result <- tryCatch(ms_native_backup_for_root(root, directories), error = function(e) e)
  if (inherits(result, "error")) {
    return(list(status = 500L, body = list(ok = FALSE, copied = 0L, skipped = 0L,
      failed = list(list(folder = "", name = "", error = conditionMessage(result))),
      index = structure(list(), names = character()))))
  }
  # Report how the root was resolved.
  result$resolution <- ms_native$resolutions[[as.character(body$rootToken)]] %||% ""
  list(status = if (length(result$failed)) 500L else 200L, body = result)
}

# Set each backup's modified time to the original program's date.
ms_native_backup_stamp <- function(cfg, body) {
  # Resolve the root token.
  root <- tryCatch(ms_root_from_token(body$rootToken), error = function(e) e)
  if (inherits(root, "error")) {
    return(list(status = 403L, body = list(ok = FALSE, error = conditionMessage(root))))
  }
  # Require a list of entries.
  entries <- body$entries
  if (!is.list(entries) || (length(entries) && !is.null(names(entries)))) {
    return(list(status = 400L,
                body = list(ok = FALSE, error = "entries must be a list")))
  }
  # Stamp each backup file and verify the new time.
  failed <- list(); stamped <- 0L
  for (entry in entries) {
    folder <- gsub("^/+|/+$", "", gsub("\\\\", "/", as.character(entry$folder %||% "")))
    name <- as.character(entry$name %||% "")
    last_modified <- suppressWarnings(as.numeric(entry$lastModified %||% NA))
    result <- tryCatch({
      if (is.na(last_modified) || last_modified <= 0) stop("lastModified is required")
      src_dir <- ms_safe_join(root, folder)
      backup_dir <- file.path(src_dir, MS_BACKUP_DIRNAME)
      if (!dir.exists(backup_dir)) stop("backup folder does not exist")
      path <- ms_safe_child(backup_dir, name)
      when <- as.POSIXct(last_modified / 1000, origin = "1970-01-01", tz = "UTC")
      if (!isTRUE(Sys.setFileTime(path, when))) stop("timestamp update refused")
      info <- file.info(path)
      if (is.na(info$mtime) ||
          abs(as.numeric(info$mtime) - as.numeric(when)) > MS_MTIME_TOLERANCE_SECS) {
        stop("timestamp verification failed")
      }
      TRUE
    }, error = function(e) e)
    if (inherits(result, "error")) {
      failed[[length(failed) + 1L]] <- list(folder = folder, name = name,
                                            error = conditionMessage(result))
    } else {
      stamped <- stamped + 1L
    }
  }
  # Summarize the stamping results.
  body <- list(ok = !length(failed), stamped = stamped,
               datesPreserved = !length(failed), dateFailed = failed)
  list(status = if (length(failed)) 500L else 200L, body = body)
}
