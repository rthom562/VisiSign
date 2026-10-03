'use strict';

// Badge printing on a Windows host — the `direct` print transport.
//
// Why this design: printing on the reception PC through the Windows print spooler
// is far more stable than app-level Bluetooth from a tablet. The spooler + the
// printer's own Windows driver own the USB/network connection, so it works with
// ANY installed printer (Brother, DYMO, Zebra, generic) and survives reconnects.
//
// We render the badge with .NET's System.Drawing.Printing via a small PowerShell
// script (always present on Windows — no bundled tools, no vendor SDK). The badge
// data is handed over as a temp JSON file so names with spaces/accents are safe.
//
// ── This module only runs where a printer is physically attached ─────────────
// That is true in exactly two places: the reception PC running VisiSign
// directly, and the on-premise print agent (see /agent) when VisiSign itself
// runs in the cloud. The agent reuses this exact file, which is why nothing here
// touches the database, the settings table or the HTTP layer — everything it
// needs is passed in. print.service.js owns that dispatch; see print.queue.js
// for the cloud path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const qrcode = require('../vendor/qrcode');

const rand = () => crypto.randomBytes(6).toString('hex');
const tmp = (name) => path.join(os.tmpdir(), name);

// Virtual printers that write to a FILE and pop a Save-As dialog when no filename
// is supplied (which would hang a headless print). We route these to a temp file.
const FILE_PRINTER = /microsoft print to pdf|microsoft xps document writer|xpsport|onenote|\bfax\b|print to file/i;

