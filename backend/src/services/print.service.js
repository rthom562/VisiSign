'use strict';

// Badge printing — the transport-agnostic front door.
//
// There are three ways a VisiSign badge reaches paper, and which ones are even
// possible depends on where the server runs:
//
//   transport `direct`  the server IS the reception PC, so it drives the Windows
//                       spooler itself (print.windows.js). On-premise only.
//
//   transport `queue`   the server cannot reach the printer — it is in the cloud,
//                       or on Linux — so prints become queued jobs that the
//                       on-premise agent collects (print.queue.js).
//
//   device printing     the tablet prints the badge itself: AirPrint on iPad,
//                       Mopria on Android. Handled entirely in the browser (see
//                       the `device` branch in frontend/scripts/kiosk.js), so it
//                       needs no server transport at all and works everywhere,
//                       including straight from the cloud with no agent.
//
// The transport is chosen in config (PRINT_TRANSPORT), defaulting to `direct` on
// Windows outside a container and `queue` everywhere else. Callers — the kiosk
// route, the admin UI, the console — do not care which is in play.

const path = require('path');
const repo = require('../repositories/repo');
const config = require('../config');
const storage = require('../storage');
const logService = require('./log.service');
const printQueue = require('./print.queue');
const windowsPrinter = require('./print.windows');

const isDirect = () => config.print.transport === 'direct';

// ── Settings ─────────────────────────────────────────────────────────────────
async function cfg() {
  const rows = await repo.settings.all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const g = (k, d) => (map.has(k) ? map.get(k) : d);
  return {
    printer: g('badge_printer', ''),
    autoprint: g('badge_autoprint', 'false'),
    printMode: g('badge_print_mode', 'server'),
    widthMm: Number(g('badge_width_mm', '62')) || 62,
    heightMm: Number(g('badge_height_mm', '90')) || 90,
  };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso);
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(config.timezone ? { timeZone: config.timezone } : {}),
  });
}

/**
 * Everything needed to render a badge for a visit, read from the database.
 *
 * The photo comes back as a NAME plus (for the direct transport) its bytes, so
 * the same shape works whether photos live in a local folder or in a bucket.
 */
async function badgeFieldsFromVisit(pid, { withPhotoBytes = false } = {}) {
  const visit = await repo.visits.byPublicId(String(pid || ''));
  if (!visit) throw new Error('Visit not found');

  const [guest, staff, badge] = await Promise.all([
    visit.guest_id ? repo.guests.byId(visit.guest_id) : null,
    visit.staff_user_id ? repo.users.byId(visit.staff_user_id) : null,
    repo.badges.byVisit(visit.id),
  ]);

  const photoName = guest && guest.photo_url ? guest.photo_url : null;

  const fields = {
    visitId: visit.public_id,
    visitRowId: visit.id,
    name: guest ? guest.full_name : staff ? staff.full_name : 'Visitor',
    company: guest ? guest.company : null,
    hostName: visit.host_name || null,
    reason: visit.reason || null,
    code: badge ? badge.code : null,
    dateStr: fmtDate(visit.signed_in_at),
    photoName,
    qrPayload: badge
      ? badge.qr_payload
      : JSON.stringify({ visit: visit.public_id, code: badge ? badge.code : null }),
  };

  if (withPhotoBytes && photoName) {
    // The local driver can hand over a path directly, which avoids reading the
    // file into memory just to write it back out to a temp file.
    if (storage.driver.pathFor) {
      fields.photoPath = storage.driver.pathFor(photoName);
    } else {
      fields.photoBuffer = await storage.get(photoName);
      fields.photoIsPng = path.extname(photoName).toLowerCase() === '.png';
    }
  }

  return fields;
}

// ── Printer discovery (direct transport only) ────────────────────────────────
// In queue mode the printers live on the reception PC, which this process cannot
// enumerate. The agent reports what it has, and the admin UI reads that.

async function listPrinters() {
  if (!isDirect()) {
    const row = await repo.settings.get('agent_printers');
    if (row && row.value) {
      try {
        return JSON.parse(row.value);
      } catch (_) {
        /* fall through to the empty list */
      }
    }
    return [];
  }
  return windowsPrinter.listPrinters();
}

