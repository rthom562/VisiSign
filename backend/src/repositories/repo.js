'use strict';

// The repository layer: the ONLY place that writes SQL. Everything is a
// parameterised prepared statement — no string concatenation of user input.
// Services call these functions; they never see SQL.
//
// ── Two backends, one query layer ───────────────────────────────────────────
// Every function here runs unchanged on SQLite (on-premise / packaged .exe) and
// on PostgreSQL (cloud). That works because:
//
//   * queries are written with `?` placeholders and the Postgres driver rewrites
//     them to $1, $2, … (see ../db/drivers/postgres.js);
//   * timestamps are TEXT 'YYYY-MM-DD HH:MM:SS' UTC in both schemas, so range
//     filters and sorts are the same string comparison either way;
//   * the few genuine dialect differences go through `d` (../db/dialect.js).
//
// ── Everything is async ─────────────────────────────────────────────────────
// Postgres is network-bound, so the interface has to be promise-based. Callers
// must await. The SQLite driver is synchronous underneath and resolves
// immediately.
//
// ── Dynamic filters ─────────────────────────────────────────────────────────
// Optional filters build their WHERE clause from the arguments actually given
// rather than the older `(? IS NULL OR col = ?)` trick. That keeps Postgres
// from having to infer a bare parameter's type, stops binding each value twice,
// and lets the planner use the indexes.

const { exec: rootExec, dialect: d, tx: driverTx } = require('../db/connection');

/**
 * Build a repository bound to one executor — either the pool/handle (the
 * default) or a transaction-scoped client (inside `tx`).
 */
