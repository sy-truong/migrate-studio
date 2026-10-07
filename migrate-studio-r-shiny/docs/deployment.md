# Shiny deployment

For desktop use, follow the edition README and keep the default loopback host.
For hosted use, install the dependencies in `DESCRIPTION` and deploy `app.R`,
`R/`, `www/`, `python/`, `rules/`, `docs/`, `CHANGELOG.md`, `LICENSE`, `NOTICE` and
the repository-root `THIRD-PARTY-NOTICES.md` as an ordinary Shiny application.

Configure authentication and HTTPS in your hosting service before exposing the
application. The application supplies no sign-in or per-user filesystem policy.
Run under an account with access only to the intended program folders.

| Environment variable | Example | Purpose |
|---|---|---|
| MIGRATE_STUDIO_ENGINE | r | Use the native R backend |
| MIGRATE_STUDIO_FOLDER_MODE | server | Select files visible to the server |
| MIGRATE_STUDIO_SERVER_ROOTS | /srv/example-programs | Allowlisted program root; separate multiple roots with the OS path separator |
| MIGRATE_STUDIO_DATA_DIR | /srv/migrate-studio-data | Persistent writable history/cache folder outside the deployment bundle |
| MIGRATE_STUDIO_STOP_ON_LOGOUT | false | Close the session without stopping the shared app |
| MIGRATE_STUDIO_PYTHON | configured interpreter path | Optional Python bridge only |

All sessions under a shared account can access the same roots and history.
Use separate accounts/processes and data directories for isolation. Keep shared
history writing in one process: independent processes can overwrite concurrent
updates. Back up program folders outside the app; its write-once originals do
not replace a backup policy. Browser folder access requires a secure browser
context. Server folder mode delegates all reads/writes to the run-as account.
