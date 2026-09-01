'use strict';

const repo = require('../repositories/repo');
const authService = require('./auth.service');
const { ApiError } = require('../utils/http');
const logService = require('./log.service');

// ── Users management ─────────────────────────────────────────────────────────
const listUsers = (filter) => repo.users.list(filter);

async function createUser(req, admin, payload) {
  const user = await authService.createUser(payload);
  logService.record(req, {
    actorType: 'admin', actorId: admin.id, action: 'user.create',
    targetTable: 'users', targetId: user.id, detail: { email: user.email, role: user.role },
  });
  return user;
}

function updateUser(req, admin, publicUserId, patch) {
  const target = repo.users.byPublicId(publicUserId);
  if (!target) throw new ApiError(404, 'User not found');
  repo.users.update(target.id, {
    full_name: patch.fullName,
    role: patch.role,
    access_level: patch.accessLevel,
    is_active: patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0,
  });
  logService.record(req, {
    actorType: 'admin', actorId: admin.id, action: 'user.update',
    targetTable: 'users', targetId: target.id, detail: patch,
  });
  return authService.publicUser(repo.users.byId(target.id));
}

function deleteUser(req, admin, publicUserId) {
  const target = repo.users.byPublicId(publicUserId);
  if (!target) throw new ApiError(404, 'User not found');
  if (target.id === admin.id) throw new ApiError(400, 'You cannot delete your own account');
  repo.users.remove(target.id);
  logService.record(req, {
    actorType: 'admin', actorId: admin.id, action: 'user.delete',
    targetTable: 'users', targetId: target.id,
  });
  return { id: publicUserId, deleted: true };
}

// ── Overview / alerts ────────────────────────────────────────────────────────
const overview = () => repo.stats.overview();
const openAlerts = () => repo.alerts.open();
function resolveAlert(req, admin, id) {
  repo.alerts.resolve(Number(id));
  logService.record(req, {
    actorType: 'admin', actorId: admin.id, action: 'alert.resolve',
    targetTable: 'alerts', targetId: Number(id),
  });
  return { id: Number(id), resolved: true };
}

// ── Settings ─────────────────────────────────────────────────────────────────
function getSettings() {
  const rows = repo.settings.all();
  return rows.reduce((acc, r) => ((acc[r.key] = r.value), acc), {});
}
function updateSettings(req, admin, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    repo.settings.set(String(key), String(value));
  }
  logService.record(req, {
    actorType: 'admin', actorId: admin.id, action: 'settings.update', detail: patch,
  });
  return getSettings();
}

// ── Reports / export ─────────────────────────────────────────────────────────
function exportVisitsCsv(filter = {}) {
  const rows = repo.visits.search({ ...filter, limit: 100000, offset: 0 });
  const headers = [
    'visit_id', 'type', 'name', 'company', 'host', 'site', 'room',
    'reason', 'status', 'signed_in_at', 'signed_out_at',
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.public_id, r.type, r.guest_name || r.staff_name, r.guest_company,
      r.host_name, r.site_name, r.room_name, r.reason, r.status,
      r.signed_in_at, r.signed_out_at,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

// ── Places ───────────────────────────────────────────────────────────────────
const listSites = () => repo.places.listSites();
const listRooms = (siteId) => repo.places.listRooms(siteId ? Number(siteId) : null);
const listDesks = (roomId) => repo.places.listDesks(roomId ? Number(roomId) : null);
const recentLogs = (limit) => repo.logs.recent(limit);

module.exports = {
  listUsers, createUser, updateUser, deleteUser,
  overview, openAlerts, resolveAlert,
  getSettings, updateSettings,
  exportVisitsCsv,
  listSites, listRooms, listDesks, recentLogs,
};
