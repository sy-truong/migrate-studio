# Migrate Studio (Shiny) -- server folder mode.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# When folder_mode = "server", the programs live on the machine running R
# (Posit Workbench, Connect, Shiny Server, a shared drive mounted there).
# www/js/mig-server-fs.js gives migrate-studio.js objects that look like File
# System Access handles; every read/write lands here.
#
# Rules:
#   * only folders under cfg$server_roots are reachable;
#   * paths arrive as (root index, relative path) and are re-checked each call;
#   * live files are rewritten in place (same inode), so owner, group, ACLs and
#     permission bits stay as they were; the modified time changes unless
#     keep_live_mtime is on;
#   * a write whose source is another server file (Revert) copies that file's
#     modified time too, so a reverted program gets its original date back.

# Map a root index to an allowlisted server folder.
ms_fs_root <- function(cfg, root) {
  i <- suppressWarnings(as.integer(root))
  if (is.na(i) || i < 1L || i > length(cfg$server_roots)) {
    stop("folder root is not allowlisted")
  }
  cfg$server_roots[[i]]
}

# Resolve a root and relative path to a safe absolute path.
ms_fs_path <- function(cfg, root, rel, must_exist = TRUE) {
  base <- ms_fs_root(cfg, root)
  # Split the relative path into parts.
  rel <- gsub("\\\\", "/", as.character(rel %||% ""))
  parts <- strsplit(rel, "/", fixed = TRUE)[[1]]
  parts <- parts[nzchar(parts)]
  # Reject absolute paths and dot segments.
  if (ms_looks_absolute(rel) || any(parts %in% c(".", ".."))) {
    stop("unsafe path")
  }
  # Build the target path under the root.
  target <- if (length(parts)) do.call(file.path, as.list(c(base, parts))) else base
  target <- ms_norm(target)
  # Check the resolved path of the deepest existing ancestor, so a symlink
  # cannot lead outside the root.
  probe <- target
  while (!file.exists(probe) && !identical(probe, dirname(probe))) probe <- dirname(probe)
  if (!ms_path_inside(ms_norm(probe), base)) stop("path is outside the allowed root")
  # Require the target to exist when asked.
  if (must_exist && !file.exists(target)) {
    stop("NotFoundError: ", basename(target), " not found")
  }
  target
}

# Detect a not-found error by its message prefix.
ms_fs_not_found <- function(e) grepl("^NotFoundError", conditionMessage(e))

# Build a 200 reply with ok = TRUE.
ms_fs_ok <- function(...) ms_reply_json(200L, list(ok = TRUE, ...))

# Run a folder operation, mapping errors to 404 or 400 replies.
ms_fs_dispatch <- function(ctx, op, body, session) {
  cfg <- ctx$cfg
  # Refuse when server folder mode is off.
  if (!identical(cfg$folder_mode, "server")) {
    return(ms_reply_json(404L, list(ok = FALSE, error = "server folder mode is off")))
  }
  result <- tryCatch(ms_fs_op(ctx, op, body, session), error = function(e) {
    ms_reply_json(if (ms_fs_not_found(e)) 404L else 400L,
                  list(ok = FALSE,
                       name = if (ms_fs_not_found(e)) "NotFoundError" else "Error",
                       error = sub("^NotFoundError: ", "", conditionMessage(e))))
  })
  result
}

