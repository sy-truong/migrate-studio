# Changelog

All notable changes to this edition are documented here.

## Unreleased

- Public-release sanitation, setup documentation, bounded workbook/API inputs and security hardening.
- Samples use EXAMPLE identifiers and generic macro names.

## [0.3-beta] - 2026-09-21

- **User data now defaults to the per-user app data folder.** The R Shiny edition keeps `history.json`, `current_selections.json` and `backup_roots.json` under the OS user data location by default, with `--data-dir` / `MIGRATE_STUDIO_DATA_DIR` overrides.
- **Legacy history import.** Run `Rscript run_migrate_studio.R --import-legacy-history [PATH]` once to merge an older app-local `history.json` into the current data folder.
- **"Select All" relabeled.** The left-panel program-selection toggle is now labeled **Select All**, and its second state is **Deselect All** — previously labeled **Select** and **Unselect All**.
- **New in-app User Manual.** Added `docs/user_manual.html`, linked from the file menu's new **User Manual** item.

## [0.2-beta] - 2026-09-16

### New: in-place updates with automatic backups

- **Apply Fix now writes in place.** Fixed programs are written straight back over the live `.sas` files in the folder you picked, so the usual path is already on disk when Apply Fix finishes.
- **Write-once backups in `_migrate_original/`.** On the first in-place run for a folder, Migrate Studio creates a `_migrate_original/` subfolder inside every directory that directly contains `.sas` programs. It copies that directory's programs there before overwriting anything. Backup files are written once and never overwritten.
- **Original modified dates are kept.** When the local server can identify the selected folder on disk, it makes the backup copies itself, so they keep the modified dates the programs had before migration. `--programs <path>` tells the server where to look first.
- **Browser fallback.** If the folder can't be identified, Apply Fix still runs and the browser makes the same write-once backups. Those copies carry today's date.
- **Already-fixed programs are skipped.** A program with a backup marker or an in-place Apply Fix history record is left alone. If every target is already fixed, no files change.
- **Revert restores from the backup.** Revert copies the program back from the `_migrate_original/` folder beside it, records the action, and clears the backup marker so Apply Fix can run on it again.
- **Save is now mostly for restored versions**, since Apply Fix has already written the fix.

### Improvements

- **Fix Compare: "1 modified" is now a jump link.** When a program has exactly one modified line, the Previous/Next buttons stay hidden, and the `1 modified` count becomes a link instead. Clicking it, or pressing Enter or Space on it, centres the modified line in the Fixed pane, and the Original pane follows. The `N` / `P` shortcuts also work with a single change.
- **Update Summary workbook: Rules sheet descriptions filled in.** Manual-logic findings such as `L-032`, `L-034` and `L-035` now show a description. Descriptions come from the rule book's Rules sheet first, then its Logic Changes sheet, then the app's built-in text. Any rule with no description anywhere is labelled as such instead of left blank.
