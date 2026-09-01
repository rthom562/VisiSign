# VisiSign-Tray.ps1
# Runs VisiSign.exe in the background with a Windows system-tray icon (it appears
# in the notification area / hidden-items tray) instead of a console window.
#
# Right-click the tray icon for: Open dashboard, Open admin, Quit.
# Launch this WITHOUT a console window using the bundled VisiSign.vbs, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File VisiSign-Tray.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $scriptDir 'VisiSign.exe'

if (-not (Test-Path $exe)) {
  [System.Windows.Forms.MessageBox]::Show("VisiSign.exe was not found next to this script.", "VisiSign") | Out-Null
  return
}

# ── Read PORT from a .env beside the exe (default 4000) ───────────────────────
$port = 4000
$envFile = Join-Path $scriptDir '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
$reserveUrl = "http://localhost:$port/"        # main page = reservations
$kioskUrl   = "http://localhost:$port/kiosk"   # on-site kiosk (needs approval)
$adminUrl   = "http://localhost:$port/admin"

# ── First run: create the database + first admin if it doesn't exist yet ──────
$db = Join-Path $scriptDir 'visisign.db'
if (-not (Test-Path $db)) {
  $seedInfo = New-Object System.Diagnostics.ProcessStartInfo
  $seedInfo.FileName = $exe
  $seedInfo.Arguments = '--seed'
  $seedInfo.WorkingDirectory = $scriptDir
  $seedInfo.UseShellExecute = $false
  $seedInfo.CreateNoWindow = $true
  $seed = [System.Diagnostics.Process]::Start($seedInfo)
  $seed.WaitForExit()
}

# ── Start the host hidden (no console window) ─────────────────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.WorkingDirectory = $scriptDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

# ── Tray icon + menu ──────────────────────────────────────────────────────────
$notify = New-Object System.Windows.Forms.NotifyIcon
try   { $notify.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe) }
catch { $notify.Icon = [System.Drawing.SystemIcons]::Application }
$notify.Text = "VisiSign - running on port $port"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miReserve = $menu.Items.Add("Open reservations page")
$miReserve.add_Click({ Start-Process $reserveUrl })

$miKiosk = $menu.Items.Add("Open kiosk (this device)")
$miKiosk.add_Click({ Start-Process $kioskUrl })

$miAdmin = $menu.Items.Add("Open admin console")
$miAdmin.add_Click({ Start-Process $adminUrl })

$miCmd = $menu.Items.Add("Open command console")
$miCmd.add_Click({ Start-Process 'cmd.exe' -ArgumentList '/k', ('"' + $exe + '" --console') -WorkingDirectory $scriptDir })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miQuit = $menu.Items.Add("Quit VisiSign")
$miQuit.add_Click({
  $notify.Visible = $false
  try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch {}
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Start-Process $reserveUrl })

# Welcome balloon.
$notify.BalloonTipTitle = "VisiSign is running"
$notify.BalloonTipText  = "Reservations are live at $reserveUrl`nRight-click this icon for options."
$notify.ShowBalloonTip(4000)

# If the host process dies on its own, tear the tray icon down too.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if ($proc.HasExited) { $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$timer.Start()

# Run the message loop (keeps the tray icon alive).
[System.Windows.Forms.Application]::Run()

# Cleanup on exit.
$timer.Stop()
$notify.Dispose()
try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch {}
