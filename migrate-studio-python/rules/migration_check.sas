/*************************************************************************
 * STUDY DRUG:        ALL
 * PROTOCOL NO:       ALL
 * COPYRIGHT:         Copyright (c) 2026 Meta-Xceed, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * DATE CREATED:      04/23/2026
 * PROGRAM NAME:      MIGRATION_CHECK.SAS
 * DESCRIPTION:       Macro used to scan SAS programs for migration issues
 *                    based on configured migration rules.
 * DATA SETS USED:    Work Area Datasets: RULE_DEF, CRITERIA_DEF, MC_PGMLIST, MIGRATION_CHECK
 * GLOBAL MACRO VARS: _MC_UI, _MC_T0 (progress-display environment and start time).
 * INPUT FILES:       Folder containing .sas programs to be reviewed.
 * PARAMETER:         MC_PGMPATH (REQUIRED) - Root folder containing *.sas files.
 *                    All subfolders under MC_PGMPATH are scanned recursively.
 *                    MC_OUTSUM  (REQUIRED) - Full path and file name for
 *                    output Excel workbook (.xlsx).
 *                    MC_UPDATE  (OPTIONAL) - N/No/Y/Yes. When Y/Yes,
 *                    creates an archive subfolder beside each source program
 *                    when needed, saves a dated backup such as
 *                    archive/ae_20260813.sas, preserves the source program's
 *                    original last-modified timestamp on the backup, then updates
 *                    the original source program in place. Existing same-day
 *                    backups are preserved by adding _2, _3, and so on.
 *                    MC_LOGLEVEL (OPTIONAL) - PROGRAM/RULE/NONE. Default PROGRAM.
 *                    PROGRAM writes one progress line per scanned program. RULE
 *                    also writes roughly 30 rule-status lines per program and is
 *                    intended for small folders or troubleshooting, not full-
 *                    directory runs. NONE suppresses staged progress output.
 *                    MIGRATION_CHECK remains in WORK after completion. When
 *                    chaining multiple invocations, copy or drop it between calls
 *                    if the prior findings are no longer required.
 *
 * EXAMPLE CALL:
 * %MIGRATION_CHECK (
 *    MC_PGMPATH=./example-programs,
 *    MC_OUTSUM=./example-programs/v_migration_check.xlsx,
 *    MC_UPDATE=N,
 *    MC_LOGLEVEL=PROGRAM,
 *    MC_TOCFILES=study_toc.xlsx toc.xlsx
 * );
 *************************************************************************
 PROGRAM MODIFICATION LOG
 *************************************************************************
 Date:        04/29/2026
 Description: Added Rule S1 update mode to replace &_SASPROGRAMFILE with %sysget(SAS_EXECFILEPATH) and document changes in Update Details.

 Date:        04/29/2026
 Description: Added Rule F1 update mode to correct configured TOC workbook filename casing by searching within MC_PGMPATH and documenting changes in Update Details.

 Date:        04/29/2026
 Description: Enhanced Rule F2 folder-name casing updates so the folder case map explicitly includes all recursively discovered subfolder path segments, allowing nested references such as \TLF or /TLF to be corrected. Enhanced Rule F3 update logic to comment out OPTIONS lines containing XSYNC, NOXSYNC, XWAIT, NOXWAIT, XCMD, or NOXCMD for Linux compatibility. Enhanced Rule F4 update logic to comment lines containing more than seven backslashes, excluding common RTF markup controls. Added Rule O1 update logic to replace X/SYSTASK CD commands with a dlgcdir() block and comment the original shell command.

 Date:        04/30/2026
 Description: Added Rule O1 update mode to insert a dlgcdir() replacement block above X/SYSTASK CD commands, comment the original shell command, and document the change in Update Details.

 Date:        04/30/2026
 Description: Refined Rule O1 so SYSTASK COMMAND="CD ..." is processed before generic X "CD ..." logic and only one dlgcdir() replacement block is inserted per source line.

 Date:        04/30/2026
 Description: Added Rule O2 update mode to replace %sysget(USERNAME) with %sysget(USER) and document changes in Update Details.

 Date:        04/30/2026
 Description: Fixed Rule O2 SAS syntax error caused by semicolon inside statement-style comment and constructs literal %sysget(USER) replacement safely at run time.

 Date:        04/30/2026
 Description: Added Rule O3 update mode to wrap FILENAME _ALL_; with _GSFNAME save and restore logic and document changes in Update Details.

 Date:        04/30/2026
 Description: Fixed Rule O3 DATA step comments by removing semicolons from statement-style comments to avoid ERROR 180-322.

 Date:        04/30/2026
 Description: Updated Rule O3 inserted code to preserve _GSFNAME fileref using pathname and restore via call execute.

 Date:        04/30/2026
 Description: Added Rule O6 update mode to comment X COPY commands, parse source and destination file paths, insert FILENAME/FCOPY replacement logic, and document changes in Update Details.

 Date:        05/01/2026
 Description: Added Rule L3 update mode to comment Windows DEL commands, replace DEL with rm -f for Linux/target platform compatibility, and document changes in Update Details.

 Date:        05/01/2026
 Description: Added Rule O5 update mode to insert OPTIONS VALIDVARNAME=V7 before Excel PROC IMPORT statements when .xlsx or DBMS=XLSX is found on the PROC IMPORT line or within the next two lines, and document changes in Update Details.

 Date:        05/01/2026
 Description: Retired Rule S6 because PROC IMPORT fileref conversion is no longer required. Commented out S6 rule-list definitions and disabled S6 program-level finding output.

 Date:        04/30/2026
 Description: Enhanced Rule O6 parser to greedily capture the full COPY command payload before parsing doubled-quoted source and destination paths, preserving spaces in path names.

 Date:        05/01/2026
 Description: Updated program update mode to be operating-system aware. Windows keeps updated copies under migrate_output while preserving the source folder structure. Linux updates the current source program in place without creating a backup copy.

 Date:        05/02/2026
 Description: Updated Windows program update mode so each source folder containing SAS programs gets its own migrate_output subfolder, and updated SAS programs are written beside their source folder instead of under the top-level MC_PGMPATH migrate_output folder.

 Date:        05/03/2026
 Description: Fixed O6 statement-style comments by removing doubled quotation mark examples that caused SAS parser messages in the log.

 Date:        05/03/2026
 Description: Refactored recursive file discovery to build one consolidated MC_ALL_FILES inventory from a single OS-level pipe crawl starting three parent levels above MC_PGMPATH. Derived MC_PGMLIST, MC_TOC_CASEMAP, and MC_FOLDER_CASEMAP from that inventory, replaced the F2 line-level folder-case check with the consolidated map instead of repeated dopen calls, and initialized TOC macro variables and empty output datasets to reduce log messages.

 Date:        06/27/2026
 Description: Added Rule S7 to compare SAS autocall macros that exist in both the purpose-level /modules folder and the remaining global /modules folders from SASAUTOS. S7 reports line-level differences between matching macro files in the Excel output.

 Date:        07/02/2026
 Description: Renamed the main detail worksheet to Migration Check Details and the S7 worksheet to Global Macro Details. Corrected missing ODS EXCEL OPTIONS closing syntax so subsequent reports are written to their intended worksheets instead of creating auto-numbered Migration Check Detail sheets.

 Date:        07/24/2026
 Description: Added Rule F5 to identify duplicate case-insensitive SAS program filenames across multiple locations within the same purpose folder immediately below STAT. Added Rule F6 to identify programs in archive/date-named folders and same-folder alternate program copies whose names differ only by an appended number or one- or two-letter initials. Added both rules to the Rules List worksheet and program-level findings.

 Date:        07/25/2026
 Description: Standardized MC_PGMLIST.PGM_NAME to length $256, matching MC_ALL_FILES.FILE_NAME and downstream migration-check datasets, to eliminate the multiple-length warning and prevent inconsistent PDV definitions.

 Date:        07/25/2026
 Description: Added NOWARN to the final PROC DATASETS cleanup because several temporary S7 and update-mode datasets are created conditionally. This suppresses harmless member-not-found notes during cleanup without affecting migration findings or the Excel output.

 Date:        07/25/2026
 Description: Enhanced Rule S7 to parse single-quoted, double-quoted, and unquoted SASAUTOS entries. Updated Rule O4 to require an actual standard percent-sign SETUP macro invocation only when the scanned program is processed on Linux; Windows runs do not perform this check.

 Date:        07/25/2026
 Description: Changed recursive file discovery so MC_PGMPATH is the exact crawl root. The macro now reviews every SAS program located directly in MC_PGMPATH and in all descendant subfolders, logs the recursive scan scope and each program scanned, and no longer crawls parent folders above MC_PGMPATH.

 Date:        07/27/2026
 Description: Added Rule S5 backslash classification so RTF control words such as \brdrb,
              \brdrs, and \brdrw4, FORMCHAR values, and ODS ESCAPECHAR definitions are
              reported as no-action findings rather than Windows paths. Applied the same
              guard to the S5 update logic so RTF markup is no longer converted to forward
              slashes. Shortened the Rule F6 description to eliminate the SAS 262-character
              quoted-string NOTE. Added a folder-derived purpose fallback and explicit log
              warnings to Rule F5 when no stat folder is present. Added suppression of
              numbered program series and a confidence level with a stated basis to Rule F6B.
              Enabled CHAR compression within the macro, completed the WORK cleanup list, and
              added defensive ODS and fileref resets at macro entry to support repeated calls
              within one session.

 Date:        07/28/2026
 Description: Consolidated Rule S5 backslash classification into a single shared
              MC_S5_CLASSIFY helper used by both the detection step and the update
              step, so the Excel finding and the updated program can no longer
              disagree. Removed the backslash, underscore, hyphen, and asterisk from
              the RTF escape character class, which had prevented conversion of UNC
              paths and of paths containing those characters. Added relative-path
              recognition so references such as ..\output and &pgmpath\setup.sas are
              detected and converted again. Corrected the stale fileref test to use
              the negative FILEREF return value and to check the release return code.
              Moved the WORK cleanup block after the exit label so it runs on every
              exit path. Preserved the callers ODS LISTING state instead of opening
              it unconditionally. Separated STAT-derived and folder-derived F5
              purposes so mixed tree shapes cannot be grouped together.

 Date:        08/01/2026
 Description: Added MC_LOGLEVEL-controlled progress reporting with percent complete,
              step counts, elapsed time, per-program status, optional per-rule
              status, S7 comparison progress, and Display Manager log scrolling.
              Macro debug options are temporarily suppressed and restored so the
              progress display remains readable.

 Date:        08/01/2026
 Description: Corrected progress-message macro quoting, removed the late step-zero
              reset, hardened total validation, included program-level special
              findings in RULE counts, and resolved generated rule totals before
              CALL EXECUTE processing.

 Date:        08/01/2026
 Description: Expanded SASAUTOS fileref entries before locating S7 /modules paths.
              Corrected S5 absolute- and relative-path PRX character classes by
              representing dollar, ampersand, and percent with hexadecimal escapes,
              preventing unsupported Perl variable-token interpretation.

 Date:        08/01/2026
 Description: Moved the program-inventory completion progress line to immediately
              after the final MC_FOLDER_CASEMAP DATA step. The progress status now
              follows the SAS notes generated while the folder case map is read and
              finalized, instead of appearing before that potentially lengthy work.

 Date:        08/01/2026
 Description: Refined client detection to distinguish Display Manager, Enterprise
              Guide, SAS Studio, and batch execution. Added a half-second pause after
              each primary progress status in Display Manager or Enterprise Guide so
              the completed line has time to render before processing continues.

 Date:        08/01/2026
 Description: Added separator lines immediately before and after each primary
              MIGRATION_CHECK progress status. The trailing separator keeps the
              status message above the bottom edge of the log window so completion
              text remains visible in Display Manager and other clients.

 Date:        08/02/2026
 Description: Rule O2 no longer flags the automatic macro variable &SYSUSERID,
              which resolves correctly on both Windows and Linux. Detection is now
              limited to %SYSGET(USERNAME).

 Date:        08/02/2026
 Description: Retired Rule F4 (More 7 levels Folder). The target server supports
              folder structures deeper than seven levels, so the depth check no
              longer applies. Detection logic, update logic, and the Rules List
              entry are disabled by the mc_rule_f4_enabled toggle, which is set
              to N.

 Date:        08/09/2026
 Description: Added a three-line WIN context exemption for Rules F3, O1, and L1.
              When any of the one, two, or three source lines immediately above
              a candidate finding contains "WIN" or 'WIN' (case-insensitive),
              the candidate is treated as passed and is not reported. Applied
              the same exemption to F3 and O1 update mode to prevent passed lines
              from being modified when MC_UPDATE=Y.

 Date:        08/09/2026
 Description: Updated Rule S5 so lines whose first nonblank characters are /*
              are treated as comments and passed without an S5 finding. The same
              exemption is applied by the shared MC_S5_CLASSIFY helper, so S5
              update mode also leaves those comment lines unchanged.

 Date:        08/10/2026
 Description: Simplified Rule S5 path detection. A non-comment source line is
              considered a Windows path only when it contains C:\, D:\, E:\,
              F:\, G:\, H:\, two consecutive backslashes, .\, or ..\.
              All other backslash usage is treated as passed and is not reported
              or converted by S5 update mode.

 Date:        08/11/2026
 Description: Corrected Migration Check Summary source identification and line
              number presentation. Summary rows are now sorted by full program
              path before physical source line number and include Program Path,
              preventing findings from same-named programs in different folders
              from being interleaved and appearing to have incorrect line numbers.

 Date:        08/12/2026
 Description: Updated Rule S5 so any source line containing PRXCHANGE, in any
              letter case, is treated as passed and is not reported as a Windows
              path finding. Because the shared MC_S5_CLASSIFY helper is used by
              both detection and update mode, those lines are also left unchanged
              when MC_UPDATE=Y.

 Date:        08/13/2026
 Description: Updated MC_UPDATE=Y processing to protect each source program before
              an in-place update. The macro creates an archive subfolder beside
              the source program when needed, copies the original program to a
              dated backup such as ae_20260813.sas, preserves an existing same-day
              backup by adding _2, _3, and so on, and then updates the original
              program in place. The backup is created with FCOPY using binary
              record mode so the original file contents are preserved.

 Date:        08/13/2026
 Description: Updated archive backup creation to retain the source program's
              original last-modified timestamp. Windows uses ROBOCOPY /COPY:DAT
              through a temporary staging folder and then moves the staged file
              to the dated backup name. Linux uses cp -p directly to the dated
              backup path. The original program is updated only after the
              timestamp-preserving backup succeeds.

 Date:        08/13/2026
 Description: Corrected MC_UPDATE timestamp-preserving backup comments that used
              unmatched apostrophes inside SAS statement-style comments. Replaced
              those comments with block comments so SAS does not enter an unterminated
              quoted-string state or report a downstream unmatched %END error.

 Date:        08/13/2026
 Description: Corrected Windows archive backup cleanup by removing use of the
              unsupported DDELETE function. Empty temporary ROBOCOPY staging folders
              are now removed with CMD /C RMDIR. Backup success is retained even
              if cleanup of the temporary folder is unsuccessful.

 Date:        08/13/2026
 Description: Added temporary NOXWAIT and XSYNC settings around Windows archive
              backup commands. NOXWAIT prevents the command shell from remaining
              open at a prompt after each command completes, while XSYNC keeps the
              backup synchronous so success can be verified before the source program
              is updated. The caller's original XWAIT and XSYNC settings are restored
              immediately after backup processing.

 Date:        08/13/2026
 Description: Corrected Windows MC_UPDATE archive backup processing. Removed the
              temporary .mc_migration_tmp_* staging-folder design and ROBOCOPY/MOVE
              sequence. Windows now uses COPY /B /Y to copy the source program directly
              to the final dated archive filename while retaining the source file
              modification timestamp. NOXWAIT/XSYNC remain in effect during the
              synchronous backup. Corrected GETOPTION calls used to save XWAIT and
              XSYNC settings. Linux continues to use cp -p.

 Date:        08/13/2026
 Description: Corrected Windows archive backup copy failure reported as XCOPY RC=4.
              Replaced the XCOPY pipe/prompt logic with the Windows built-in
              COPY /B /Y command, copying directly to the final dated backup name.
              Added post-copy validation of backup existence, nonzero size, source
              versus backup byte count, and source versus backup Last Modified
              timestamp before the original program can be updated. Linux continues
              to use cp -p with the same post-copy validation.

 Date:        08/13/2026
 Description: Corrected archive backup command construction on both Windows and
              Linux. CATS stripped the required command-token spaces, causing
              COPY and cp -p to receive malformed command strings. Replaced those
              constructions with CATX using a single blank delimiter. The fully
              resolved backup command is now written to the SAS log before SYSTEM
              executes it. Shell output is captured to a temporary diagnostic file
              and the first nonblank shell message is included in the failure
              message. Post-copy size and Last Modified validation remains required
              before the original program can be updated.


 Date:        08/14/2026
 Description: Corrected Rule F2 folder-case validation. Folder casing is now
              verified against the physical file system with DOPEN/DREAD rather
              than trusting the casing returned in the recursive crawl or the
              casing supplied in MC_PGMPATH. Folder keys found with more than one
              physical casing under the scan root are treated as ambiguous and
              excluded from automatic F2 findings and updates instead of selecting
              an arbitrary first match.

 Date:        08/14/2026
 Description: Corrected Rule F2 so folder casing is resolved in path context
              against the exact physical parent directory referenced by the
              source program. Removed the global folder-name-only lookup from
              F2 detection and update decisions, which could incorrectly apply
              casing from an unrelated same-named folder elsewhere in the scan
              tree (for example changing a physical Sandbox\TLF reference to
              lowercase because another physical tlf folder existed). F2 now
              uses DOPEN/DREAD on the referenced parent path and updates only
              when that exact physical directory confirms a different casing.
              If the physical parent cannot be resolved, F2 does not guess or
              modify the source text.

 Date:        08/14/2026
 Description: Corrected JMSCAN fileref lifecycle and Rule F2 string parsing.
              JMSCAN is now deassigned exactly once immediately after the source
              program is read into _MC_SRC_LINES, eliminating the warning
              "No logical assign for filename JMSCAN." Removed later duplicate
              JMSCAN CLEAR statements. Rule F2 now searches only the meaningful
              portion of fixed-length parser variables instead of their padded
              blanks, and uses SUBSTRN for boundary-safe extraction. This
              prevents FINDC from returning position 32767 on padded blanks and
              eliminates "Invalid second argument to function SUBSTR" notes.
              Obsolete F2 variables were removed and F4-only path variables are
              explicitly initialized to avoid uninitialized-variable notes.
              F2 also skips SAS comment lines so ordinary comment text containing
              slash characters is not parsed as a physical folder reference.

 Date:        08/15/2026
 Description: Refined MC_UPDATE archive protection so the immediate folder
              containing each SAS program is checked before an archive backup
              subfolder is created. If that current folder name contains the
              word archive in any letter case, the program remains scan-only
              and no nested archive subfolder or in-place update is performed.

 Date:        08/15/2026
 Description: Added Windows-only XMIN handling for SYSTEM() command execution.
              Before Windows SYSTEM() calls, the macro saves the caller's XMIN,
              XWAIT, and XSYNC settings and temporarily applies XMIN NOXWAIT
              XSYNC so command windows start minimized, do not remain open at a
              prompt, and complete synchronously. The original settings are
              restored immediately after command processing. Linux behavior is
              unchanged.


 Date:        08/27/2026
 Description: Error-correction release 4.30. Converted two newly added SAS
              statement-style comments that contained internal semicolons to
              block comments so the semicolon cannot terminate the comment
              early and cause ERROR 180-322. Also initialized
              MC_SETUP_SCAN_LINE before the platform-specific SETUP scan to
              prevent the Windows-only uninitialized-variable note.

 Date:        08/27/2026
 Description: Performance optimization release 4.29. Preserved migration-rule
              results and update behavior while reducing repeated work: source
              look-ahead data are built once and reused for findings; whole-file
              setup/CHMOD/VALIDVARNAME flags are collected during the initial
              source read; the redundant generic CRITERIA_DEF POINT= loop is
              removed because active line-level rules use explicit logic; Rule
              L4 first gates on non-ASCII bytes; Rule S5 uses one precomputed
              uppercase line plus a no-backslash fast path; Rule F2 caches exact-
              parent directory lookups within each program; per-file append
              staging datasets are removed; Windows SYSTEM options are saved and
              applied once per run; and F6 filters prefix-incompatible stems
              before candidate-pair materialization.
*************************************************************************/

/*************************************************************************
 * MC_S5_CLASSIFY
 * Classifies one source line for Rule S5 using explicit Windows-path
 * indicators only.
 *
 * PASS / no finding:
 *   - First nonblank characters are /*
 *   - Line contains PRXCHANGE in any letter case
 *   - No configured Windows-path indicator is present
 *
 * PATH / failed finding:
 *   - C:\, D:\, E:\, F:\, G:\, or H:\ (case-insensitive)
 *   - two consecutive backslashes (UNC-style reference)
 *   - .\ or ..\ relative-path indicator
 *
 * _IN  = character variable holding the line to classify.
 * _OUT = character variable ($10); PATH means fail, blank means pass.
 *************************************************************************/

