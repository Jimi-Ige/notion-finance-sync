# ---------------------------------------------------------------------------
# setup-scheduler.ps1 — Register a daily Windows Task Scheduler task.
#
# Creates a task named "NotionFinanceSync" that runs `scripts/run-sync.bat`
# every day at 6:00 AM. The task runs whether or not the user is logged in
# (if supported), and starts automatically on missed schedule (e.g., laptop
# was asleep).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-scheduler.ps1
#
# To change the time:
#   Edit the -At parameter below (e.g., "7:00AM", "12:00PM")
#
# To remove the task:
#   Unregister-ScheduledTask -TaskName "NotionFinanceSync" -Confirm:$false
#
# To verify the task:
#   Get-ScheduledTask -TaskName "NotionFinanceSync" | Format-List
#
# Idempotent — safe to re-run. If the task already exists, it is replaced.
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$taskName = "NotionFinanceSync"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$batPath = Join-Path $projectDir "scripts\run-sync.bat"

# Validate the batch file exists
if (-not (Test-Path $batPath)) {
    Write-Error "Could not find $batPath. Run this script from the project root."
    exit 1
}

# Remove existing task if present (idempotent)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$taskName'..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Define the task
$action = New-ScheduledTaskAction `
    -Execute $batPath `
    -WorkingDirectory $projectDir

$trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At "6:00AM"

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# Register the task
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Daily sync of bank transactions to Notion via Plaid" `
    -RunLevel Limited

Write-Host ""
Write-Host "Scheduled task '$taskName' created successfully."
Write-Host "  Schedule:  Daily at 6:00 AM"
Write-Host "  Action:    $batPath"
Write-Host "  Directory: $projectDir"
Write-Host ""
Write-Host "To verify:  Get-ScheduledTask -TaskName '$taskName'"
Write-Host "To remove:  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host "To run now: Start-ScheduledTask -TaskName '$taskName'"
