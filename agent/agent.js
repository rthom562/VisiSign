'use strict';

// VisiSign on-premise print agent.
//
// ── The problem it solves ───────────────────────────────────────────────────
// A label printer at a reception desk is on a USB cable or a private LAN. No
// server in Google Cloud or AWS can reach it, and you should not want it to —
// that would mean opening a hole into the building.
//
// ── How it works ───────────────────────────────────────────────────────────
// The agent runs on the reception PC and polls OUT over HTTPS. Nothing inbound
// is ever required: no port forward, no VPN, no tunnel, no static IP.
//
//   kiosk ──▶ cloud VisiSign ──▶ print_jobs row
//                                    │   agent polls out over HTTPS
//                                    ▼
//                 reception PC ──▶ THIS AGENT ──▶ Windows spooler ──▶ label
//
// It renders badges with exactly the same code the on-premise build uses
// (backend/src/services/print.windows.js), so a badge printed via the cloud is
// byte-identical to one printed by the Windows .exe — same layout, same label
// sizes, same driver handling for Brother/DYMO/Zebra.
//
// ── What it needs ──────────────────────────────────────────────────────────
//   * Windows, with the printer installed and working (print a test page first)
//   * Node 22.5+
//   * the VisiSign server URL and the PRINT_AGENT_TOKEN set on that server
//
// ── Running it ─────────────────────────────────────────────────────────────
//   set VISISIGN_URL=https://visisign.example.com
//   set PRINT_AGENT_TOKEN=<the same secret as the server>
//   node agent/agent.js
//
// Or use agent/Install-PrintAgent.ps1 to register it as a Windows service that
// starts with the PC.
//
// This is NOT needed for iPad AirPrint or Android Mopria printing — the tablet
// prints those itself from the browser, straight from the cloud.

const os = require('os');
const path = require('path');

// The renderer is shared with the server build rather than duplicated.
const windowsPrinter = require(path.join(__dirname, '..', 'backend', 'src', 'services', 'print.windows'));

// ── Configuration ────────────────────────────────────────────────────────────
const BASE = String(process.env.VISISIGN_URL || 'http://localhost:4000').replace(/\/$/, '');
const TOKEN = process.env.PRINT_AGENT_TOKEN || '';
const AGENT_ID = process.env.AGENT_ID || `${os.hostname()}`.slice(0, 64);
const PRINTER_OVERRIDE = process.env.BADGE_PRINTER || '';
const VERBOSE = String(process.env.VERBOSE || 'false') === 'true';

// Poll pacing. The server suggests an interval; these bound it.
const MIN_POLL_MS = Number(process.env.POLL_MS) || 3000;
const MAX_POLL_MS = 60_000;

if (!TOKEN) {
  console.error('\nPRINT_AGENT_TOKEN is not set.');
  console.error('Set it to the same value as PRINT_AGENT_TOKEN on the VisiSign server, then run again.\n');
  process.exit(1);
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const debug = (...a) => {
  if (VERBOSE) log(...a);
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Agent-Id': AGENT_ID,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* non-JSON error page */
  }

  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = json?.error?.code;
    throw err;
  }
  return json?.data ?? json;
}

