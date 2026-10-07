# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Check that server writes keep inode and mode, and that revert restores the date.
test_that("server folder writes keep inode and mode; revert restores the date", {
  skip_on_os("windows")   # inode check only; the behaviour itself is portable
  # Read a file's inode with stat where the platform supports it.
  file_inode <- function(path) {
    sys <- Sys.info()[["sysname"]]
    if (identical(sys, "Linux")) return(system2("stat", c("-c", "%i", shQuote(path)), stdout = TRUE))
    if (identical(sys, "Darwin")) return(system2("stat", c("-f", "%i", shQuote(path)), stdout = TRUE))
    NA_character_
  }
  # Build a sample study and restrict the server root to it.
  study <- make_study()
  live <- file.path(study$prog, "t-dm.sas")
  Sys.chmod(live, "640")
  opts <- options(migrate_studio.folder_mode = "server",
                  migrate_studio.server_roots = study$root)
  on.exit(options(opts))
  # Create the request context and a helper that calls fs/ operations.
  ctx <- new.env(); ctx$cfg <- test_config(study); ctx$py <- NULL
  session <- fake_session()
  fs <- function(op, body) ms_handle_request(ctx, list(method = "POST",
    path = paste0("fs/", op), body = ms_to_json(body)), session)

  # Select the program folder and confirm the reply.
  selected <- fs("select", list(root = "1", rel = "SOURCE_T"))
  expect_equal(selected$status, 200L)
  selected_body <- jsonlite::fromJSON(selected$json)
  expect_equal(selected_body$name, basename(study$prog))
  expect_equal(selected_body$path, normalizePath(study$prog, winslash = "/"))
  # Confirm backup resolve takes the server-folder shortcut.
  res <- jsonlite::fromJSON(ms_handle_request(ctx, list(method = "POST",
    path = "api/backup/resolve", body = fingerprint_json(study)), session)$json)
  expect_equal(res$resolution, "server-folder")
  # Create the backup folder and file.
  expect_equal(fs("dir", list(root = "1", rel = "SOURCE_T/_migrate_original",
                              create = TRUE))$status, 200L)
  expect_equal(fs("file", list(root = "1", rel = "SOURCE_T/_migrate_original/t-dm.sas",
                               create = TRUE))$status, 200L)
  # Copy the program into the backup and confirm its date is preserved.
  backup <- fs("write", list(root = "1", rel = "SOURCE_T/_migrate_original/t-dm.sas",
                             copyFrom = list(root = "1", rel = "SOURCE_T/t-dm.sas")))
  expect_equal(backup$status, 200L)
  backup_body <- jsonlite::fromJSON(backup$json)
  expect_true(backup_body$datePreserved)
  expect_equal(as.numeric(file.info(file.path(study$prog, "_migrate_original",
                                              "t-dm.sas"))$mtime),
               as.numeric(study$old))

  # Overwrite the live file and confirm inode, mode and a newer date.
  inode <- file_inode(live)
  skip_if(is.na(inode), "inode check is not available on this platform")
  out <- fs("write", list(root = "1", rel = "SOURCE_T/t-dm.sas",
                          base64 = jsonlite::base64_enc(charToRaw("fixed;\n"))))
  expect_equal(out$status, 200L)
  expect_equal(readLines(live), "fixed;")
  expect_equal(file_inode(live), inode)
  expect_equal(as.character(file.info(live)$mode), "640")
  expect_gt(as.numeric(file.info(live)$mtime), as.numeric(study$old))

  # Revert from the backup and confirm content and original date return.
  fs("write", list(root = "1", rel = "SOURCE_T/t-dm.sas",
                   copyFrom = list(root = "1", rel = "SOURCE_T/_migrate_original/t-dm.sas")))
  expect_equal(readLines(live), "proc print; run;")
  expect_equal(as.numeric(file.info(live)$mtime), as.numeric(study$old))

  # Reject path traversal, bad roots and missing files.
  expect_equal(fs("read", list(root = "1", rel = "../../etc/passwd"))$status, 400L)
  expect_equal(fs("read", list(root = "2", rel = ""))$status, 400L)
  expect_equal(jsonlite::fromJSON(fs("read", list(root = "1", rel = "SOURCE_T/none.sas"))$json)$name,
               "NotFoundError")
})

# Check that roots cannot be removed and symlinks cannot escape.
test_that("server roots cannot be removed and symlinks cannot escape", {
  study <- make_study()
  opts <- options(migrate_studio.folder_mode = "server", migrate_studio.server_roots = study$root)
  on.exit(options(opts))
  ctx <- new.env(); ctx$cfg <- test_config(study); ctx$py <- NULL
  # Refuse to remove an allowed root.
  response <- ms_handle_request(ctx, list(method = "POST", path = "fs/remove",
    body = ms_to_json(list(root = "1", rel = "", recursive = TRUE))), fake_session())
  expect_equal(response$status, 400L)
  expect_true(dir.exists(study$root))
  # Refuse a symlink that points outside the root.
  outside <- file.path(study$td, "private"); dir.create(outside)
  skip_if_not(file.symlink(outside, file.path(study$root, "escape")))
  expect_error(ms_fs_path(ctx$cfg, "1", "escape/secret.sas", must_exist = FALSE), "outside")
})
