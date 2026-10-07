#!/usr/bin/env Rscript
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
# Install declared application dependencies in a user-selected R library.
# Locate the app folder from the script path.
args <- commandArgs(FALSE)
script <- sub("^--file=", "", grep("^--file=", args, value = TRUE)[1])
app <- normalizePath(file.path(dirname(script), ".."))
# Read Imports, plus Suggests with --dev, from DESCRIPTION.
desc <- read.dcf(file.path(app, "DESCRIPTION"))
fields <- c("Imports", if ("--dev" %in% commandArgs(TRUE)) "Suggests")
# Strip version constraints to get package names.
packages <- trimws(gsub("\\s*\\([^)]*\\)", "", unlist(strsplit(paste(desc[1, fields], collapse = ","), ","))))
# Install the packages from CRAN.
install.packages(packages, repos = "https://cloud.r-project.org")
