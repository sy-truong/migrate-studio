# Per-user data folder: OS defaults, overrides, legacy import.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0

# Fake an environment-variable lookup from named values.
env_of <- function(...) {
  values <- list(...)
  function(name) if (is.null(values[[name]])) "" else values[[name]]
}

# Check the OS default data folders for Windows, macOS and Linux.
test_that("OS defaults follow the per-user app data conventions", {
  expect_equal(ms_default_data_dir("Windows",
                 env_of(LOCALAPPDATA = "C:/Users/testuser/AppData/Local"),
                 "C:/Users/testuser/Documents"),
               "C:/Users/testuser/AppData/Local/Migrate Studio")
  expect_equal(ms_default_data_dir("Windows",
                 env_of(USERPROFILE = "C:/Users/testuser"),
                 "C:/Users/testuser/Documents"),
               "C:/Users/testuser/AppData/Local/Migrate Studio")
  expect_equal(ms_default_data_dir("Darwin", env_of(), "/Users/testuser"),
               "/Users/testuser/Library/Application Support/Migrate Studio")
  expect_equal(ms_default_data_dir("Linux", env_of(XDG_DATA_HOME = "/data/xdg"),
                                   "/home/testuser"),
               "/data/xdg/Migrate Studio")
  expect_equal(ms_default_data_dir("Linux", env_of(XDG_DATA_HOME = "relative"),
                                   "/home/testuser"),
               "/home/testuser/.local/share/Migrate Studio")
  expect_equal(ms_default_data_dir("Linux", env_of(), "/home/testuser"),
               "/home/testuser/.local/share/Migrate Studio")
})

# Check that the R option overrides MIGRATE_STUDIO_DATA_DIR.
test_that("option beats MIGRATE_STUDIO_DATA_DIR", {
  # Save the current setting and restore it on exit.
  old_env <- Sys.getenv("MIGRATE_STUDIO_DATA_DIR", unset = NA)
  old_opt <- getOption("migrate_studio.data_dir", NULL)
  on.exit({
    if (is.na(old_env)) Sys.unsetenv("MIGRATE_STUDIO_DATA_DIR")
    else Sys.setenv(MIGRATE_STUDIO_DATA_DIR = old_env)
    options(migrate_studio.data_dir = old_opt)
  }, add = TRUE)

  # Confirm the environment variable applies, then the option wins.
  Sys.setenv(MIGRATE_STUDIO_DATA_DIR = "/tmp/new")
  options(migrate_studio.data_dir = NULL)
  expect_equal(ms_resolve_data_dir(), "/tmp/new")
  options(migrate_studio.data_dir = "/tmp/opt")
  expect_equal(ms_resolve_data_dir(), "/tmp/opt")
})

# Check that config points all three data files at the data folder.
test_that("ms_load_config points all three files at the data folder", {
  # Point the data folder at a temp location.
  td <- tempfile("ms-data-dir")
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  old_opt <- getOption("migrate_studio.data_dir", NULL)
  options(migrate_studio.data_dir = file.path(td, "a", "Migrate Studio"))
  on.exit(options(migrate_studio.data_dir = old_opt), add = TRUE)

  # Confirm the folder exists and holds the three files.
  cfg <- ms_load_config(app_dir)
  expect_true(dir.exists(cfg$data_dir))
  expect_equal(basename(cfg$data_dir), "Migrate Studio")
  expect_equal(cfg$data_dir_source, "option")
  expect_equal(cfg$history_file, file.path(cfg$data_dir, "history.json"))
  expect_equal(cfg$selection_file, file.path(cfg$data_dir, "current_selections.json"))
  expect_equal(cfg$backup_cache, file.path(cfg$data_dir, "backup_roots.json"))
})

# Check that legacy import merges, de-duplicates and leaves the source untouched.
test_that("legacy import merges, dedupes, is repeatable and leaves the source alone", {
  # Write a legacy file containing a duplicate run.
  td <- tempfile("ms-history-import")
  dir.create(td, recursive = TRUE)
  on.exit(unlink(td, recursive = TRUE), add = TRUE)
  legacy <- file.path(td, "old.json")
  target <- file.path(td, "new", "history.json")
  writeLines('{"runs":[{"runId":"r1","appliedAt":"2026-01-01"},
                       {"runId":"r0","appliedAt":"2025-12-01"},
                       {"runId":"r0","appliedAt":"2025-12-01"}]}', legacy)
  before <- readLines(legacy)

  # Import and confirm the counts and the run order.
  res <- ms_import_legacy_history(legacy, target)
  expect_true(res$ok)
  expect_equal(res$imported, 2L)
  expect_equal(res$skipped, 1L)
  runs <- jsonlite::fromJSON(target, simplifyVector = FALSE)$runs
  expect_equal(vapply(runs, `[[`, "", "runId"), c("r0", "r1"))
  # Confirm a repeat import adds nothing and a missing source fails.
  expect_equal(ms_import_legacy_history(legacy, target)$imported, 0L)
  expect_identical(readLines(legacy), before)
  expect_false(ms_import_legacy_history(file.path(td, "missing.json"), target)$ok)
})
