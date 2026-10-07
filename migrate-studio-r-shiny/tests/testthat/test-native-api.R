# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Check that resolve and backup keep dates and permissions and never overwrite.
test_that("resolve + backup keep dates and permissions, never overwrite", {
  # Build a sample study and a request helper.
  study <- make_study()
  Sys.chmod(file.path(study$prog, "t-dm.sas"), "640")
  ctx <- new.env(); ctx$cfg <- test_config(study); ctx$py <- NULL
  req <- function(method, path, body = "") {
    ms_handle_request(ctx, list(method = method, path = path, body = body), fake_session())
  }
  # Resolve the backup root from the fingerprint.
  res <- jsonlite::fromJSON(req("POST", "api/backup/resolve", fingerprint_json(study))$json)
  expect_true(res$resolved)
  expect_equal(res$resolution, "programs-flag")

  # Back up the originals and check the index.
  body <- sprintf('{"rootToken":"%s","directories":[{"folder":"","files":["t-dm.sas"]},{"folder":"adam","files":["adsl.sas"]}]}', res$rootToken)
  out <- req("POST", "api/backup/originals", body)
  expect_equal(out$status, 200L)
  expect_match(out$json, '"index":{"":["t-dm.sas"],"adam":["adsl.sas"]}', fixed = TRUE)
  expect_true(jsonlite::fromJSON(out$json)$datesPreserved)

  # Confirm the backup's date, mode and content match the source.
  backup <- file.path(study$prog, "_migrate_original", "t-dm.sas")
  expect_equal(as.numeric(file.info(backup)$mtime), as.numeric(study$old))
  expect_equal(file.info(backup)$mode, file.info(file.path(study$prog, "t-dm.sas"))$mode)
  expect_equal(unname(tools::md5sum(backup)),
               unname(tools::md5sum(file.path(study$prog, "t-dm.sas"))))

  # Change the source and confirm a second backup skips and keeps the original.
  writeLines("changed", file.path(study$prog, "t-dm.sas"))
  again <- jsonlite::fromJSON(req("POST", "api/backup/originals", body)$json)
  expect_equal(again$skipped, 2L)
  expect_equal(readLines(backup), "proc print; run;")

  # Reset the backup date, then stamp it back through the API.
  Sys.setFileTime(backup, as.POSIXct("2024-01-01", tz = "UTC"))
  stamp_body <- sprintf(
    '{"rootToken":"%s","entries":[{"folder":"","name":"t-dm.sas","lastModified":%.0f}]}',
    res$rootToken, as.numeric(study$old) * 1000)
  stamped <- jsonlite::fromJSON(req("POST", "api/backup/stamp", stamp_body)$json)
  expect_true(stamped$ok)
  expect_equal(stamped$stamped, 1L)
  expect_equal(as.numeric(file.info(backup)$mtime), as.numeric(study$old))
})

# Check that the OS copy helper preserves dates and reports the platform.
test_that("OS copy helper preserves dates and reports platform", {
  study <- make_study()
  expected <- if (.Platform$OS.type == "windows") "windows"
              else if (identical(Sys.info()[["sysname"]], "Linux")) "linux"
              else "unix"
  expect_equal(ms_os_name(), expected)

  src <- file.path(study$prog, "t-dm.sas")
  dst <- file.path(study$prog, "_migrate_original", "t-dm.sas")
  dir.create(dirname(dst), showWarnings = FALSE)
  expect_true(ms_os_copy(src, dst))
  expect_equal(as.numeric(file.info(dst)$mtime), as.numeric(study$old))
})

# Check that copy falls back to R and skips existing backups.
test_that("copy preserving falls back to R and skips existing backups", {
  study <- make_study()
  src <- file.path(study$prog, "t-dm.sas")
  dst <- file.path(study$prog, "_migrate_original", "t-dm.sas")
  dir.create(dirname(dst), showWarnings = FALSE)
  # Force the OS copy to fail and restore it on exit.
  old_ms_os_copy <- ms_os_copy
  assign("ms_os_copy", function(...) FALSE, envir = .GlobalEnv)
  on.exit(assign("ms_os_copy", old_ms_os_copy, envir = .GlobalEnv), add = TRUE)
  first <- ms_copy_preserving(src, dst)
  expect_equal(first$method, "r")
  expect_true(first$datePreserved)
  expect_equal(as.numeric(file.info(dst)$mtime), as.numeric(study$old))

  # Confirm a second copy is skipped.
  second <- ms_copy_preserving(src, dst)
  expect_equal(second$status, "skipped")
})