%macro MC_S5_CLASSIFY(_IN=, _UP=, _OUT=);
   &_OUT = '';

   /* Fast pass: every configured S5 path indicator contains a backslash. */
   if index(&_IN, '\') = 0 then &_OUT = '';

   /* Lines beginning with a block-comment opener are always passed. */
   else if prxmatch('/^\s*\/\*/', &_IN) then &_OUT = '';

   /* PRXCHANGE is cross-platform SAS logic. Any line containing it is */
   /* excluded from S5 regardless of letter case. _UP is calculated once. */
   else if index(&_UP, 'PRXCHANGE') > 0 then &_OUT = '';

   else do;
      if index(&_UP, 'C:\') > 0 or
         index(&_UP, 'D:\') > 0 or
         index(&_UP, 'E:\') > 0 or
         index(&_UP, 'F:\') > 0 or
         index(&_UP, 'G:\') > 0 or
         index(&_UP, 'H:\') > 0 or
         index(&_IN, '\\') > 0 or
         index(&_IN, '..\') > 0 or
         index(&_IN, '.\') > 0 then
         &_OUT = 'PATH';
      else &_OUT = '';
   end;
%mend MC_S5_CLASSIFY;

/*************************************************************************
 * Progress-display helpers.
 *************************************************************************/
%macro MC_LOG_ENV;
   %global _mc_ui _mc_t0;
   %let _mc_ui = BATCH;

   /* Display Manager is identified from SYSPROCESSNAME. */
   %if %symexist(sysprocessname) %then %do;
      %if %index(%upcase(%superq(sysprocessname)),DMS) > 0
       or %index(%upcase(%superq(sysprocessname)),DISPLAY MANAGER) > 0 %then
         %let _mc_ui = DMS;
   %end;

   /* Distinguish Enterprise Guide from SAS Studio before enabling the pause. */
   %if "&_mc_ui" ne "DMS" %then %do;
      %if %symexist(_CLIENTAPP) %then %do;
         %if %index(%upcase(%superq(_CLIENTAPP)),ENTERPRISE GUIDE) > 0 %then
            %let _mc_ui = EG;
         %else %if %index(%upcase(%superq(_CLIENTAPP)),SAS STUDIO) > 0
              or %index(%upcase(%superq(_CLIENTAPP)),STUDIO) > 0 %then
            %let _mc_ui = STUDIO;
      %end;
      /* Older EG sessions might not create _CLIENTAPP. */
      %else %if %symexist(sysprocessname) %then %do;
         %if %index(%upcase(%superq(sysprocessname)),OBJECT SERVER) > 0 %then
            %let _mc_ui = EG;
      %end;
   %end;

   %let _mc_t0 = %sysfunc(datetime());
%mend MC_LOG_ENV;

%macro MC_LOG_BOTTOM;
   %if "&_mc_ui" = "DMS" %then %do;
      dm "log; bottom;";
   %end;
%mend MC_LOG_BOTTOM;

%macro MC_LOG_PAUSE;
   %local mc_sleep_rc;
   %if %symexist(_mc_ui) %then %do;
      %if "%upcase(%superq(_mc_ui))" = "DMS"
       or "%upcase(%superq(_mc_ui))" = "EG" %then %do;
         /* 500 milliseconds: 500 units multiplied by .001 second. */
         %let mc_sleep_rc = %sysfunc(sleep(500,.001));
      %end;
   %end;
%mend MC_LOG_PAUSE;

%macro MC_PROGRESS(step=, total=, message=, width=20, prefix=MIGRATION_CHECK);
   %local pct filled empty bar i elapsed;
   %if %sysevalf(%superq(total)=,boolean) %then %let total = 1;
   %else %if %sysfunc(notdigit(%superq(total))) > 0 %then %let total = 1;
   %else %if &total = 0 %then %let total = 1;
   %let pct    = %sysfunc(round(%sysevalf((&step / &total) * 100), 1));
   %let filled = %sysfunc(floor(%sysevalf((&step / &total) * &width)));
   %if &filled > &width %then %let filled = &width;
   %let empty  = %eval(&width - &filled);
   %let bar    =;
   %do i = 1 %to &filled; %let bar = &bar.#; %end;
   %do i = 1 %to &empty;  %let bar = &bar.-; %end;
   %let elapsed = %sysfunc(round(%sysevalf(%sysfunc(datetime()) - &_mc_t0), 1));

   /* Frame primary status lines so the trailing separator keeps the message */
   /* above the bottom edge of Display Manager and other log windows.       */
   %if "%upcase(%superq(prefix))" = "MIGRATION_CHECK" %then %do;
      %put *************************************************************;
   %end;
   %put NOTE: [&prefix] [&bar] &pct.%str(%%) - &step of &total - &elapsed.s - %superq(message);
   %if "%upcase(%superq(prefix))" = "MIGRATION_CHECK" %then %do;
      %put *************************************************************;
   %end;

   %MC_LOG_BOTTOM;
   /* Pause only for the primary completion/program status, not RULE or S7 detail bars. */
   %if "%upcase(%superq(prefix))" = "MIGRATION_CHECK" %then %MC_LOG_PAUSE;
%mend MC_PROGRESS;

%macro MC_STEP(message=);
   %if "%upcase(&mc_loglevel)" ne "NONE" %then %do;
      %let mc_step = %eval(&mc_step + 1);
      %MC_PROGRESS(step=&mc_step, total=&mc_total_steps, message=%superq(message));
   %end;
%mend MC_STEP;

%macro MIGRATION_CHECK (MC_PGMPATH=, MC_OUTSUM=, MC_UPDATE=N, MC_LOGLEVEL=PROGRAM, MC_TOCFILES=study_toc.xlsx toc.xlsx);

   %local _err
          mc_memcnt
          mc_i
          mc_fname
          mc_fpath
          mc_outdir
          mc_path_sep
          mc_update_yn
          mc_migdir
          mc_scan_root
          mc_toc_root
          mc_crawl_method
          mc_all_filecnt
          mc_toc_regex
          mc_os_family
          mc_update_target_mode
          mc_obs_found1
          mc_obs_found2
          mc_obs_found
          mc_total_found
          mc_s7_paircnt
          mc_s7_i
          mc_s7_macro_name
          mc_s7_purpose_path
          mc_s7_global_path
          mc_s7_findcnt
          mc_s7_diffcnt
          mc_s7_pathcnt
          mc_has_setup_call
          mc_f5_findcnt
          mc_f6_findcnt
          mc_f5_stat_cnt
          mc_f5_folder_cnt
          mc_f5_none_cnt
          mc_f6_desc
          mc_save_compress
          mc_excel_open
          mc_listing_open
          mc_out_lock
          mc_has_chmod
          mc_has_validvarname_v7
          mc_skip_update_file
          mc_update_migdir
          mc_update_archivedir
          mc_update_backuppath
          mc_update_outpath
          mc_warn_label
          mc_warn_dash
          mc_loglevel
          mc_step
          mc_total_steps
          mc_rule_i
          mc_rule_cnt
          mc_save_mprint
          mc_save_mlogic
          mc_save_symbolgen
          mc_save_xwait
          mc_save_xsync
          mc_save_xmin
          mc_xopts_changed
          mc_msg
          mc_rule_f4_enabled
          mc_version;

   %let _err = no;
   %let mc_memcnt = 0;
   %let mc_total_found = 0;
   %let mc_version = 4.30;
   %let mc_f6_desc = Identifies SAS programs that appear to be archive, backup, or alternate copies, based on an archive or date-named folder, or a same-folder filename that differs only by an appended number or one- or two-letter initials.;
   %let mc_save_compress = %sysfunc(getoption(compress));
   %let mc_save_mprint = %sysfunc(getoption(mprint));
   %let mc_save_mlogic = %sysfunc(getoption(mlogic));
   %let mc_save_symbolgen = %sysfunc(getoption(symbolgen));
   %let mc_xopts_changed = N;
   options nomprint nomlogic nosymbolgen;
   %MC_LOG_ENV;
   %let mc_step = 0;
   /* The environment, rule-definition, and recursive-crawl bars use this
      provisional denominator because the program count is not yet known. */
   %let mc_total_steps = 9;
   options compress=char;
   %let mc_warn_label = %sysfunc(cats(WAR,NING:));
   %let mc_warn_dash  = %sysfunc(cats(WAR,NING-));

   *** Document in log what parameter value specified ***;
   data _null_;
      put " ";
      put "******************* Parameter Values *******************";
      put "ALERT:I: MC_PGMPATH PROCESSED - &MC_PGMPATH.";
      put "ALERT:I: MC_OUTSUM  PROCESSED - &MC_OUTSUM.";
      put "ALERT:I: MC_UPDATE  PROCESSED - &MC_UPDATE.";
      put "ALERT:I: MC_LOGLEVEL PROCESSED - &MC_LOGLEVEL.";
      put "********************************************************";
      put " ";
      put "NOTE: [MIGRATION_CHECK] Processing started.";
      put "NOTE: [MIGRATION_CHECK] Program path: &MC_PGMPATH.";
      put "NOTE: [MIGRATION_CHECK] Macro version: &mc_version..";
      put " ";
   run;

   *** Defensive reset. A prior failed run can leave ODS EXCEL open or ***;
   *** filerefs assigned. Record the callers LISTING state before cleanup. ***;
   proc sql noprint;
      select count(*) into :mc_excel_open trimmed
        from sashelp.vdest
       where upcase(destination) = 'EXCEL';

      select count(*) into :mc_listing_open trimmed
        from sashelp.vdest
       where upcase(destination) = 'LISTING';
   quit;

   %if %sysevalf(%superq(mc_excel_open)=,boolean) %then %let mc_excel_open = 0;
   %if %sysevalf(%superq(mc_listing_open)=,boolean) %then %let mc_listing_open = 0;

   %if &mc_excel_open > 0 %then %do;
      %put NOTE: [MIGRATION_CHECK] Closing an ODS EXCEL destination left open by a prior run.;
      ods excel close;
   %end;

   data _null_;
      length mc_fr $8;
      do mc_fr = 'oscrawl', 'JMSCAN', 'JMUPD', 'JMBSRC', 'JMBDST',
                 'JMARCH', 'JMS7OS', 'JMS7SH', 'JMS7D', 'JMS7P', 'JMS7G';
         /* FILEREF returns a negative value when the fileref is assigned  */
         /* but the physical file is gone, which is the usual stale state. */
         if fileref(mc_fr) <= 0 then do;
            rc = filename(mc_fr);
            if rc = 0 then
               put "NOTE: [MIGRATION_CHECK] Released stale fileref " mc_fr;
            else
               put "NOTE: [MIGRATION_CHECK] Could not release fileref " mc_fr
                   ". It may still be open. Return code: " rc;
         end;
      end;
      drop rc;
   run;

   *** Validate required parameters and output directory ***;
   data _null_;
      length mc_pgmpath mc_outsum mc_parent $1024;
      mc_pgmpath = strip(symget('MC_PGMPATH'));
      mc_outsum  = strip(symget('MC_OUTSUM'));

      if compress(mc_pgmpath) = '' then do;
         put " ";
         put "ER" "ROR:[MIGRATION_CHECK] Parameter MC_PGMPATH is "
             "required and cannot be blank.";
         call symputx('_err','yes');
      end;

      if compress(mc_outsum) = '' then do;
         put " ";
         put "ER" "ROR:[MIGRATION_CHECK] Parameter MC_OUTSUM is "
             "required and cannot be blank.";
         call symputx('_err','yes');
      end;

      if compress(mc_outsum) ne '' then do;
         if prxmatch('/\.xlsx$/i', strip(mc_outsum)) = 0 then do;
            put " ";
            put "ER" "ROR:[MIGRATION_CHECK] Parameter MC_OUTSUM must "
                "specify a .xlsx filename. Received: " mc_outsum;
            call symputx('_err','yes');
         end;

         mc_parent = prxchange('s#[/\\][^/\\]+$##', 1, strip(mc_outsum));
         call symputx('mc_outdir', strip(mc_parent));

         if strip(mc_parent) = strip(mc_outsum) then do;
            put " ";
            put "ER" "ROR:[MIGRATION_CHECK] Output directory does not "
                "exist for MC_OUTSUM: " mc_outsum;
            call symputx('_err','yes');
         end;
      end;
   run;
   %if "&_err" = "yes" %then %goto mc_exit;

   *** Validate MC_UPDATE and MC_LOGLEVEL parameters. Invalid values use safe defaults. ***;
   data _null_;
      length mc_update_raw $40 mc_update_norm $3
             mc_loglevel_raw $40 mc_loglevel_norm $12
             mc_warn_label $8;
      mc_update_raw = strip(symget('MC_UPDATE'));
      mc_update_norm = upcase(mc_update_raw);
      mc_loglevel_raw = strip(symget('MC_LOGLEVEL'));
      mc_loglevel_norm = upcase(mc_loglevel_raw);
      mc_warn_label = 'WAR' || 'NING:';

      if mc_update_norm in ('Y', 'YES') then
         call symputx('mc_update_yn', 'Y', 'l');
      else if mc_update_norm in ('N', 'NO', '') then
         call symputx('mc_update_yn', 'N', 'l');
      else do;
         put mc_warn_label " [MIGRATION_CHECK] Invalid MC_UPDATE value: " mc_update_raw
            ". Valid values are N, No, Y, or Yes. MC_UPDATE=N will be assumed and processing will continue.";
         call symputx('mc_update_yn', 'N', 'l');
      end;

      if mc_loglevel_norm in ('PROGRAM', 'RULE', 'NONE') then
         call symputx('mc_loglevel', mc_loglevel_norm, 'l');
      else do;
         put "NOTE: [MIGRATION_CHECK] Invalid MC_LOGLEVEL value: " mc_loglevel_raw
             ". Valid values are PROGRAM, RULE, or NONE. MC_LOGLEVEL=PROGRAM will be assumed.";
         call symputx('mc_loglevel', 'PROGRAM', 'l');
      end;
   run;

   *** Determine operating system for reporting. MC_UPDATE behavior is now the same on all hosts. ***;
   *** A dated archive backup is created first, then the original source is updated in place. ***;
   data _null_;
      length mc_sysscp $80 mc_os_family $20 mc_update_target_mode $20;
      mc_sysscp = upcase(strip(symget('SYSSCP')));

      if index(mc_sysscp, 'WIN') > 0 then mc_os_family = 'WINDOWS';
      else if index(mc_sysscp, 'LIN') > 0 then mc_os_family = 'LINUX';
      else mc_os_family = 'OTHER';

      mc_update_target_mode = 'ARCHIVE_BACKUP';

      call symputx('mc_os_family', mc_os_family, 'l');
      call symputx('mc_update_target_mode', mc_update_target_mode, 'l');

      put "NOTE: [MIGRATION_CHECK] Operating system detected from SYSSCP: " mc_sysscp;
      put "NOTE: [MIGRATION_CHECK] Update target mode: ARCHIVE_BACKUP then IN_PLACE.";
   run;

   *** Verify input directory exists and is accessible ***;
   data _null_;
      length mc_pgmpath $1024;
      mc_pgmpath = strip(symget('MC_PGMPATH'));
      rc = filename('mc_vdir', mc_pgmpath);
      did = dopen('mc_vdir');

      if did <= 0 then do;
         put " ";
         put "ER" "ROR:[MIGRATION_CHECK] Directory not found or not "
             "accessible: " mc_pgmpath " Update the MC_PGMPATH parameter to ensure it resolves correctly.";
         call symputx('_err','yes');
      end;
      else rc = dclose(did);

      rc = filename('mc_vdir');
      drop rc did;
   run;
   %if "&_err" = "yes" %then %goto mc_exit;

   *** Verify output directory exists ***;
   data _null_;
      length mc_outdir $1024;
      mc_outdir = strip(symget('mc_outdir'));

      rc = filename('mc_odir', mc_outdir);
      did = dopen('mc_odir');

      if did <= 0 then do;
         put " ";
         put "ER" "ROR:[MIGRATION_CHECK] Output directory does not "
             "exist for MC_OUTSUM: " mc_outdir " Update the MC_OUTDIR parameter to ensure it resolves correctly.";
         call symputx('_err','yes');
      end;
      else rc = dclose(did);

      rc = filename('mc_odir');
      drop rc did;
   run;
   %if "&_err" = "yes" %then %goto mc_exit;

   *** Determine file separator based on input path ***;
   data _null_;
      length mc_pgmpath $1024 mc_path_sep $1;
      mc_pgmpath = strip(symget('MC_PGMPATH'));

      if substr(mc_pgmpath, lengthn(mc_pgmpath), 1) in ('/', '\') then
         mc_path_sep = '';
      else if index(mc_pgmpath, '\') > 0 then
         mc_path_sep = '\';
      else mc_path_sep = '/';

      call symputx('mc_path_sep', mc_path_sep);
   run;

   %put NOTE: [MIGRATION_CHECK] Environment setup and parameter validation complete.;
   %MC_STEP(message=Environment setup complete);

   %let mc_rule_f4_enabled = N;
   /*
      Rule F4 is retired as of 08/02/2026 because the target platform/Linux server
      supports folder structures deeper than seven levels. Set
      mc_rule_f4_enabled=Y to restore the Rule F4 definition, detection,
      and update logic.
   */

   /*--- Define Migration Rules ---*/
   data RULE_DEF;
      length category $60
             rule_id $20
             rule_name $200
             rule_desc $1000
             mc_special_rule $40
             criteria $500;
    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F1';
    rule_name = 'TOC Casing';
    rule_desc = 'Configured TOC workbook filename casing does not match the physical file name.';
    mc_special_rule = 'TOC_CASE';
    criteria = '';
    output;

    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F1';
    rule_name = 'TOC Casing';
    rule_desc = 'Configured TOC workbook filename casing does not match the physical file name.';
    mc_special_rule = 'TOC_CASE';
    criteria = '';
    output;

    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F2';
    rule_name = 'Folder Name Casing';
    rule_desc = 'Folder path referenced in SAS code does not match the physical file system casing.';
    mc_special_rule = 'FOLDER_CASE';
    criteria = '';
    output;

    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F3';
    rule_name = 'X command related OPTIONS';
    rule_desc = 'Remove OPTIONS statements that specify X command related options such as XSYNC, NOXSYNC, XWAIT, NOXWAIT, XCMD, or NOXCMD. ' ||
                'If one of the three immediately preceding source lines contains a quoted WIN marker, the condition is treated as passed and no finding is reported.';
    mc_special_rule = 'OPTIONS_XCMD';
    criteria = '';
    output;

    %if %upcase(&mc_rule_f4_enabled) = Y %then %do;
    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F4';
    rule_name = 'More 7 levels Folder';
    rule_desc = 'Subfolder structures that are greater than 7 levels deep can lead to display issues in SAS Studio';
    mc_special_rule = 'DIR_DEPTH';
    criteria = '';
    output;
    %end;

    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F5';
    rule_name = 'Duplicate Programs by Purpose';
    rule_desc = 'Identifies SAS programs with the same case-insensitive filename in multiple '
             || 'locations within the same purpose. The purpose is the folder immediately below '
             || 'the stat folder, or the folder immediately below MC_PGMPATH when no stat folder is present. '
             || 'STAT-derived and folder-derived purposes are evaluated separately.';
    mc_special_rule = 'DUPLICATE_PROGRAM_BY_PURPOSE';
    criteria = 'Same case-insensitive .sas filename exists in multiple locations within the same purpose under stat';
    output;

    category = 'File ' || '&' || ' Folder Structure';
    rule_id = 'F6';
    rule_name = 'Archive or Backup Programs';
    rule_desc = "&mc_f6_desc";
    mc_special_rule = 'ARCHIVE_BACKUP_PROGRAM';
    criteria = 'Folder contains archive/date, or same-folder filename differs only by an appended number or one- or two-letter initials';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O1';
    rule_name = 'DOS cd command';
    rule_desc = 'When a x command such as x ''cd path'' is applied but does not work. Use rc=dlgcdir(path) instead. ' ||
                'If one of the three immediately preceding source lines contains a quoted WIN marker, the condition is treated as passed and no finding is reported.';
    mc_special_rule = '';
    criteria = 'x ''cd ';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O1';
    rule_name = 'DOS cd command';
    rule_desc = 'When a systask command such as systask command="cd path" is applied but does not work. Use rc=dlgcdir(path) instead. ' ||
                'If one of the three immediately preceding source lines contains a quoted WIN marker, the condition is treated as passed and no finding is reported.';
    mc_special_rule = '';
    criteria = 'systask command="cd ';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O2';
    rule_name = 'Obtain User ID';
    rule_desc = 'The ' || '%' || 'sysget(username) function will not work on Linux/target platform. Use ' || '%' || 'sysget(user) or the automatic macro variable ' || '&' || 'SYSUSERID instead. Case-insensitive variants of the text are checked.';
    mc_special_rule = '';
    criteria = '%' || 'sysget(username)';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O3';
    rule_name = 'Remove filenames';
    rule_desc = 'The statement filename _all_; will remove needes filename such as _gsfname.  Update to capture and restore _gsfname.';
    mc_special_rule = '';
    criteria = 'filename _all_;';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O4';
    rule_name = 'Standard Setup Macro';
    rule_desc = 'On Linux/target platform, each SAS program must invoke the required standard '
             || '%' || 'setup macro. This check is not performed on Windows.';
    mc_special_rule = 'MISSING_SETUP';
    criteria = 'Linux only: missing invocation of the standard ' || '%' || 'setup macro';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O5';
    rule_name = 'Importing Excel';
    rule_desc = 'When PROC IMPORT reads an Excel .xlsx file, insert OPTIONS VALIDVARNAME=V7 immediately above the PROC IMPORT statement so imported variable names are compatible with SAS V7 naming rules.';
    mc_special_rule = '';
    criteria = 'proc import plus .xlsx or dbms=xlsx on same line or within next two lines';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O6';
    rule_name = 'Copying files';
    rule_desc = 'Coping files using x command does not work such as:  x ''copy oldfile.sas newfile.sas''; use fcopy function instead such as: rc = fcopy(''source'',''dest''); where source and dest are defined as file names.';
    mc_special_rule = '';
    criteria = 'x ''copy';
    output;

    category = 'OS Commands ' || '&' || ' Shell';
    rule_id = 'O6';
    rule_name = 'Copying files';
    rule_desc = 'Coping files using x command does not work such as:  x ''copy oldfile.sas newfile.sas''; use fcopy function instead such as: rc = fcopy(''source'',''dest''); where source and dest are defined as file names.';
    mc_special_rule = '';
    criteria = 'x "copy';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S1';
    rule_name = 'Current program name';
    rule_desc = 'On Windows, existing code can capture the current program path using '
             || '&' || '_SASPROGRAMFILE. For Linux/target platform compatibility, update the reference '
             || 'to SAS_EXECFILEPATH.';
    mc_special_rule = '';
    criteria = '_sasprogramfile';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S2';
    rule_name = 'Appending to Excel';
    rule_desc = 'In windows, this commonly works: '
             || 'libname xlout excel "'
             || '&' || 'outfile" scan_text=no; '
             || 'proc append base=xlout.''Report Information$''n '
             || '   data=report_info; run; '
             || 'This needs to be updated to use PROC IMPORT.';
    mc_special_rule = '';
    criteria = 'proc append';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S3';
    rule_name = 'Libname Excel';
    rule_desc = 'A libname to an excel file can work in windows such as: '
             || 'libname xlout excel "'
             || '&' || 'outfile" scan_text=no; '
             || 'This needs to be updated to use PROC IMPORT on Linux.';
    mc_special_rule = '';
    criteria = 'libname + excel on same line';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S3';
    rule_name = 'Libname Excel';
    rule_desc = 'A libname to an excel file can work in windows such as: '
             || 'libname xlout excel "'
             || '&' || 'outfile" scan_text=no; '
             || 'This needs to be updated to use PROC IMPORT on Linux.';
    mc_special_rule = '';
    criteria = 'proc export';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S3';
    rule_name = 'Libname Excel';
    rule_desc = 'A libname to an excel file can work in windows such as: '
             || 'libname xlout excel "'
             || '&' || 'outfile" scan_text=no; '
             || 'This needs to be updated to use PROC IMPORT on Linux.';
    mc_special_rule = '';
    criteria = 'proc import + dbms=excel on same line';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S4';
    rule_name = 'ER' || 'ROR log position';
    rule_desc = 'On windows, SAS log has ER' || 'ROR: and WAR' || 'NING: messages appear in the first position.  However on Linux, this appears on the second column. ';
    mc_special_rule = '';
    criteria = 'ER' || 'ROR: or ER + ROR:';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S4';
    rule_name = 'ER' || 'ROR log position';
    rule_desc = 'On windows, SAS log has ER' || 'ROR: and WAR' || 'NING: messages appear in the first position.  However on Linux, this appears on the second column. ';
    mc_special_rule = '';
    criteria = 'WAR' || 'NING: or WAR + NING:';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S5';
    rule_name = 'Windows path backslash';
    rule_desc = 'Identify a Windows path only when the source line contains C:\, D:\, E:\, F:\, G:\, H:\, two consecutive backslashes, .\, or ..\. Lines containing PRXCHANGE, in any case, pass Rule S5. All other backslash usage also passes.';
    mc_special_rule = '';
    criteria = 'C:\ / D:\ / E:\ / F:\ / G:\ / H:\ / two consecutive backslashes / .\ / ..\';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S7';
    rule_name = 'Verify Global vs Purpose macros';
    rule_desc = 'Compare SAS autocall macro programs that exist in both the purpose-level /modules folder and the remaining global /modules folders from SASAUTOS. Report line-level differences when the matching macro files are not identical.';
    mc_special_rule = 'GLOBAL_PURPOSE_MACRO_COMPARE';
    criteria = 'Same .sas macro file exists in purpose-level and global SASAUTOS /modules folders';
    output;

    /*
       Rule S6 is retired as of 05/01/2026.
       PROC IMPORT fileref conversion is no longer required for the target platform migration check.
       Keep the prior rule text below for traceability, but do not output it to RULE_DEF.

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S6';
    rule_name = 'PROC IMPORT Excel DBMS';
    rule_desc = 'On windows, proc import can use a filename directly: '
             || 'proc import datafile="C:\ClinicalStudies\study123\rawdata\dm.csv" '
             || '   out=work.dm dbms=csv replace; '
             || 'On Linux, update to use a fileref: '
             || 'filename in1 "./example-input/ae.csv" '
             || '   lrecl=32767; '
             || 'proc import datafile=in1 out=work.ae dbms=csv replace; run;';
    mc_special_rule = '';
    criteria = 'proc import anywhere in program';
    output;

    category = 'SAS Environment ' || '&' || ' Setup';
    rule_id = 'S6';
    rule_name = 'PROC IMPORT Excel DBMS';
    rule_desc = 'On windows, proc import can use a filename directly: '
             || 'proc import datafile="C:\ClinicalStudies\study123\rawdata\dm.csv" '
             || '   out=work.dm dbms=csv replace; '
             || 'On Linux, update to use a fileref: '
             || 'filename in1 "./example-input/ae.csv" '
             || '   lrecl=32767; '
             || 'proc import datafile=in1 out=work.ae dbms=csv replace; run;';
    mc_special_rule = '';
    criteria = 'dbms=xls/xlsx/xlsb/xlsm/dde anywhere in program';
    output;

    */

    category = 'Data Import ' || '&' || ' Export';
    rule_id = 'D1';
    rule_name = 'BAT file ';
    rule_desc = 'On Windows, references to .bat files need to be reviewed and updated to Linux shell script logic where applicable.';
    mc_special_rule = '';
    criteria = '.bat';
    output;

    category = 'Data Import ' || '&' || ' Export';
    rule_id = 'D2';
    rule_name = 'Executing Command';
    rule_desc = 'Line contains a .sh file reference, but chmod is not found anywhere in the SAS program. On Linux, update permissions of the .sh file before execution.';
    mc_special_rule = '';
    criteria = '.sh without chmod anywhere in program';
    output;

    category = 'Data Import ' || '&' || ' Export';
    rule_id = 'D3';
    rule_name = 'Special characters';
    rule_desc = 'On windows, some special characters can be used such as: (â€˜ or â€™)  which will cause er' || 'rors on Linux. Use ('') instead. ';
    mc_special_rule = '';
    criteria = "â€˜";
    output;

    category = 'Data Import ' || '&' || ' Export';
    rule_id = 'D3';
    rule_name = 'Special characters';
    rule_desc = 'On windows, some special characters can be used such as: (â€˜ or â€™)  which will cause er' || 'rors on Linux. Use ('') instead. ';
    mc_special_rule = '';
    criteria = "â€™";
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C1';
    rule_name = 'Source-Platform Folders';
    rule_desc = 'Some standard folders on source platform do not exist on Linux. '
             || 'The following will need to be reviewed and updated: '
             || 'Patient Profiles\ or Patient Profiles/, '
             || '\vendor or /vendor, \profile or /profile, '
             || 'anadata\SDTM or anadata/SDTM, '
             || 'reference\SMQ or reference/SMQ, '
             || 'validate\tlf\QCdata or validate/tlf/QCdata';
    mc_special_rule = '';
    criteria = 'Patient Profiles\ or Patient Profiles/';
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C1';
    rule_name = 'Source-Platform Folders';
    rule_desc = 'Some standard folders on source platform do not exist on Linux. '
             || 'The following will need to be reviewed and updated: '
             || 'Patient Profiles\ or Patient Profiles/, '
             || '\vendor or /vendor, \profile or /profile, '
             || 'anadata\SDTM or anadata/SDTM, '
             || 'reference\SMQ or reference/SMQ, '
             || 'validate\tlf\QCdata or validate/tlf/QCdata';
    mc_special_rule = '';
    criteria = '\vendor or /vendor';
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C1';
    rule_name = 'Source-Platform Folders';
    rule_desc = 'Some standard folders on source platform do not exist on Linux. '
             || 'The following will need to be reviewed and updated: '
             || 'Patient Profiles\ or Patient Profiles/, '
             || '\vendor or /vendor, \profile or /profile, '
             || 'anadata\SDTM or anadata/SDTM, '
             || 'reference\SMQ or reference/SMQ, '
             || 'validate\tlf\QCdata or validate/tlf/QCdata';
    mc_special_rule = '';
    criteria = '\profile or /profile';
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C1';
    rule_name = 'Source-Platform Folders';
    rule_desc = 'Some standard folders on source platform do not exist on Linux. '
             || 'The following will need to be reviewed and updated: '
             || 'Patient Profiles\ or Patient Profiles/, '
             || '\vendor or /vendor, \profile or /profile, '
             || 'anadata\SDTM or anadata/SDTM, '
             || 'reference\SMQ or reference/SMQ, '
             || 'validate\tlf\QCdata or validate/tlf/QCdata';
    mc_special_rule = '';
    criteria = 'anadata\SDTM or anadata/SDTM/';
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C1';
    rule_name = 'Source-Platform Folders';
    rule_desc = 'Some standard folders on source platform do not exist on Linux. '
             || 'The following will need to be reviewed and updated: '
             || 'Patient Profiles\ or Patient Profiles/, '
             || '\vendor or /vendor, \profile or /profile, '
             || 'anadata\SDTM or anadata/SDTM, '
             || 'reference\SMQ or reference/SMQ, '
             || 'validate\tlf\QCdata or validate/tlf/QCdata';
    mc_special_rule = '';
    criteria = 'reference\SMQ or reference/SMQ';
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C1';
    rule_name = 'Source-Platform Folders';
    rule_desc = 'Some standard folders on source platform do not exist on Linux. '
             || 'The following will need to be reviewed and updated: '
             || 'Patient Profiles\ or Patient Profiles/, '
             || '\vendor or /vendor, \profile or /profile, '
             || 'anadata\SDTM or anadata/SDTM, '
             || 'reference\SMQ or reference/SMQ, '
             || 'validate\tlf\QCdata or validate/tlf/QCdata';
    mc_special_rule = '';
    criteria = 'validate\tlf\QCdata or validate/tlf/QCdata';
    output;

    category = 'Character Encoding ' || '&' || ' Special Characters';
    rule_id = 'C2';
    rule_name = 'Write to SASUSER';
    rule_desc = 'On Windows, SAS User is available to Write to such as creating a new user dataset.  However, in Linux SASUSER is read-only library.';
    mc_special_rule = '';
    criteria = 'sasuser';
    output;

    category = 'Library ' || '&' || ' Path References';
    rule_id = 'L1';
    rule_name = 'Standard libnames';
    rule_desc = 'Some standard libnames that exist on Windows do not exist or need to be reviewed in Linux/target platform. ' ||
                'Capture LIBNAME statements for: CDF, HERE, PFDATA, VENDORPKATA, RAWVEND, RAWW, SDTMA, SMQ, TLFOUT, TLFVDATA, and UTILITY. ' ||
                'If one of the three immediately preceding source lines contains a quoted WIN marker, the condition is treated as passed and no finding is reported.';
    mc_special_rule = '';
    criteria = 'libname CDF/HERE/PFDATA/VENDORPKATA/RAWVEND/RAWW/SDTMA/SMQ/TLFOUT/TLFVDATA/UTILITY';
    output;

    category = 'Library ' || '&' || ' Path References';
    rule_id = 'L2';
    rule_name = 'Directory of files';
    rule_desc = 'On Windows, FILENAME PIPE can be used to list files or run shell commands. Review FILENAME PIPE usage and update command syntax for Linux/target platform where needed.';
    mc_special_rule = '';
    criteria = 'filename + pipe on same line';
    output;

    category = 'Library ' || '&' || ' Path References';
    rule_id = 'L3';
    rule_name = 'Delete files';
    rule_desc = 'On Windows, DEL commands can be used to delete files. Update X DEL and SYSTASK COMMAND="DEL ..." commands to Linux-compatible rm -f logic.';
    mc_special_rule = '';
    criteria = 'x "del, x ''del, or systask command="del';
    output;

    category = 'Library ' || '&' || ' Path References';
    rule_id = 'L4';
    rule_name = 'Encoding-sensitive characters';
    rule_desc = 'Identify lines containing encoding-sensitive characters where the byte value is greater than 127. These characters can behave differently between Windows and Linux/target platform and should be reviewed.';
    mc_special_rule = 'ENCODING_RISK';
    criteria = 'rank(character) > 127';
    output;

   run;

   data CRITERIA_DEF;
      set RULE_DEF;
      if compress(criteria) ne '';
   run;

   %put NOTE: [MIGRATION_CHECK] Rule definitions and criteria tables created.;
   %MC_STEP(message=Rule definitions loaded);

   /*--- Recursive File Discovery Starting at MC_PGMPATH ---*/
   /*
      Recursive scan behavior:
      - MC_PGMPATH is the exact crawl root.
      - Review SAS programs located directly in MC_PGMPATH and in every subfolder below it.
      - Do not crawl parent folders above MC_PGMPATH.
      - Derive MC_PGMLIST and MC_TOC_CASEMAP from MC_ALL_FILES.
      - Rule F2 validates folder casing directly against each referenced physical parent directory.
   */
   data MC_TOC_CONFIG;
      length lower_name $256 escaped $512;
      do mc_i = 1 to countw(symget('MC_TOCFILES'), ' ');
         lower_name = lowcase(strip(scan(symget('MC_TOCFILES'), mc_i, ' ')));
         if missing(lower_name) then continue;
         escaped = tranwrd(lower_name, '.', '\.');
         output;
      end;
      keep lower_name escaped;
   run;

   proc sql noprint;
      select escaped into :mc_toc_regex separated by '|'
        from MC_TOC_CONFIG;
   quit;

   %if %length(%superq(mc_toc_regex)) > 0 %then
      %let mc_toc_regex = /(%superq(mc_toc_regex))/i;
   %else
      %let mc_toc_regex = /^$/;

   data _null_;
      length mc_pgmpath mc_scan_root mc_toc_root $1024
             mc_path_sep $1;

      mc_pgmpath = strip(symget('MC_PGMPATH'));
      mc_path_sep = strip(symget('mc_path_sep'));

      if missing(mc_path_sep) then do;
         if index(mc_pgmpath, '\') > 0 then mc_path_sep = '\';
         else mc_path_sep = '/';
      end;

      /* The requested folder is the root for both the program and related-file scans. */
      mc_scan_root = mc_pgmpath;
      mc_toc_root  = mc_pgmpath;

      call symputx('mc_toc_root', strip(mc_toc_root), 'l');
      call symputx('mc_scan_root', strip(mc_scan_root), 'l');

      put "NOTE: [MIGRATION_CHECK] Recursive program scan root: " mc_scan_root;
      put "NOTE: [MIGRATION_CHECK] Recursive subfolder scan is enabled.";
      put "NOTE: [MIGRATION_CHECK] Only MC_PGMPATH and its descendant folders will be reviewed.";
   run;

   %if "%upcase(&mc_os_family)" = "WINDOWS" %then %do;
      %let mc_crawl_method = WINDOWS_DIR_PIPE;
      filename oscrawl pipe "dir ""%superq(mc_scan_root)"" /s /b /a-d" lrecl=32767;
   %end;
   %else %do;
      %let mc_crawl_method = FIND_PIPE;
      filename oscrawl pipe "find ""%superq(mc_scan_root)"" -type f" lrecl=32767;
   %end;

   data MC_ALL_FILES;
      length full_path $1024
             parent_path $1024
             file_name $256
             ext $20
             mc_full_norm mc_pgm_prefix mc_toc_prefix mc_scan_prefix $1024
             mc_path_work $1024
             in_pgmpath in_toc_root 8;

      infile oscrawl truncover lrecl=32767;
      input full_path $char1024.;

      full_path = strip(full_path);
      if missing(full_path) then delete;

      /* Normalize only for matching. Preserve the original path for reporting and file access. */
      mc_full_norm = lowcase(translate(strip(full_path), '/', '\'));
      mc_pgm_prefix = lowcase(translate(strip(symget('MC_PGMPATH')), '/', '\'));
      mc_toc_prefix = lowcase(translate(strip(symget('mc_toc_root')), '/', '\'));
      mc_scan_prefix = lowcase(translate(strip(symget('mc_scan_root')), '/', '\'));

      if lengthn(mc_pgm_prefix) > 0 and substr(mc_pgm_prefix, lengthn(mc_pgm_prefix), 1) ne '/' then
         mc_pgm_prefix = cats(mc_pgm_prefix, '/');
      if lengthn(mc_toc_prefix) > 0 and substr(mc_toc_prefix, lengthn(mc_toc_prefix), 1) ne '/' then
         mc_toc_prefix = cats(mc_toc_prefix, '/');
      if lengthn(mc_scan_prefix) > 0 and substr(mc_scan_prefix, lengthn(mc_scan_prefix), 1) ne '/' then
         mc_scan_prefix = cats(mc_scan_prefix, '/');

      /* Do not scan generated migrate_output outputs on reruns. */
      if index(upcase(mc_full_norm), '/MIGRATE_OUTPUT/') > 0 then delete;

      mc_path_work = translate(strip(full_path), '/', '\');
      file_name = scan(mc_path_work, -1, '/');
      ext = lowcase(scan(strip(file_name), -1, '.'));
      parent_path = prxchange('s#[/\\][^/\\]+$##', 1, strip(full_path));

      in_pgmpath = (lengthn(mc_pgm_prefix) > 0 and substr(mc_full_norm, 1, lengthn(mc_pgm_prefix)) = mc_pgm_prefix);
      in_toc_root = (lengthn(mc_toc_prefix) > 0 and substr(mc_full_norm, 1, lengthn(mc_toc_prefix)) = mc_toc_prefix);

      keep full_path parent_path file_name ext in_pgmpath in_toc_root;
   run;

   filename oscrawl clear;

   proc sql noprint;
      select count(*) into :mc_all_filecnt trimmed
        from MC_ALL_FILES;
   quit;

   %if %sysevalf(%superq(mc_all_filecnt)=,boolean) %then %let mc_all_filecnt = 0;
   %put NOTE: [MIGRATION_CHECK] &mc_all_filecnt file(s) found under MC_PGMPATH by recursive &mc_crawl_method. crawl.;
   %MC_STEP(message=Recursive crawl complete%str(,) &mc_all_filecnt file(s));

   data MC_PGMLIST;
      /* pgm_name is derived from MC_ALL_FILES.file_name, which is $256.
         Keep the same length throughout the macro to avoid SET length warnings. */
      length pgm_name $256 pgm_path $1024;
      set MC_ALL_FILES;
      if in_pgmpath and ext = 'sas';
      pgm_name = strip(file_name);
      pgm_path = strip(full_path);
      keep pgm_name pgm_path;
   run;

   proc sort data=MC_PGMLIST nodupkey;
      by pgm_path;
   run;

   proc sql noprint;
      select count(*)
        into :mc_memcnt trimmed
        from MC_PGMLIST;
   quit;

   %if %sysevalf(%superq(mc_memcnt)=,boolean) %then %let mc_memcnt = 0;

   %if &mc_memcnt = 0 %then %do;
      %put &mc_warn_label [MIGRATION_CHECK] No *.sas files found in:;
      %put &mc_warn_dash &MC_PGMPATH.;
      %goto mc_exit;
   %end;

   %put NOTE: [MIGRATION_CHECK] &mc_memcnt SAS program(s) found in MC_PGMPATH and its subfolders.;
   %let mc_total_steps = %eval(&mc_memcnt + 8);
   %put NOTE: [MIGRATION_CHECK] Starting migration check for &mc_memcnt program(s).;

   /* Program inventory completion is reported after the TOC map and
      physical-path setup are complete. The three earlier fixed-stage bars still
      use the provisional total because the SAS program count is not yet available. */

   data MC_TOC_CASEMAP;
      length lower_name $256 actual_name $256 actual_path $1024;
      if _n_ = 1 then do;
         declare hash mc_toc_cfg(dataset:'MC_TOC_CONFIG');
         mc_toc_cfg.defineKey('lower_name');
         mc_toc_cfg.defineDone();
      end;
      set MC_ALL_FILES;
      lower_name = lowcase(strip(file_name));
      if in_toc_root and ext = 'xlsx' and mc_toc_cfg.find() = 0;
      actual_name = strip(file_name);
      actual_path = strip(full_path);
      keep lower_name actual_name actual_path;
   run;

   proc sort data=MC_TOC_CASEMAP;
      by lower_name actual_path;
   run;

   data MC_TOC_CASEMAP;
      set MC_TOC_CASEMAP;
      by lower_name;
      if first.lower_name;
   run;

   /* Rule F2 no longer builds or uses a global folder-name case map.
      Each source reference is validated in path context by opening its exact
      physical parent directory with DOPEN/DREAD during F2 detection/update. */

   %MC_STEP(message=Program inventory and physical path setup built);

   *** Initialize update tracking dataset requested for target platform path migration updates. ***;
   data MC_UPDATE;
      length rule_id $20
             update_desc $200
             pgm_name $256
             pgm_path $1024
             output_path $1024
             line_num 8
             original_text $32767
             updated_text $32767;
      call missing(rule_id, update_desc, pgm_name, pgm_path, output_path,
                   line_num, original_text, updated_text);
      stop;
   run;

   *** MC_UPDATE=Y creates a dated archive backup beside each source program, then updates the source in place. ***;
   %if "%upcase(&mc_update_yn)" = "Y" %then %do;
      %put NOTE: [MIGRATION_CHECK] Update mode is enabled. Each source program will be backed up under its archive subfolder before the original is updated in place.;
   %end;

   /*--- Initialize Output Dataset ---*/
   data MIGRATION_CHECK;
      length category $60
             rule_id $20
             rule_name $200
             rule_desc $1000
             criteria $500
             pgm_name $256
             pgm_path $1024
             line_num 8
             line_text $32767
             s7_macro_name $256
             s7_purpose_macro_path $1024
             s7_global_macro_path $1024
             s7_purpose_line_text $32767
             s7_global_line_text $32767;
      call missing(category, rule_id, rule_name, rule_desc, criteria,
                   pgm_name, pgm_path, line_num, line_text,
                   s7_macro_name, s7_purpose_macro_path, s7_global_macro_path,
                   s7_purpose_line_text, s7_global_line_text);
      stop;
   run;


   /*--- Rules F5 and F6: Inventory-level program checks. ---*/
   /*
      Purpose is the folder immediately below the STAT folder.

      Example:
         .../stat/tlf/production/t_14_1_1.sas
         Purpose = tlf
   */
   data MC_PGM_RULE_BASE;
      length pgm_name $256
             pgm_path $1024
             pgm_path_norm $1024
             pgm_path_key $1024
             pgm_path_with_lead $1025
             parent_path $1024
             parent_key $1024
             pgm_name_key $256
             pgm_stem $256
             pgm_stem_key $256
             path_after_stat $1024
             folder_path_for_f6 $1024
             purpose $256
             purpose_key $256
             purpose_src $8
             mc_root_norm $1024
             mc_rel_path $1024;

      set MC_PGMLIST;

      pgm_path_norm = translate(strip(pgm_path), '/', '\');
      pgm_path_key = lowcase(pgm_path_norm);
      pgm_path_with_lead = cats('/', pgm_path_norm);
      parent_path = prxchange('s#/[^/]+$##', 1, pgm_path_norm);
      parent_key = lowcase(parent_path);
      pgm_name_key = lowcase(strip(pgm_name));
      pgm_stem = prxchange('s/\.sas$//i', 1, strip(pgm_name));
      pgm_stem_key = lowcase(strip(pgm_stem));

      /* Locate the exact STAT path segment and derive purpose. */
      mc_stat_pos = index(lowcase(pgm_path_with_lead), '/stat/');

      if mc_stat_pos > 0 then do;
         path_after_stat = substr(pgm_path_with_lead,
                                  mc_stat_pos + length('/stat/'));
         purpose = scan(path_after_stat, 1, '/');
         purpose_key = lowcase(strip(purpose));
         purpose_src = 'STAT';
         folder_path_for_f6 = prxchange('s#/[^/]+$##', 1,
                                        strip(path_after_stat));
      end;
      else do;
         /* Fallback. No /stat/ segment is present, which happens when   */
         /* MC_PGMPATH points below stat or at a non-standard tree. Use  */
         /* the folder immediately below MC_PGMPATH as the purpose so    */
         /* F5 still detects duplicates. Record the derivation source so */
         /* the finding remains traceable in the Excel output.           */
         path_after_stat = '';
         folder_path_for_f6 = parent_path;

         mc_root_norm = lowcase(translate(strip(symget('MC_PGMPATH')), '/', '\'));
         mc_root_norm = prxchange('s#/+$##', 1, strip(mc_root_norm));

         if lengthn(mc_root_norm) > 0 and
            index(lowcase(strip(pgm_path_norm)), strip(mc_root_norm)) = 1 then do;
            mc_rel_path = substr(strip(pgm_path_norm), lengthn(mc_root_norm) + 1);
            mc_rel_path = prxchange('s#^/+##', 1, strip(mc_rel_path));

            /* Only assign a purpose when the program sits in a subfolder. */
            if countw(mc_rel_path, '/') > 1 then purpose = scan(mc_rel_path, 1, '/');
            else purpose = '';
         end;
         else purpose = scan(parent_path, -1, '/');

         purpose_key = lowcase(strip(purpose));

         if lengthn(purpose_key) > 0 then purpose_src = 'FOLDER';
         else purpose_src = 'NONE';
      end;

      keep pgm_name pgm_path pgm_path_key parent_path parent_key
           pgm_name_key pgm_stem pgm_stem_key purpose purpose_key
           purpose_src folder_path_for_f6;
   run;

   /* Rule F5: same filename in more than one location within a purpose. */
   proc sql;
      create table MC_F5_DUPLICATE_KEYS as
      select purpose_src,
             purpose_key,
             pgm_name_key,
             count(*) as duplicate_count
        from MC_PGM_RULE_BASE
       where not missing(purpose_key)
         and not missing(pgm_name_key)
       group by purpose_src, purpose_key, pgm_name_key
      having count(*) > 1;

      create table MC_F5_FINDINGS_RAW as
      select a.pgm_name,
             a.pgm_path,
             a.purpose,
             a.purpose_src,
             b.duplicate_count
        from MC_PGM_RULE_BASE as a
        inner join MC_F5_DUPLICATE_KEYS as b
          on a.purpose_src = b.purpose_src
         and a.purpose_key = b.purpose_key
         and a.pgm_name_key = b.pgm_name_key
       order by a.purpose, a.pgm_name, a.pgm_path;
   quit;

   data MC_F5_FINDINGS;
      if 0 then set MIGRATION_CHECK;
      set MC_F5_FINDINGS_RAW;

      category = 'File & Folder Structure';
      rule_id = 'F5';
      rule_name = 'Duplicate Programs by Purpose';
      rule_desc = 'Identifies SAS programs with the same case-insensitive filename in multiple '
               || 'locations within the same purpose. The purpose is the folder immediately below '
               || 'the stat folder, or the folder immediately below MC_PGMPATH when no stat folder is present. '
               || 'STAT-derived and folder-derived purposes are evaluated separately.';
      criteria = cats('Purpose=[', strip(purpose),
                      '] Source=[', strip(purpose_src),
                      '] Program=[', strip(pgm_name),
                      '] Matching files=', strip(put(duplicate_count, best.)));
      line_num = 0;
      line_text = cats('Program-level check: duplicate program filename found within purpose ',
                       strip(purpose), '. Full path: ', strip(pgm_path));

      keep category rule_id rule_name rule_desc criteria pgm_name pgm_path
           line_num line_text
           s7_macro_name s7_purpose_macro_path s7_global_macro_path
           s7_purpose_line_text s7_global_line_text;
   run;

   proc append base=MIGRATION_CHECK data=MC_F5_FINDINGS;
   run;

   /* Rule F6A: folder name contains ARCHIVE or a supported date format. */
   data MC_F6_FOLDER_RAW;
      length archive_folder $256
             archive_reason $500
             mc_folder_name $256;
      set MC_PGM_RULE_BASE;

      retain mc_f6_date_re;
      if _n_ = 1 then
         mc_f6_date_re = prxparse(
            '/(0[1-9]|[12][0-9]|3[01])'
            || '(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)'
            || '[0-9]{4}'
            || '|(0[1-9]|[12][0-9]|3[01])_'
            || '(0[1-9]|1[0-2])_[0-9]{4}'
            || '|[0-9]{4}(0[1-9]|1[0-2])'
            || '(0[1-9]|[12][0-9]|3[01])'
            || '|[0-9]{4}-(0[1-9]|1[0-2])-'
            || '(0[1-9]|[12][0-9]|3[01])/i'
         );

      archive_folder = '';
      archive_reason = '';

      do mc_folder_i = 1 to countw(folder_path_for_f6, '/');
         mc_folder_name = scan(folder_path_for_f6, mc_folder_i, '/');

         if index(lowcase(mc_folder_name), 'archive') > 0 then do;
            archive_folder = strip(mc_folder_name);
            archive_reason = 'Folder name contains archive';
            leave;
         end;
         else if prxmatch(mc_f6_date_re, mc_folder_name) then do;
            archive_folder = strip(mc_folder_name);
            archive_reason = 'Folder name contains a supported archive date';
            leave;
         end;
      end;

      if not missing(archive_reason);
      keep pgm_name pgm_path purpose archive_folder archive_reason;
   run;

   data MC_F6_FOLDER_FINDINGS;
      if 0 then set MIGRATION_CHECK;
      set MC_F6_FOLDER_RAW;

      category = 'File & Folder Structure';
      rule_id = 'F6';
      rule_name = 'Archive or Backup Programs';
      rule_desc = "&mc_f6_desc";
      criteria = cats('Folder=[', strip(archive_folder),
                      '] Reason=[', strip(archive_reason),
                      '] Date formats checked=[ddmmmyyyy, dd_mm_yyyy, yyyymmdd, yyyy-mm-dd]');
      line_num = 0;
      line_text = cats('Program-level check: program may be an archive or backup copy. Full path: ',
                       strip(pgm_path));

      keep category rule_id rule_name rule_desc criteria pgm_name pgm_path
           line_num line_text
           s7_macro_name s7_purpose_macro_path s7_global_macro_path
           s7_purpose_line_text s7_global_line_text;
   run;

   /* Rule F6B: same-folder alternate filename with appended number/initials. */
   proc sql;
      create table MC_F6_SUFFIX_CANDIDATES as
      select a.parent_path,
             a.pgm_name as pgm_name_a,
             a.pgm_path as pgm_path_a,
             a.pgm_path_key as pgm_path_key_a,
             a.pgm_stem_key as pgm_stem_a,
             b.pgm_name as pgm_name_b,
             b.pgm_path as pgm_path_b,
             b.pgm_path_key as pgm_path_key_b,
             b.pgm_stem_key as pgm_stem_b
        from MC_PGM_RULE_BASE as a
        inner join MC_PGM_RULE_BASE as b
          on a.parent_key = b.parent_key
         and a.pgm_path_key < b.pgm_path_key
       where not missing(a.parent_key)
         and not missing(a.pgm_stem_key)
         and not missing(b.pgm_stem_key)
         /* The downstream DATA step keeps only unequal stems where the shorter
            stem is an exact prefix of the longer stem. Filter here first. */
         and (
              (lengthn(a.pgm_stem_key) < lengthn(b.pgm_stem_key) and
               substr(b.pgm_stem_key, 1, lengthn(a.pgm_stem_key)) = a.pgm_stem_key)
           or (lengthn(b.pgm_stem_key) < lengthn(a.pgm_stem_key) and
               substr(a.pgm_stem_key, 1, lengthn(b.pgm_stem_key)) = b.pgm_stem_key)
             );
   quit;

   data MC_F6_SUFFIX_PAIRS;
      length base_program alternate_program $256
             short_stem long_stem $256
             suffix_raw suffix_check $256
             f6b_confidence $6
             f6b_reason $300;
      set MC_F6_SUFFIX_CANDIDATES;

      if lengthn(pgm_stem_a) < lengthn(pgm_stem_b) then do;
         short_stem = pgm_stem_a;
         long_stem = pgm_stem_b;
         base_program = pgm_name_a;
         alternate_program = pgm_name_b;
      end;
      else if lengthn(pgm_stem_b) < lengthn(pgm_stem_a) then do;
         short_stem = pgm_stem_b;
         long_stem = pgm_stem_a;
         base_program = pgm_name_b;
         alternate_program = pgm_name_a;
      end;
      else delete;

      if substr(long_stem, 1, lengthn(short_stem)) ne short_stem then delete;

      suffix_raw = substr(long_stem, lengthn(short_stem) + 1);
      suffix_check = strip(suffix_raw);

      /* Permit an optional underscore or hyphen before the suffix. */
      if substr(suffix_check, 1, 1) in ('_', '-') then
         suffix_check = substr(suffix_check, 2);

      if missing(suffix_check) then delete;

      mc_suffix_is_number = (notdigit(strip(suffix_check)) = 0);
      mc_suffix_is_initial =
         (lengthn(strip(suffix_check)) in (1, 2) and
          notalpha(strip(suffix_check)) = 0);

      /* Was the suffix separated from the base name by _ or - ? */
      mc_had_delim = (substr(strip(suffix_raw), 1, 1) in ('_', '-'));

      /* Does the base name already end in a digit? If so, both files are  */
      /* almost certainly members of a numbered output series such as      */
      /* table_1.sas and table_12.sas, not a base program and a backup.    */
      mc_short_ends_digit =
         (notdigit(substr(strip(short_stem), lengthn(strip(short_stem)), 1)) = 0);

      /* Explicit backup wording is the strongest available signal. */
      mc_suffix_is_keyword =
         (prxmatch('/^(bak|backup|bkp|old|orig|prev|previous|copy|arch|archive|v[0-9]+)$/i',
                   strip(suffix_check)) > 0);

      if not (mc_suffix_is_number or mc_suffix_is_initial or mc_suffix_is_keyword)
         then delete;

      /* Hard suppression. Undelimited digits appended to a base name that */
      /* already ends in a digit is a numbered series, not a backup.       */
      if mc_suffix_is_number and not mc_had_delim and mc_short_ends_digit
         then delete;

      /* Assign confidence and a human-readable basis for each survivor. */
      if mc_suffix_is_keyword then do;
         f6b_confidence = 'HIGH';
         f6b_reason = cats('Suffix [', strip(suffix_check),
                           '] is an explicit backup or version keyword.');
      end;
      else if mc_had_delim and mc_suffix_is_initial then do;
         f6b_confidence = 'HIGH';
         f6b_reason = cats('Delimited one- or two-letter initials [', strip(suffix_check),
                           '] appended to the base program name.');
      end;
      else if mc_suffix_is_initial then do;
         f6b_confidence = 'MEDIUM';
         f6b_reason = cats('Undelimited one- or two-letter suffix [', strip(suffix_check),
                           ']. Confirm this is not a distinct program.');
      end;
      else if mc_had_delim and mc_suffix_is_number then do;
         f6b_confidence = 'MEDIUM';
         f6b_reason = cats('Delimited numeric suffix [', strip(suffix_check),
                           ']. Confirm this is not a legitimate output number.');
      end;
      else do;
         f6b_confidence = 'LOW';
         f6b_reason = cats('Undelimited numeric suffix [', strip(suffix_check),
                           ']. Numbered program series commonly match this pattern. ',
                           'Manual confirmation required.');
      end;
   run;

   data MC_F6_SUFFIX_FINDINGS;
      if 0 then set MIGRATION_CHECK;
      set MC_F6_SUFFIX_PAIRS;
      length paired_program $256;

      category = 'File & Folder Structure';
      rule_id = 'F6';
      rule_name = 'Archive or Backup Programs';
      rule_desc = "&mc_f6_desc";
      line_num = 0;

      pgm_name = pgm_name_a;
      pgm_path = pgm_path_a;
      paired_program = pgm_name_b;
      criteria = cats('Same-folder alternate pair=[', strip(pgm_name_a),
                      '] and [', strip(pgm_name_b),
                      '] Confidence=', strip(f6b_confidence));
      line_text = cats('Program-level check: filename may be an alternate archive or backup copy of ',
                       strip(paired_program),
                       '. Confidence: ', strip(f6b_confidence),
                       '. Basis: ', strip(f6b_reason),
                       ' Folder: ', strip(parent_path));
      output;

      pgm_name = pgm_name_b;
      pgm_path = pgm_path_b;
      paired_program = pgm_name_a;
      criteria = cats('Same-folder alternate pair=[', strip(pgm_name_a),
                      '] and [', strip(pgm_name_b),
                      '] Confidence=', strip(f6b_confidence));
      line_text = cats('Program-level check: filename may be an alternate archive or backup copy of ',
                       strip(paired_program),
                       '. Confidence: ', strip(f6b_confidence),
                       '. Basis: ', strip(f6b_reason),
                       ' Folder: ', strip(parent_path));
      output;

      keep category rule_id rule_name rule_desc criteria pgm_name pgm_path
           line_num line_text
           s7_macro_name s7_purpose_macro_path s7_global_macro_path
           s7_purpose_line_text s7_global_line_text;
   run;

   data MC_F6_FINDINGS;
      set MC_F6_FOLDER_FINDINGS MC_F6_SUFFIX_FINDINGS;
   run;

   proc sort data=MC_F6_FINDINGS nodupkey;
      by pgm_path criteria;
   run;

   proc append base=MIGRATION_CHECK data=MC_F6_FINDINGS;
   run;

   proc sql noprint;
      select count(*) into :mc_f5_findcnt    trimmed from MC_F5_FINDINGS;
      select count(*) into :mc_f6_findcnt    trimmed from MC_F6_FINDINGS;
      select count(*) into :mc_f5_stat_cnt   trimmed from MC_PGM_RULE_BASE where purpose_src = 'STAT';
      select count(*) into :mc_f5_folder_cnt trimmed from MC_PGM_RULE_BASE where purpose_src = 'FOLDER';
      select count(*) into :mc_f5_none_cnt   trimmed from MC_PGM_RULE_BASE where purpose_src = 'NONE';
   quit;

   %if %sysevalf(%superq(mc_f5_findcnt)=,boolean)    %then %let mc_f5_findcnt = 0;
   %if %sysevalf(%superq(mc_f6_findcnt)=,boolean)    %then %let mc_f6_findcnt = 0;
   %if %sysevalf(%superq(mc_f5_stat_cnt)=,boolean)   %then %let mc_f5_stat_cnt = 0;
   %if %sysevalf(%superq(mc_f5_folder_cnt)=,boolean) %then %let mc_f5_folder_cnt = 0;
   %if %sysevalf(%superq(mc_f5_none_cnt)=,boolean)   %then %let mc_f5_none_cnt = 0;

   %put NOTE: [MIGRATION_CHECK] Rule F5 purpose derivation: &mc_f5_stat_cnt from stat, &mc_f5_folder_cnt from folder fallback, &mc_f5_none_cnt not derivable.;

   %if &mc_f5_stat_cnt = 0 and &mc_f5_folder_cnt > 0 %then %do;
      %put &mc_warn_label [MIGRATION_CHECK] Rule F5: no /stat/ segment was found in any scanned path. Purpose values were derived from the folder immediately below MC_PGMPATH. Review F5 findings with that in mind.;
   %end;

   %if &mc_f5_none_cnt > 0 %then %do;
      %put &mc_warn_label [MIGRATION_CHECK] Rule F5: &mc_f5_none_cnt program(s) have no derivable purpose folder and were excluded from duplicate detection.;
   %end;

   %put NOTE: [MIGRATION_CHECK] Rule F5 identified &mc_f5_findcnt duplicate-program finding(s).;
   %put NOTE: [MIGRATION_CHECK] Rule F6 identified &mc_f6_findcnt archive/backup finding(s).;
   %MC_STEP(message=Rules F5 and F6 complete);

   /*--- Rule S7: Verify Global vs Purpose macros from SASAUTOS. ---*/
   /* Parse literal SASAUTOS paths and expand unquoted fileref tokens. */
   /* A fileref can resolve to one path or to a parenthesized path list. */
   data MC_S7_SASAUTOS_PATHS;
      length sasautos $32767
             sasautos_token $1024
             resolved_list $32767
             resolved_token $1024
             folder_path $1024
             folder_norm $1024
             macro_role $20;
      retain modules_seq 0;

      sasautos = getoption('SASAUTOS');

      do sasautos_index = 1 by 1
         while (not missing(scan(sasautos, sasautos_index, '(), ', 'q')));

         sasautos_token = strip(scan(sasautos, sasautos_index, '(), ', 'q'));
         resolved_list = '';

         /* Tokens containing a path separator or drive colon are paths. */
         /* Other unquoted tokens are treated as filerefs and expanded.  */
         if indexc(sasautos_token, '\/:') > 0 then
            resolved_list = sasautos_token;
         else do;
            resolved_list = pathname(dequote(sasautos_token));
            if missing(resolved_list) then resolved_list = sasautos_token;
         end;

         /* Aggregate filerefs return a parenthesized list of paths. */
         if substrn(strip(resolved_list), 1, 1) = '(' then do;
            do resolved_index = 1 by 1
               while (not missing(scan(resolved_list, resolved_index, '(), ', 'q')));

               resolved_token = strip(scan(resolved_list, resolved_index, '(), ', 'q'));
               folder_path = dequote(resolved_token);
               folder_norm = lowcase(translate(strip(folder_path), '/', '\'));

               if index(folder_norm, '/modules') > 0 then do;
                  modules_seq + 1;
                  if modules_seq = 1 then macro_role = 'PURPOSE';
                  else macro_role = 'GLOBAL';
                  output;
               end;
            end;
         end;
         else do;
            /* Preserve spaces when a fileref resolves to one unquoted path. */
            folder_path = dequote(strip(resolved_list));
            folder_norm = lowcase(translate(strip(folder_path), '/', '\'));

            if index(folder_norm, '/modules') > 0 then do;
               modules_seq + 1;
               if modules_seq = 1 then macro_role = 'PURPOSE';
               else macro_role = 'GLOBAL';
               output;
            end;
         end;
      end;

      keep modules_seq macro_role folder_path folder_norm;
   run;

   proc sql noprint;
      select count(*) into :mc_s7_pathcnt trimmed
        from MC_S7_SASAUTOS_PATHS;
   quit;

   %if %sysevalf(%superq(mc_s7_pathcnt)=,boolean) %then %let mc_s7_pathcnt = 0;

   %if &mc_s7_pathcnt = 0 %then %do;
      %put &mc_warn_label [MIGRATION_CHECK] S7 did not find /modules paths after expanding SASAUTOS filerefs and parsing literal path entries. S7 macro comparison will be skipped.;
   %end;
   %else %do;

      data MC_S7_MACRO_FILES;
         length macro_role $20
                folder_path $1024
                macro_name $256
                macro_name_key $256
                macro_path $1024
                member $256
               mc_warn_label $8;

         mc_warn_label = 'WAR' || 'NING:';
         set MC_S7_SASAUTOS_PATHS;

         rc = filename('s7dir', folder_path);
         did = dopen('s7dir');

         if did <= 0 then do;
            put mc_warn_label " [MIGRATION_CHECK] S7 could not open SASAUTOS folder: " folder_path;
         end;
         else do;
            do i = 1 to dnum(did);
               member = dread(did, i);

               if prxmatch('/\.sas$/i', strip(member)) then do;
                  if substr(strip(folder_path), lengthn(strip(folder_path)), 1) in ('/', '\') then
                     macro_path = cats(strip(folder_path), strip(member));
                  else macro_path = cats(strip(folder_path), '/', strip(member));

                  rc_file = filename('s7file', macro_path);
                  fid = fopen('s7file', 'I');

                  if fid > 0 then do;
                     rc_file = fclose(fid);
                     macro_name = strip(member);
                     macro_name_key = lowcase(strip(member));
                     output;
                  end;

                  rc_file = filename('s7file');
               end;
            end;

            rc = dclose(did);
         end;

         rc = filename('s7dir');

         keep macro_role folder_path macro_name macro_name_key macro_path;
      run;

      proc sql;
         create table MC_S7_COMPARE_PAIRS as
         select p.macro_name as s7_macro_name length=256,
                p.macro_path as purpose_macro_path length=1024,
                g.macro_path as global_macro_path length=1024,
                p.folder_path as purpose_macro_folder length=1024,
                g.folder_path as global_macro_folder length=1024
           from MC_S7_MACRO_FILES as p
                inner join MC_S7_MACRO_FILES as g
                   on p.macro_name_key = g.macro_name_key
          where p.macro_role = 'PURPOSE'
            and g.macro_role = 'GLOBAL'
            and strip(p.macro_path) ne strip(g.macro_path)
          order by s7_macro_name, global_macro_folder;
      quit;

      proc sql noprint;
         select count(*) into :mc_s7_paircnt trimmed
           from MC_S7_COMPARE_PAIRS;
      quit;

      %if %sysevalf(%superq(mc_s7_paircnt)=,boolean) %then %let mc_s7_paircnt = 0;
      %put NOTE: [MIGRATION_CHECK] S7 found &mc_s7_paircnt purpose/global macro pair(s) to compare.;

      %do mc_s7_i = 1 %to &mc_s7_paircnt;

         data _null_;
            _mc_s7_point = &mc_s7_i;
            set MC_S7_COMPARE_PAIRS point=_mc_s7_point nobs=_mc_s7_nobs;
            call symputx('mc_s7_macro_name', strip(s7_macro_name), 'l');
            call symputx('mc_s7_purpose_path', strip(purpose_macro_path), 'l');
            call symputx('mc_s7_global_path', strip(global_macro_path), 'l');
            stop;
         run;

         %if "%upcase(&mc_os_family)" = "LINUX" %then %do;

            *** On Linux, use Git/GNU diff with zero-context unified output. ***;
            *** Prefer git diff --no-index --diff-algorithm=histogram to reduce shifted-line noise. ***;
            *** If histogram is unavailable, retry git diff with patience. If git is unavailable, use GNU diff -d -U0. ***;
            *** The parser reads only hunk body additions/deletions, so unchanged shifted lines are not reported. ***;
            filename JMS7OS "/etc/os-release" lrecl=32767;

            data _null_;
               length os_line os_key os_value $500
                      rh_product rh_version name version_id pretty_name $500;
               retain rh_product rh_version name version_id pretty_name;

               infile JMS7OS lrecl=32767 truncover end=eof;
               input os_line $char500.;

               if index(os_line, '=') > 0 then do;
                  os_key   = upcase(strip(scan(os_line, 1, '=')));
                  os_value = strip(substr(os_line, index(os_line, '=') + 1));
                  os_value = dequote(os_value);

                  select (os_key);
                     when ('REDHAT_BUGZILLA_PRODUCT') rh_product = os_value;
                     when ('REDHAT_BUGZILLA_PRODUCT_VERSION') rh_version = os_value;
                     when ('NAME') name = os_value;
                     when ('VERSION_ID') version_id = os_value;
                     when ('PRETTY_NAME') pretty_name = os_value;
                     otherwise;
                  end;
               end;

               if eof then do;
                  if missing(rh_product) then rh_product = name;
                  if missing(rh_version) then rh_version = version_id;

                  if not missing(rh_product) or not missing(rh_version) then do;
                     put "NOTE: [MIGRATION_CHECK] S7 Linux distribution detected: "
                         rh_product " " rh_version;
                  end;
                  else if not missing(pretty_name) then do;
                     put "NOTE: [MIGRATION_CHECK] S7 Linux distribution detected: "
                         pretty_name;
                  end;
                  else do;
                     put "NOTE: [MIGRATION_CHECK] S7 Linux distribution could not be determined from /etc/os-release.";
                  end;
               end;
            run;

            filename JMS7OS clear;

            *** Command behavior: ***;
            *** 1. git diff histogram: best first choice for code where inserted blocks shift later lines. ***;
            *** 2. git diff patience: fallback if histogram is not supported by the Git version. ***;
            *** 3. GNU diff -d -U0: fallback when Git is not installed. ***;
            *** --unified=0/-U0 suppress unchanged context so only added, deleted, and modified hunk lines are parsed. ***;
            *** Create a temporary shell script so SAS does not need to parse shell variables such as $1, $2, or embedded quotes. ***;
            filename JMS7SH temp lrecl=32767;

            data _null_;
               file JMS7SH lrecl=32767;
               put '#!/bin/sh';
               put 'old_file="$1"';
               put 'new_file="$2"';
               put 'if command -v git >/dev/null 2>&1; then';
               put '  git diff --no-index --diff-algorithm=histogram --ignore-space-at-eol --no-color --unified=0 "$old_file" "$new_file"';
               put '  rc=$?';
               put '  if [ $rc -eq 129 ]; then';
               put '    git diff --no-index --diff-algorithm=patience --ignore-space-at-eol --no-color --unified=0 "$old_file" "$new_file"';
               put '  fi';
               put 'else';
               put '  /usr/bin/diff -a --strip-trailing-cr --minimal -d -U0 "$old_file" "$new_file"';
               put 'fi';
            run;

            %let mc_s7_script_path = %sysfunc(pathname(JMS7SH));
            %put NOTE: [MIGRATION_CHECK] S7 temporary diff script: %superq(mc_s7_script_path);

            filename JMS7D pipe "/bin/sh ""%superq(mc_s7_script_path)"" ""%superq(mc_s7_purpose_path)"" ""%superq(mc_s7_global_path)"" 2>&1" lrecl=32767;

            data _MC_S7_DIFF_RAW
                 _MC_S7_DIFF_MSG;
               length diff_line $32767
                      diff_side $1
                      diff_msg $32767
                      mc_warn_label $8
                      s7_purpose_line_text $32767
                      s7_global_line_text $32767;
               retain hunk_id 0 purpose_line_num global_line_num purpose_seq global_seq hunk_re;

               mc_warn_label = 'WAR' || 'NING:';

               if _n_ = 1 then hunk_re = prxparse('/^@@\s+-(\d+)(,(\d+))?\s+\+(\d+)(,(\d+))?\s+@@/');

               infile JMS7D lrecl=32767 truncover;
               input diff_line $char32767.;

               if _n_ <= 80 then
                  putlog "NOTE: [MIGRATION_CHECK] S7 raw git/diff output: " diff_line= $quote.;

               *** Ignore common Git/GNU diff metadata and empty lines. ***;
               if missing(strip(diff_line)) then delete;
               else if substr(diff_line, 1, 10) = 'diff --git' then delete;
               else if substr(diff_line, 1, 6) = 'index ' then delete;
               else if substr(diff_line, 1, 9) = 'old mode ' then delete;
               else if substr(diff_line, 1, 9) = 'new mode ' then delete;
               else if substr(diff_line, 1, 13) = 'deleted file ' then delete;
               else if substr(diff_line, 1, 9) = 'new file ' then delete;
               else if substr(diff_line, 1, 3) in ('---', '+++') then delete;
               else if substr(diff_line, 1, 1) = '\\' then delete;

               *** Hunk header example: @@ -10,2 +10,3 @@. Initialize old/new line counters. ***;
               else if prxmatch(hunk_re, strip(diff_line)) then do;
                  hunk_id + 1;
                  purpose_line_num = input(prxposn(hunk_re, 1, strip(diff_line)), best.) - 1;
                  global_line_num  = input(prxposn(hunk_re, 4, strip(diff_line)), best.) - 1;
                  purpose_seq = 0;
                  global_seq = 0;
               end;

               *** Purpose-level line removed or modified. ***;
               else if substr(diff_line, 1, 1) = '-' then do;
                  if hunk_id = 0 then hunk_id = 1;
                  diff_side = 'P';
                  purpose_seq + 1;
                  pair_seq = purpose_seq;
                  purpose_line_num + 1;
                  line_num = purpose_line_num;
                  s7_purpose_line_text = substr(diff_line, 2);
                  s7_global_line_text = '';
                  output _MC_S7_DIFF_RAW;
               end;

               *** Global line added or modified. ***;
               else if substr(diff_line, 1, 1) = '+' then do;
                  if hunk_id = 0 then hunk_id = 1;
                  diff_side = 'G';
                  global_seq + 1;
                  pair_seq = global_seq;
                  global_line_num + 1;
                  line_num = global_line_num;
                  s7_purpose_line_text = '';
                  s7_global_line_text = substr(diff_line, 2);
                  output _MC_S7_DIFF_RAW;
               end;

               *** Context lines should be rare because --unified=0/-U0 is used, but keep counters correct if they appear. ***;
               else if substr(diff_line, 1, 1) = ' ' then do;
                  purpose_line_num + 1;
                  global_line_num + 1;
               end;

               *** Keep command messages for troubleshooting, but do not create S7 findings from them. ***;
               else do;
                  diff_msg = diff_line;
                  putlog mc_warn_label " [MIGRATION_CHECK] S7 git/diff command message: " diff_msg;
                  output _MC_S7_DIFF_MSG;
               end;

               keep hunk_id pair_seq diff_side line_num
                    s7_purpose_line_text s7_global_line_text diff_msg;
            run;

            filename JMS7D clear;
            filename JMS7SH clear;

            data _MC_S7_PURPOSE_DIFF;
               set _MC_S7_DIFF_RAW(where=(diff_side = 'P'));
               purpose_line_num = line_num;
               keep hunk_id pair_seq purpose_line_num s7_purpose_line_text;
            run;

            data _MC_S7_GLOBAL_DIFF;
               set _MC_S7_DIFF_RAW(where=(diff_side = 'G'));
               global_line_num = line_num;
               keep hunk_id pair_seq global_line_num s7_global_line_text;
            run;

            proc sort data=_MC_S7_PURPOSE_DIFF;
               by hunk_id pair_seq;
            run;

            proc sort data=_MC_S7_GLOBAL_DIFF;
               by hunk_id pair_seq;
            run;

            data _MC_S7_DIFF;
               length category $60
                      rule_id $20
                      rule_name $200
                      rule_desc $1000
                      criteria $500
                      pgm_name $256
                      pgm_path $1024
                      line_num 8
                      line_text $32767
                      s7_macro_name $256
                      s7_purpose_macro_path $1024
                      s7_global_macro_path $1024
                      s7_purpose_line_text $32767
                      s7_global_line_text $32767;

               merge _MC_S7_PURPOSE_DIFF(in=in_purpose)
                     _MC_S7_GLOBAL_DIFF(in=in_global);
               by hunk_id pair_seq;

               if in_purpose or in_global;

               line_num = coalesce(purpose_line_num, global_line_num);
               s7_purpose_line_text = coalescec(s7_purpose_line_text, '');
               s7_global_line_text  = coalescec(s7_global_line_text, '');

               category = 'SAS Environment & Setup';
               rule_id = 'S7';
               rule_name = 'Verify Global vs Purpose macros';
               rule_desc = 'The same SAS macro program exists in both the purpose-level SASAUTOS /modules location and a global SASAUTOS /modules location, but the file contents are not identical.';
               criteria = 'Git/GNU zero-context diff found an added, deleted, or modified macro line without reporting unchanged shifted lines';
               pgm_name = symget('mc_s7_macro_name');
               pgm_path = symget('mc_s7_purpose_path');
               s7_macro_name = symget('mc_s7_macro_name');
               s7_purpose_macro_path = symget('mc_s7_purpose_path');
               s7_global_macro_path = symget('mc_s7_global_path');

               if in_purpose and in_global then
                  line_text = cats('S7 modified-line finding from Git/GNU diff: Macro ', strip(s7_macro_name),
                                   ' exists in both the purpose-level macro folder and a global macro folder, but the line text differs near line ',
                                   strip(put(line_num, best.)), '.');
               else if in_global then
                  line_text = cats('S7 added-line finding from Git/GNU diff: Macro ', strip(s7_macro_name),
                                   ' has an added line in the global macro near line ', strip(put(line_num, best.)), '.');
               else
                  line_text = cats('S7 deleted-line finding from Git/GNU diff: Macro ', strip(s7_macro_name),
                                   ' has a purpose-level line not present in the global macro near line ', strip(put(line_num, best.)), '.');
            run;

            proc sql noprint;
               select count(*) into :mc_s7_linux_diffcnt trimmed
                 from _MC_S7_DIFF;
            quit;

            %if %sysevalf(%superq(mc_s7_linux_diffcnt)=,boolean) %then %let mc_s7_linux_diffcnt = 0;

            %if &mc_s7_linux_diffcnt = 0 %then %do;
               %put &mc_warn_label [MIGRATION_CHECK] S7 Linux diff parser produced 0 findings for &mc_s7_macro_name.. Running SAS line-by-line fallback comparison.;

               filename JMS7P "%superq(mc_s7_purpose_path)" lrecl=32767;
               filename JMS7G "%superq(mc_s7_global_path)" lrecl=32767;

               data _MC_S7_PURPOSE_LINES;
                  length s7_purpose_line_text $32767 line_num 8;
                  infile JMS7P lrecl=32767 truncover;
                  input s7_purpose_line_text $char32767.;
                  line_num + 1;
               run;

               data _MC_S7_GLOBAL_LINES;
                  length s7_global_line_text $32767 line_num 8;
                  infile JMS7G lrecl=32767 truncover;
                  input s7_global_line_text $char32767.;
                  line_num + 1;
               run;

               data _MC_S7_DIFF_FALLBACK;
                  length category $60
                         rule_id $20
                         rule_name $200
                         rule_desc $1000
                         criteria $500
                         pgm_name $256
                         pgm_path $1024
                         line_num 8
                         line_text $32767
                         s7_macro_name $256
                         s7_purpose_macro_path $1024
                         s7_global_macro_path $1024
                         s7_purpose_line_text $32767
                         s7_global_line_text $32767;

                  merge _MC_S7_PURPOSE_LINES(in=in_purpose)
                        _MC_S7_GLOBAL_LINES(in=in_global);
                  by line_num;

                  if in_purpose ne in_global or s7_purpose_line_text ne s7_global_line_text then do;
                     category = 'SAS Environment & Setup';
                     rule_id = 'S7';
                     rule_name = 'Verify Global vs Purpose macros';
                     rule_desc = 'The same SAS macro program exists in both the purpose-level SASAUTOS /modules location and a global SASAUTOS /modules location, but the file contents are not identical.';
                     criteria = 'Linux diff parser produced no parseable findings, so SAS line-by-line fallback identified the differing macro line';
                     pgm_name = symget('mc_s7_macro_name');
                     pgm_path = symget('mc_s7_purpose_path');
                     s7_macro_name = symget('mc_s7_macro_name');
                     s7_purpose_macro_path = symget('mc_s7_purpose_path');
                     s7_global_macro_path = symget('mc_s7_global_path');
                     s7_purpose_line_text = coalescec(s7_purpose_line_text, '');
                     s7_global_line_text  = coalescec(s7_global_line_text, '');
                     line_text = cats('S7 finding from SAS fallback compare: Macro ', strip(s7_macro_name),
                                      ' exists in both the purpose-level macro folder and a global macro folder, but the contents are not identical at line ',
                                      strip(put(line_num, best.)), '.');
                     output;
                  end;
               run;

               data _MC_S7_DIFF;
                  set _MC_S7_DIFF_FALLBACK;
               run;

               filename JMS7P clear;
               filename JMS7G clear;
            %end;

         %end;
         %else %do;

            *** On Windows and non-Linux platforms, use the SAS line-by-line comparison fallback. ***;
            filename JMS7P "%superq(mc_s7_purpose_path)" lrecl=32767;
            filename JMS7G "%superq(mc_s7_global_path)" lrecl=32767;

            data _MC_S7_PURPOSE_LINES;
               length s7_purpose_line_text $32767 line_num 8;
               infile JMS7P lrecl=32767 truncover;
               input s7_purpose_line_text $char32767.;
               line_num + 1;
            run;

            data _MC_S7_GLOBAL_LINES;
               length s7_global_line_text $32767 line_num 8;
               infile JMS7G lrecl=32767 truncover;
               input s7_global_line_text $char32767.;
               line_num + 1;
            run;

            data _MC_S7_DIFF;
               length category $60
                      rule_id $20
                      rule_name $200
                      rule_desc $1000
                      criteria $500
                      pgm_name $256
                      pgm_path $1024
                      line_num 8
                      line_text $32767
                      s7_macro_name $256
                      s7_purpose_macro_path $1024
                      s7_global_macro_path $1024
                      s7_purpose_line_text $32767
                      s7_global_line_text $32767;

               merge _MC_S7_PURPOSE_LINES(in=in_purpose)
                     _MC_S7_GLOBAL_LINES(in=in_global);
               by line_num;

               if in_purpose ne in_global or s7_purpose_line_text ne s7_global_line_text then do;
                  category = 'SAS Environment & Setup';
                  rule_id = 'S7';
                  rule_name = 'Verify Global vs Purpose macros';
                  rule_desc = 'The same SAS macro program exists in both the purpose-level SASAUTOS /modules location and a global SASAUTOS /modules location, but the file contents are not identical.';
                  criteria = 'Purpose-level macro line differs from matching global macro line';
                  pgm_name = symget('mc_s7_macro_name');
                  pgm_path = symget('mc_s7_purpose_path');
                  s7_macro_name = symget('mc_s7_macro_name');
                  s7_purpose_macro_path = symget('mc_s7_purpose_path');
                  s7_global_macro_path = symget('mc_s7_global_path');
                  s7_purpose_line_text = coalescec(s7_purpose_line_text, '');
                  s7_global_line_text  = coalescec(s7_global_line_text, '');
                  line_text = cats('S7 finding: Macro ', strip(s7_macro_name),
                                   ' exists in both the purpose-level macro folder and a global macro folder, but the contents are not identical at line ',
                                   strip(put(line_num, best.)), '.');
                  output;
               end;
            run;

            filename JMS7P clear;
            filename JMS7G clear;

         %end;

         *** Build append dataset with the same structure as MIGRATION_CHECK.
             This prevents PROC APPEND variable-structure messages caused by
             temporary Git/GNU diff pairing variables such as hunk_id and pair_seq. ***;
         data _MC_S7_DIFF_APPEND;
            if 0 then set MIGRATION_CHECK;
            set _MC_S7_DIFF;
            keep category rule_id rule_name rule_desc criteria pgm_name pgm_path
                 line_num line_text
                 s7_macro_name s7_purpose_macro_path s7_global_macro_path
                 s7_purpose_line_text s7_global_line_text;
         run;

         proc append base=MIGRATION_CHECK data=_MC_S7_DIFF_APPEND;
         run;

         proc sql noprint;
            select count(*) into :mc_s7_diffcnt trimmed
              from _MC_S7_DIFF;
         quit;

         %if %sysevalf(%superq(mc_s7_diffcnt)=,boolean) %then %let mc_s7_diffcnt = 0;
         %let mc_msg = S7 %superq(mc_s7_macro_name): &mc_s7_diffcnt difference(s);
         %if "%upcase(&mc_loglevel)" ne "NONE" %then
            %MC_PROGRESS(step=&mc_s7_i, total=&mc_s7_paircnt, message=%superq(mc_msg), prefix=MIGRATION_CHECK S7);


      %end;

   %end;

   %put NOTE: [MIGRATION_CHECK] Rule S7 global macro comparison stage ended.;
   %MC_STEP(message=Rule S7 global macro comparison complete);

   /*--- Main Processing Loop ---*/
   /* Apply Windows SYSTEM execution options once instead of around every backup. */
   %if "%upcase(&mc_update_yn)" = "Y" and "%upcase(&mc_os_family)" = "WINDOWS" %then %do;
      %let mc_save_xmin  = %sysfunc(getoption(xmin));
      %let mc_save_xwait = %sysfunc(getoption(xwait));
      %let mc_save_xsync = %sysfunc(getoption(xsync));
      options xmin noxwait xsync;
      %let mc_xopts_changed = Y;
   %end;

   %do mc_i = 1 %to &mc_memcnt;

      data _null_;
         _mc_point = &mc_i;
         set MC_PGMLIST point=_mc_point;
         call symputx('mc_fname', strip(pgm_name), 'l');
         call symputx('mc_fpath', strip(pgm_path), 'l');
         stop;
      run;

      %if %sysevalf(%superq(mc_fpath)=,boolean) %then %do;
         %put &mc_warn_label [MIGRATION_CHECK] Blank program path found at MC_PGMLIST observation &mc_i.. Skipping this record.;
      %end;
      %else %do;

      %put NOTE: [MIGRATION_CHECK] Program path: %superq(mc_fpath).;
      %let mc_msg = Scanning %superq(mc_fname) (program &mc_i of &mc_memcnt);
      %MC_STEP(message=%superq(mc_msg));

      *** Use SAS filerefs without underscores to avoid Invalid logical name er rors in some Windows SAS sessions. ***;
      filename JMSCAN "%superq(mc_fpath)" lrecl=32767;

      *** Initialize whole-program flags before the single physical source read. ***;
      %let mc_has_validvarname_v7 = no;
      %let mc_has_setup_call = no;
      %let mc_has_chmod = no;

      *** Read source lines once before any update so finding logic uses original text. ***;
      *** Collect whole-program context in this same pass to avoid rereading the source. ***;
      data _MC_SRC_LINES;
         length mc_line mc_setup_scan_line $32767 line_num 8;
         mc_setup_scan_line = '';
         infile JMSCAN lrecl=32767 truncover;
         input mc_line $char32767.;
         line_num + 1;

         if prxmatch('/\bvalidvarname\s*=\s*v7\b/i', mc_line) then
            call symputx('mc_has_validvarname_v7', 'yes', 'l');

         %if "%upcase(&mc_os_family)" = "LINUX" %then %do;
            mc_setup_scan_line = prxchange('s#/\*.*?\*/##', -1, mc_line);
            if not prxmatch('/^\s*\*/', mc_setup_scan_line) and
               prxmatch(cats('/%', 'setup\b\s*(\(|;)/i'), mc_setup_scan_line) then
               call symputx('mc_has_setup_call', 'yes', 'l');
         %end;

         if prxmatch('/\bchmod\b/i', mc_line) then
            call symputx('mc_has_chmod', 'yes', 'l');
      run;

      *** Release JMSCAN immediately after the source has been read. ***;
      *** All remaining processing uses the WORK copy in _MC_SRC_LINES. ***;
      filename JMSCAN clear;

      data _MC_SRC_NEXT1;
         length mc_next_line1 $32767 line_num 8;
         set _MC_SRC_LINES(firstobs=2 keep=mc_line);
         line_num + 1;
         mc_next_line1 = mc_line;
         keep line_num mc_next_line1;
      run;

      data _MC_SRC_NEXT2;
         length mc_next_line2 $32767 line_num 8;
         set _MC_SRC_LINES(firstobs=3 keep=mc_line);
         line_num + 1;
         mc_next_line2 = mc_line;
         keep line_num mc_next_line2;
      run;

      data _MC_SRC_LOOK;
         length mc_prev_line mc_prev_line2 mc_prev_line3
                mc_next_line1 mc_next_line2 $32767;
         merge _MC_SRC_LINES _MC_SRC_NEXT1 _MC_SRC_NEXT2;
         by line_num;
         mc_prev_line  = lag(mc_line);
         mc_prev_line2 = lag2(mc_line);
         mc_prev_line3 = lag3(mc_line);
      run;

      %if "%upcase(&mc_update_yn)" = "Y" %then %do;

         *** Build archive backup path and keep the update target as the original source program. ***;
         data _null_;
            length mc_fname mc_fpath mc_outpath mc_sep $1024
                   mc_srcdir mc_archivedir mc_backuppath mc_candidate $1024
                   mc_current_folder $256
                   mc_base $256 mc_backup_name $512 mc_datestr $8
                   mc_warn_label $8;
            mc_warn_label = 'WAR' || 'NING:';
            mc_fname = strip(symget('mc_fname'));
            mc_fpath = strip(symget('mc_fpath'));

            call symputx('mc_skip_update_file', 'N', 'l');
            call symputx('mc_update_archivedir', '', 'l');
            call symputx('mc_update_backuppath', '', 'l');

            if index(mc_fpath, '\') > 0 then mc_sep = '\';
            else mc_sep = '/';

            mc_srcdir = prxchange('s#[/\\][^/\\]+$##', 1, strip(mc_fpath));
            mc_outpath = mc_fpath;

            if lengthn(mc_srcdir) = 0 or strip(mc_srcdir) = strip(mc_fpath) then do;
               put mc_warn_label " [MIGRATION_CHECK] Unable to determine source folder for archive backup. Skipping update for: " mc_fpath;
               call symputx('mc_skip_update_file', 'Y', 'l');
            end;
            *** Check the immediate folder containing the SAS program before creating an archive subfolder. ***;
            else do;
               mc_current_folder = scan(strip(mc_srcdir), -1, '/\\');

               *** If the current folder name contains ARCHIVE in any letter case, keep the program scan-only. ***;
               if index(lowcase(strip(mc_current_folder)), 'archive') > 0 then do;
                  put "NOTE: [MIGRATION_CHECK] Current folder contains ARCHIVE; program is scan-only and no nested archive folder will be created: "
                      mc_srcdir;
                  call symputx('mc_skip_update_file', 'Y', 'l');
               end;
               else do;
               if substr(mc_srcdir, lengthn(mc_srcdir), 1) in ('/', '\') then
                  mc_archivedir = cats(mc_srcdir, 'archive');
               else mc_archivedir = cats(mc_srcdir, mc_sep, 'archive');

               mc_datestr = put(today(), yymmddn8.);

               if lowcase(substr(mc_fname, max(1, lengthn(mc_fname)-3))) = '.sas' then
                  mc_base = substr(mc_fname, 1, lengthn(mc_fname)-4);
               else mc_base = mc_fname;

               mc_backup_name = cats(mc_base, '_', mc_datestr, '.sas');
               mc_candidate = cats(mc_archivedir, mc_sep, mc_backup_name);

               *** Never overwrite a backup from an earlier run on the same date. ***;
               if fileexist(mc_candidate) then do;
                  mc_suffix = 2;
                  do while (mc_suffix <= 9999);
                     mc_backup_name = cats(mc_base, '_', mc_datestr, '_', strip(put(mc_suffix, 8.)), '.sas');
                     mc_candidate = cats(mc_archivedir, mc_sep, mc_backup_name);
                     if not fileexist(mc_candidate) then leave;
                     mc_suffix + 1;
                  end;
                  if mc_suffix > 9999 then do;
                     put mc_warn_label " [MIGRATION_CHECK] Unable to allocate a unique dated backup filename. Skipping update for: " mc_fpath;
                     call symputx('mc_skip_update_file', 'Y', 'l');
                  end;
               end;

               mc_backuppath = mc_candidate;

               put "NOTE: [MIGRATION_CHECK] In-place update target: " mc_outpath;
               put "NOTE: [MIGRATION_CHECK] Archive backup target: " mc_backuppath;

               call symputx('mc_update_archivedir', mc_archivedir, 'l');
               call symputx('mc_update_backuppath', mc_backuppath, 'l');
               end;
            end;

            call symputx('mc_update_outpath', mc_outpath, 'l');
            call symputx('mc_update_migdir', '', 'l');
         run;

         *** Create the archive subfolder when it does not already exist. ***;
         %if "%upcase(&mc_skip_update_file)" ne "Y" %then %do;
            data _null_;
               length mc_archivedir mc_parent mc_newdir created $1024 mc_warn_label $8;
               mc_warn_label = 'WAR' || 'NING:';
               mc_archivedir = strip(symget('mc_update_archivedir'));

               rc = filename('JMARCH', mc_archivedir);
               did = dopen('JMARCH');

               if did > 0 then do;
                  rc = dclose(did);
                  put "NOTE: [MIGRATION_CHECK] Archive folder already exists: " mc_archivedir;
               end;
               else do;
                  mc_parent = prxchange('s#[/\\][^/\\]+$##', 1, strip(mc_archivedir));
                  mc_newdir = scan(mc_archivedir, -1, '/\\');
                  created = dcreate(strip(mc_newdir), strip(mc_parent));

                  if missing(created) then do;
                     put mc_warn_label " [MIGRATION_CHECK] Unable to create archive folder: " mc_archivedir
                         ". The source program will not be updated because a backup could not be secured.";
                     call symputx('mc_skip_update_file', 'Y', 'l');
                  end;
                  else put "NOTE: [MIGRATION_CHECK] Created archive folder: " created;
               end;

               rc = filename('JMARCH');
            run;
         %end;

         *** Copy the original source program to the dated archive backup before any update is written. ***;
         /* Preserve the source program's last-modified timestamp on both Windows and Linux. */
         %if "%upcase(&mc_skip_update_file)" ne "Y" %then %do;

            data _null_;
               length mc_warn_label $8 mc_msg $500 mc_os $20
                      mc_source mc_backup $1024 mc_cmd $4096
                      mc_src_size_c mc_bak_size_c $64
                      mc_src_mtime mc_bak_mtime $128
                      mc_errfile $1200 mc_shell_line $2900;

               mc_warn_label = 'WAR' || 'NING:';
               mc_os         = upcase(strip(symget('mc_os_family')));
               mc_source     = strip(symget('mc_fpath'));
               mc_backup     = strip(symget('mc_update_backuppath'));

               rc = 999;
               mc_msg = '';

               /* Use a per-backup diagnostic file so the external shell's own */
               /* error text can be reported when a copy command fails.            */
               mc_errfile = cats(mc_backup, '.copy_error.txt');

               if fileexist(mc_errfile) then do;
                  rc_fn = filename('JMCPERR', mc_errfile);
                  rc_delete = fdelete('JMCPERR');
                  rc_fn = filename('JMCPERR');
               end;

               /* Fail closed for shell metacharacters rather than interpolating them. */
               if prxmatch('/[%!`$"&|<>^\x00-\x1f]/', cats(mc_source, mc_backup, mc_errfile))
                  or (mc_os = 'LINUX' and index(cats(mc_source, mc_backup), '\') > 0) then do;
                  rc = 999;
                  mc_msg = 'Unsupported characters in backup paths; source not updated.';
               end;
               else if mc_os = 'LINUX' then do;
                  /* CATX inserts the required spaces between shell command tokens. */
                  /* cp -p preserves the source file's access and modification timestamps. */
                  mc_cmd = catx(' ', 'cp -p --',
                                quote(trim(mc_source)),
                                quote(trim(mc_backup)),
                                '2>', quote(trim(mc_errfile)));
                  put "NOTE: [MIGRATION_CHECK] Creating timestamp-preserving backup.";
                  rc = system(mc_cmd);

                  if rc ne 0 then
                     mc_msg = cats('Linux cp -p returned RC=', strip(put(rc, best.)));
               end;
               else if mc_os = 'WINDOWS' then do;
                  /* COPY is a CMD built-in and supports copying directly to a different */
                  /* destination filename. /B performs a binary copy and /Y suppresses   */
                  /* overwrite confirmation. CATX is required so CMD receives properly   */
                  /* separated command tokens even when paths are quoted.                */
                  mc_cmd = catx(' ', 'cmd /d /q /c copy /b /y',
                                quote(trim(mc_source)),
                                quote(trim(mc_backup)),
                                '>', quote(trim(mc_errfile)), '2>&1');
                  put "NOTE: [MIGRATION_CHECK] Creating timestamp-preserving backup.";
                  rc = system(mc_cmd);

                  if rc ne 0 then
                     mc_msg = cats('Windows COPY returned RC=', strip(put(rc, best.)));
                  else if not fileexist(mc_backup) then do;
                     rc = 999;
                     mc_msg = 'Windows COPY returned success but the dated archive backup was not created.';
                  end;
               end;
               else do;
                  rc = 999;
                  mc_msg = cats('Timestamp-preserving backup is not configured for operating system ', mc_os);
               end;

               /* If the shell command failed, append its first nonblank diagnostic line. */
               if rc ne 0 and fileexist(mc_errfile) then do;
                  rc_fn = filename('JMCPERR', mc_errfile);
                  fid_err = fopen('JMCPERR', 'I', 1, 'V');
                  if fid_err > 0 then do;
                     mc_shell_line = '';
                     rc_get = fget(fid_err, mc_shell_line, 2900);
                     do while (rc_get = 0 and missing(strip(mc_shell_line)));
                        mc_shell_line = '';
                        rc_get = fget(fid_err, mc_shell_line, 2900);
                     end;
                     if rc_get = 0 and not missing(strip(mc_shell_line)) then
                        mc_msg = catx(' ', mc_msg, 'Shell:', strip(mc_shell_line));
                     rc_close = fclose(fid_err);
                  end;
                  rc_fn = filename('JMCPERR');
               end;

               /* Remove the temporary command-output file after diagnostics are read. */
               if fileexist(mc_errfile) then do;
                  rc_fn = filename('JMCPERR', mc_errfile);
                  rc_delete_err = fdelete('JMCPERR');
                  rc_fn = filename('JMCPERR');
               end;

               /* Validate the physical backup before the original source can be changed. */
               if rc = 0 and fileexist(mc_backup) then do;
                  mc_src_size = .;
                  mc_bak_size = .;
                  mc_src_size_c = '';
                  mc_bak_size_c = '';
                  mc_src_mtime = '';
                  mc_bak_mtime = '';

                  rc_fn = filename('JMSRCBK', mc_source);
                  fid_src = fopen('JMSRCBK', 'I', 1, 'B');
                  if fid_src > 0 then do;
                     mc_src_size_c = finfo(fid_src, 'File Size (bytes)');
                     mc_src_mtime  = finfo(fid_src, 'Last Modified');
                     rc_close = fclose(fid_src);
                  end;
                  rc_fn = filename('JMSRCBK');

                  rc_fn = filename('JMDSTBK', mc_backup);
                  fid_bak = fopen('JMDSTBK', 'I', 1, 'B');
                  if fid_bak > 0 then do;
                     mc_bak_size_c = finfo(fid_bak, 'File Size (bytes)');
                     mc_bak_mtime  = finfo(fid_bak, 'Last Modified');
                     rc_close = fclose(fid_bak);
                  end;
                  rc_fn = filename('JMDSTBK');

                  mc_src_size = input(compress(mc_src_size_c, ','), best32.);
                  mc_bak_size = input(compress(mc_bak_size_c, ','), best32.);

                  if not missing(mc_bak_size) and mc_bak_size <= 0 then do;
                     rc = 998;
                     mc_msg = 'Archive backup was created but is empty.';
                  end;
                  else if not missing(mc_src_size) and not missing(mc_bak_size)
                       and mc_src_size ne mc_bak_size then do;
                     rc = 997;
                     mc_msg = cats('Archive backup byte count does not match source. SourceBytes=',
                                   strip(put(mc_src_size, best32.)),
                                   ' BackupBytes=', strip(put(mc_bak_size, best32.)));
                  end;
                  else if not missing(mc_src_mtime) and not missing(mc_bak_mtime)
                       and strip(mc_src_mtime) ne strip(mc_bak_mtime) then do;
                     rc = 996;
                     mc_msg = cats('Archive backup Last Modified timestamp does not match source. Source=',
                                   strip(mc_src_mtime), ' Backup=', strip(mc_bak_mtime));
                  end;
               end;

               if rc ne 0 or not fileexist(mc_backup) then do;
                  put mc_warn_label " [MIGRATION_CHECK] Timestamp-preserving backup failed. Source program will NOT be updated. "
                      "Source=" mc_source " Backup=" mc_backup
                      " RC=" rc " Message=" mc_msg;

                  if fileexist(mc_backup) then do;
                     rc_fn = filename('JMBADBK', mc_backup);
                     rc_delete = fdelete('JMBADBK');
                     rc_fn = filename('JMBADBK');
                  end;

                  call symputx('mc_skip_update_file', 'Y', 'l');
               end;
               else do;
                  put "NOTE: [MIGRATION_CHECK] Backup created successfully: " mc_backup;
                  if not missing(mc_bak_size) then
                     put "NOTE: [MIGRATION_CHECK] Backup byte count verified: " mc_bak_size;
                  if not missing(mc_bak_mtime) then
                     put "NOTE: [MIGRATION_CHECK] Backup Last Modified timestamp verified: " mc_bak_mtime;
               end;
            run;
         %end;

         %if "%upcase(&mc_skip_update_file)" ne "Y" %then %do;

         filename JMUPD "%superq(mc_update_outpath)" lrecl=32767;

         *** Rule F1, F2, F3, O1, O2, O3, O5, O6, L3, S1, and S5 updates: write the updated source program in place after backup. ***;
         data _MC_UPDATE_FILE;
            retain mc_f2_seg_re;
            length rule_id $20
                   update_desc $200
                   pgm_name $256
                   pgm_path $1024
                   output_path $1024
                   line_num 8
                   original_text $32767
                   updated_text $32767
                   mc_line $32767
                   mc_before_rule $32767
                   mc_s1_repl $64
                   mc_o2_repl $64
                            mc_f2_ref $256
                   mc_f2_desc $200
                   mc_f2_prefix $32767
                   mc_f2_token_prefix $1024
                   mc_f2_parent $1024
                   mc_f2_srcpath $1024
                   mc_f2_srcdir $1024
                   mc_f2_child $1024
                   mc_f2_entry $256
                   mc_f2_actual $256
                   mc_f2_cache_parent $1024
                   mc_f2_cache_ref $256
                   mc_f2_cache_actual $256
                   mc_f2_sep $1
                   mc_o1_path $1024
                   mc_o1_path_out $1024
                   mc_o3_apply 8
                   mc_o5_apply 8
                   mc_o5_context $32767
                   mc_o6_apply 8
                   mc_o6_args $2900
                   mc_o6_work $2900
                   mc_o6_pos 8
                   mc_o6_oldfile $1024
                   mc_o6_newfile $1024
                   mc_toc_ref $256
                   lower_name $256
                   actual_name $256
                   mc_s5_class $10
                   mc_s5_up $32767;
            set _MC_SRC_LOOK;
            file JMUPD lrecl=32767;

            if _n_ = 1 then do;
               declare hash mc_f2_cache();
               mc_f2_cache.defineKey('mc_f2_cache_parent', 'mc_f2_cache_ref');
               mc_f2_cache.defineData('mc_f2_cache_actual', 'mc_f2_cache_verified');
               mc_f2_cache.defineDone();
               mc_f2_seg_re = prxparse('/[\\\/]([^\\\/"''\s;,()]+)/');
               declare hash mc_toc_map(dataset:'MC_TOC_CASEMAP');
               mc_toc_map.defineKey('lower_name');
               mc_toc_map.defineData('actual_name');
               mc_toc_map.defineDone();
               mc_toc_re = prxparse(symget('mc_toc_regex'));
            end;

            if missing(mc_f2_seg_re) then do;
               put "ER" "ROR:[MIGRATION_CHECK] Rule F2 PRX pattern did not compile. Skipping F2 update for this file.";
            end;

            original_text = mc_line;
            updated_text = mc_line;

            *** Shared WIN exemption for Rules F3, O1, and L1. ***;
            *** If any of the prior three source lines contains "WIN" or 'WIN', ***;
            *** treat the current F3/O1/L1 candidate as passed.                 ***;
            mc_win_exempt = (
               index(upcase(mc_prev_line),  '"WIN"') > 0 or
               index(upcase(mc_prev_line),  "'WIN'") > 0 or
               index(upcase(mc_prev_line2), '"WIN"') > 0 or
               index(upcase(mc_prev_line2), "'WIN'") > 0 or
               index(upcase(mc_prev_line3), '"WIN"') > 0 or
               index(upcase(mc_prev_line3), "'WIN'") > 0
            );

            mc_s5_up = upcase(updated_text);
            %MC_S5_CLASSIFY(_IN=updated_text, _UP=mc_s5_up, _OUT=mc_s5_class)
            mc_o1_path_out = '';
            mc_o3_apply = 0;
            mc_o5_apply = 0;
            mc_o5_context = '';
            mc_o6_apply = 0;
            mc_o6_args = '';
            mc_o6_work = '';
            mc_o6_pos = .;
            mc_o6_oldfile = '';
            mc_o6_newfile = '';

            *** Rule F1 update: correct configured TOC workbook filename casing based on physical files. ***;
            *** The physical TOC files are discovered recursively within MC_PGMPATH and its descendant folders. ***;
            if not missing(mc_toc_re) and prxmatch(mc_toc_re, updated_text) then do;
               mc_before_rule = updated_text;
               mc_toc_start = 1;
               mc_toc_stop = lengthn(updated_text);
               call prxnext(mc_toc_re, mc_toc_start, mc_toc_stop, updated_text,
                            mc_toc_pos, mc_toc_len);

               do while (mc_toc_pos > 0);
                  mc_toc_ref = substr(updated_text, mc_toc_pos, mc_toc_len);
                  lower_name = lowcase(strip(mc_toc_ref));
                  actual_name = '';
                  if mc_toc_map.find() = 0 and lengthn(actual_name) > 0 then
                     updated_text = prxchange(cats('s/', tranwrd(lower_name, '.', '\.'), '/', strip(actual_name), '/i'), -1, updated_text);
                  call prxnext(mc_toc_re, mc_toc_start, mc_toc_stop, updated_text,
                               mc_toc_pos, mc_toc_len);
               end;

               if mc_before_rule ne updated_text then do;
                  rule_id = 'F1';
                  update_desc = cats('Corrected configured TOC workbook filename casing to match physical file: ', strip(actual_name), '.');
                  pgm_name = symget('mc_fname');
                  pgm_path = symget('mc_fpath');
                  output_path = symget('mc_update_outpath');
                  original_text = mc_before_rule;
                  output;
               end;
            end;

            *** Rule F2 update: correct folder-name casing using the exact physical parent directory. ***;
            *** Do not use a global folder-name-only case map for the update decision. A folder such as ***;
            *** TLF may legitimately exist elsewhere as tlf, and that unrelated casing must not be applied. ***;
            mc_before_rule = updated_text;
            mc_f2_desc = '';

            if not missing(mc_f2_seg_re) and lengthn(updated_text) > 0
               and not prxmatch('/^\s*(%?\*|\/\*)/', updated_text)
               and (index(updated_text, '/') > 0 or index(updated_text, '\') > 0) then do;

               mc_f2_start = 1;
               mc_f2_stop = lengthn(updated_text);
               call prxnext(mc_f2_seg_re, mc_f2_start, mc_f2_stop,
                            updated_text, mc_f2_pos, mc_f2_len);

               do while (mc_f2_pos > 0);
                  if mc_f2_len > 1 and mc_f2_pos < lengthn(updated_text) then
                     mc_f2_ref = substrn(updated_text, mc_f2_pos + 1, mc_f2_len - 1);
                  else
                     mc_f2_ref = '';
                  mc_f2_actual = '';
                  mc_f2_parent = '';
                  mc_f2_child = '';
                  mc_f2_verified = 0;

                  if not missing(mc_f2_ref) and strip(mc_f2_ref) not in ('.', '..') then do;

                     /* Determine the path text immediately preceding this folder segment.
                        Quoted paths may contain blanks, so use the most recent quote as
                        the path boundary when one is present. Otherwise use the most
                        recent normal SAS/token delimiter. */
                     if mc_f2_pos > 1 then
                        mc_f2_prefix = substrn(updated_text, 1, max(0, mc_f2_pos - 1));
                     else
                        mc_f2_prefix = '';

                     mc_f2_dq = findc(substrn(mc_f2_prefix, 1, lengthn(mc_f2_prefix)), '"', 'b');
                     mc_f2_sq = findc(substrn(mc_f2_prefix, 1, lengthn(mc_f2_prefix)), "'", 'b');
                     mc_f2_qpos = max(mc_f2_dq, mc_f2_sq);

                     if mc_f2_qpos > 0 then
                        mc_f2_token_prefix = substrn(mc_f2_prefix, mc_f2_qpos + 1);
                     else do;
                        mc_f2_delim = findc(substrn(mc_f2_prefix, 1, lengthn(mc_f2_prefix)), ' =,();', 'b');
                        if mc_f2_delim > 0 then
                           mc_f2_token_prefix = substrn(mc_f2_prefix, mc_f2_delim + 1);
                        else
                           mc_f2_token_prefix = mc_f2_prefix;
                     end;

                     mc_f2_token_prefix = strip(mc_f2_token_prefix);

                     /* Absolute Windows/UNC/Linux path: the token prefix is the
                        physical parent path for the current segment. */
                     if prxmatch('/^[A-Za-z]:/', strip(mc_f2_token_prefix)) or
                        substrn(strip(mc_f2_token_prefix), 1, 2) = '\\' or
                        substrn(strip(mc_f2_token_prefix), 1, 1) = '/' then
                        mc_f2_parent = strip(mc_f2_token_prefix);

                     /* Relative literal path: resolve it relative to the source
                        program folder. Do not attempt to guess unresolved macro
                        variable paths. */
                     else if not missing(mc_f2_token_prefix) and
                             index(mc_f2_token_prefix, '&') = 0 and
                             index(mc_f2_token_prefix, '%') = 0 then do;
                        mc_f2_srcpath = symget('mc_fpath');
                        mc_f2_srcdir = prxchange('s#[\\/][^\\/]+$##', 1,
                                                 strip(mc_f2_srcpath));

                        if index(mc_f2_srcdir, '\') > 0 then mc_f2_sep = '\';
                        else mc_f2_sep = '/';

                        mc_f2_parent = cats(strip(mc_f2_srcdir),
                                             mc_f2_sep,
                                             strip(mc_f2_token_prefix));
                     end;

                     /* C: alone must be opened as the drive root C:\ . */
                     if prxmatch('/^[A-Za-z]:$/', strip(mc_f2_parent)) then
                        mc_f2_parent = cats(strip(mc_f2_parent), '\');

                     /* Verify exact-parent casing, caching repeated lookups in this program. */
                     if not missing(mc_f2_parent) and
                        index(mc_f2_parent, '&') = 0 and
                        index(mc_f2_parent, '%') = 0 then do;

                        mc_f2_cache_parent = strip(mc_f2_parent);
                        mc_f2_cache_ref = lowcase(strip(mc_f2_ref));
                        mc_f2_cache_actual = '';
                        mc_f2_cache_verified = 0;
                        rc_f2_cache = mc_f2_cache.find();

                        if rc_f2_cache = 0 then do;
                           mc_f2_actual = mc_f2_cache_actual;
                           mc_f2_verified = mc_f2_cache_verified;
                        end;
                        else do;
                           rc_f2 = filename('JMF2PAR', strip(mc_f2_parent));
                           did_f2 = dopen('JMF2PAR');

                           if did_f2 > 0 then do;
                              do mc_f2_i = 1 to dnum(did_f2);
                                 mc_f2_entry = dread(did_f2, mc_f2_i);
                                 if lowcase(strip(mc_f2_entry)) = lowcase(strip(mc_f2_ref)) then do;
                                    mc_f2_actual = strip(mc_f2_entry);
                                    leave;
                                 end;
                              end;
                              rc_f2close = dclose(did_f2);
                           end;
                           rc_f2 = filename('JMF2PAR');

                           if not missing(mc_f2_actual) then do;
                              if index(mc_f2_parent, '\') > 0 or
                                 prxmatch('/^[A-Za-z]:/', strip(mc_f2_parent)) then mc_f2_sep = '\';
                              else mc_f2_sep = '/';

                              mc_f2_child = cats(strip(mc_f2_parent), mc_f2_sep, strip(mc_f2_actual));
                              rc_f2 = filename('JMF2CHK', strip(mc_f2_child));
                              did_f2_chk = dopen('JMF2CHK');
                              if did_f2_chk > 0 then do;
                                 mc_f2_verified = 1;
                                 rc_f2close = dclose(did_f2_chk);
                              end;
                              rc_f2 = filename('JMF2CHK');
                           end;

                           mc_f2_cache_actual = mc_f2_actual;
                           mc_f2_cache_verified = mc_f2_verified;
                           rc_f2_cache = mc_f2_cache.add();
                        end;
                     end;

                     if mc_f2_verified = 1 and
                        strip(mc_f2_ref) ne strip(mc_f2_actual) then do;

                        updated_text = cats(substrn(updated_text, 1, mc_f2_pos),
                                            strip(mc_f2_actual),
                                            substrn(updated_text,
                                                    mc_f2_pos + mc_f2_len));

                        mc_f2_desc = catx('; ', mc_f2_desc,
                           cats('Corrected folder reference from ',
                                strip(mc_f2_ref), ' to ', strip(mc_f2_actual),
                                ' using physical parent ',
                                strip(mc_f2_parent)));

                        mc_f2_stop = lengthn(updated_text);

                        /* Restart after replacement so later path segments are
                           validated using the corrected physical parent path. */
                        mc_f2_start = 1;
                     end;
                  end;

                  call prxnext(mc_f2_seg_re, mc_f2_start, mc_f2_stop,
                               updated_text, mc_f2_pos, mc_f2_len);
               end;
            end;

            if mc_before_rule ne updated_text then do;
               rule_id = 'F2';
               update_desc = substr(strip(mc_f2_desc), 1, 200);
               pgm_name = symget('mc_fname');
               pgm_path = symget('mc_fpath');
               output_path = symget('mc_update_outpath');
               original_text = mc_before_rule;
               output;
            end;

            *** Rule F3 update: comment out OPTIONS statements containing X command related options. ***;
            *** XSYNC, NOXSYNC, XWAIT, NOXWAIT, XCMD, and NOXCMD are removed for Linux/target platform compatibility. ***;
            if mc_win_exempt = 0 and
               prxmatch('/\boptions\b/i', updated_text) and
               prxmatch('/\b(noxsync|xsync|noxwait|xwait|noxcmd|xcmd)\b/i', updated_text) and
               not prxmatch('/^\s*\*\*\*\s*remove for linux\s*\*\*\*/i', updated_text) then do;
               mc_before_rule = updated_text;
               updated_text = cats('*** remove for linux *** ', updated_text);

               rule_id = 'F3';
               update_desc = 'Commented out OPTIONS statement containing XSYNC, NOXSYNC, XWAIT, NOXWAIT, XCMD, or NOXCMD for Linux/target platform compatibility.';
               pgm_name = symget('mc_fname');
               pgm_path = symget('mc_fpath');
               output_path = symget('mc_update_outpath');
               original_text = mc_before_rule;
               output;
            end;

            %if %upcase(&mc_rule_f4_enabled) = Y %then %do;
            *** Rule F4 update: comment deep Windows path lines for Linux/target platform review. ***;
            *** If a line contains backslashes, is not an RTF control/markup line,  ***;
            *** and contains more than seven backslashes, add a review comment.      ***;
            if index(updated_text, '\') > 0 and
               not prxmatch('/^\s*\*\*\*\s*update path for linux\s*\*\*\*/i', updated_text) then do;
               mc_f4_bslash_count = countc(updated_text, '\');
               mc_f4_is_rtf = (mc_s5_class in ('RTF', 'FORMCHAR'));

               if mc_f4_is_rtf = 0 and mc_f4_bslash_count > 7 and
                  not prxmatch('/^\s*\*\*\*\s*update path for linux\s*\*\*\*/i', updated_text) then do;
                  mc_before_rule = updated_text;
                  updated_text = cats('*** update path for linux *** ', updated_text);

                  rule_id = 'F4';
                  update_desc = cats('Commented line containing more than seven backslashes for Linux/target platform path review; backslash count=',
                                     strip(put(mc_f4_bslash_count, best.)), '.');
                  pgm_name = symget('mc_fname');
                  pgm_path = symget('mc_fpath');
                  output_path = symget('mc_update_outpath');
                  original_text = mc_before_rule;
                  output;
               end;
            end;
            %end;

            *** Rule O1 update: replace shell CD command with DLGCDIR() logic. ***;
            *** Detect SYSTASK COMMAND="CD path" first, then X "CD path".       ***;
            *** This prevents a SYSTASK line from being processed by both       ***;
            *** detection branches and inserts only one DLGCDIR block per line. ***;
            mc_o1_path = '';
            mc_o1_path_out = '';
            mc_o1_apply = 0;

            if mc_win_exempt = 0 and
               not prxmatch('/^\s*\*\*\*\s*Updated to use dlgcdir\(\)\s*\*\*\*/i', updated_text) then do;

               *** SYSTASK-specific CD command. Process this first. ***;
               if prxmatch("/\bsystask\s+command\s*=\s*[""']cd\s+/i", updated_text) then do;
                  mc_o1_path = prxchange("s/^.*\bsystask\s+command\s*=\s*[""']cd\s+([^""']+)[""'].*$/\1/i", 1, updated_text);
                  mc_o1_apply = 1;
               end;

               *** Generic X CD command. Only process when SYSTASK was not matched. ***;
               else if prxmatch("/\bx\s*[""']cd\s+/i", updated_text) then do;
                  mc_o1_path = prxchange("s/^.*\bx\s*[""']cd\s+([^""']+)[""'].*$/\1/i", 1, updated_text);
                  mc_o1_apply = 1;
               end;
            end;

            if mc_o1_apply = 1 then do;
               mc_before_rule = updated_text;
               mc_o1_path = strip(mc_o1_path);

               *** Defensive check: if PRXCHANGE did not isolate a path, do not insert an invalid replacement block. ***;
               if lengthn(mc_o1_path) > 0 and mc_o1_path ne strip(mc_before_rule) then do;

                  *** Convert captured path separators in the replacement DLGCDIR() block to Linux/target platform forward slashes. ***;
                  mc_o1_path_out = translate(mc_o1_path, '/', '\');

                  updated_text = cats('*** Updated to use dlgcdir() *** ', updated_text);

                  rule_id = 'O1';
                  update_desc = cats('Inserted one DLGCDIR replacement block for shell CD command using path: ',
                                     substr(strip(mc_o1_path_out), 1, 120), '.');
                  pgm_name = symget('mc_fname');
                  pgm_path = symget('mc_fpath');
                  output_path = symget('mc_update_outpath');
                  original_text = mc_before_rule;
                  output;
               end;
               else do;
                  mc_o1_path_out = '';
               end;
            end;

            /* Rule O2 update: replace %sysget(USERNAME) with %sysget(USER). */
            /* USERNAME may not be available in Linux/target platform. USER is the compatible environment variable. */
            mc_o2_repl = cats('%', 'sysget(USER)');
            if prxmatch('/%sysget\s*\(\s*USERNAME\s*\)/i', updated_text) then do;
               mc_before_rule = updated_text;
               updated_text = prxchange(cats('s/%sysget\s*\(\s*USERNAME\s*\)/', mc_o2_repl, '/i'), -1, updated_text);

               if mc_before_rule ne updated_text then do;
                  rule_id = 'O2';
                  update_desc = 'Replaced %sysget(USERNAME) with %sysget(USER) for Linux/target platform user ID compatibility.';
                  pgm_name = symget('mc_fname');
                  pgm_path = symget('mc_fpath');
                  output_path = symget('mc_update_outpath');
                  original_text = mc_before_rule;
                  output;
               end;
            end;

            *** Rule O3 update: preserve _GSFNAME around FILENAME _ALL statement. ***;
            *** FILENAME _ALL can clear _GSFNAME so save the current option before. ***;
            *** Restore the option immediately after the filename statement.        ***;
            if prxmatch('/\bfilename\s+_all_\s*;/i', updated_text) and
               not prxmatch('/^\s*\*\*\*\s*Updated to preserve _GSFNAME\s*\*\*\*/i', updated_text) then do;
               mc_before_rule = updated_text;
               mc_o3_apply = 1;

               rule_id = 'O3';
               update_desc = 'Inserted _GSFNAME save and restore logic around FILENAME _ALL_; for Linux/target platform compatibility.';
               pgm_name = symget('mc_fname');
               pgm_path = symget('mc_fpath');
               output_path = symget('mc_update_outpath');
               original_text = mc_before_rule;
               output;
            end;

            *** Rule O5 update: insert VALIDVARNAME=V7 before Excel PROC IMPORT. ***;
            *** Detect PROC IMPORT where .xlsx or DBMS=XLSX appears on this line or within the next two lines. ***;
            *** Insert OPTIONS VALIDVARNAME=V7 immediately above the PROC IMPORT line. ***;
            mc_o5_context = catx(' ', updated_text, mc_next_line1, mc_next_line2);
            if not prxmatch('/^\s*(\*|\/\*)/', updated_text) and
               prxmatch('/\bproc\s+import\b/i', updated_text) and
               (prxmatch('/\.xlsx/i', mc_o5_context) or
                prxmatch('/\bdbms\s*=\s*xlsx\b/i', mc_o5_context)) and
               not prxmatch('/^\s*options\s+validvarname\s*=\s*v7\s*;/i', mc_prev_line) then do;
               mc_before_rule = updated_text;
               mc_o5_apply = 1;

               rule_id = 'O5';
               update_desc = 'Inserted OPTIONS VALIDVARNAME=V7 before Excel PROC IMPORT using .xlsx or DBMS=XLSX.';
               pgm_name = symget('mc_fname');
               pgm_path = symget('mc_fpath');
               output_path = symget('mc_update_outpath');
               original_text = mc_before_rule;
               updated_text = cats('options validvarname=v7;', '0A'x, mc_before_rule);
               output;
               updated_text = mc_before_rule;
            end;

            *** Rule O6 update: replace shell COPY command with FCOPY logic. ***;
            *** Detect X COPY commands that use single or double quoted shell commands. ***;
            *** The original command is commented and an FCOPY replacement block is inserted below. ***;
            if prxmatch("/^\s*x\s*[""']copy\s+/i", updated_text) and
               not prxmatch('/^\s*\*\*\*\s*Update to use fcopy \( \)\s*\*\*\*/i', updated_text) then do;
               mc_before_rule = updated_text;
               *** Use greedy capture so doubled quotes inside the command are not treated as the end of the X string. ***;
               *** Example payload retained as doubled-quoted source and target path values. ***;
               mc_o6_args = prxchange("s/^\s*x\s*[""']copy\s+(.*)[""']\s*;?\s*$/\1/i", 1, updated_text);
               mc_o6_args = strip(mc_o6_args);

               *** Rule O6 enhancement: when file paths are wrapped in doubled quotation marks, ***;
               *** use the quote pairs to delimit the two paths instead of using spaces.          ***;
               *** Example uses doubled-quoted source path followed by doubled-quoted target path. ***;
               mc_o6_oldfile = '';
               mc_o6_newfile = '';

               if substr(strip(mc_o6_args), 1, 2) = '""' then do;
                  mc_o6_work = substr(strip(mc_o6_args), 3);
                  mc_o6_pos  = index(mc_o6_work, '""');

                  if mc_o6_pos > 0 then do;
                     mc_o6_oldfile = substr(mc_o6_work, 1, mc_o6_pos - 1);
                     mc_o6_work    = left(substr(mc_o6_work, mc_o6_pos + 2));

                     if substr(mc_o6_work, 1, 2) = '""' then mc_o6_work = substr(mc_o6_work, 3);
                     mc_o6_pos = index(mc_o6_work, '""');

                     if mc_o6_pos > 0 then
                        mc_o6_newfile = substr(mc_o6_work, 1, mc_o6_pos - 1);
                  end;
               end;

               *** Fallback: commands without quoted paths are split on spaces. ***;
               else do;
                  mc_o6_oldfile = scan(mc_o6_args, 1, ' ');
                  mc_o6_newfile = scan(mc_o6_args, 2, ' ');
               end;

               *** Remove any remaining doubled quote wrappers defensively before writing FILENAME statements. ***;
               mc_o6_oldfile = tranwrd(strip(mc_o6_oldfile), '""', '');
               mc_o6_newfile = tranwrd(strip(mc_o6_newfile), '""', '');

               if lengthn(mc_o6_oldfile) > 0 and lengthn(mc_o6_newfile) > 0 and
                  strip(mc_o6_args) ne strip(mc_before_rule) then do;
                  updated_text = cats('*** Update to use fcopy ( ) *** ', updated_text);
                  mc_o6_apply = 1;

                  rule_id = 'O6';
                  update_desc = cats('Commented X COPY command and inserted FCOPY replacement logic from ',
                                     substr(strip(mc_o6_oldfile), 1, 70), ' to ',
                                     substr(strip(mc_o6_newfile), 1, 70), '.');
                  pgm_name = symget('mc_fname');
                  pgm_path = symget('mc_fpath');
                  output_path = symget('mc_update_outpath');
                  original_text = mc_before_rule;
                  output;
               end;
            end;

            *** Rule L3 update: replace Windows DEL shell command with Linux rm -f command. ***;
            *** Detect X "DEL ...", X 'DEL ...', and SYSTASK COMMAND="DEL ...".   ***;
            *** The original command line is converted in place and prefixed with a       ***;
            *** comment so the migrated program documents the Linux/target platform change.        ***;
            if not prxmatch('/^\s*(\*|\/\*)/', updated_text) and
               (prxmatch("/\bx\s*[""']del\s+/i", updated_text) or
                prxmatch('/\bsystask\s+command\s*=\s*"del\s+/i', updated_text)) and
               not prxmatch('/^\s*\*\*\*\s*Update del command with rm\s*\*\*\*;/i', updated_text) then do;
               mc_before_rule = updated_text;

               if prxmatch("/\bx\s*[""']del\s+/i", updated_text) then
                  updated_text = prxchange("s/(\bx\s*[""'])del\s+/\1rm -f /i", 1, updated_text);
               else if prxmatch('/\bsystask\s+command\s*=\s*"del\s+/i', updated_text) then
                  updated_text = prxchange('s/(\bsystask\s+command\s*=\s*")del\s+/\1rm -f /i', 1, updated_text);

               if mc_before_rule ne updated_text then do;
                  updated_text = cats('*** Update del command with rm ***; ', updated_text);

                  rule_id = 'L3';
                  update_desc = 'Commented Windows DEL command and replaced DEL with rm -f for Linux/target platform delete compatibility.';
                  pgm_name = symget('mc_fname');
                  pgm_path = symget('mc_fpath');
                  output_path = symget('mc_update_outpath');
                  original_text = mc_before_rule;
                  output;
               end;
            end;

            *** Rule S1 update: replace &_SASPROGRAMFILE with %sysget(SAS_EXECFILEPATH). ***;
            *** This mirrors the S5 update pattern by capturing the original line, writing ***;
            *** the updated line to the OS-specific output target and documenting        ***;
            *** Update Details.                                                         ***;
            mc_s1_repl = cats('%', 'sysget(SAS_EXECFILEPATH)');
            if prxmatch('/&_sasprogramfile/i', updated_text) then do;
               mc_before_rule = updated_text;
               updated_text = prxchange(cats('s/&_SASPROGRAMFILE/', mc_s1_repl, '/i'), -1, updated_text);

               rule_id = 'S1';
               update_desc = 'Replaced &_SASPROGRAMFILE with %sysget(SAS_EXECFILEPATH) for Linux/target platform current-program-path compatibility.';
               pgm_name = symget('mc_fname');
               pgm_path = symget('mc_fpath');
               output_path = symget('mc_update_outpath');
               original_text = mc_before_rule;
               output;
            end;

            *** Rule S5 update: convert Windows backslash path separators to Linux/target platform ***;
            *** forward slashes. The classification is identical to the one used for      ***;
            *** detection, so the workbook and the updated program always agree.          ***;
            if mc_s5_class = 'PATH' then do;
               mc_before_rule = updated_text;
               updated_text = translate(updated_text, '/', '\');

               rule_id = 'S5';
               update_desc = 'Converted Windows backslash path separator to Linux/target platform forward slash separator.';
               pgm_name = symget('mc_fname');
               pgm_path = symget('mc_fpath');
               output_path = symget('mc_update_outpath');
               original_text = mc_before_rule;
               output;
            end;

            *** Insert replacement code generated by Rule O1 before writing the commented original line. ***;
            if lengthn(mc_o1_path_out) > 0 then do;
               put 'data _null_;';
               put '   rc = dlgcdir("' mc_o1_path_out +(-1) '");';
               put '   put "NOTE: Change directory return code (0 means success): " rc;';
               put 'run;';
            end;

            *** Insert save logic generated by Rule O3 before writing FILENAME _ALL. ***;
            if mc_o3_apply = 1 then do;
               put '%let old_path=;';
               put ' ';
               put 'data _null_;';
               put '    if fileref(''_GSFNAME'') = 0 then';
               put '    call symputx(''old_path'', pathname(''_GSFNAME''), ''g'');';
               put 'run;';
            end;

            *** Insert VALIDVARNAME option generated by Rule O5 immediately above PROC IMPORT. ***;
            if mc_o5_apply = 1 then do;
               put 'options validvarname=v7;';
            end;

            *** Always write exactly one output line for each input line, plus any inserted replacement block above. ***;
            updated_len = lengthn(updated_text);
            if updated_len = 0 then put;
            else put updated_text $varying32767. updated_len;

            *** Insert replacement code generated by Rule O6 after writing the commented original COPY line. ***;
            if mc_o6_apply = 1 then do;
               put 'filename src  "' mc_o6_oldfile +(-1) '";';
               put 'filename dest "' mc_o6_newfile +(-1) '";';
               put ' ';
               put 'data _null_;';
               put '    rc = fcopy(''src'', ''dest'');';
               put '    if rc = 0 then put "NOTE: Copied ' mc_o6_oldfile +(-1) ' to ' mc_o6_newfile +(-1) '";';
               put '    else put "ER" "ROR: Copy failed. " rc= sysmsg();';
               put 'run;';
            end;

            *** Insert restore logic generated by Rule O3 after writing FILENAME _ALL. ***;
            if mc_o3_apply = 1 then do;
               put 'data _null_;';
               put '    if symget(''old_path'') ne '''' then call execute(cats(''filename _GSFNAME "'', symget(''old_path''), ''";''));';
               put '    else call execute(''filename _GSFNAME temp;'');';
               put 'run;';
            end;

            keep rule_id update_desc pgm_name pgm_path output_path line_num original_text updated_text;
         run;

         proc append base=MC_UPDATE data=_MC_UPDATE_FILE force;
         run;

         filename JMUPD clear;
         %end;
      %end;

      /* Whole-program context was collected during the initial JMSCAN read.
         Reuse _MC_SRC_LOOK directly; no duplicate _MC_FIND_* reconstruction is required. */

      data _MC_FILE_FINDINGS;
         length category $60
                rule_id $20
                rule_name $200
                rule_desc $1000
                criteria $500
                pgm_name $256
                pgm_path $1024
                line_num 8
                line_text $32767
                line_up $32767
                mc_path_ref $1024
                mc_folder_ref $1024
                mc_case_detail $1000
                mc_f2_ref $256
                mc_f2_prefix $32767
                mc_f2_token_prefix $1024
                mc_f2_parent $1024
                mc_f2_srcpath $1024
                mc_f2_srcdir $1024
                mc_f2_child $1024
                mc_f2_entry $256
                mc_f2_actual $256
                mc_f2_cache_parent $1024
                mc_f2_cache_ref $256
                mc_f2_cache_actual $256
                mc_f2_sep $1
                mc_s5_class $10
               
                mc_toc_ref $256
                lower_name $256
                actual_name $256
                mc_toc_expected $256
                mc_f3_option $40
                mc_f3_matches $500
                mc_pre_line $32767
                mc_prev_line $32767
                mc_prev_line2 $32767
                mc_prev_line3 $32767
                mc_next_line1 $32767
                mc_next_line2 $32767
                mc_o5_context $32767
                c $1
                encoding_risk_chars $1000
                encoding_risk_hex $1000;
         /* Carry the full MIGRATION_CHECK structure for direct append. */
         if 0 then set MIGRATION_CHECK;

         if _n_ = 1 then do;
            declare hash mc_f2_cache_find();
            mc_f2_cache_find.defineKey('mc_f2_cache_parent', 'mc_f2_cache_ref');
            mc_f2_cache_find.defineData('mc_f2_cache_actual', 'mc_f2_cache_verified');
            mc_f2_cache_find.defineDone();
            declare hash mc_toc_map_find(dataset:'MC_TOC_CASEMAP');
            mc_toc_map_find.defineKey('lower_name');
            mc_toc_map_find.defineData('actual_name');
            mc_toc_map_find.defineDone();
         end;

         set _MC_SRC_LOOK;
         line_text = mc_line;

         pgm_name = symget('mc_fname');
         pgm_path = symget('mc_fpath');

         *** Capture the physical source line number before any rule output. ***;
         mc_file_line_num = line_num;

         line_up = upcase(line_text);

         *** Initialize F4-only path variables because F4 may be disabled at compile time. ***;
         mc_path_ref = '';
         mc_folder_ref = '';

         *** Shared WIN exemption for Rules F3, O1, and L1. ***;
         *** Review one, two, and three source lines immediately above current line. ***;
         *** A quoted WIN marker means the current candidate is considered passed.  ***;
         mc_win_exempt = (
            index(upcase(mc_prev_line),  '"WIN"') > 0 or
            index(upcase(mc_prev_line),  "'WIN'") > 0 or
            index(upcase(mc_prev_line2), '"WIN"') > 0 or
            index(upcase(mc_prev_line2), "'WIN'") > 0 or
            index(upcase(mc_prev_line3), '"WIN"') > 0 or
            index(upcase(mc_prev_line3), "'WIN'") > 0
         );

         /* Rules O1-O6: line-level OS command checks using explicit conditions. */
         if mc_win_exempt = 0 and
            (prxmatch('/\bx\s*["'']cd\s+/i', line_text) or
             prxmatch('/\bsystask\s+command\s*=\s*"cd\s+/i', line_text)) then do;
            category = 'OS Commands & Shell';
            rule_id = 'O1';
            rule_name = 'DOS cd command';
            rule_desc = 'Line contains X or SYSTASK CD command. Use rc=dlgcdir(path) instead where appropriate.';
            criteria = 'Matched: x "cd, x ''cd, or systask command="cd';
            output;
         end;

         if prxmatch('/%sysget\s*\(\s*username\s*\)/i', line_text) then do;
            category = 'OS Commands & Shell';
            rule_id = 'O2';
            rule_name = 'Obtain User ID';
            rule_desc = 'Line contains %SYSGET(USERNAME), which does not resolve on Linux/target platform. Use %SYSGET(USER) or the automatic macro variable &SYSUSERID instead.';
            criteria = 'Matched: %SYSGET(USERNAME)';
            output;
         end;

         if prxmatch('/\bfilename\s+_all_\s*;/i', line_text) then do;
            category = 'OS Commands & Shell';
            rule_id = 'O3';
            rule_name = 'Remove filenames';
            rule_desc = 'Line contains FILENAME _ALL_; which may remove required filerefs. Capture and restore required filerefs as needed.';
            criteria = 'Matched: filename _all_;';
            output;
         end;

         if prxmatch('/_sasprogramfile/i', line_text) then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S1';
            rule_name = 'Current program name';
            rule_desc = 'Line references _SASPROGRAMFILE. Review current-program-name logic for Linux/target platform compatibility.';
            criteria = 'Matched: _sasprogramfile';
            output;
         end;

         if prxmatch('/\bproc\s+append\b/i', line_text) then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S2';
            rule_name = 'Appending to Excel';
            rule_desc = 'Line contains PROC APPEND. Review whether this is appending to an Excel libname or another Windows-specific workflow that must be updated for Linux/target platform.';
            criteria = 'Matched: proc append';
            output;
         end;

         if prxmatch('/\blibname\b/i', line_text) and
            prxmatch('/\bexcel\b/i', line_text) then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S3';
            rule_name = 'Libname Excel';
            rule_desc = 'Line contains LIBNAME and EXCEL on the same line. Review Excel libname logic for Linux/target platform compatibility.';
            criteria = 'Matched on same line: libname + excel';
            output;
         end;
         else if prxmatch('/\bproc\s+export\b/i', line_text) then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S3';
            rule_name = 'Libname Excel';
            rule_desc = 'Line contains PROC EXPORT. Review Excel/file export logic for Linux/target platform compatibility.';
            criteria = 'Matched: proc export';
            output;
         end;
         else if prxmatch('/\bproc\s+import\b/i', line_text) and
                 prxmatch('/\bdbms\s*=\s*excel\b/i', line_text) then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S3';
            rule_name = 'Libname Excel';
            rule_desc = 'Line contains PROC IMPORT and DBMS=EXCEL on the same line. Review Excel import logic for Linux/target platform compatibility.';
            criteria = 'Matched on same line: proc import + dbms=excel';
            output;
         end;

         if index(line_text, 'ER' || 'ROR:') > 0 or
            index(line_text, 'WARN' || 'ING:') > 0 or
            (index(line_text, 'ER') > 0 and index(line_text, 'ROR:') > 0) or
            (index(line_text, 'WAR') > 0 and index(line_text, 'NING:') > 0) then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S4';
            rule_name = 'ER' || 'ROR/WA' || 'RNING log position';
            rule_desc = 'Line contains uppercase ERR' || 'OR:/WARN' || 'ING: text or split ER ROR:/WAR NING: text. Review log parsing logic because Linux can shift these messages from the first position.';
            criteria = 'Matched uppercase: ER' || 'ROR:, WARN' || 'ING:, ER + ROR:, or WAR + NING:';
            output;
         end;

         /* --- Rule S5 backslash classification. ------------------------- */
         /* Reuse LINE_UP so UPCASE is not recalculated repeatedly. */
         %MC_S5_CLASSIFY(_IN=line_text, _UP=line_up, _OUT=mc_s5_class)

         if mc_s5_class = 'PATH' then do;
            category = 'SAS Environment & Setup';
            rule_id = 'S5';
            rule_name = 'Windows path backslash';
            rule_desc = 'Line contains one of the configured Windows-path indicators and should be converted or reviewed for Linux/target platform.';
            criteria = 'Matched S5 path indicator: C:\, D:\, E:\, F:\, G:\, H:\, two consecutive backslashes, .\, or ..\; Action=CONVERT';
            output;
         end;

         if prxmatch('/\.bat\b/i', line_text) then do;
            category = 'Data Import & Export';
            rule_id = 'D1';
            rule_name = 'BAT file';
            rule_desc = 'Line contains a .bat file reference. Update Windows batch file logic to Linux shell script logic where applicable.';
            criteria = 'Matched: .bat';
            output;
         end;

         if prxmatch('/\.sh(\s|["'';]|$)/i', line_text) and
            symget('mc_has_chmod') ne 'yes' then do;
            category = 'Data Import & Export';
            rule_id = 'D2';
            rule_name = 'Executing Command';
            rule_desc = 'Line contains a .sh file reference, but the program does not contain CHMOD anywhere. Add chmod permission handling before executing shell scripts on Linux.';
            criteria = 'Matched: .sh; Missing in program: chmod';
            output;
         end;

         if index(line_text, "â€˜") > 0 or index(line_text, "â€™") > 0 then do;
            category = 'Data Import & Export';
            rule_id = 'D3';
            rule_name = 'Special characters';
            rule_desc = 'Line contains curly quote characters that can cause issues on Linux. Replace with a standard single quote where appropriate.';
            criteria = 'Matched: "â€˜" or "â€™"';
            output;
         end;

         if prxmatch('/patient profiles[\\\/]/i', line_text) or
            prxmatch('/[\\\/]vendor/i', line_text) or
            prxmatch('/[\\\/]profile/i', line_text) or
            prxmatch('/anadata[\\\/]sdtm([\\\/]|\b)/i', line_text) or
            prxmatch('/reference[\\\/]smq/i', line_text) or
            prxmatch('/validate[\\\/]tlf[\\\/]qcdata/i', line_text) then do;
            category = 'Character Encoding & Special Characters';
            rule_id = 'C1';
            rule_name = 'Source-Platform Folders';
            rule_desc = 'Line contains a source-platform folder reference that should be reviewed and mapped for Linux/target platform compatibility.';
            criteria = 'Matched source-platform folder: Patient Profiles, vendor, profile, anadata/SDTM, reference/SMQ, or validate/tlf/QCdata';
            output;
         end;

         if prxmatch('/\bsasuser\b/i', line_text) then do;
            category = 'Character Encoding & Special Characters';
            rule_id = 'C2';
            rule_name = 'Write to SASUSER';
            rule_desc = 'Line contains SASUSER. Review because SASUSER may be read-only in Linux/target platform.';
            criteria = 'Matched: sasuser';
            output;
         end;

         if mc_win_exempt = 0 and
            prxmatch('/\blibname\s+(cdf|here|pfdata|vendordata|rawvend|raww|sdtma|smq|tlfout|tlfvdata|utility)\b/i', line_text) then do;
            category = 'Library & Path References';
            rule_id = 'L1';
            rule_name = 'Standard libnames';
            rule_desc = 'Line contains a LIBNAME statement for a standard Windows/source platform libref that should be reviewed for Linux/target platform compatibility.';
            criteria = 'Matched: libname CDF/HERE/PFDATA/VENDORPKATA/RAWVEND/RAWW/SDTMA/SMQ/TLFOUT/TLFVDATA/UTILITY';
            output;
         end;

         if prxmatch('/\bfilename\b/i', line_text) and
            prxmatch('/\bpipe\b/i', line_text) then do;
            category = 'Library & Path References';
            rule_id = 'L2';
            rule_name = 'Directory of files';
            rule_desc = 'Line contains FILENAME and PIPE. Review command syntax and update to Linux/target platform-compatible logic where needed.';
            criteria = 'Matched on same line: filename + pipe';
            output;
         end;

         if not prxmatch('/^\s*(\*|\/\*)/', line_text) and
            (prxmatch("/\bx\s*[""']del\s+/i", line_text) or
             prxmatch('/\bsystask\s+command\s*=\s*"del\s+/i', line_text)) then do;
            category = 'Library & Path References';
            rule_id = 'L3';
            rule_name = 'Delete files';
            rule_desc = 'Line contains an X DEL or SYSTASK COMMAND="DEL ..." statement. Update Windows delete command to Linux-compatible rm -f logic.';
            criteria = 'Matched: x "del, x ''del, or systask command="del';
            output;
         end;

         /* Rule L4: identify only encoding-sensitive characters.
            Do not use NOTALNUM because many valid SAS characters such as
            spaces, quotes, operators, and punctuation are expected. Only
            flag bytes above 127, which are more likely to cause encoding
            differences between Windows and Linux/target platform. */
         mc_pre_line = line_text;
         encoding_risk_count = 0;
         encoding_risk_chars = '';
         encoding_risk_hex = '';

         /* Fast gate: only inspect individual bytes when non-ASCII is present. */
         if prxmatch('/[^\x00-\x7F]/', mc_pre_line) then do;
            do i = 1 to length(mc_pre_line);
               c = substr(mc_pre_line, i, 1);
               code = rank(c);

               if code > 127 then do;
                  encoding_risk_count + 1;
                  encoding_risk_chars = catx(', ', encoding_risk_chars,
                                             cats('pos', i, '=[NON_ASCII]'));
                  encoding_risk_hex = catx(', ', encoding_risk_hex,
                                           cats('pos', i,
                                                '=[HEX:', put(code, hex2.), ']'));
               end;
            end;
         end;

         has_encoding_risk = (encoding_risk_count > 0);

         if has_encoding_risk then do;
            category = 'Library & Path References';
            rule_id = 'L4';
            rule_name = 'Encoding-sensitive characters';
            rule_desc = 'Line contains one or more characters with byte value greater than 127. Review these characters for Windows-to-Linux/target platform encoding compatibility.';
            criteria = catx('; ',
                            cats('Encoding risk count=', encoding_risk_count),
                            cats('Characters: ', encoding_risk_chars),
                            cats('Hex: ', encoding_risk_hex));
            output;
         end;

         mc_o5_context = catx(' ', line_text, mc_next_line1, mc_next_line2);
         if not prxmatch('/^\s*(\*|\/\*)/', line_text) and
            prxmatch('/\bproc\s+import\b/i', line_text) and
            (prxmatch('/\.xlsx/i', mc_o5_context) or
             prxmatch('/\bdbms\s*=\s*xlsx\b/i', mc_o5_context)) and
            not prxmatch('/^\s*options\s+validvarname\s*=\s*v7\s*;/i', mc_prev_line) then do;
            category = 'OS Commands & Shell';
            rule_id = 'O5';
            rule_name = 'Importing Excel';
            rule_desc = 'PROC IMPORT reads an Excel .xlsx file. Insert OPTIONS VALIDVARNAME=V7 immediately above the PROC IMPORT statement.';
            criteria = 'Matched: proc import plus .xlsx or dbms=xlsx on same line or within next two lines';
            output;
         end;

         if prxmatch('/\bx\s*"copy\s+/i', line_text) or
            prxmatch('/\bsystask\s+command\s*=\s*"cmd\s+\/c\s+copy\s+/i', line_text) then do;
            category = 'OS Commands & Shell';
            rule_id = 'O6';
            rule_name = 'Copying files';
            rule_desc = 'Line contains Windows COPY command through X or SYSTASK. Use FCOPY or another Linux-compatible file copy approach.';
            criteria = 'Matched: x "copy or systask command="cmd /c copy';
            output;
         end;

         /* Rule F3: identify OPTIONS statements that include X command related
            options. This rule is case-insensitive and only fires when the line
            contains OPTIONS plus at least one of XSYNC, NOXSYNC, XWAIT, NOXWAIT, XCMD,
            or NOXCMD. */
         retain mc_f3_re;
         if _n_ = 1 then
            mc_f3_re = prxparse('/\b(noxsync|xsync|noxwait|xwait|noxcmd|xcmd)\b/i');

         if mc_win_exempt = 0 and
            prxmatch('/\boptions\b/i', line_text) then do;
            mc_f3_matches = '';
            mc_f3_start = 1;
            mc_f3_stop = lengthn(line_text);
            call prxnext(mc_f3_re, mc_f3_start, mc_f3_stop, line_text,
                         mc_f3_pos, mc_f3_len);

            do while (mc_f3_pos > 0);
               mc_f3_option = substr(line_text, mc_f3_pos, mc_f3_len);
               mc_f3_matches = catx(' | ', mc_f3_matches,
                                     cats('Option=[', strip(mc_f3_option), ']'));
               call prxnext(mc_f3_re, mc_f3_start, mc_f3_stop, line_text,
                            mc_f3_pos, mc_f3_len);
            end;

            if lengthn(mc_f3_matches) > 0 then do;
               category = 'File & Folder Structure';
               rule_id = 'F3';
               rule_name = 'X command related OPTIONS';
               rule_desc = 'OPTIONS statement contains X command related option that should be reviewed for Linux/target platform compatibility.';
               criteria = mc_f3_matches;
               output;
            end;
         end;


         /* Rule F1: identify TOC workbook references in the SAS source line
            and flag casing variants that do not match the physical file name
            found within MC_PGMPATH or one of its descendant folders. */
         retain mc_toc_re;
         if _n_ = 1 then
            mc_toc_re = prxparse(symget('mc_toc_regex'));

         if lengthn(line_text) > 0 then do;
            mc_toc_start = 1;
            mc_toc_stop = lengthn(line_text);
            call prxnext(mc_toc_re, mc_toc_start, mc_toc_stop, line_text,
                         mc_toc_pos, mc_toc_len);

            do while (mc_toc_pos > 0);
               mc_toc_ref = substr(line_text, mc_toc_pos, mc_toc_len);
               mc_toc_expected = '';
               lower_name = lowcase(strip(mc_toc_ref));
               actual_name = '';
               if mc_toc_map_find.find() = 0 then
                  mc_toc_expected = actual_name;

               if lengthn(mc_toc_expected) > 0 and strip(mc_toc_ref) ne strip(mc_toc_expected) then do;
                  category = 'File & Folder Structure';
                  rule_id = 'F1';
                  rule_name = 'TOC Casing';
                  rule_desc = 'A configured TOC workbook filename casing does not match the physical file name casing found in the study folder tree.';
                  criteria = cats('Referenced=[', strip(mc_toc_ref),
                                  '] Physical file=[', strip(mc_toc_expected), ']');
                  output;
               end;

               call prxnext(mc_toc_re, mc_toc_start, mc_toc_stop, line_text,
                            mc_toc_pos, mc_toc_len);
            end;
         end;

         /* Active line-level rules are evaluated explicitly. F5/F6/O4/S7 are
            inventory/program-level checks, so no per-line CRITERIA_DEF POINT= scan is needed. */

         /* Rule F2: compare each referenced folder segment to the casing
            returned by its exact physical parent directory. This path-context
            check prevents casing from an unrelated same-named folder elsewhere
            in the scan tree from being applied to the current reference. */
         retain mc_path_re mc_f2_seg_re_find;
         if _n_ = 1 then do;
            /* mc_path_re remains available for Rule F4 below. */
            mc_path_re = prxparse('/((?:[A-Za-z]:|\\\\)?[^"''\s;,()]*\\[^"''\s;,()]*)/');
            mc_f2_seg_re_find = prxparse('/[\\\/]([^\\\/"''\s;,()]+)/');
         end;

         if lengthn(line_text) > 0 and not missing(mc_f2_seg_re_find)
            and not prxmatch('/^\s*(%?\*|\/\*)/', line_text) then do;
            mc_f2_start = 1;
            mc_f2_stop = lengthn(line_text);
            mc_case_detail = '';

            call prxnext(mc_f2_seg_re_find, mc_f2_start, mc_f2_stop,
                         line_text, mc_f2_pos, mc_f2_len);

            do while (mc_f2_pos > 0);
               if mc_f2_len > 1 and mc_f2_pos < lengthn(line_text) then
                  mc_f2_ref = substrn(line_text, mc_f2_pos + 1, mc_f2_len - 1);
               else
                  mc_f2_ref = '';
               mc_f2_actual = '';
               mc_f2_parent = '';
               mc_f2_child = '';
               mc_f2_verified = 0;

               if not missing(mc_f2_ref) and strip(mc_f2_ref) not in ('.', '..') then do;

                  if mc_f2_pos > 1 then
                     mc_f2_prefix = substrn(line_text, 1, max(0, mc_f2_pos - 1));
                  else
                     mc_f2_prefix = '';

                  mc_f2_dq = findc(substrn(mc_f2_prefix, 1, lengthn(mc_f2_prefix)), '"', 'b');
                  mc_f2_sq = findc(substrn(mc_f2_prefix, 1, lengthn(mc_f2_prefix)), "'", 'b');
                  mc_f2_qpos = max(mc_f2_dq, mc_f2_sq);

                  if mc_f2_qpos > 0 then
                     mc_f2_token_prefix = substrn(mc_f2_prefix, mc_f2_qpos + 1);
                  else do;
                     mc_f2_delim = findc(substrn(mc_f2_prefix, 1, lengthn(mc_f2_prefix)), ' =,();', 'b');
                     if mc_f2_delim > 0 then
                        mc_f2_token_prefix = substrn(mc_f2_prefix, mc_f2_delim + 1);
                     else
                        mc_f2_token_prefix = mc_f2_prefix;
                  end;

                  mc_f2_token_prefix = strip(mc_f2_token_prefix);

                  if prxmatch('/^[A-Za-z]:/', strip(mc_f2_token_prefix)) or
                     substrn(strip(mc_f2_token_prefix), 1, 2) = '\\' or
                     substrn(strip(mc_f2_token_prefix), 1, 1) = '/' then
                     mc_f2_parent = strip(mc_f2_token_prefix);
                  else if not missing(mc_f2_token_prefix) and
                          index(mc_f2_token_prefix, '&') = 0 and
                          index(mc_f2_token_prefix, '%') = 0 then do;
                     mc_f2_srcpath = symget('mc_fpath');
                     mc_f2_srcdir = prxchange('s#[\\/][^\\/]+$##', 1,
                                              strip(mc_f2_srcpath));

                     if index(mc_f2_srcdir, '\') > 0 then mc_f2_sep = '\';
                     else mc_f2_sep = '/';

                     mc_f2_parent = cats(strip(mc_f2_srcdir),
                                          mc_f2_sep,
                                          strip(mc_f2_token_prefix));
                  end;

                  if prxmatch('/^[A-Za-z]:$/', strip(mc_f2_parent)) then
                     mc_f2_parent = cats(strip(mc_f2_parent), '\');

                  if not missing(mc_f2_parent) and
                     index(mc_f2_parent, '&') = 0 and
                     index(mc_f2_parent, '%') = 0 then do;

                     mc_f2_cache_parent = strip(mc_f2_parent);
                     mc_f2_cache_ref = lowcase(strip(mc_f2_ref));
                     mc_f2_cache_actual = '';
                     mc_f2_cache_verified = 0;
                     rc_f2_cache = mc_f2_cache_find.find();

                     if rc_f2_cache = 0 then do;
                        mc_f2_actual = mc_f2_cache_actual;
                        mc_f2_verified = mc_f2_cache_verified;
                     end;
                     else do;
                        rc_f2 = filename('JMF2PAR', strip(mc_f2_parent));
                        did_f2 = dopen('JMF2PAR');

                        if did_f2 > 0 then do;
                           do mc_f2_i = 1 to dnum(did_f2);
                              mc_f2_entry = dread(did_f2, mc_f2_i);
                              if lowcase(strip(mc_f2_entry)) = lowcase(strip(mc_f2_ref)) then do;
                                 mc_f2_actual = strip(mc_f2_entry);
                                 leave;
                              end;
                           end;
                           rc_f2close = dclose(did_f2);
                        end;
                        rc_f2 = filename('JMF2PAR');

                        if not missing(mc_f2_actual) then do;
                           if index(mc_f2_parent, '\') > 0 or
                              prxmatch('/^[A-Za-z]:/', strip(mc_f2_parent)) then mc_f2_sep = '\';
                           else mc_f2_sep = '/';

                           mc_f2_child = cats(strip(mc_f2_parent), mc_f2_sep, strip(mc_f2_actual));
                           rc_f2 = filename('JMF2CHK', strip(mc_f2_child));
                           did_f2_chk = dopen('JMF2CHK');
                           if did_f2_chk > 0 then do;
                              mc_f2_verified = 1;
                              rc_f2close = dclose(did_f2_chk);
                           end;
                           rc_f2 = filename('JMF2CHK');
                        end;

                        mc_f2_cache_actual = mc_f2_actual;
                        mc_f2_cache_verified = mc_f2_verified;
                        rc_f2_cache = mc_f2_cache_find.add();
                     end;
                  end;

                  if mc_f2_verified = 1 and
                     strip(mc_f2_ref) ne strip(mc_f2_actual) then
                     mc_case_detail = catx(' | ', mc_case_detail,
                        cats('Referenced=[', strip(mc_f2_ref),
                             '] Physical=[', strip(mc_f2_actual),
                             '] Parent=[', strip(mc_f2_parent), ']'));
               end;

               call prxnext(mc_f2_seg_re_find, mc_f2_start, mc_f2_stop,
                            line_text, mc_f2_pos, mc_f2_len);
            end;

            if lengthn(mc_case_detail) > 0 then do;
               category = 'File & Folder Structure';
               rule_id = 'F2';
               rule_name = 'Folder Name Casing';
               rule_desc = 'Folder path referenced in the SAS program does not match the casing returned by the exact physical parent directory.';
               criteria = substr(mc_case_detail, 1, 500);
               output;
            end;
         end;

         %if %upcase(&mc_rule_f4_enabled) = Y %then %do;
         /* Rule F4: identify Windows-style path references in the SAS source line
            and count folder depth from the referenced path. Capture the finding
            only when the referenced path exceeds 7 folder levels. */
         if lengthn(line_text) > 0 then do;
            mc_start = 1;
            mc_stop = lengthn(line_text);
            call prxnext(mc_path_re, mc_start, mc_stop, line_text, mc_pos, mc_len);

            do while (mc_pos > 0);
            mc_path_ref = substr(line_text, mc_pos, mc_len);
            mc_path_ref = prxchange('s#[\\/.,:]+$##', 1, strip(mc_path_ref));

            if index(mc_path_ref, '\') > 0 then do;
               mc_last_slash = findc(mc_path_ref, '\', 'b');
               if mc_last_slash > 1 then mc_folder_ref = substr(mc_path_ref, 1, mc_last_slash - 1);
               else if mc_last_slash = 1 then mc_folder_ref = '';
               else mc_folder_ref = mc_path_ref;

               mc_depth = countw(mc_folder_ref, '\');

               /* Do not count the drive segment for absolute Windows paths. */
               if prxmatch('/^[A-Za-z]:\\/', mc_folder_ref) then mc_depth = mc_depth - 1;

               /* Do not count server/share segments for UNC paths. */
               else if substr(mc_folder_ref, 1, 2) = '\\' then mc_depth = max(0, mc_depth - 2);

               if mc_depth > 7 then do;
                  category = 'File & Folder Structure';
                  rule_id = 'F4';
                  rule_name = 'More 7 levels Folder';
                  rule_desc = 'Folder path referenced in the SAS program exceeds 7 folder levels and may lead to display issues in SAS Studio.';
                  criteria = cats('REFERENCED DIRECTORY LEVELS > 7; levels=', strip(put(mc_depth, best.)));
                  output;
               end;
            end;

               call prxnext(mc_path_re, mc_start, mc_stop, line_text, mc_pos, mc_len);
            end;
         end;
         %end;

         keep category rule_id rule_name rule_desc criteria pgm_name pgm_path
              line_num line_text
              s7_macro_name s7_purpose_macro_path s7_global_macro_path
              s7_purpose_line_text s7_global_line_text;
      run;



      data _MC_FILE_SPECIAL;
         length category $60
                rule_id $20
                rule_name $200
                rule_desc $1000
                criteria $500
                pgm_name $256
                pgm_path $1024
                line_num 8
                line_text $32767;
         if 0 then set MIGRATION_CHECK;

         /* Rule O4 applies only on Linux/target platform. Windows programs are not checked. */
         if upcase(symget('mc_os_family')) = 'LINUX' and
            symget('mc_has_setup_call') ne 'yes' then do;
            category = 'OS Commands & Shell';
            rule_id = 'O4';
            rule_name = 'Standard Setup Macro';
            rule_desc = 'Current Linux program did not invoke the required standard '
                      || '%' || 'setup macro.';
            criteria = 'Linux only: missing standard ' || '%' || 'setup macro invocation';
            pgm_name = symget('mc_fname');
            pgm_path = symget('mc_fpath');
            line_num = 0;
            line_text = 'Program-level check: required standard '
                     || '%' || 'setup macro invocation was not found.';

            /* Split ER/ROR and the percent sign in source so MPRINT does not create a false log hit. */
            put "ER" "ROR: Current program did not invoke the required standard `" '%' "setup` macro.";
            output;
         end;

         /*
            Rule S6 retired: do not create program-level findings for
            PROC IMPORT plus Excel/DDE DBMS usage. PROC IMPORT fileref
            conversion no longer applies.
         */
      run;

      /* Append directly; both per-file datasets already carry the MIGRATION_CHECK structure. */
      proc append base=MIGRATION_CHECK data=_MC_FILE_FINDINGS;
      run;

      proc append base=MIGRATION_CHECK data=_MC_FILE_SPECIAL;
      run;

      proc sql noprint;
         select count(*) into :mc_obs_found1 trimmed from _MC_FILE_FINDINGS;
         select count(*) into :mc_obs_found2 trimmed from _MC_FILE_SPECIAL;
      quit;

      %if %sysevalf(%superq(mc_obs_found1)=,boolean) %then %let mc_obs_found1 = 0;
      %if %sysevalf(%superq(mc_obs_found2)=,boolean) %then %let mc_obs_found2 = 0;
      %let mc_obs_found = %eval(&mc_obs_found1 + &mc_obs_found2);

      %put NOTE: [MIGRATION_CHECK] &mc_fname.: &mc_obs_found finding(s) identified.;

      %if "%upcase(&mc_loglevel)" = "RULE" %then %do;
         /* F5, F6, and S7 are evaluated once for the whole run outside this
            per-program loop, so their per-program RULE bars report 0. */
         proc sql noprint;
            create table _MC_RULE_HITS as
            select r.rule_id, r.rule_name, count(f.rule_id) as hits
              from (select distinct rule_id, rule_name from RULE_DEF) r
              left join (select rule_id from _MC_FILE_FINDINGS
                         union all
                         select rule_id from _MC_FILE_SPECIAL) f
                on r.rule_id = f.rule_id
             group by r.rule_id, r.rule_name
             order by r.rule_id;
            select count(*) into :mc_rule_cnt trimmed from _MC_RULE_HITS;
         quit;

         data _null_;
            set _MC_RULE_HITS;
            call execute(cats('%MC_PROGRESS(step=', _n_,
                              ",total=&mc_rule_cnt,message=Rule ", strip(rule_id),
                              ' ', strip(rule_name), ': ', put(hits, best.-l),
                              ' finding(s), prefix=MIGRATION_CHECK RULE)'));
         run;
      %end;

      %end;

   %end;

   /*--- Keep Program Path as folder only for the detail report. ---*/
   data MIGRATION_CHECK;
      set MIGRATION_CHECK;
      length mc_full_pgm_path $1024;

      *** Ensure Line Number is never missing in the Excel report.
          Line-level findings contain the actual source line number.
          Path-level findings use 0. ***;
      if missing(line_num) then line_num = 0;
      mc_full_pgm_path = strip(pgm_path);
      if prxmatch('/[\\\/][^\\\/]+$/', mc_full_pgm_path) then
         pgm_path = prxchange('s#[/\\][^/\\]+$##', 1, mc_full_pgm_path);
      drop mc_full_pgm_path;
   run;

   /*--- Sort Output Dataset ---*/
   proc sort data=MIGRATION_CHECK;
      by pgm_name line_num rule_id criteria;
   run;

   proc sql noprint;
      select count(*)
        into :mc_total_found trimmed
        from MIGRATION_CHECK;
   quit;

   %if %sysevalf(%superq(mc_total_found)=,boolean) %then %let mc_total_found = 0;

   %put NOTE: [MIGRATION_CHECK] Findings roll-up calculated &mc_total_found total finding(s).;
   %MC_STEP(message=Findings roll-up complete%str(,) &mc_total_found finding(s));

   /*--- Prepare ODS-safe report datasets. ---*/
   /*
      ODS Excel can fail with "Invalid characters were present in the data"
      when source code contains bytes/characters that are not valid for the
      session encoding.  Keep the original MIGRATION_CHECK values unchanged,
      but create ASCII-safe display variables for PROC REPORT.
   */

   /*
      Keep summary findings grouped by the actual source file.  Program names
      are not unique because archive/test folders can contain another program
      with the same filename.  Sorting only by PGM_NAME and LINE_NUM interleaves
      those records and makes a correct physical LINE_NUM appear incorrect.
   */
   proc sort data=MIGRATION_CHECK out=_MC_MIGRATION_SUMMARY_SRC;
      by pgm_name pgm_path line_num rule_id criteria;
   run;

   data MIGRATION_SUMMARY;
      set _MC_MIGRATION_SUMMARY_SRC;
      length pgm_name_disp $132
             pgm_path_disp $1024
             line_text_clean $32767
             line_text_disp $255
             criteria_disp $500
             rule_name_disp $200;

      *** Preserve the physical source line number already validated in MIGRATION_CHECK. ***;
      mc_row_id = _n_;
      pgm_name_disp = substr(pgm_name, 1, 132);

      array mc_src_txt[4] pgm_path line_text criteria rule_name;
      array mc_dst_txt[4] pgm_path_disp line_text_clean criteria_disp rule_name_disp;

      do mc_clean_idx = 1 to dim(mc_src_txt);
         mc_dst_txt[mc_clean_idx] = '';
         mc_out_pos = 0;

         do mc_clean_i = 1 to min(lengthn(mc_src_txt[mc_clean_idx]),
                                  vlength(mc_dst_txt[mc_clean_idx]));
            mc_clean_c = substr(mc_src_txt[mc_clean_idx], mc_clean_i, 1);
            mc_clean_code = rank(mc_clean_c);

            if 32 <= mc_clean_code <= 126 then mc_safe_c = mc_clean_c;
            else if mc_clean_code in (9, 10, 13) then mc_safe_c = ' ';
            else mc_safe_c = '?';

            mc_out_pos + 1;
            substr(mc_dst_txt[mc_clean_idx], mc_out_pos, 1) = mc_safe_c;
         end;
      end;

      if lengthn(line_text_clean) > 255 then
         line_text_disp = cats(substr(line_text_clean, 1, 252), '...');
      else line_text_disp = line_text_clean;

      drop mc_clean_: mc_out_pos mc_safe_c line_text_clean;
   run;

   data MIGRATION_CHECK_RPT;
      set MIGRATION_CHECK;
      length pgm_name_disp $132
             category_disp $60
             rule_desc_disp $1000
             criteria_disp $500
             rule_name_disp $200
             pgm_path_disp $1024
             line_text_disp $32767;

      pgm_name_disp = substr(pgm_name, 1, 132);

      array mc_src_txt[6] category rule_desc criteria rule_name pgm_path line_text;
      array mc_dst_txt[6] category_disp rule_desc_disp criteria_disp
                            rule_name_disp pgm_path_disp line_text_disp;

      do mc_clean_idx = 1 to dim(mc_src_txt);
         mc_dst_txt[mc_clean_idx] = '';
         mc_out_pos = 0;

         do mc_clean_i = 1 to min(lengthn(mc_src_txt[mc_clean_idx]),
                                  vlength(mc_dst_txt[mc_clean_idx]));
            mc_clean_c = substr(mc_src_txt[mc_clean_idx], mc_clean_i, 1);
            mc_clean_code = rank(mc_clean_c);

            if 32 <= mc_clean_code <= 126 then mc_safe_c = mc_clean_c;
            else if mc_clean_code in (9, 10, 13) then mc_safe_c = ' ';
            else mc_safe_c = '?';

            mc_out_pos + 1;
            substr(mc_dst_txt[mc_clean_idx], mc_out_pos, 1) = mc_safe_c;
         end;
      end;

      drop mc_clean_: mc_out_pos mc_safe_c;
   run;

   data MIGRATION_S7_RPT;
      set MIGRATION_CHECK;
      where rule_id = 'S7';
      length finding_message $32767
             category_disp $60
             rule_name_disp $200
             s7_macro_name_disp $256
             s7_purpose_macro_path_disp $1024
             s7_global_macro_path_disp $1024
             s7_purpose_line_text_disp $32767
             s7_global_line_text_disp $32767
             finding_message_disp $32767;

      finding_message = line_text;

      array mc_src_txt[7] category rule_name s7_macro_name
                          s7_purpose_macro_path s7_global_macro_path
                          s7_purpose_line_text s7_global_line_text;
      array mc_dst_txt[7] category_disp rule_name_disp s7_macro_name_disp
                          s7_purpose_macro_path_disp s7_global_macro_path_disp
                          s7_purpose_line_text_disp s7_global_line_text_disp;

      do mc_clean_idx = 1 to dim(mc_src_txt);
         mc_dst_txt[mc_clean_idx] = '';
         mc_out_pos = 0;

         do mc_clean_i = 1 to min(lengthn(mc_src_txt[mc_clean_idx]),
                                  vlength(mc_dst_txt[mc_clean_idx]));
            mc_clean_c = substr(mc_src_txt[mc_clean_idx], mc_clean_i, 1);
            mc_clean_code = rank(mc_clean_c);

            if 32 <= mc_clean_code <= 126 then mc_safe_c = mc_clean_c;
            else if mc_clean_code in (9, 10, 13) then mc_safe_c = ' ';
            else mc_safe_c = '?';

            mc_out_pos + 1;
            substr(mc_dst_txt[mc_clean_idx], mc_out_pos, 1) = mc_safe_c;
         end;
      end;

      finding_message_disp = '';
      mc_out_pos = 0;
      do mc_clean_i = 1 to min(lengthn(finding_message), vlength(finding_message_disp));
         mc_clean_c = substr(finding_message, mc_clean_i, 1);
         mc_clean_code = rank(mc_clean_c);

         if 32 <= mc_clean_code <= 126 then mc_safe_c = mc_clean_c;
         else if mc_clean_code in (9, 10, 13) then mc_safe_c = ' ';
         else mc_safe_c = '?';

         mc_out_pos + 1;
         substr(finding_message_disp, mc_out_pos, 1) = mc_safe_c;
      end;

      drop mc_clean_: mc_out_pos mc_safe_c;
   run;

   data RULE_DEF_RPT;
      set RULE_DEF;
      length category_disp $60
             rule_name_disp $200
             rule_desc_disp $1000
             mc_special_rule_disp $200
             criteria_disp $500;

      array mc_src_txt[5] category rule_name rule_desc mc_special_rule criteria;
      array mc_dst_txt[5] category_disp rule_name_disp rule_desc_disp
                          mc_special_rule_disp criteria_disp;

      do mc_clean_idx = 1 to dim(mc_src_txt);
         mc_dst_txt[mc_clean_idx] = '';
         mc_out_pos = 0;

         do mc_clean_i = 1 to min(lengthn(mc_src_txt[mc_clean_idx]),
                                  vlength(mc_dst_txt[mc_clean_idx]));
            mc_clean_c = substr(mc_src_txt[mc_clean_idx], mc_clean_i, 1);
            mc_clean_code = rank(mc_clean_c);

            if 32 <= mc_clean_code <= 126 then mc_safe_c = mc_clean_c;
            else if mc_clean_code in (9, 10, 13) then mc_safe_c = ' ';
            else mc_safe_c = '?';

            mc_out_pos + 1;
            substr(mc_dst_txt[mc_clean_idx], mc_out_pos, 1) = mc_safe_c;
         end;
      end;

      drop mc_clean_: mc_out_pos mc_safe_c;
   run;

   data REPORT_INFO;
      length information_item $40
             parameter_name $40
             parameter_value $1024;
      format run_datetime datetime20.;

      run_datetime = datetime();

      information_item = 'User ID';
      parameter_name = '';
      parameter_value = symget('SYSUSERID');
      if missing(parameter_value) then parameter_value = 'Unknown';
      output;

      information_item = 'Run Date Time';
      parameter_name = '';
      parameter_value = put(run_datetime, datetime20.);
      output;

      information_item = 'Parameter';
      parameter_name = 'MC_PGMPATH';
      parameter_value = symget('MC_PGMPATH');
      output;

      information_item = 'Parameter';
      parameter_name = 'MC_OUTSUM';
      parameter_value = symget('MC_OUTSUM');
      output;

      information_item = 'Parameter';
      parameter_name = 'MC_UPDATE';
      parameter_value = symget('MC_UPDATE');
      output;

      information_item = 'Parameter';
      parameter_name = 'MC_UPDATE_RESOLVED';
      parameter_value = symget('mc_update_yn');
      output;

      information_item = 'Parameter';
      parameter_name = 'MC_LOGLEVEL';
      parameter_value = symget('MC_LOGLEVEL');
      output;

      information_item = 'Parameter';
      parameter_name = 'MC_LOGLEVEL_RESOLVED';
      parameter_value = symget('mc_loglevel');
      output;

      information_item = 'Environment';
      parameter_name = 'SYSSCP';
      parameter_value = symget('SYSSCP');
      output;

      information_item = 'Environment';
      parameter_name = 'OS_UPDATE_MODE';
      parameter_value = symget('mc_update_target_mode');
      output;

      information_item = 'Environment';
      parameter_name = 'UPDATE_BACKUP_STRATEGY';
      parameter_value = 'Per-source-folder archive subfolder with dated backup, then in-place update';
      output;

      information_item = 'Performance';
      parameter_name = 'FILE_CRAWL_METHOD';
      parameter_value = symget('mc_crawl_method');
      output;

      information_item = 'Performance';
      parameter_name = 'FILE_CRAWL_ROOT';
      parameter_value = symget('mc_scan_root');
      output;

      information_item = 'Performance';
      parameter_name = 'FILE_CRAWL_SCOPE';
      parameter_value = 'MC_PGMPATH and all descendant subfolders';
      output;

      information_item = 'Performance';
      parameter_name = 'FILE_CRAWL_COUNT';
      parameter_value = symget('mc_all_filecnt');
      output;
   run;

   *** Verify the output workbook can be opened before ODS EXCEL starts. ***;
   %let mc_out_lock = N;
   data _null_;
      length mc_outsum $1024;
      mc_outsum = strip(symget('MC_OUTSUM'));
      rc = filename('jmotest', mc_outsum);
      fid = fopen('jmotest', 'A');

      if fid = 0 then do;
         put "ER" "ROR:[MIGRATION_CHECK] Output workbook cannot be opened for writing. "
             "It may be open in Excel or locked by another process: " mc_outsum;
         call symputx('mc_out_lock', 'Y', 'l');
      end;
      else rc = fclose(fid);

      rc = filename('jmotest');
      drop rc fid;
   run;

   %if "&mc_out_lock" = "Y" %then %goto mc_exit;

   /*--- Export to Excel ---*/
   ods listing close;

   ods excel file="&MC_OUTSUM."
      style=pearl
      options(embedded_titles='yes'
              frozen_headers='1'
              autofilter='all');


   ods excel options(sheet_name='Migration Check Summary'
                     absolute_column_width='24,40,12,60,24,14,32'
                     row_repeat='1'
                     frozen_headers='1'
                     autofilter='all');

   title "Migration Check Summary";

   proc report data=MIGRATION_SUMMARY nowd missing;
      columns mc_row_id pgm_name_disp pgm_path_disp line_num line_text_disp
              criteria_disp rule_id rule_name_disp;

      define mc_row_id / order noprint;
      define pgm_name_disp / display "Program Name"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.5in just=l vjust=top];
      define pgm_path_disp / display "Program Path" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=4.0in just=l vjust=top];
      define line_num / display "Line Number"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.0in just=r vjust=top];
      define line_text_disp / display "Original Text" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=6.0in just=l vjust=top];
      define criteria_disp / display "Matching Criteria" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.5in just=l vjust=top];
      define rule_id / display "Rule ID"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.2in just=l vjust=top];
      define rule_name_disp / display "Rule Name" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];

      compute mc_row_id;
         if mod(mc_row_id, 2) = 0 then
            call define(_row_, 'style', 'style=[background=#F2F2F2]');
      endcomp;
   run;

   title;

   ods excel options(sheet_name='Migration Check Details'
                     absolute_column_width='24,12,32,60,32,24,14,32,80'
                     row_repeat='1'
                     frozen_headers='1'
                     autofilter='all');

   title "Migration Check Details";

   proc report data=MIGRATION_CHECK_RPT nowd missing;
      columns pgm_name_disp line_num category_disp rule_desc_disp criteria_disp rule_id
              rule_name_disp pgm_path_disp line_text_disp;

      define pgm_name_disp / display "Program Name"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.5in just=l vjust=top];
      define line_num / display "Line Number"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.0in just=r vjust=top];
      define category_disp / display "Category" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];
      define rule_desc_disp / display "Rule Description" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=6.0in just=l vjust=top];
      define criteria_disp / display "Matching Criteria" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];
      define rule_id / display "Rule ID"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.2in just=l vjust=top];
      define rule_name_disp / display "Rule Name" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];
      define pgm_path_disp / display "Program Path" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=5.0in just=l vjust=top];
      define line_text_disp / display "Original Text / Finding Message" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=8.0in just=l vjust=top];
   run;

   title;

   ods excel options(sheet_name='Global Macro Details'
                     absolute_column_width='24,14,32,70,70,12,80,80,100'
                     row_repeat='1'
                     frozen_headers='1'
                     autofilter='all');

   title "Global Macro Details - Purpose-Level vs Global Macro Differences";

   proc report data=MIGRATION_S7_RPT nowd missing;
      columns rule_id category_disp rule_name_disp s7_macro_name_disp
              s7_purpose_macro_path_disp s7_global_macro_path_disp line_num
              s7_purpose_line_text_disp s7_global_line_text_disp finding_message_disp;

      define rule_id / display "Check ID"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.2in just=l vjust=top];
      define category_disp / display "Category" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];
      define rule_name_disp / display "Rule Name" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];
      define s7_macro_name_disp / display "Macro / Program Name" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top];
      define s7_purpose_macro_path_disp / display "Purpose-Level Macro Path" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=7.0in just=l vjust=top];
      define s7_global_macro_path_disp / display "Global Macro Path" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=7.0in just=l vjust=top];
      define line_num / display "Line Number"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.0in just=r vjust=top];
      define s7_purpose_line_text_disp / display "Purpose-Level Line Text" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=8.0in just=l vjust=top];
      define s7_global_line_text_disp / display "Global Line Text" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=8.0in just=l vjust=top];
      define finding_message_disp / display "Finding Message" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=10.0in just=l vjust=top];
   run;

   title;

   ods excel options(sheet_name='Rules List'
                     absolute_column_width='24,14,32,80,24,40'
                     row_repeat='1'
                     frozen_headers='1'
                     autofilter='all');

   title "Rules List";

   proc report data=RULE_DEF_RPT nowd missing;
      columns category_disp rule_id rule_name_disp rule_desc_disp mc_special_rule_disp criteria_disp;

      define category_disp / display "Category" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.5in just=l vjust=top tagattr='wrap:yes'];
      define rule_id / display "Rule ID"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.2in just=l vjust=top];
      define rule_name_disp / display "Rule Name" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=3.2in just=l vjust=top tagattr='wrap:yes'];
      define rule_desc_disp / display "Rule Description" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=8.0in just=l vjust=top tagattr='wrap:yes'];
      define mc_special_rule_disp / display "Special Rule" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.5in just=l vjust=top tagattr='wrap:yes'];
      define criteria_disp / display "Criteria" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=4.0in just=l vjust=top tagattr='wrap:yes'];

      compute category_disp;
         mc_rule_row + 1;
         if mod(mc_rule_row, 2) = 0 then
            call define(_row_, 'style', 'style=[background=#F2F2F2]');
      endcomp;

      compute rule_desc_disp;
         if rule_id = 'O4' then
            call define(_row_, 'style',
                        'style=[cellheight=1.25in]');
         else if lengthn(rule_desc_disp) > 240 or countc(rule_desc_disp, '0A'x) > 0 then
            call define(_row_, 'style',
                        'style=[cellheight=0.80in]');
      endcomp;
   run;

   title;

   *** Prepare Update Details report dataset with program-level alternating shade groups. ***;
   data MC_UPDATE_RPT;
      set MC_UPDATE;
      by pgm_name notsorted;
      retain mc_prog_group 0;
      length update_desc_disp $200
             pgm_name_disp2 $256
             pgm_path_disp $1024
             output_path_disp $1024
             original_text_disp $32767
             updated_text_disp $32767;

      if first.pgm_name then mc_prog_group + 1;

      array mc_src_txt[6] update_desc pgm_name pgm_path output_path original_text updated_text;
      array mc_dst_txt[6] update_desc_disp pgm_name_disp2 pgm_path_disp
                          output_path_disp original_text_disp updated_text_disp;

      do mc_clean_idx = 1 to dim(mc_src_txt);
         mc_dst_txt[mc_clean_idx] = '';
         mc_out_pos = 0;

         do mc_clean_i = 1 to min(lengthn(mc_src_txt[mc_clean_idx]),
                                  vlength(mc_dst_txt[mc_clean_idx]));
            mc_clean_c = substr(mc_src_txt[mc_clean_idx], mc_clean_i, 1);
            mc_clean_code = rank(mc_clean_c);

            if 32 <= mc_clean_code <= 126 then mc_safe_c = mc_clean_c;
            else if mc_clean_code in (9, 10, 13) then mc_safe_c = ' ';
            else mc_safe_c = '?';

            mc_out_pos + 1;
            substr(mc_dst_txt[mc_clean_idx], mc_out_pos, 1) = mc_safe_c;
         end;
      end;

      drop mc_clean_: mc_out_pos mc_safe_c;
   run;

   ods excel options(sheet_name='Update Details'
                     absolute_column_width='14,28,24,12,60,60,80,80'
                     row_repeat='1'
                     frozen_headers='1'
                     autofilter='all');

   title "Update Details";

   proc report data=MC_UPDATE_RPT nowd missing;
      columns mc_prog_group rule_id update_desc_disp pgm_name_disp2 line_num pgm_path_disp output_path_disp original_text_disp updated_text_disp;

      define mc_prog_group / display noprint;
      define rule_id / display "Rule ID"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.2in just=l vjust=top];
      define update_desc_disp / display "Update Description" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.8in just=l vjust=top tagattr='wrap:yes'];
      define pgm_name_disp2 / display "Program Name" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.5in just=l vjust=top tagattr='wrap:yes'];
      define line_num / display "Line Number"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=1.0in just=r vjust=top];
      define pgm_path_disp / display "Source Program Path" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=6.0in just=l vjust=top tagattr='wrap:yes'];
      define output_path_disp / display "Updated Program Path" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=6.0in just=l vjust=top tagattr='wrap:yes'];
      define original_text_disp / display "Original Text" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=8.0in just=l vjust=top tagattr='wrap:yes'];
      define updated_text_disp / display "Updated Text" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=8.0in just=l vjust=top tagattr='wrap:yes'];

      compute mc_prog_group;
         if mod(mc_prog_group, 2) = 0 then
            call define(_row_, 'style', 'style=[background=#F2F2F2]');
      endcomp;
   run;

   title;
   ods excel options(sheet_name='Report Information'
                     absolute_column_width='24,24,100'
                     row_repeat='1'
                     frozen_headers='1'
                     autofilter='none');

   title "Report Information";

   proc report data=REPORT_INFO nowd missing;
      columns information_item parameter_name parameter_value;

      define information_item / display "Information Item"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.4in just=l vjust=top];
      define parameter_name / display "Parameter Name"
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=2.4in just=l vjust=top];
      define parameter_value / display "Value" flow
         style(header)=[background=#BDD7EE fontweight=bold
                        bordertopcolor=black borderbottomcolor=black
                        borderleftcolor=black borderrightcolor=black]
         style(column)=[cellwidth=10.0in just=l vjust=top tagattr='wrap:yes'];
   run;

   title;

   ods excel close;
   %put NOTE: [MIGRATION_CHECK] ODS EXCEL destination closed successfully.;
   %MC_STEP(message=Excel workbook written);
   %if &mc_listing_open > 0 %then %do;
      ods listing;
   %end;

   %put NOTE: [MIGRATION_CHECK] Total findings across all programs: &mc_total_found.;
   %put NOTE: [MIGRATION_CHECK] Output Excel written to: &MC_OUTSUM.;
   %put NOTE: [MIGRATION_CHECK] Processing complete.;
   %if "%upcase(&mc_loglevel)" ne "NONE" %then
      %MC_PROGRESS(step=&mc_total_steps, total=&mc_total_steps, message=All processing complete);

   %mc_exit:

   /* Restore caller Windows SYSTEM options once on every exit path. */
   %if "%upcase(&mc_xopts_changed)" = "Y" %then %do;
      options &mc_save_xmin &mc_save_xwait &mc_save_xsync;
      %let mc_xopts_changed = N;
   %end;

   /*--- Cleanup ---*/
   /* Runs on every exit path, including parameter-validation failures and */
   /* the output-workbook lock guard, so WORK never carries residue into   */
   /* a subsequent call within the same session.                           */
   proc datasets lib=work nolist nowarn;
      delete RULE_DEF
             RULE_DEF_RPT
             CRITERIA_DEF
             MC_ALL_FILES
             MC_TOC_CASEMAP
             MC_PGMLIST
             MC_PGM_RULE_BASE
             MC_F5_DUPLICATE_KEYS
             MC_F5_FINDINGS_RAW
             MC_F5_FINDINGS
             MC_F6_FOLDER_RAW
             MC_F6_FOLDER_FINDINGS
             MC_F6_SUFFIX_CANDIDATES
             MC_F6_SUFFIX_PAIRS
             MC_F6_SUFFIX_FINDINGS
             MC_F6_FINDINGS
             MIGRATION_SUMMARY
             _MC_MIGRATION_SUMMARY_SRC
             MIGRATION_CHECK_RPT
             MIGRATION_S7_RPT
             REPORT_INFO
             MC_S7_SASAUTOS_PATHS
             MC_S7_MACRO_FILES
             MC_S7_COMPARE_PAIRS
             _MC_SRC_LINES
             _MC_SRC_NEXT1
             _MC_SRC_NEXT2
             _MC_SRC_LOOK
             _MC_FILE_FINDINGS
             _MC_RULE_HITS
             _MC_FILE_SPECIAL
             _MC_UPDATE_FILE
             MC_UPDATE
             _MC_S7_DIFF_APPEND
             _MC_S7_DIFF_FALLBACK
             _MC_S7_PURPOSE_LINES
             _MC_S7_GLOBAL_LINES
             _MC_S7_DIFF_RAW
             _MC_S7_DIFF_MSG
             _MC_S7_PURPOSE_DIFF
             _MC_S7_GLOBAL_DIFF
             _MC_S7_DIFF
             MC_UPDATE_RPT;
   quit;

   options compress=&mc_save_compress;
   options &mc_save_mprint &mc_save_mlogic &mc_save_symbolgen;
   %put NOTE: [MIGRATION_CHECK] Macro execution ended.;

%mend MIGRATION_CHECK;
