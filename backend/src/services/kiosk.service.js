'use strict';

// Kiosk device pairing. A device (browser) that opens the kiosk page registers
// itself; it stays 'pending' until an administrator accepts it from the console
// (`/kiosk accept <code>`) or the admin UI. The device polls its status and only
// shows the kiosk UI once accepted. If the `kiosk_require_approval` setting is
// 'false', devices are auto-accepted.

const repo = require('../repositories/repo');
const { ApiError } = require('../utils/http');
const { shortCode } = require('../utils/ids');
const logService = require('./log.service');

async function requireApproval() {
  const row = await repo.settings.get('kiosk_require_approval');
  return row ? row.value !== 'false' : true; // default: approval required
}

function publicView(k) {
  return { status: k.status, code: k.code, name: k.name || null };
}

// Settings the kiosk device needs: whether to capture a visitor photo, and how
// badges print — 'server' (a real printer driven by the VisiSign host or the
// on-premise print agent), 'device' (the tablet's own printing: AirPrint on
// iPad / Mopria on Android), or 'off'.
async function publicConfig() {
  const rows = await repo.settings.all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const g = (k, dflt) => (map.has(k) ? map.get(k) : dflt);
  return {
    orgName: g('org_name', ''),
    photo: g('require_photo', 'false') === 'true',
    printMode: g('badge_print_mode', 'server'),
    label: {
      widthMm: Number(g('badge_width_mm', '62')) || 62,
      heightMm: Number(g('badge_height_mm', '90')) || 90,
    },
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

const listAccepted = () => repo.kiosks.byStatus('accepted');
const listPending = () => repo.kiosks.byStatus('pending');
const listAll = () => repo.kiosks.all();

module.exports = {
  register, status, publicConfig,
  accept, reject, revoke,
  listAccepted, listPending, listAll,
};
