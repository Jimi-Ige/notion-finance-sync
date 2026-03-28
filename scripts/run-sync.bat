@echo off
REM ---------------------------------------------------------------------------
REM run-sync.bat — Wrapper for Windows Task Scheduler.
REM
REM Task Scheduler calls this batch file daily. It sets the working directory,
REM runs the sync, and pipes all output to the log file.
REM
REM Usage: This file is called by the scheduled task, not directly.
REM To set up the task, run: powershell -File scripts\setup-scheduler.ps1
REM ---------------------------------------------------------------------------

cd /d "%~dp0.."
call npm run sync 2>&1