async function printerInfo(name) {
  const c = await cfg();
  const printer = name || c.printer;
  if (!isDirect()) {
    // Calibration needs the real driver, which only the agent can reach.
    return {
      valid: false,
      printer,
      unavailable: true,
      reason:
        'This VisiSign server has no printers attached (print transport "queue"). ' +
        'Label sizes are reported by the on-premise print agent.',
    };
  }
  return windowsPrinter.printerInfo(printer);
}

// ── Printing ─────────────────────────────────────────────────────────────────

/**
 * Print (or reprint) the badge for an existing visit.
 *
 * In `direct` mode this resolves once the label is actually printed. In `queue`
 * mode it resolves once the job is queued — the agent prints it moments later,
 * which the response signals with `queued: true` rather than `printed: true`.
 */
async function printBadgeForVisit(pid, opts = {}) {
  const c = await cfg();

  if (isDirect()) {
    const fields = await badgeFieldsFromVisit(pid, { withPhotoBytes: true });
    const r = await windowsPrinter.runJob(fields, c, opts);
    return { printed: true, ...r };
  }

  const fields = await badgeFieldsFromVisit(pid);
  const r = await printQueue.enqueue(fields.visitRowId, {
    kind: 'badge',
    fields: {
      name: fields.name,
      company: fields.company,
      hostName: fields.hostName,
      reason: fields.reason,
      code: fields.code,
      dateStr: fields.dateStr,
      qrPayload: fields.qrPayload,
      // The agent fetches the image itself, so a 4MB photo never sits in a row.
      photoName: fields.photoName,
    },
    label: { printer: opts.printer || c.printer, widthMm: c.widthMm, heightMm: c.heightMm },
    visitId: fields.visitId,
  });
  return { printed: false, ...r };
}

/** Sample badge, for the "Print test" button and the console. */
async function testPrint(opts = {}) {
  const c = await cfg();
  const fields = {
    name: 'Test Visitor',
    company: 'VisiSign',
    hostName: 'Reception',
    code: 'VS-TEST',
    dateStr: fmtDate(new Date().toISOString().replace('T', ' ').slice(0, 19)),
    qrPayload: JSON.stringify({ test: true }),
  };

  if (isDirect()) {
    const r = await windowsPrinter.runJob(fields, c, opts);
    return { printed: true, ...r };
  }

  const r = await printQueue.enqueue(null, {
    kind: 'badge',
    fields,
    label: { printer: opts.printer || c.printer, widthMm: c.widthMm, heightMm: c.heightMm },
  });
  return { printed: false, ...r };
}

/**
 * Fire-and-forget auto-print on sign-in / check-in. Never throws, never blocks
 * the sign-in it was triggered by.
 */
async function autoPrint(pid) {
  try {
    const c = await cfg();
    if (c.autoprint !== 'true') return;
    // Nothing to do when the tablet prints its own badge, or printing is off.
    if (c.printMode !== 'server') return;
    // In direct mode a printer must be chosen; in queue mode the agent may
    // supply its own default, so an empty setting is still worth queueing.
    if (isDirect() && !c.printer) return;

    const r = await printBadgeForVisit(pid, {});
    logService.record(null, {
      actorType: 'system',
      action: r.printed ? 'badge.printed' : 'badge.queued',
      targetTable: 'visits',
      detail: { visit: pid, ...(r.jobId ? { job: r.jobId } : {}) },
    });
  } catch (e) {
    logService.record(null, {
      actorType: 'system',
      action: 'badge.print_failed',
      detail: { visit: pid, error: e.message },
    });
    try {
      await repo.alerts.create({ level: 'warning', message: 'Badge print failed: ' + e.message });
    } catch (_) {
      /* the alert is best-effort */
    }
  }
}

/** Render a PNG preview without a printer (used for setup/verification). */
async function previewBadge(fields, outPath) {
  if (!isDirect()) throw new Error('Badge preview needs a local printer driver (print transport "direct").');
  const c = await cfg();
  await windowsPrinter.runJob(fields, c, { dryRun: true, outPath });
  return outPath;
}

/** Which transport is live — shown in the startup banner and the admin UI. */
function transport() {
  return {
    transport: config.print.transport,
    agentConfigured: !!config.print.agentToken,
    canPrintLocally: isDirect() && windowsPrinter.available(),
  };
}

module.exports = {
  cfg,
  fmtDate,
  badgeFieldsFromVisit,
  listPrinters,
  printerInfo,
  printBadgeForVisit,
  testPrint,
  autoPrint,
  previewBadge,
  transport,
  queue: printQueue,
};
