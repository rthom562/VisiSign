'use strict';

// The repository layer: the ONLY place that writes SQL. Everything is a
// parameterised prepared statement — no string concatenation of user input.
// Services call these functions; they never see SQL.

const { db } = require('../db/connection');

// ── Generic helpers ──────────────────────────────────────────────────────────
// node:sqlite binds anonymous parameters positionally via spread arguments, so
// we expand the params array into the call. Values must be primitives
// (string/number/bigint/null/Buffer) — `??` defaults to null handle that.
const get = (sql, params = []) => db.prepare(sql).get(...params);
const all = (sql, params = []) => db.prepare(sql).all(...params);
const run = (sql, params = []) => db.prepare(sql).run(...params);

// Transaction helper that mirrors the better-sqlite3 call style
// (`repo.tx(fn)()`): returns a function which runs fn inside BEGIN/COMMIT and
// rolls back on error. Returns whatever fn returns.
const tx = (fn) => (...args) => {
  db.exec('BEGIN');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

// ── Users ────────────────────────────────────────────────────────────────────
const users = {
  byEmail: (email) => get('SELECT * FROM users WHERE email = ?', [email]),
  byId: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
  byPublicId: (pid) => get('SELECT * FROM users WHERE public_id = ?', [pid]),
  create: ({ public_id, email, password_hash, full_name, role, access_level }) =>
    run(
      `INSERT INTO users (public_id, email, password_hash, full_name, role, access_level)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [public_id, email, password_hash, full_name, role, access_level]
    ),
  list: ({ q = '', limit = 100, offset = 0 }) =>
    all(
      `SELECT id, public_id, email, full_name, role, access_level, is_active, created_at
         FROM users
        WHERE (? = '' OR full_name LIKE '%'||?||'%' OR email LIKE '%'||?||'%')
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [q, q, q, limit, offset]
    ),
  update: (id, { full_name, role, access_level, is_active }) =>
    run(
      `UPDATE users
          SET full_name = COALESCE(?, full_name),
              role = COALESCE(?, role),
              access_level = COALESCE(?, access_level),
              is_active = COALESCE(?, is_active),
              updated_at = datetime('now')
        WHERE id = ?`,
      [full_name ?? null, role ?? null, access_level ?? null, is_active ?? null, id]
    ),
  setPassword: (id, password_hash) =>
    run(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`, [
      password_hash,
      id,
    ]),
  remove: (id) => run('DELETE FROM users WHERE id = ?', [id]),
};

const staff = {
  byUserId: (userId) => get('SELECT * FROM staff WHERE user_id = ?', [userId]),
  create: ({ user_id, site_id, department, title, phone, photo_url }) =>
    run(
      `INSERT INTO staff (user_id, site_id, department, title, phone, photo_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user_id, site_id ?? null, department ?? null, title ?? null, phone ?? null, photo_url ?? null]
    ),
};

const admins = {
  create: ({ user_id, scope = 'global' }) =>
    run('INSERT INTO admins (user_id, scope) VALUES (?, ?)', [user_id, scope]),
};

// ── Guests ───────────────────────────────────────────────────────────────────
const guests = {
  create: ({ public_id, full_name, company, email, phone, photo_url }) =>
    run(
      `INSERT INTO guests (public_id, full_name, company, email, phone, photo_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [public_id, full_name, company ?? null, email ?? null, phone ?? null, photo_url ?? null]
    ),
  byId: (id) => get('SELECT * FROM guests WHERE id = ?', [id]),
};

// ── Visits ───────────────────────────────────────────────────────────────────
const visits = {
  create: (v) =>
    run(
      `INSERT INTO visits
        (public_id, type, guest_id, staff_user_id, host_user_id, host_name,
         site_id, room_id, desk_id, reason, status, custom_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed_in', ?)`,
      [
        v.public_id, v.type, v.guest_id ?? null, v.staff_user_id ?? null,
        v.host_user_id ?? null, v.host_name ?? null, v.site_id ?? null,
        v.room_id ?? null, v.desk_id ?? null, v.reason ?? null,
        v.custom_data ?? null,
      ]
    ),
  byId: (id) => get('SELECT * FROM visits WHERE id = ?', [id]),
  byPublicId: (pid) => get('SELECT * FROM visits WHERE public_id = ?', [pid]),
  openStaffSession: (staffUserId) =>
    get(
      `SELECT * FROM visits
        WHERE type = 'staff' AND staff_user_id = ? AND status = 'signed_in'
        ORDER BY signed_in_at DESC LIMIT 1`,
      [staffUserId]
    ),
  signOut: (id) =>
    run(
      `UPDATE visits
          SET status = 'signed_out', signed_out_at = datetime('now')
        WHERE id = ? AND status = 'signed_in'`,
      [id]
    ),
  // Live list = currently signed in.
  live: ({ type = null, site_id = null }) =>
    all(
      `SELECT v.*, g.full_name AS guest_name, g.company AS guest_company,
              u.full_name AS staff_name, s.name AS site_name, r.name AS room_name
         FROM visits v
         LEFT JOIN guests g ON g.id = v.guest_id
         LEFT JOIN users  u ON u.id = v.staff_user_id
         LEFT JOIN sites  s ON s.id = v.site_id
         LEFT JOIN rooms  r ON r.id = v.room_id
        WHERE v.status = 'signed_in'
          AND (? IS NULL OR v.type = ?)
          AND (? IS NULL OR v.site_id = ?)
        ORDER BY v.signed_in_at DESC`,
      [type, type, site_id, site_id]
    ),
  // Full searchable history.
  search: ({ q = '', type = null, from = null, to = null, limit = 100, offset = 0 }) =>
    all(
      `SELECT v.*, g.full_name AS guest_name, g.company AS guest_company,
              u.full_name AS staff_name, s.name AS site_name, r.name AS room_name
         FROM visits v
         LEFT JOIN guests g ON g.id = v.guest_id
         LEFT JOIN users  u ON u.id = v.staff_user_id
         LEFT JOIN sites  s ON s.id = v.site_id
         LEFT JOIN rooms  r ON r.id = v.room_id
        WHERE (? = '' OR g.full_name LIKE '%'||?||'%'
                     OR u.full_name LIKE '%'||?||'%'
                     OR g.company   LIKE '%'||?||'%'
                     OR v.reason    LIKE '%'||?||'%'
                     OR v.host_name LIKE '%'||?||'%')
          AND (? IS NULL OR v.type = ?)
          AND (? IS NULL OR v.signed_in_at >= ?)
          AND (? IS NULL OR v.signed_in_at <= ?)
        ORDER BY v.signed_in_at DESC
        LIMIT ? OFFSET ?`,
      [q, q, q, q, q, q, type, type, from, from, to, to, limit, offset]
    ),
  // Staff hours: aggregate closed sessions, plus the current open one.
  staffSessions: (staffUserId, from = null, to = null) =>
    all(
      `SELECT id, public_id, signed_in_at, signed_out_at, status,
              CASE WHEN signed_out_at IS NULL THEN NULL
                   ELSE (julianday(signed_out_at) - julianday(signed_in_at)) * 24
              END AS hours
         FROM visits
        WHERE type = 'staff' AND staff_user_id = ?
          AND (? IS NULL OR signed_in_at >= ?)
          AND (? IS NULL OR signed_in_at <= ?)
        ORDER BY signed_in_at DESC`,
      [staffUserId, from, from, to, to]
    ),
};

// ── Badges ───────────────────────────────────────────────────────────────────
const badges = {
  create: ({ visit_id, code, qr_payload }) =>
    run('INSERT INTO badges (visit_id, code, qr_payload) VALUES (?, ?, ?)', [
      visit_id, code, qr_payload,
    ]),
  byVisit: (visitId) => get('SELECT * FROM badges WHERE visit_id = ?', [visitId]),
  revoke: (visitId) =>
    run(`UPDATE badges SET revoked_at = datetime('now') WHERE visit_id = ? AND revoked_at IS NULL`, [
      visitId,
    ]),
};

// ── Alerts ───────────────────────────────────────────────────────────────────
const alerts = {
  create: ({ level, message, visit_id, site_id }) =>
    run('INSERT INTO alerts (level, message, visit_id, site_id) VALUES (?, ?, ?, ?)', [
      level, message, visit_id ?? null, site_id ?? null,
    ]),
  open: () =>
    all(`SELECT * FROM alerts WHERE is_resolved = 0 ORDER BY created_at DESC`),
  resolve: (id) =>
    run(`UPDATE alerts SET is_resolved = 1, resolved_at = datetime('now') WHERE id = ?`, [id]),
};

// ── Logs ─────────────────────────────────────────────────────────────────────
const logs = {
  add: ({ actor_type, actor_id, action, target_table, target_id, detail, ip }) =>
    run(
      `INSERT INTO logs (actor_type, actor_id, action, target_table, target_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actor_type, actor_id ?? null, action, target_table ?? null, target_id ?? null,
       detail ? JSON.stringify(detail) : null, ip ?? null]
    ),
  recent: (limit = 100) =>
    all('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?', [limit]),
};

// ── Sites / rooms / desks ────────────────────────────────────────────────────
const places = {
  listSites: () => all('SELECT * FROM sites WHERE is_active = 1 ORDER BY name'),
  createSite: ({ name, address, timezone }) =>
    run('INSERT INTO sites (name, address, timezone) VALUES (?, ?, ?)', [
      name, address ?? null, timezone ?? 'UTC',
    ]),
  listRooms: (siteId) =>
    all('SELECT * FROM rooms WHERE (? IS NULL OR site_id = ?) ORDER BY name', [siteId ?? null, siteId ?? null]),
  createRoom: ({ site_id, name, floor, capacity }) =>
    run('INSERT INTO rooms (site_id, name, floor, capacity) VALUES (?, ?, ?, ?)', [
      site_id, name, floor ?? null, capacity ?? 0,
    ]),
  listDesks: (roomId) =>
    all('SELECT * FROM desks WHERE (? IS NULL OR room_id = ?) ORDER BY label', [roomId ?? null, roomId ?? null]),
  createDesk: ({ room_id, label, is_bookable }) =>
    run('INSERT INTO desks (room_id, label, is_bookable) VALUES (?, ?, ?)', [
      room_id, label, is_bookable ?? 1,
    ]),
};

// ── Reservations ─────────────────────────────────────────────────────────────
const reservations = {
  create: (r) =>
    run(
      `INSERT INTO reservations
        (public_id, full_name, company, email, phone, host_name, reason,
         site_id, reserved_date, time_slot, custom_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.public_id, r.full_name, r.company ?? null, r.email ?? null, r.phone ?? null,
       r.host_name ?? null, r.reason ?? null, r.site_id ?? null,
       r.reserved_date, r.time_slot, r.custom_data ?? null]
    ),
  byPublicId: (pid) => get('SELECT * FROM reservations WHERE public_id = ?', [pid]),
  // Count active bookings in a given date + slot (for capacity checks).
  countInSlot: (date, slot) =>
    get(
      `SELECT COUNT(*) AS n FROM reservations
        WHERE reserved_date = ? AND time_slot = ? AND status IN ('reserved','checked_in')`,
      [date, slot]
    ).n,
  // Per-slot counts for a whole day (for availability display).
  countsForDate: (date) =>
    all(
      `SELECT time_slot, COUNT(*) AS n FROM reservations
        WHERE reserved_date = ? AND status IN ('reserved','checked_in')
        GROUP BY time_slot`,
      [date]
    ),
  // Still-open reservations for a date, ordered by slot.
  openForDate: (date) =>
    all(
      `SELECT * FROM reservations
        WHERE reserved_date = ? AND status = 'reserved'
        ORDER BY time_slot, full_name`,
      [date]
    ),
  // Full list for admin (any status) for a date.
  allForDate: (date) =>
    all(
      `SELECT r.*, v.public_id AS visit_public_id
         FROM reservations r
         LEFT JOIN visits v ON v.id = r.visit_id
        WHERE r.reserved_date = ?
        ORDER BY r.time_slot, r.full_name`,
      [date]
    ),
  markCheckedIn: (id, visitId) =>
    run(
      `UPDATE reservations
          SET status = 'checked_in', visit_id = ?, checked_in_at = datetime('now')
        WHERE id = ? AND status = 'reserved'`,
      [visitId, id]
    ),
  cancel: (id) =>
    run(`UPDATE reservations SET status = 'cancelled' WHERE id = ? AND status = 'reserved'`, [id]),
};

// ── Kiosks ───────────────────────────────────────────────────────────────────
const kiosks = {
  byPublicId: (pid) => get('SELECT * FROM kiosks WHERE public_id = ?', [pid]),
  byCode: (code) => get('SELECT * FROM kiosks WHERE code = ? COLLATE NOCASE', [code]),
  create: ({ public_id, code, name, user_agent, ip, status }) =>
    run(
      `INSERT INTO kiosks (public_id, code, name, user_agent, ip, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [public_id, code, name ?? null, user_agent ?? null, ip ?? null, status || 'pending']
    ),
  all: () => all('SELECT * FROM kiosks ORDER BY requested_at DESC'),
  byStatus: (status) =>
    all('SELECT * FROM kiosks WHERE status = ? ORDER BY requested_at DESC', [status]),
  setStatus: (id, status) =>
    run(
      `UPDATE kiosks
          SET status = ?,
              accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE accepted_at END
        WHERE id = ?`,
      [status, status, id]
    ),
  touch: (id) => run(`UPDATE kiosks SET last_seen_at = datetime('now') WHERE id = ?`, [id]),
  updateMeta: (id, { name, user_agent, ip }) =>
    run(
      `UPDATE kiosks SET name = COALESCE(?, name), user_agent = COALESCE(?, user_agent),
              ip = COALESCE(?, ip) WHERE id = ?`,
      [name ?? null, user_agent ?? null, ip ?? null, id]
    ),
};

// ── Settings ─────────────────────────────────────────────────────────────────
const settings = {
  all: () => all('SELECT key, value FROM settings'),
  get: (key) => get('SELECT value FROM settings WHERE key = ?', [key]),
  set: (key, value) =>
    run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, value]
    ),
};

// ── Stats (for the admin overview) ───────────────────────────────────────────
const stats = {
  overview: () =>
    get(`SELECT
           (SELECT COUNT(*) FROM visits WHERE status='signed_in' AND type='guest') AS guests_onsite,
           (SELECT COUNT(*) FROM visits WHERE status='signed_in' AND type='staff') AS staff_onsite,
           (SELECT COUNT(*) FROM visits WHERE date(signed_in_at)=date('now'))      AS visits_today,
           (SELECT COUNT(*) FROM alerts WHERE is_resolved=0)                       AS open_alerts`),
};

module.exports = {
  get, all, run, tx,
  users, staff, admins, guests, visits, badges, alerts, logs, places,
  reservations, kiosks, settings, stats,
};
