# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Load the app code and provide shared fixtures for the tests.
app_dir <- normalizePath(file.path(testthat::test_path(), "..", ".."), winslash = "/")
for (f in c("config.R", "api_native.R", "py_bridge.R", "fs_server.R", "api_dispatch.R")) {
  source(file.path(app_dir, "R", f), local = FALSE)
}

# Create a temp study folder with two SAS files at a fixed modification time.
make_study <- function() {
  td <- tempfile("ms-test")
  prog <- file.path(td, "studies", "SOURCE_T")
  dir.create(file.path(prog, "adam"), recursive = TRUE)
  writeBin(charToRaw("data x;\r\n set y;\r\nrun;\r\n"), file.path(prog, "adam", "adsl.sas"))
  writeLines("proc print; run;", file.path(prog, "t-dm.sas"))
  old <- as.POSIXct("2021-03-04 05:06:07", tz = "UTC")
  for (f in c(file.path(prog, "adam", "adsl.sas"), file.path(prog, "t-dm.sas"))) {
    Sys.setFileTime(f, old)
  }
  list(td = td, root = file.path(td, "studies"), prog = prog, old = old)
}

# Build the folder fingerprint JSON that a browser would send.
fingerprint_json <- function(study) {
  entry <- function(path) sprintf('{"name":"%s","size":%d,"lastModified":%s}',
    basename(path), file.info(path)$size,
    format(floor(as.numeric(file.info(path)$mtime) * 1000), scientific = FALSE))
  sprintf('{"folderName":"SOURCE_T","fingerprint":{"":[%s],"adam":[%s]}}',
          entry(file.path(study$prog, "t-dm.sas")),
          entry(file.path(study$prog, "adam", "adsl.sas")))
}

# Load a config that points data and programs at the temp study.
test_config <- function(study, engine = "r") {
  withr_opts <- options(migrate_studio.data_dir = file.path(study$td, "data"),
                        migrate_studio.programs = study$root,
                        migrate_studio.engine = engine)
  cfg <- ms_load_config(app_dir)
  options(withr_opts)
  cfg
}

# Stub a Shiny session that has no user.
fake_session <- function() list(user = NULL, userData = new.env())