// Open a file with its default Windows app (used to preview file-printer output).
function openFile(f) {
  try { spawn('cmd', ['/c', 'start', '', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
  catch (_) { /* preview is best-effort */ }
}

// Label defaults, used when the caller does not specify a size. Brother QL
// 62mm continuous stock.
const DEFAULT_LABEL = { printer: '', widthMm: 62, heightMm: 90 };

// ── The PowerShell renderer/printer (ASCII only; written with a BOM so PS 5.1
// reads it as UTF-8). Reads a JSON job file and either prints the badge or, for a
// dry run, saves a PNG preview. ─────────────────────────────────────────────────
const PRINT_PS1 = `
param([Parameter(Mandatory=$true)][string]$DataPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $d = Get-Content -Raw -Encoding UTF8 -LiteralPath $DataPath | ConvertFrom-Json

  # Diagnostic: report the printer's supported label sizes (for calibration).
  if ($d.infoOnly) {
    $pd = New-Object System.Drawing.Printing.PrintDocument
    $pd.PrinterSettings.PrinterName = [string]$d.printer
    if (-not $pd.PrinterSettings.IsValid) { Write-Output 'INVALID'; exit 0 }
    $def = $pd.DefaultPageSettings.PaperSize
    Write-Output ('DEFAULT|' + $def.PaperName + '|' + $def.Width + '|' + $def.Height)
    foreach ($p in $pd.PrinterSettings.PaperSizes) { Write-Output ('PAPER|' + $p.PaperName + '|' + $p.Width + '|' + $p.Height) }
    exit 0
  }

  $qr = $null
  if ($d.qrPath -and (Test-Path -LiteralPath $d.qrPath)) { $qr = [System.Drawing.Image]::FromFile($d.qrPath) }
  $photo = $null
  if ($d.photoPath -and (Test-Path -LiteralPath $d.photoPath)) {
    try { $photo = [System.Drawing.Image]::FromFile($d.photoPath) } catch { $photo = $null }
  }

  # Draw the badge scaled to the given area, so it fits whatever label is loaded.
  $draw = {
    param($g, $ox, $oy, $w, $h)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $black = [System.Drawing.Brushes]::Black
    $s = [double]$w / 244.0            # 244 units ~ 62mm reference width
    if ($s -lt 0.45) { $s = 0.45 }
    if ($s -gt 1.6)  { $s = 1.6 }
    $nameSize = 15 * $s
    if ($photo) { $nameSize = 12 * $s }   # narrower text column when a photo is shown
    $fTitle = New-Object System.Drawing.Font('Segoe UI', [single](8 * $s), [System.Drawing.FontStyle]::Bold)
    $fName  = New-Object System.Drawing.Font('Segoe UI', [single]$nameSize, [System.Drawing.FontStyle]::Bold)
    $fSub   = New-Object System.Drawing.Font('Segoe UI', [single](9 * $s))
    $fCode  = New-Object System.Drawing.Font('Consolas', [single](12 * $s), [System.Drawing.FontStyle]::Bold)
    $lh = [single](16 * $s)

    # Visitor photo (top-left); the details column sits to the right of it.
    $textX = [single]$ox
    $photoBottom = [single]$oy
    if ($photo) {
      $pw = [double]$w * 0.34
      $ph = $pw * 1.25
      try {
        $g.DrawImage($photo, [single]$ox, [single]$oy, [single]$pw, [single]$ph)
        $g.DrawRectangle([System.Drawing.Pens]::Black, [single]$ox, [single]$oy, [single]$pw, [single]$ph)
      } catch {}
      $textX = [single]($ox + $pw + 8 * $s)
      $photoBottom = [single]($oy + $ph)
    }

    $y = [single]$oy
    $g.DrawString('VISITOR', $fTitle, $black, $textX, $y); $y += $lh
    $g.DrawString([string]$d.name, $fName, $black, $textX, $y); $y += [single](26 * $s)
    if ($d.company)  { $g.DrawString([string]$d.company, $fSub, $black, $textX, $y); $y += $lh }
    if ($d.hostName) { $g.DrawString('Host: ' + [string]$d.hostName, $fSub, $black, $textX, $y); $y += $lh }
    if ($d.dateStr)  { $g.DrawString([string]$d.dateStr, $fSub, $black, $textX, $y); $y += $lh }
    if ($y -lt $photoBottom) { $y = $photoBottom }
    $y += [single](6 * $s)
    if ($qr) {
      $avail = [double]$h - ($y - [single]$oy) - (18 * $s)
      $qs = [Math]::Min([double]$w * 0.9, $avail)
      if ($qs -lt 40) { $qs = 40 }
      $g.DrawImage($qr, [single]$ox, $y, [single]$qs, [single]$qs); $y += [single]($qs + 2)
    }
    if ($d.code) { $g.DrawString([string]$d.code, $fCode, $black, [single]$ox, $y) }
  }

  if ($d.dryRun) {
    $wpx = [int]([double]$d.widthMm / 25.4 * 100)
    $hpx = [int]([double]$d.heightMm / 25.4 * 100)
    $bmp = New-Object System.Drawing.Bitmap($wpx, $hpx)
    $bmp.SetResolution(100, 100)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    & $draw $g 8 8 ($wpx - 16) ($hpx - 16)
    $g.Dispose()
    $bmp.Save([string]$d.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output 'DRYRUN_OK'
  } else {
    $doc = New-Object System.Drawing.Printing.PrintDocument
    if ($d.printer) { $doc.PrinterSettings.PrinterName = [string]$d.printer }
    if (-not $doc.PrinterSettings.IsValid) { throw ('Printer not found or invalid: ' + [string]$d.printer) }
    if ($d.printToFile) { $doc.PrinterSettings.PrintToFile = $true; $doc.PrinterSettings.PrintFileName = [string]$d.printToFile }

    # Label printers (e.g. Brother QL) only accept paper sizes their driver
    # defines. Forcing a random custom size can crash the driver, so prefer a
    # driver-supported size matching the requested width; fall back to the
    # driver default rather than an unsupported custom size.
    $want100w = [int]([double]$d.widthMm / 25.4 * 100)
    $want100h = [int]([double]$d.heightMm / 25.4 * 100)
    $chosen = $null
    foreach ($ps in $doc.PrinterSettings.PaperSizes) {
      if ([Math]::Abs($ps.Width - $want100w) -le 24) {
        if (($null -eq $chosen) -or ([Math]::Abs($ps.Height - $want100h) -lt [Math]::Abs($chosen.Height - $want100h))) { $chosen = $ps }
      }
    }
    # Use a driver-supported size if we found one; otherwise keep the printer's
    # OWN default label. Never force an unsupported custom size — that is what
    # makes label drivers (e.g. Brother QL) fail.
    if ($null -ne $chosen) { try { $doc.DefaultPageSettings.PaperSize = $chosen } catch {} }
    try { $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(6, 6, 6, 6) } catch {}
    try { $doc.OriginAtMargins = $true } catch {}
    $doc.DocumentName = 'VisiSign Badge'
    $doc.add_PrintPage({
      param($s, $e)
      try { $mb = $e.MarginBounds; & $draw $e.Graphics $mb.Left $mb.Top $mb.Width $mb.Height }
      catch { [Console]::Error.WriteLine('DRAW_ERROR: ' + $_.Exception.Message) }
    })
    $doc.Print()
    Write-Output ('PRINT_OK paper=' + $doc.DefaultPageSettings.PaperSize.PaperName)
  }
  if ($qr) { $qr.Dispose() }
  if ($photo) { $photo.Dispose() }
} catch {
  [Console]::Error.WriteLine('PRINT_ERROR: ' + $_.Exception.Message)
  exit 1
}
`;

let scriptPath = null;
function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  scriptPath = tmp('visisign-print-badge.ps1');
  fs.writeFileSync(scriptPath, '﻿' + PRINT_PS1, 'utf8'); // BOM => PS reads as UTF-8
  return scriptPath;
}

// ── PowerShell runner ─────────────────────────────────────────────────────────
function runPS(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Printing is only supported on Windows.'));
    const ps = spawn('powershell.exe', args, { windowsHide: true });
    let outBuf = '', errBuf = '';
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error('Printing timed out — the printer may be offline, out of labels, or its driver is showing a dialog. Check the printer.'));
    }, timeoutMs);
    ps.stdout.on('data', (d) => (outBuf += d));
    ps.stderr.on('data', (d) => (errBuf += d));
    ps.on('error', (e) => { clearTimeout(timer); reject(new Error('Could not start PowerShell: ' + e.message)); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(outBuf.trim());
      const line = (errBuf.trim() || outBuf.trim() || 'exit ' + code).split('\n')[0].trim();
      reject(new Error(line.replace(/^PRINT_ERROR:\s*/, '')));
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
async function listPrinters() {
  const cmd = 'try { Get-Printer | Select-Object -ExpandProperty Name } ' +
              'catch { Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name }';
  const out = await runPS(['-NoProfile', '-NonInteractive', '-Command', cmd], 15000);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Report a printer's default + supported label sizes (mm) — for calibration.
async function printerInfo(name) {
  const printer = name;
  if (!printer) throw new Error('No printer specified.');
  const jsonPath = tmp(`visisign-info-${rand()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ infoOnly: true, printer }), 'utf8');
  let out;
  try {
    out = await runPS(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), '-DataPath', jsonPath], 15000);
  } finally { try { fs.unlinkSync(jsonPath); } catch (_) { /* ignore */ } }

  if (out.trim() === 'INVALID') return { valid: false, printer };
  const toMm = (u) => Math.round((Number(u) / 100) * 25.4);
  let def = null; const papers = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.split('|');
    if (p[0] === 'DEFAULT') def = { name: p[1], wmm: toMm(p[2]), hmm: toMm(p[3]) };
    else if (p[0] === 'PAPER') papers.push({ name: p[1], wmm: toMm(p[2]), hmm: toMm(p[3]) });
  }
  return { valid: true, printer, default: def, papers };
}

function genQr(payload) {
  const qr = qrcode(0, 'M');
  qr.addData(String(payload));
  qr.make();
  const gif = Buffer.from(qr.createDataURL(6, 8).split(',')[1], 'base64');
  const p = tmp(`visisign-qr-${rand()}.gif`);
  fs.writeFileSync(p, gif);
  return p;
}

/**
 * Render and print one badge.
 *
 * `fields` is the badge content (name, company, hostName, reason, code,
 * dateStr, qrPayload). `label` carries the printer name and label size.
 *
 * Nothing here reads the database, so the on-premise agent can call it with
 * data that arrived over the wire.
 */
async function runJob(fields, label = {}, { printer, dryRun = false, outPath = '', printToFile = '' } = {}) {
  const l = { ...DEFAULT_LABEL, ...label };
  const usePrinter = printer || l.printer;
  if (!dryRun && !usePrinter) {
    throw new Error('No badge printer configured. Choose one in Admin → Settings.');
  }

  // Route file/virtual printers to a temp file (and open it) so they never hang.
  let openAfter = false;
  if (!dryRun && !printToFile && FILE_PRINTER.test(usePrinter)) {
    printToFile = tmp(`visisign-badge-${rand()}.${/xps/i.test(usePrinter) ? 'oxps' : 'pdf'}`);
    openAfter = true;
  }

  let qrPath = '';
  if (fields.qrPayload) qrPath = genQr(fields.qrPayload);

  const data = {
    printer: usePrinter,
    name: fields.name || 'Visitor',
    company: fields.company || '',
    hostName: fields.hostName || '',
    reason: fields.reason || '',
    code: fields.code || '',
    dateStr: fields.dateStr || '',
    qrPath,
    widthMm: l.widthMm,
    heightMm: l.heightMm,
    // The renderer still accepts a photo path; VisiSign no longer captures
    // visitor photos, so it is always empty and that branch simply never runs.
    photoPath: '',
    dryRun,
    outPath,
    printToFile,
  };
  const jsonPath = tmp(`visisign-job-${rand()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data), 'utf8');
  try {
    // -STA: GDI+ printing and some print drivers require a single-threaded apartment.
    await runPS(['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), '-DataPath', jsonPath]);
    if (openAfter) openFile(printToFile);
    return { printer: usePrinter, file: printToFile || outPath || null, opened: openAfter };
  } finally {
    for (const f of [jsonPath, qrPath]) {
      if (f) { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }
    }
  }
}

// True when this process could actually drive a printer.
const available = () => process.platform === 'win32';

module.exports = { runJob, listPrinters, printerInfo, available, DEFAULT_LABEL };
