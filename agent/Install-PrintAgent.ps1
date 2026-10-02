<#
.SYNOPSIS
  Install the VisiSign print agent so it starts with the reception PC.

.DESCRIPTION
  When VisiSign runs in the cloud it cannot reach a label printer on a USB cable
  at a reception desk. The print agent bridges that: it runs on the reception PC,
  polls the server OUT over HTTPS for queued badges, and prints them on the local
  Windows printer. Nothing inbound is needed — no port forward, no VPN, no static
  IP.

  This script registers the agent as a Scheduled Task that runs at boot, before
  anyone logs in, and restarts itself if it stops. A Scheduled Task is used
  rather than a true Windows Service because it needs no extra tooling (nssm,
  winsw) and can be inspected and stopped from Task Scheduler by anyone at the
  desk.

  NOTE: iPad AirPrint and Android Mopria printing do NOT need this agent at all.
  Set the kiosk's `badge_print_mode` setting to `device` and the tablet prints
  the badge itself, straight from the cloud.

.PARAMETER ServerUrl
  The VisiSign server, e.g. https://visisign.example.com

.PARAMETER AgentToken
  The shared secret. Must match PRINT_AGENT_TOKEN on the server.

.PARAMETER Printer
  Optional. Overrides the badge printer chosen in Admin, for a desk that uses a
  different one. Omit to follow the server's setting.

.PARAMETER AgentId
  Optional. A name for this desk in the job history. Defaults to the hostname.

.EXAMPLE
  .\Install-PrintAgent.ps1 -ServerUrl https://visisign.example.com -AgentToken abc123...

.EXAMPLE
  .\Install-PrintAgent.ps1 -ServerUrl https://visisign.example.com -AgentToken abc123... -Printer "Brother QL-820NWB"

.EXAMPLE
  # Remove it again
  .\Install-PrintAgent.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [string]$ServerUrl,
  [string]$AgentToken,
  [string]$Printer = "",
  [string]$AgentId = $env:COMPUTERNAME,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'VisiSign Print Agent'

# Must be elevated: a task that runs at boot as SYSTEM needs admin to register.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "Run this from an elevated PowerShell (right-click > Run as administrator)."
  exit 1
}

# ── Uninstall ────────────────────────────────────────────────────────────────
if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "'$TaskName' is not installed; nothing to remove."
  }
  exit 0
}

if (-not $ServerUrl -or -not $AgentToken) {
  Write-Error "Both -ServerUrl and -AgentToken are required. See: Get-Help .\Install-PrintAgent.ps1 -Detailed"
  exit 1
}

# ── Locate node and the agent script ─────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error "Node.js was not found on PATH. Install Node 22.5 or newer, then run this again."
  exit 1
}

$nodeVersion = (& $node -v) -replace '^v',''
$major = [int]($nodeVersion -split '\.')[0]
$minor = [int]($nodeVersion -split '\.')[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  Write-Error "Node $nodeVersion is too old. VisiSign needs 22.5 or newer."
  exit 1
}

$agentScript = Join-Path $PSScriptRoot 'agent.js'
if (-not (Test-Path $agentScript)) {
  Write-Error "Could not find agent.js next to this script ($agentScript)."
  exit 1
}

Write-Host ""
Write-Host "  Node      : $node ($nodeVersion)"
Write-Host "  Agent     : $agentScript"
Write-Host "  Server    : $ServerUrl"
Write-Host "  Agent id  : $AgentId"
Write-Host "  Printer   : $(if ($Printer) { $Printer } else { '(follow the server setting)' })"
Write-Host ""

# ── Check we can actually reach the server before installing anything ────────
Write-Host "Checking the server is reachable..." -NoNewline
try {
  $health = Invoke-RestMethod -Uri "$ServerUrl/api/health" -TimeoutSec 15
  if ($health.ok) { Write-Host " ok" -ForegroundColor Green }
  else { Write-Host " unexpected reply" -ForegroundColor Yellow }
} catch {
  Write-Host " FAILED" -ForegroundColor Red
  Write-Error "Could not reach $ServerUrl/api/health -- $($_.Exception.Message)"
  exit 1
}

# ── Check the token is accepted, so a typo fails HERE and not silently later ──
Write-Host "Checking the agent token..." -NoNewline
try {
  $null = Invoke-RestMethod -Uri "$ServerUrl/api/print/agent/jobs?limit=1" -TimeoutSec 15 `
    -Headers @{ Authorization = "Bearer $AgentToken"; 'X-Agent-Id' = $AgentId }
  Write-Host " ok" -ForegroundColor Green
} catch {
  Write-Host " FAILED" -ForegroundColor Red
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401) {
    Write-Error "The server rejected the token. It must match PRINT_AGENT_TOKEN on the server exactly."
  } elseif ($status -eq 503) {
    Write-Error "The server has no PRINT_AGENT_TOKEN set, so its agent API is switched off. Set it there first."
  } else {
    Write-Error "Token check failed -- $($_.Exception.Message)"
  }
  exit 1
}

# ── Register the task ────────────────────────────────────────────────────────
# The secret goes in the task's environment rather than the command line, so it
# does not show up in the process list for every user on the machine.
$envPrefix = "`$env:VISISIGN_URL='$ServerUrl'; `$env:PRINT_AGENT_TOKEN='$AgentToken'; `$env:AGENT_ID='$AgentId';"
if ($Printer) { $envPrefix += " `$env:BADGE_PRINTER='$Printer';" }
$inner = "$envPrefix & '$node' '$agentScript'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded"

$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM so it runs without anyone logged in — a reception PC is often at the
# lock screen. SYSTEM can still print to installed system-wide printers.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # never time it out; it is long-running

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Replacing the existing task..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Prints VisiSign visitor badges queued by the VisiSign server.' | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $TaskName).State

Write-Host ""
Write-Host "  Installed '$TaskName' (state: $state)." -ForegroundColor Green
Write-Host ""
Write-Host "  It starts automatically at boot and restarts if it stops."
Write-Host ""
Write-Host "  Check it      : Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop it       : Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Remove it     : .\Install-PrintAgent.ps1 -Uninstall"
Write-Host "  Run in a window to watch the log:"
Write-Host "      `$env:VISISIGN_URL='$ServerUrl'; `$env:PRINT_AGENT_TOKEN='<token>'; node '$agentScript'"
Write-Host ""
Write-Host "  Then print a test badge from Admin > Settings, or /printtest in the console."
Write-Host ""