function makeRepo(x) {
  const get = (sql, params = []) => x.get(sql, params);
  const all = (sql, params = []) => x.all(sql, params);
  const run = (sql, params = []) => x.run(sql, params);
  const insert = (sql, params = []) => x.insert(sql, params);

  // ── Users ──────────────────────────────────────────────────────────────────
  const users = {
    byEmail: (email) => get('SELECT * FROM users WHERE email = ?', [email]),
    byId: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
    byPublicId: (pid) => get('SELECT * FROM users WHERE public_id = ?', [pid]),

    create: ({ public_id, email, password_hash, full_name, role, access_level }) =>
      insert(
        `INSERT INTO users (public_id, email, password_hash, full_name, role, access_level)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [public_id, email, password_hash, full_name, role, access_level]
      ),

    list: ({ q = '', limit = 100, offset = 0 }) => {
      const where = [];
      const p = [];
      if (q) {
        where.push(`(full_name ${d.like} '%'||?||'%' OR email ${d.like} '%'||?||'%')`);
        p.push(q, q);
      }
      p.push(limit, offset);
      return all(
        `SELECT id, public_id, email, full_name, role, access_level, is_active, created_at
           FROM users
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
        p
      );
    },

    update: (id, { full_name, role, access_level, is_active }) =>
      run(
        `UPDATE users
            SET full_name    = COALESCE(?, full_name),
                role         = COALESCE(?, role),
                access_level = COALESCE(?, access_level),
                is_active    = COALESCE(?, is_active),
                updated_at   = ${d.now()}
          WHERE id = ?`,
        [full_name ?? null, role ?? null, access_level ?? null, is_active ?? null, id]
      ),

    setPassword: (id, password_hash) =>
      run(`UPDATE users SET password_hash = ?, updated_at = ${d.now()} WHERE id = ?`, [
        password_hash,
        id,
      ]),

    remove: (id) => run('DELETE FROM users WHERE id = ?', [id]),
  };

  const staff = {
    byUserId: (userId) => get('SELECT * FROM staff WHERE user_id = ?', [userId]),
    create: ({ user_id, site_id, department, title, phone, photo_url }) =>
      insert(
        `INSERT INTO staff (user_id, site_id, department, title, phone, photo_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user_id, site_id ?? null, department ?? null, title ?? null, phone ?? null, photo_url ?? null]
      ),
  };

  const admins = {
    create: ({ user_id, scope = 'global' }) =>
      insert('INSERT INTO admins (user_id, scope) VALUES (?, ?)', [user_id, scope]),
  };

  // ── Guests ─────────────────────────────────────────────────────────────────
  const guests = {
    create: ({ public_id, full_name, company, email, phone, photo_url }) =>
      insert(
        `INSERT INTO guests (public_id, full_name, company, email, phone, photo_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [public_id, full_name, company ?? null, email ?? null, phone ?? null, photo_url ?? null]
      ),
    byId: (id) => get('SELECT * FROM guests WHERE id = ?', [id]),
  };

  // ── Visits ─────────────────────────────────────────────────────────────────
  // The SELECT list shared by the live view and the history search.
  const VISIT_COLUMNS = `
    v.*, g.full_name AS guest_name, g.company AS guest_company,
    u.full_name AS staff_name, s.name AS site_name, r.name AS room_name`;
  const VISIT_JOINS = `
      FROM visits v
      LEFT JOIN guests g ON g.id = v.guest_id
      LEFT JOIN users  u ON u.id = v.staff_user_id
      LEFT JOIN sites  s ON s.id = v.site_id
      LEFT JOIN rooms  r ON r.id = v.room_id`;

  const visits = {
    create: (v) =>
      insert(
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
            SET status = 'signed_out', signed_out_at = ${d.now()}
          WHERE id = ? AND status = 'signed_in'`,
        [id]
      ),

    // Live list = currently signed in.
    live: ({ type = null, site_id = null } = {}) => {
      const where = ["v.status = 'signed_in'"];
      const p = [];
      if (type) { where.push('v.type = ?'); p.push(type); }
      if (site_id) { where.push('v.site_id = ?'); p.push(site_id); }
      return all(
        `SELECT ${VISIT_COLUMNS} ${VISIT_JOINS}
          WHERE ${where.join(' AND ')}
          ORDER BY v.signed_in_at DESC`,
        p
      );
    },

    // Full searchable history.
    search: ({ q = '', type = null, from = null, to = null, limit = 100, offset = 0 } = {}) => {
      const where = [];
      const p = [];
      if (q) {
        where.push(
          `(g.full_name ${d.like} '%'||?||'%'
         OR u.full_name ${d.like} '%'||?||'%'
         OR g.company   ${d.like} '%'||?||'%'
         OR v.reason    ${d.like} '%'||?||'%'
         OR v.host_name ${d.like} '%'||?||'%')`
        );
        p.push(q, q, q, q, q);
      }
      if (type) { where.push('v.type = ?'); p.push(type); }
      if (from) { where.push('v.signed_in_at >= ?'); p.push(from); }
      if (to)   { where.push('v.signed_in_at <= ?'); p.push(to); }
      p.push(limit, offset);
      return all(
        `SELECT ${VISIT_COLUMNS} ${VISIT_JOINS}
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY v.signed_in_at DESC
          LIMIT ? OFFSET ?`,
        p
      );
    },

    // Staff hours: closed sessions with their duration, plus any open one.
    staffSessions: (staffUserId, from = null, to = null) => {
      const where = ["type = 'staff'", 'staff_user_id = ?'];
      const p = [staffUserId];
      if (from) { where.push('signed_in_at >= ?'); p.push(from); }
      if (to)   { where.push('signed_in_at <= ?'); p.push(to); }
      return all(
        `SELECT id, public_id, signed_in_at, signed_out_at, status,
                CASE WHEN signed_out_at IS NULL THEN NULL
                     ELSE ${d.hoursBetween('signed_in_at', 'signed_out_at')}
                END AS hours
           FROM visits
          WHERE ${where.join(' AND ')}
          ORDER BY signed_in_at DESC`,
        p
      );
    },

    // Everyone still signed in — used by the end-of-day auto-signout sweep.
    allOpen: () => all("SELECT id, public_id FROM visits WHERE status = 'signed_in'"),
  };

  // ── Badges ─────────────────────────────────────────────────────────────────
  const badges = {
    create: ({ visit_id, code, qr_payload }) =>
      insert('INSERT INTO badges (visit_id, code, qr_payload) VALUES (?, ?, ?)', [
        visit_id, code, qr_payload,
      ]),
    byVisit: (visitId) => get('SELECT * FROM badges WHERE visit_id = ?', [visitId]),
    revoke: (visitId) =>
      run(
        `UPDATE badges SET revoked_at = ${d.now()} WHERE visit_id = ? AND revoked_at IS NULL`,
        [visitId]
      ),
  };

  // ── Alerts ─────────────────────────────────────────────────────────────────
  const alerts = {
    create: ({ level, message, visit_id, site_id }) =>
      insert('INSERT INTO alerts (level, message, visit_id, site_id) VALUES (?, ?, ?, ?)', [
        level, message, visit_id ?? null, site_id ?? null,
      ]),
    open: () => all('SELECT * FROM alerts WHERE is_resolved = 0 ORDER BY created_at DESC'),
    resolve: (id) =>
      run(`UPDATE alerts SET is_resolved = 1, resolved_at = ${d.now()} WHERE id = ?`, [id]),
  };

  // ── Logs ───────────────────────────────────────────────────────────────────
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

  // ── Sites / rooms / desks ──────────────────────────────────────────────────
  const places = {
    listSites: () => all('SELECT * FROM sites WHERE is_active = 1 ORDER BY name'),

    createSite: ({ name, address, timezone }) =>
      insert('INSERT INTO sites (name, address, timezone) VALUES (?, ?, ?)', [
        name, address ?? null, timezone ?? 'UTC',
      ]),

    listRooms: (siteId) =>
      siteId
        ? all('SELECT * FROM rooms WHERE site_id = ? ORDER BY name', [siteId])
        : all('SELECT * FROM rooms ORDER BY name'),

    createRoom: ({ site_id, name, floor, capacity }) =>
      insert('INSERT INTO rooms (site_id, name, floor, capacity) VALUES (?, ?, ?, ?)', [
        site_id, name, floor ?? null, capacity ?? 0,
      ]),

    listDesks: (roomId) =>
      roomId
        ? all('SELECT * FROM desks WHERE room_id = ? ORDER BY label', [roomId])
        : all('SELECT * FROM desks ORDER BY label'),

    createDesk: ({ room_id, label, is_bookable }) =>
      insert('INSERT INTO desks (room_id, label, is_bookable) VALUES (?, ?, ?)', [
        room_id, label, is_bookable ?? 1,
      ]),
  };

  // ── Reservations ───────────────────────────────────────────────────────────
  const reservations = {
    create: (r) =>
      insert(
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
    countInSlot: async (date, slot) => {
      const row = await get(
        `SELECT COUNT(*) AS n FROM reservations
          WHERE reserved_date = ? AND time_slot = ? AND status IN ('reserved','checked_in')`,
        [date, slot]
      );
      return Number(row ? row.n : 0);
    },

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
            SET status = 'checked_in', visit_id = ?, checked_in_at = ${d.now()}
          WHERE id = ? AND status = 'reserved'`,
        [visitId, id]
      ),

    cancel: (id) =>
      run(`UPDATE reservations SET status = 'cancelled' WHERE id = ? AND status = 'reserved'`, [id]),
  };

  // ── Kiosks ─────────────────────────────────────────────────────────────────
  const kiosks = {
    byPublicId: (pid) => get('SELECT * FROM kiosks WHERE public_id = ?', [pid]),

    // Case-insensitive on both backends: SQLite would need COLLATE NOCASE and
    // Postgres has no such collation, so compare lowered values instead.
    byCode: (code) => get('SELECT * FROM kiosks WHERE lower(code) = lower(?)', [code]),

    create: ({ public_id, code, name, user_agent, ip, status }) =>
      insert(
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
                accepted_at = CASE WHEN ? = 'accepted' THEN ${d.now()} ELSE accepted_at END
          WHERE id = ?`,
        [status, status, id]
      ),

    touch: (id) => run(`UPDATE kiosks SET last_seen_at = ${d.now()} WHERE id = ?`, [id]),

    updateMeta: (id, { name, user_agent, ip }) =>
      run(
        `UPDATE kiosks SET name = COALESCE(?, name), user_agent = COALESCE(?, user_agent),
                ip = COALESCE(?, ip) WHERE id = ?`,
        [name ?? null, user_agent ?? null, ip ?? null, id]
      ),
  };

  // ── Settings ───────────────────────────────────────────────────────────────
  const settings = {
    all: () => all('SELECT key, value FROM settings'),
    get: (key) => get('SELECT value FROM settings WHERE key = ?', [key]),
    set: (key, value) =>
      run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ${d.now()})
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ${d.now()}`,
        [key, value]
      ),
  };

  // ── Print jobs ─────────────────────────────────────────────────────────────
  // The queue the on-premise print agent drains when the server cannot reach
  // the label printer itself (i.e. whenever VisiSign runs in the cloud).
  const printJobs = {
    create: ({ public_id, visit_id, payload }) =>
      insert('INSERT INTO print_jobs (public_id, visit_id, payload) VALUES (?, ?, ?)', [
        public_id, visit_id ?? null, payload,
      ]),

    byPublicId: (pid) => get('SELECT * FROM print_jobs WHERE public_id = ?', [pid]),

    // Oldest queued jobs first. Claiming is a separate conditional UPDATE so two
    // agents polling at the same time cannot both take the same job.
    queued: (limit = 5) =>
      all(
        `SELECT * FROM print_jobs WHERE status = 'queued'
          ORDER BY created_at, id LIMIT ?`,
        [limit]
      ),

    // Returns { changes: 1 } only for the agent that actually won the job.
    claim: (id, agentId) =>
      run(
        `UPDATE print_jobs
            SET status = 'claimed', agent_id = ?, claimed_at = ${d.now()},
                attempts = attempts + 1
          WHERE id = ? AND status = 'queued'`,
        [agentId, id]
      ),

    finish: (id, { ok, error }) =>
      run(
        `UPDATE print_jobs
            SET status = ?, error = ?, finished_at = ${d.now()}
          WHERE id = ?`,
        [ok ? 'done' : 'failed', error ?? null, id]
      ),

    // Re-queue jobs an agent claimed but never finished (it crashed, lost
    // network, or the PC was shut down mid-print).
    requeueStale: (olderThan, maxAttempts = 3) =>
      run(
        `UPDATE print_jobs
            SET status = 'queued', agent_id = NULL, claimed_at = NULL
          WHERE status = 'claimed' AND claimed_at < ? AND attempts < ?`,
        [olderThan, maxAttempts]
      ),

    recent: (limit = 50) =>
      all('SELECT * FROM print_jobs ORDER BY created_at DESC, id DESC LIMIT ?', [limit]),
  };

  // ── Stats (for the admin overview) ─────────────────────────────────────────
  const stats = {
    overview: () =>
      get(`SELECT
             (SELECT COUNT(*) FROM visits WHERE status='signed_in' AND type='guest') AS guests_onsite,
             (SELECT COUNT(*) FROM visits WHERE status='signed_in' AND type='staff') AS staff_onsite,
             (SELECT COUNT(*) FROM visits
               WHERE ${d.dateOf('signed_in_at')} = ${d.today()})                      AS visits_today,
             (SELECT COUNT(*) FROM alerts WHERE is_resolved=0)                        AS open_alerts`),
  };

  return {
    get, all, run, insert,
    users, staff, admins, guests, visits, badges, alerts, logs, places,
    reservations, kiosks, settings, printJobs, stats,
  };
}

// The default repository, bound to the shared pool / database handle.
const repo = makeRepo(rootExec);

/**
 * Run a function inside a database transaction.
 *
 * The callback receives a repository bound to the transaction's own connection
 * — use THAT, not the module-level `repo`, or the statements will run outside
 * the transaction (on Postgres they would go to a different pooled client).
 *
 *   const out = await repo.tx(async (t) => {
 *     const g = await t.guests.create({ ... });
 *     await t.visits.create({ guest_id: g.lastInsertRowid, ... });
 *     return g.lastInsertRowid;
 *   });
 */
repo.tx = (fn) => driverTx((txExec) => fn(makeRepo(txExec)));

module.exports = repo;
module.exports.makeRepo = makeRepo;
