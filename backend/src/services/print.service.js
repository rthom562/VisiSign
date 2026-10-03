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

const repo = require('../repositories/repo');
const config = require('../config');
const logService = require('./log.service');
const printQueue = require('./print.queue');
const windowsPrinter = require('./print.windows');

const isDirect = () => config.print.transport === 'direct';

/**
 * The printing settings to use for a job.
 *
 * A kiosk may name its own printer and label size; anything it does not set
 * falls back to the organisation default. This is what lets one building run
 * several kiosks against several printers.
 */
async function resolveFor(kioskId, override = {}) {
  const base = await cfg();
  let kiosk = null;
  if (kioskId) {
    try {
      kiosk = await repo.kiosks.byPublicId(String(kioskId).trim());
    } catch (_) {
      /* an unknown kiosk just falls back to the defaults */
    }
  }
  return {
    printer: override.printer || (kiosk && kiosk.printer) || base.printer,
    printMode: (kiosk && kiosk.print_mode) || base.printMode,
    widthMm: Number((kiosk && kiosk.label_width_mm) || base.widthMm) || 62,
    heightMm: Number((kiosk && kiosk.label_height_mm) || base.heightMm) || 90,
    autoprint: base.autoprint,
  };
}

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

/** Everything needed to render a badge for a visit, read from the database. */
async function badgeFieldsFromVisit(pid) {
  const visit = await repo.visits.byPublicId(String(pid || ''));
  if (!visit) throw new Error('Visit not found');

  const [guest, staff, badge] = await Promise.all([
    visit.guest_id ? repo.guests.byId(visit.guest_id) : null,
    visit.staff_user_id ? repo.users.byId(visit.staff_user_id) : null,
    repo.badges.byVisit(visit.id),
  ]);

  return {
    visitId: visit.public_id,
    visitRowId: visit.id,
    name: guest ? guest.full_name : staff ? staff.full_name : 'Visitor',
    company: guest ? guest.company : null,
    hostName: visit.host_name || null,
    reason: visit.reason || null,
    code: badge ? badge.code : null,
    dateStr: fmtDate(visit.signed_in_at),
    qrPayload: badge
      ? badge.qr_payload
      : JSON.stringify({ visit: visit.public_id, code: badge ? badge.code : null }),
  };
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
  // Which printer and label size depends on which kiosk asked.
  const c = await resolveFor(opts.kioskId, opts);
  const fields = await badgeFieldsFromVisit(pid);

  if (isDirect()) {
    const r = await windowsPrinter.runJob(fields, c, opts);
    return { printed: true, ...r };
  }

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
    },
    label: { printer: c.printer, widthMm: c.widthMm, heightMm: c.heightMm },
    visitId: fields.visitId,
    kioskId: opts.kioskId || null,
  });
  return { printed: false, ...r };
}

/** Sample badge, for the "Print test" button and the console. */
async function testPrint(opts = {}) {
  const c = await resolveFor(opts.kioskId, opts);
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
    label: { printer: c.printer, widthMm: c.widthMm, heightMm: c.heightMm },
  });
  return { printed: false, ...r };
}

/**
 * Fire-and-forget auto-print on sign-in / check-in. Never throws, never blocks
 * the sign-in it was triggered by.
 *
 * `kioskId` selects that kiosk's printer, so a sign-in at the loading bay
 * prints at the loading bay.
 */
async function autoPrint(pid, { kioskId } = {}) {
  try {
    const c = await resolveFor(kioskId);
    if (c.autoprint !== 'true') return;
    // Nothing to do when the tablet prints its own badge, or printing is off.
    if (c.printMode !== 'server') return;
    // In direct mode a printer must be chosen; in queue mode the agent may
    // supply its own default, so an empty setting is still worth queueing.
    if (isDirect() && !c.printer) return;

    const r = await printBadgeForVisit(pid, { kioskId });
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
