# Changelog

All notable changes to this edition are documented here.

## Unreleased

- Public-release sanitation, setup documentation, bounded workbook/API inputs and security hardening.
- Samples use EXAMPLE identifiers and generic macro names.

## [0.3-beta] - 2026-09-21

- **"Select All" relabeled.** The left-panel program-selection toggle is now labeled **Select All**, and its second state is **Deselect All** — previously labeled **Select** and **Unselect All**.
- **New in-app User Manual.** Added `docs/user_manual.html`, linked from the file menu's new **User Manual** item.

## [0.2-beta] - 2026-09-16

### New: in-place updates with automatic backups

- **Apply Fix now writes in place.** Updated programs are written straight back over the live `.sas` files in the folder you picked, and each run records a version.
- **Write-once backups in `_migrate_original/`.** Before the first in-place run, every directory that directly contains `.sas` programs gets its own `_migrate_original/` subfolder. Migrate Studio copies that directory's programs into it byte-for-byte before writing anything. Backups are flat and sit beside the programs they protect. For example, `adam/adsl.sas` is backed up as `adam/_migrate_original/adsl.sas`. Each backup file is written once and never overwritten.
- **Original modified dates are kept.** When the local server can resolve the folder path, it makes the backup copies itself, so they keep the modified dates the programs had before migration. `--programs <path>` names study roots up front so they are found immediately.
- **Browser fallback.** If the server can't resolve the path, the browser still creates the backups and Apply Fix continues. Those copies carry today's date.
- **Already-fixed programs are skipped.** A program that already has a backup copy, or an in-place Apply Fix run in History, is left alone. If every target is already fixed, no files are written.
- **Revert restores from the backup.** Revert copies the live program back from the `_migrate_original/` folder beside it, removes that program's backup marker, and records the revert as a version, so the fixed copy is still in the history.
- **Save** writes the current fixed or restored text back to the live files. In read-only fallback mode, it downloads the updated programs instead.

### Improvements

- **Fix Compare: "1 modified" is now a jump link.** When a program has exactly one modified line, the Previous/Next buttons stay hidden, and the `1 modified` count becomes a link instead. Clicking it, or pressing Enter or Space on it, centres the modified line in the Fixed pane, and the Original pane follows. The `N` / `P` shortcuts also work with a single change.
- **Update Summary workbook: Rules sheet descriptions filled in.** Manual-logic findings such as `L-032`, `L-034` and `L-035` now show a description. Descriptions come from the rule book's Rules sheet first, then its Logic Changes sheet, then the app's built-in text. Any rule with no description anywhere is labelled as such instead of left blank.
- **History is stored per user.** `history.json`, `current_selections.json` and `backup_roots.json` now live in the per-user Migrate Studio data folder printed when the app starts, instead of beside the application files. Use `--data-dir` or `MIGRATE_STUDIO_DATA_DIR` to choose another location, and `--import-legacy-history` to copy runs from an older app-folder `history.json`.
