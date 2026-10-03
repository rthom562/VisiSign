'use strict';

// Kiosk device pairing and per-device configuration.
//
// A device (browser) that opens the kiosk page registers itself; it stays
// 'pending' until an administrator accepts it. The device polls its status and
// only shows the kiosk UI once accepted. If `kiosk_require_approval` is 'false',
// devices are auto-accepted.
//
// ── Several kiosks, several printers ────────────────────────────────────────
// A building can run any number of kiosks, and each one can drive its own
// printer at its own label size — a lobby desk with a Brother QL and a loading
// bay with a Zebra, say. Each kiosk stores only the fields it OVERRIDES; a null
// column means "follow the organisation default", so changing the default in
// Settings still moves every kiosk that has not been given its own.

const repo = require('../repositories/repo');
const settingsService = require('./settings.service');
const { ApiError } = require('../utils/http');
const { shortCode } = require('../utils/ids');
const logService = require('./log.service');

async function requireApproval() {
  return (await settingsService.value('kiosk_require_approval')) !== 'false';
}

function publicView(k) {
  return { status: k.status, code: k.code, name: k.name || null };
}

/**
 * Resolve the printing configuration for one kiosk: its own overrides where it
 * has them, the organisation defaults everywhere else.
 */
function resolvePrinting(kiosk, s) {
  const k = kiosk || {};
  return {
    printMode: k.print_mode || s.badge_print_mode || 'server',
    printer: k.printer || s.badge_printer || '',
    label: {
      widthMm: Number(k.label_width_mm || s.badge_width_mm) || 62,
      heightMm: Number(k.label_height_mm || s.badge_height_mm) || 90,
    },
    // So the admin UI can show what is inherited rather than set here.
    overrides: {
      printMode: !!k.print_mode,
      printer: !!k.printer,
      label: !!(k.label_width_mm || k.label_height_mm),
    },
  };
}

/**
 * Settings a kiosk device needs. Public, so it carries only what a visitor
 * standing at the kiosk could already see.
 *
 * `deviceId` is optional: when given, the reply is tailored to that kiosk's own
 * printer and label size.
 */
async function publicConfig(deviceId) {
  const s = await settingsService.all();
  const kiosk = deviceId ? await repo.kiosks.byPublicId(String(deviceId).trim()) : null;
  const printing = resolvePrinting(kiosk, s);

  return {
    orgName: s.org_name,
    printMode: printing.printMode,
    label: printing.label,
    kiosk: kiosk ? { code: kiosk.code, name: kiosk.name || null, location: kiosk.location || null } : null,
  };
}

// Device calls this on load. Creates a pending kiosk the first time, otherwise
// refreshes its metadata and returns the current status.
async function register(req, { deviceId, name }) {
  deviceId = String(deviceId || '').trim();
  if (!deviceId) throw new ApiError(400, 'deviceId is required');

  const meta = {
    name: name ? String(name).slice(0, 60) : null,
    user_agent: req && req.headers ? req.headers['user-agent'] : null,
    ip: req ? req.ip : null,
  };

  let k = await repo.kiosks.byPublicId(deviceId);
  if (!k) {
    const status = (await requireApproval()) ? 'pending' : 'accepted';
    await repo.kiosks.create({
      public_id: deviceId,
      code: shortCode(4),
      name: meta.name,
      user_agent: meta.user_agent,
      ip: meta.ip,
      status,
    });
    k = await repo.kiosks.byPublicId(deviceId);
    logService.record(req, {
      actorType: 'system',
      action: 'kiosk.request',
      targetTable: 'kiosks',
      targetId: k.id,
      detail: { code: k.code, name: meta.name },
    });
  } else {
    await repo.kiosks.updateMeta(k.id, meta);
    // A device that was removed and comes back goes to the pending queue again.
    if (k.status === 'revoked' || k.status === 'rejected') {
      await repo.kiosks.setStatus(k.id, 'pending');
      k = await repo.kiosks.byPublicId(deviceId);
    }
  }
  await repo.kiosks.touch(k.id);
  return publicView(k);
}

async function status(req, deviceId) {
  const k = await repo.kiosks.byPublicId(String(deviceId || '').trim());
  if (!k) return { status: 'unknown' };
  await repo.kiosks.touch(k.id);
  return publicView(k);
}

