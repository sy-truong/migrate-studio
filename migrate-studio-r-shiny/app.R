# Migrate Studio -- R Shiny edition.
# Migrate Studio
#
# Copyright (c) 2026 Meta-Xceed, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# The page, styles and application logic are the same files the Python server
# served (www/). This app replaces migrate_studio.py's HTTP server:
#   * www/ is served as static files by Shiny;
#   * the page's fetch() calls to api/..., history.json, current_selections.json,
#     the rule book and CHANGELOG.md travel over the Shiny websocket
#     (www/js/mig-shiny-bridge.js) and are answered by R/api_dispatch.R;
#   * the answers come from python/migrate_studio.py (reticulate) or from the
#     R port in R/api_native.R.
#
# Targets R 4.2.3 and shiny 1.12.1. Run with run_migrate_studio.R, or
# shiny::runApp(".") from this folder.

library(shiny)

# Resolve the app folder and load the R helper files.
app_dir <- normalizePath(getOption("migrate_studio.app_dir", getwd()),
                         winslash = "/", mustWork = TRUE)
for (f in c("config.R", "api_native.R", "py_bridge.R", "fs_server.R",
            "api_dispatch.R")) {
  source(file.path(app_dir, "R", f), local = TRUE)
}

# Build the shared context: configuration and the optional Python engine.
ctx <- new.env(parent = emptyenv())
ctx$cfg <- ms_load_config(app_dir)
ctx$py <- ms_py_load(ctx$cfg)
# Serve the docs folder as a static resource.
addResourcePath("docs", file.path(app_dir, "docs"))
# Log the data folder, folder mode, and engine at startup.
message("Migrate Studio: data folder ", ctx$cfg$data_dir,
        " (", ctx$cfg$data_dir_source, ")",
        " | folder mode ", ctx$cfg$folder_mode,
        " | engine ", if (is.null(ctx$py)) "R" else "Python")
# Warn when server mode shares the run-as account's data folder.
if (identical(ctx$cfg$folder_mode, "server") &&
    identical(ctx$cfg$data_dir_source, "os-default")) {
  warning("Server folder mode is using the run-as account's own data folder (",
          ctx$cfg$data_dir, "), which every signed-in user shares. Set ",
          "MIGRATE_STUDIO_DATA_DIR to a persistent folder you manage.",
          call. = FALSE)
}

# Render index.html as a template that carries the folder mode.
ui <- function(req) {
  htmlTemplate(
    file.path(ctx$cfg$www_dir, "index.html"),
    folder_mode = ctx$cfg$folder_mode,
    document_ = TRUE
  )
}

# Forward each browser API message to the dispatcher and send back the reply.
server <- function(input, output, session) {
  observeEvent(input$mig_api, {
    request <- input$mig_api
    reply <- ms_handle_request(ctx, request, session)
    reply$id <- request$id
    session$sendCustomMessage("mig-api-reply", reply)
  }, ignoreNULL = TRUE, ignoreInit = FALSE)
}

# Create the Shiny app.
shinyApp(ui, server)