# Check that unsafe requests are refused.
test_that("unsafe requests are refused", {
  study <- make_study()
  ctx <- new.env(); ctx$cfg <- test_config(study); ctx$py <- NULL
  req <- function(path, body) ms_handle_request(ctx, list(method = "POST", path = path, body = body), fake_session())
  # Reject an unknown token, traversal, bad names and unknown routes.
  expect_equal(req("api/backup/originals", '{"rootToken":"nope","directories":[]}')$status, 403L)
  tok <- jsonlite::fromJSON(req("api/backup/resolve", fingerprint_json(study))$json)$rootToken
  expect_equal(req("api/backup/originals", sprintf('{"rootToken":"%s","directories":[{"folder":"../..","files":["x.sas"]}]}', tok))$status, 400L)
  expect_equal(req("api/backup/originals", sprintf('{"rootToken":"%s","directories":[{"folder":"","files":["../x.sas"]}]}', tok))$status, 400L)
  expect_equal(req("api/backup/stamp", sprintf('{"rootToken":"%s","entries":[{"folder":"","name":"../x.sas","lastModified":1}]}', tok))$status, 500L)
  expect_equal(ms_handle_request(ctx, list(method = "GET", path = "../app.R"), fake_session())$status, 404L)
})

# Check that history append is atomic, de-duplicated and keeps empty keys.
test_that("history append is atomic, de-duplicated and round-trips empty keys", {
  study <- make_study()
  cfg <- test_config(study)
  run <- ms_from_json('{"runId":"r1","index":{"":["a.sas"]},"n":1726000000123,"empty":{},"list":[],"nul":null}')
  expect_equal(ms_native_append_history_run(cfg, run)$runs, 1L)
  expect_true(ms_native_append_history_run(cfg, run)$duplicate)
  back <- jsonlite::fromJSON(cfg$history_file, simplifyVector = FALSE)
  expect_equal(names(back$runs[[1]]$index), "")
  expect_match(paste(readLines(cfg$history_file), collapse = ""), '"n": 1726000000123', fixed = TRUE)
})

# Check that the fingerprint hash matches the Python server byte for byte.
test_that("fingerprint hash matches the Python server byte for byte", {
  fp <- ms_normalize_fingerprint(ms_from_json(
    '{"z\\u00fc":[{"name":"caf\\u00e9.sas","size":1,"lastModified":2}],"A":[{"name":"b.sas","size":3,"lastModified":4.9},{"name":"B.sas","size":3,"lastModified":4}]}'))
  expect_equal(names(fp), c("A", "z\u00fc"))
  expect_equal(vapply(fp$A, `[[`, "", "name"), c("B.sas", "b.sas"))
  hash <- ms_fingerprint_hash("f\u00f6\"x", fp)
  # Compare against the Python implementation when reticulate is available.
  skip_if_not_installed("reticulate")
  skip_if_not(suppressWarnings(reticulate::py_available(initialize = TRUE)))
  ms <- reticulate::import_from_path("migrate_studio", file.path(app_dir, "python"))
  json <- reticulate::import("json")
  body <- json$loads('{"z\\u00fc":[{"name":"caf\\u00e9.sas","size":1,"lastModified":2}],"A":[{"name":"b.sas","size":3,"lastModified":4.9},{"name":"B.sas","size":3,"lastModified":4}]}')
  expect_equal(ms$fingerprint_hash("f\u00f6\"x", ms$normalize_fingerprint(body)), hash)
})

# Check that whoami and backups are loopback-only in browser mode.
test_that("whoami and backups are loopback-only in browser mode", {
  study <- make_study()
  ctx <- new.env(); ctx$cfg <- test_config(study); ctx$py <- NULL
  # Refuse a remote client and accept a local one.
  remote <- list(user = NULL, userData = new.env(),
                 request = list(REMOTE_ADDR = "10.1.2.3"))
  local <- list(user = "jdoe", userData = new.env(),
                request = list(REMOTE_ADDR = "127.0.0.1"))
  expect_equal(ms_handle_request(ctx, list(method = "GET", path = "api/whoami"), remote)$status, 403L)
  who <- ms_handle_request(ctx, list(method = "GET", path = "api/whoami"), local)
  expect_equal(jsonlite::fromJSON(who$json)$userId, "jdoe")
})