// ── Admin/console operations ─────────────────────────────────────────────────
async function resolve(codeOrId) {
  const key = String(codeOrId || '').trim();
  return (await repo.kiosks.byCode(key)) || (await repo.kiosks.byPublicId(key)) || null;
}

async function setStatus(codeOrId, next, action) {
  const k = await resolve(codeOrId);
  if (!k) throw new ApiError(404, 'Kiosk not found');
  await repo.kiosks.setStatus(k.id, next);
  logService.record(null, { actorType: 'admin', action, targetTable: 'kiosks', targetId: k.id });
  return { code: k.code, name: k.name || null, status: next };
}

const accept = (codeOrId) => setStatus(codeOrId, 'accepted', 'kiosk.accept');
const reject = (codeOrId) => setStatus(codeOrId, 'rejected', 'kiosk.reject');
const revoke = (codeOrId) => setStatus(codeOrId, 'revoked', 'kiosk.revoke');

/** Every kiosk, with its resolved printing config, for the admin device list. */
async function listDetailed() {
  const [rows, s] = await Promise.all([repo.kiosks.all(), settingsService.all()]);
  return rows.map((k) => ({
    id: k.public_id,
    code: k.code,
    name: k.name || null,
    location: k.location || null,
    status: k.status,
    requestedAt: k.requested_at,
    acceptedAt: k.accepted_at,
    lastSeenAt: k.last_seen_at,
    userAgent: k.user_agent || null,
    ip: k.ip || null,
    printing: resolvePrinting(k, s),
  }));
}

/**
 * Change one kiosk's own configuration.
 *
 * An empty string means "stop overriding this and follow the default again",
 * which is different from leaving the field out (meaning "don't touch it").
 */
async function updateConfig(req, admin, codeOrId, patch) {
  const k = await resolve(codeOrId);
  if (!k) throw new ApiError(404, 'Kiosk not found');

  const clears = [];
  const set = {};

  const str = (field, value, maxLen) => {
    if (value === undefined) return;
    const v = String(value).trim();
    if (v === '') clears.push(field);
    else set[field] = v.slice(0, maxLen);
  };

  str('name', patch.name, 60);
  str('location', patch.location, 80);
  str('printer', patch.printer, 200);

  if (patch.printMode !== undefined) {
    const v = String(patch.printMode).trim();
    if (v === '') clears.push('print_mode');
    else if (!['server', 'device', 'off'].includes(v)) {
      throw new ApiError(400, 'printMode must be server, device or off', 'validation');
    } else set.print_mode = v;
  }

  for (const [field, raw] of [['label_width_mm', patch.labelWidthMm], ['label_height_mm', patch.labelHeightMm]]) {
    if (raw === undefined) continue;
    const v = String(raw).trim();
    if (v === '') { clears.push(field); continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 10 || n > 300) {
      throw new ApiError(400, 'Label sizes must be between 10 and 300 mm', 'validation');
    }
    set[field] = Math.round(n);
  }

  if (Object.keys(set).length) await repo.kiosks.updateConfig(k.id, set);
  for (const field of clears) await repo.kiosks.clearConfigField(k.id, field);

  logService.record(req, {
    actorType: 'admin', actorId: admin ? admin.id : null, action: 'kiosk.configure',
    targetTable: 'kiosks', targetId: k.id, detail: { set, cleared: clears },
  });

  const fresh = await repo.kiosks.byPublicId(k.public_id);
  const s = await settingsService.all();
  return { code: fresh.code, name: fresh.name, location: fresh.location, printing: resolvePrinting(fresh, s) };
}

/** Forget a kiosk entirely. It must re-register and be approved again. */
async function remove(req, admin, codeOrId) {
  const k = await resolve(codeOrId);
  if (!k) throw new ApiError(404, 'Kiosk not found');
  await repo.kiosks.remove(k.id);
  logService.record(req, {
    actorType: 'admin', actorId: admin ? admin.id : null, action: 'kiosk.delete',
    targetTable: 'kiosks', targetId: k.id, detail: { code: k.code },
  });
  return { code: k.code, deleted: true };
}

const listAccepted = () => repo.kiosks.byStatus('accepted');
const listPending = () => repo.kiosks.byStatus('pending');
const listAll = () => repo.kiosks.all();

module.exports = {
  register, status, publicConfig,
  accept, reject, revoke,
  listAccepted, listPending, listAll, listDetailed,
  updateConfig, remove, resolve, resolvePrinting,
};