/** Fetch a visitor photo for the badge being printed. */
async function fetchPhoto(name) {
  try {
    const res = await fetch(`${BASE}/api/print/agent/photo/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Agent-Id': AGENT_ID },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (_) {
    return null; // a missing photo must not stop the badge printing
  }
}

// ── Announce ourselves ───────────────────────────────────────────────────────
// Reporting the installed printers lets the admin UI show a real dropdown even
// though the cloud server has no printers of its own. The server replies with
// the label settings the administrator chose, so the agent needs no config of
// its own beyond the URL and the token.
let serverLabel = { ...windowsPrinter.DEFAULT_LABEL };
let pollMs = MIN_POLL_MS;

async function hello() {
  let printers = [];
  try {
    printers = await windowsPrinter.listPrinters();
  } catch (e) {
    log('! could not list printers:', e.message);
  }

  const reply = await api('POST', '/api/print/agent/hello', { printers });
  if (reply && reply.label) serverLabel = { ...serverLabel, ...reply.label };
  if (reply && reply.pollSeconds) {
    pollMs = Math.min(Math.max(reply.pollSeconds * 1000, MIN_POLL_MS), MAX_POLL_MS);
  }

  log(`connected to ${BASE} as "${AGENT_ID}"`);
  log(`printers: ${printers.length ? printers.join(', ') : '(none found)'}`);
  const chosen = PRINTER_OVERRIDE || serverLabel.printer;
  log(`badge printer: ${chosen || '(not configured — set one in Admin, or BADGE_PRINTER here)'}`);
  log(`label size: ${serverLabel.widthMm} x ${serverLabel.heightMm} mm`);
}

// ── Print one job ────────────────────────────────────────────────────────────
async function runOne(job) {
  const spec = job.payload || {};
  const fields = { ...(spec.fields || {}) };
  const label = { ...serverLabel, ...(spec.label || {}) };

  // A printer named here overrides the server's choice, so one desk can use a
  // different printer from the organisation default.
  if (PRINTER_OVERRIDE) label.printer = PRINTER_OVERRIDE;

  if (fields.photoName) {
    const buf = await fetchPhoto(fields.photoName);
    if (buf) {
      fields.photoBuffer = buf;
      fields.photoIsPng = /\.png$/i.test(fields.photoName);
    }
    delete fields.photoName;
  }

  log(`printing job ${job.jobId} — ${fields.name || 'badge'} (${fields.code || 'no code'})`);
  const out = await windowsPrinter.runJob(fields, label, {});
  return out;
}

async function processJob(job) {
  try {
    const out = await runOne(job);
    await api('POST', `/api/print/agent/jobs/${job.jobId}/result`, { ok: true });
    log(`  done — ${out.file ? `written to ${out.file}` : `sent to ${out.printer}`}`);
  } catch (e) {
    log(`  FAILED — ${e.message}`);
    try {
      await api('POST', `/api/print/agent/jobs/${job.jobId}/result`, { ok: false, error: e.message });
    } catch (reportErr) {
      // Could not even report the failure. Leave the job claimed; the server
      // re-queues it once PRINT_STALE_SECONDS passes.
      log(`  (could not report the failure: ${reportErr.message})`);
    }
  }
}

// ── Poll loop ────────────────────────────────────────────────────────────────
let stopping = false;
let backoff = 0; // consecutive failures, for exponential backoff

// Pending sleeps, so Ctrl+C can cut a long backoff short instead of waiting it
// out. Each entry removes itself when it fires, so this cannot grow unbounded
// over a long run.
//
// These timers are deliberately NOT unref'd: while the agent sits idle between
// polls, the pending sleep is the only thing keeping the event loop alive. An
// unref'd timer here makes the process exit silently as soon as the handshake
// finishes, and no badge ever prints.
const pending = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    const entry = {};
    entry.resolve = resolve;
    entry.timer = setTimeout(() => {
      pending.delete(entry);
      resolve();
    }, ms);
    pending.add(entry);
  });
}

// Wake every pending sleep immediately, so a shutdown does not wait out a
// 60-second backoff.
function cancelSleeps() {
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.resolve();
  }
  pending.clear();
}

async function pollOnce() {
  const { jobs } = await api('GET', '/api/print/agent/jobs?limit=2');
  if (!jobs || !jobs.length) {
    debug('no jobs');
    return 0;
  }
  for (const job of jobs) {
    if (stopping) break;
    await processJob(job);
  }
  return jobs.length;
}

async function loop() {
  while (!stopping) {
    try {
      const n = await pollOnce();
      backoff = 0;
      // Had work? Check again immediately — a queue is probably draining.
      await sleep(n > 0 ? 250 : pollMs);
    } catch (e) {
      backoff = Math.min(backoff + 1, 6);
      const wait = Math.min(pollMs * 2 ** backoff, MAX_POLL_MS);

      if (e.code === 'agent_disabled') {
        log(`! the server has no PRINT_AGENT_TOKEN set — the agent API is disabled. Retrying in ${wait / 1000}s.`);
      } else if (e.status === 401) {
        log(`! token rejected. Check PRINT_AGENT_TOKEN matches the server. Retrying in ${wait / 1000}s.`);
      } else {
        log(`! ${e.message}. Retrying in ${wait / 1000}s.`);
      }
      await sleep(wait);
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n  VisiSign print agent\n');

  if (!windowsPrinter.available()) {
    console.error('  This agent drives the Windows print spooler, so it needs Windows.');
    console.error(`  Detected platform: ${process.platform}\n`);
    console.error('  On a Mac or iPad, use the kiosk device printing mode instead:');
    console.error('  set the `badge_print_mode` setting to `device` and the tablet will');
    console.error('  print badges itself via AirPrint (iPad) or Mopria (Android).\n');
    process.exit(1);
  }

  // Keep retrying the handshake — the PC may boot before the network is up.
  for (let attempt = 1; ; attempt++) {
    try {
      await hello();
      break;
    } catch (e) {
      const wait = Math.min(5000 * attempt, 60_000);
      log(`! could not reach ${BASE}: ${e.message}. Retrying in ${wait / 1000}s.`);
      await sleep(wait);
    }
  }

  // Re-announce periodically so the admin UI's printer list and the "last seen"
  // timestamp stay current, and so label-size changes are picked up.
  const heartbeat = setInterval(() => {
    hello().catch(() => {});
  }, 5 * 60 * 1000);
  heartbeat.unref();

  console.log('\n  Waiting for badge print jobs. Ctrl+C to stop.\n');
  await loop();
  log('stopped.');
  process.exit(0);
})().catch((err) => {
  console.error('\nPrint agent crashed:', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // A second signal means "stop arguing and quit".
    if (stopping) process.exit(0);
    stopping = true;
    log('stopping — finishing the current job first...');
    // Wake the poll loop so it notices `stopping` instead of sleeping on.
    cancelSleeps();
    // Hard deadline in case a print is wedged in the spooler. Refed on
    // purpose: it has to actually fire.
    setTimeout(() => {
      log('forced exit.');
      process.exit(0);
    }, 30_000);
  });
}