# Execute one folder operation chosen by name.
ms_fs_op <- function(ctx, op, body, session) {
  cfg <- ctx$cfg
  switch(op,

    # List the allowlisted roots.
    "roots" = ms_fs_ok(roots = lapply(seq_along(cfg$server_roots), function(i) {
      list(id = as.character(i), path = cfg$server_roots[[i]],
           name = basename(cfg$server_roots[[i]]))
    })),

    # List visible subfolders and the .sas file count.
    "list-dirs" = {
      dir <- ms_fs_path(cfg, body$root, body$rel)
      kids <- list.dirs(dir, full.names = FALSE, recursive = FALSE)
      kids <- kids[!startsWith(kids, ".") & !kids %in% MS_SEARCH_PRUNE]
      sas <- length(ms_sas_files(dir))
      ms_fs_ok(dirs = I(sort(kids, method = "radix")), sasCount = sas)
    },

    # List every entry with its kind.
    "entries" = {
      dir <- ms_fs_path(cfg, body$root, body$rel)
      if (!dir.exists(dir)) stop("TypeMismatchError: not a directory")
      names <- list.files(dir, all.files = TRUE, no.. = TRUE)
      kinds <- ifelse(dir.exists(file.path(dir, names)), "directory", "file")
      ms_fs_ok(entries = lapply(seq_along(names), function(i) {
        list(name = names[[i]], kind = kinds[[i]])
      }))
    },

    # Check for a folder, creating it on request.
    "dir" = {
      target <- ms_fs_path(cfg, body$root, body$rel, must_exist = FALSE)
      if (!dir.exists(target)) {
        if (file.exists(target)) stop("TypeMismatchError: not a directory")
        if (!isTRUE(body$create)) stop("NotFoundError: ", basename(target), " not found")
        if (!dir.create(target, showWarnings = FALSE)) stop("could not create folder")
      }
      ms_fs_ok()
    },

    # Check for a file, creating it on request.
    "file" = {
      target <- ms_fs_path(cfg, body$root, body$rel, must_exist = FALSE)
      if (dir.exists(target)) stop("TypeMismatchError: is a directory")
      if (!file.exists(target)) {
        if (!isTRUE(body$create)) stop("NotFoundError: ", basename(target), " not found")
        if (!file.create(target)) stop("could not create file")
      }
      ms_fs_ok()
    },

    # Return a file's bytes, size and modified time.
    "read" = {
      target <- ms_fs_path(cfg, body$root, body$rel)
      info <- file.info(target)
      bytes <- readBin(target, "raw", n = info$size)
      ms_fs_ok(base64 = gsub("\\s", "", jsonlite::base64_enc(bytes)), size = info$size,
               lastModified = floor(as.numeric(info$mtime) * 1000),
               name = basename(target))
    },

    # Write a file, copying from another server file for revert and backup.
    "write" = {
      target <- ms_fs_path(cfg, body$root, body$rel, must_exist = FALSE)
      if (dir.exists(target)) stop("TypeMismatchError: is a directory")
      date_preserved <- NULL
      # Copy from another server file, preserving dates for new backups.
      if (!is.null(body$copyFrom)) {
        source <- ms_fs_path(cfg, body$copyFrom$root, body$copyFrom$rel)
        is_new_backup <- identical(basename(dirname(target)), MS_BACKUP_DIRNAME) &&
                         (!file.exists(target) || file.info(target)$size == 0)
        if (is_new_backup) {
          if (file.exists(target)) unlink(target)
          copied <- ms_copy_preserving(source, target)
          date_preserved <- isTRUE(copied$datePreserved)
        } else {
          ms_fs_write_in_place(target, readBin(source, "raw", file.info(source)$size),
                               mtime = file.info(source)$mtime)
        }
      } else {
        # Decode the uploaded bytes and write them in place.
        bytes <- if (nzchar(body$base64 %||% "")) jsonlite::base64_dec(body$base64)
                 else raw(0)
        keep <- if (isTRUE(cfg$keep_live_mtime) && file.exists(target))
                  file.info(target)$mtime else NULL
        ms_fs_write_in_place(target, bytes, mtime = keep)
      }
      # Return the new size and modified time.
      info <- file.info(target)
      reply <- list(size = info$size, lastModified = floor(as.numeric(info$mtime) * 1000))
      if (!is.null(date_preserved)) reply$datePreserved <- date_preserved
      do.call(ms_fs_ok, reply)
    },

    # Remove a file or folder, refusing roots and non-empty folders.
    "remove" = {
      target <- ms_fs_path(cfg, body$root, body$rel)
      if (identical(target, ms_norm(ms_fs_root(cfg, body$root)))) stop("cannot remove an allowed root")
      if (dir.exists(target)) {
        if (length(list.files(target, all.files = TRUE, no.. = TRUE)) &&
            !isTRUE(body$recursive)) stop("InvalidModificationError: folder is not empty")
        unlink(target, recursive = TRUE)
      } else if (!file.remove(target)) stop("could not remove file")
      ms_fs_ok()
    },

    "select" = {
      # The user picked a folder: remember it for this session so the backup
      # step can resolve it without a disk search.
      target <- ms_fs_path(cfg, body$root, body$rel)
      session$userData$server_folder <- list(root = body$root, rel = body$rel %||% "",
                                             path = target)
      ms_fs_ok(name = basename(target), path = target)
    },

    # Reject unknown operations.
    stop("unknown folder operation: ", op)
  )
}

# Truncate-and-write the existing file (keeps inode, owner, group, ACLs and
# mode), verify, then optionally restore a modified time.
ms_fs_write_in_place <- function(target, bytes, mtime = NULL) {
  mode <- if (file.exists(target)) file.info(target)$mode else NULL
  con <- file(target, open = "wb")
  tryCatch(writeBin(bytes, con), finally = close(con))
  if (!is.null(mode)) Sys.chmod(target, mode, use_umask = FALSE)
  back <- readBin(target, "raw", n = max(1, file.info(target)$size))
  if (!identical(back[seq_len(file.info(target)$size)], bytes)) {
    stop("write verification failed for ", basename(target))
  }
  if (!is.null(mtime)) Sys.setFileTime(target, mtime)
  invisible(TRUE)
}

# api/backup/resolve short-cut: the chosen server folder is already known.
ms_server_folder_resolution <- function(ctx, session, body) {
  # Require a folder chosen in this session that matches the request.
  chosen <- session$userData$server_folder
  if (is.null(chosen) || !identical(ctx$cfg$folder_mode, "server")) return(NULL)
  if (!identical(basename(chosen$path), as.character(body$folderName %||% ""))) {
    return(NULL)
  }
  # Verify the folder still matches the fingerprint.
  fingerprint <- tryCatch(ms_normalize_fingerprint(body$fingerprint),
                          error = function(e) NULL)
  if (is.null(fingerprint) || !ms_verify_fingerprint(chosen$path, fingerprint)) {
    return(NULL)
  }
  # Register the root with the active engine and return the resolution.
  token <- if (!is.null(ctx$py)) ms_py_register_root(ctx$py, chosen$path, "server-folder")
           else ms_root_token_for(chosen$path, "server-folder")
  list(ok = TRUE, resolved = TRUE, rootToken = token, path = chosen$path,
       resolution = "server-folder")
}
