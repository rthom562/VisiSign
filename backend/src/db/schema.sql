-- VisiSign database schema
-- One SQLite file. WAL mode (set in connection.js) allows many concurrent
-- readers with a single writer. Every entity has an integer primary key and is
-- linked to others by foreign keys. History is preserved: visits are "closed"
-- by setting signed_out_at, never deleted.

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────────────────
-- Places: a site has rooms, a room has desks.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  address     TEXT,
  timezone    TEXT    NOT NULL DEFAULT 'UTC',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  floor       TEXT,
  capacity    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_site ON rooms(site_id);

CREATE TABLE IF NOT EXISTS desks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  is_bookable INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_desks_room ON desks(room_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- People with logins. users holds auth + role; staff/admins hold role profiles.
-- guests have no login and are created on sign-in.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT    NOT NULL UNIQUE,           -- opaque id exposed to clients
  email          TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  full_name      TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('staff','admin')),
  access_level   INTEGER NOT NULL DEFAULT 1,        -- 1=basic .. 9=superadmin
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  site_id     INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  department  TEXT,
  title       TEXT,
  phone       TEXT,
  photo_url   TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT    NOT NULL DEFAULT 'global'     -- 'global' or a site scope
);

CREATE TABLE IF NOT EXISTS guests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT    NOT NULL UNIQUE,
  full_name    TEXT    NOT NULL,
  company      TEXT,
  email        TEXT,
  phone        TEXT,
  photo_url    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_guests_name ON guests(full_name);

-- ─────────────────────────────────────────────────────────────────────────────
-- Visits: the core event table. A row is one sign-in. type distinguishes a
-- guest visit from a staff work session. Open visits have signed_out_at = NULL.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT    NOT NULL UNIQUE,
  type           TEXT    NOT NULL CHECK (type IN ('guest','staff')),
  guest_id       INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  staff_user_id  INTEGER REFERENCES users(id)  ON DELETE SET NULL,
  host_user_id   INTEGER REFERENCES users(id)  ON DELETE SET NULL, -- who is hosting a guest
  host_name      TEXT,                                            -- free text fallback
  site_id        INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  room_id        INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  desk_id        INTEGER REFERENCES desks(id) ON DELETE SET NULL,
  reason         TEXT,
  status         TEXT    NOT NULL DEFAULT 'signed_in'
                         CHECK (status IN ('signed_in','signed_out')),
  custom_data    TEXT,                                            -- JSON blob of custom form fields
  signed_in_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  signed_out_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
CREATE INDEX IF NOT EXISTS idx_visits_type   ON visits(type);
CREATE INDEX IF NOT EXISTS idx_visits_in     ON visits(signed_in_at);
CREATE INDEX IF NOT EXISTS idx_visits_staff  ON visits(staff_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Badges: a printable / scannable credential issued for a visit.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS badges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id     INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  code         TEXT    NOT NULL UNIQUE,             -- the badge serial
  qr_payload   TEXT    NOT NULL,                    -- string encoded into the QR
  issued_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_badges_visit ON badges(visit_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Alerts: notifications raised by rules (e.g. visitor still on site after hours).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  level         TEXT    NOT NULL CHECK (level IN ('info','warning','critical')),
  message       TEXT    NOT NULL,
  visit_id      INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  site_id       INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  is_resolved   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(is_resolved);

-- ─────────────────────────────────────────────────────────────────────────────
-- Logs: immutable audit trail of who did what.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type   TEXT    NOT NULL,                    -- 'system','guest','staff','admin'
  actor_id     INTEGER,                             -- users.id or guests.id, nullable
  action       TEXT    NOT NULL,                    -- e.g. 'visit.signin'
  target_table TEXT,
  target_id    INTEGER,
  detail       TEXT,                                -- JSON
  ip           TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action);
CREATE INDEX IF NOT EXISTS idx_logs_time   ON logs(created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Reservations: pre-check-in from a phone. A visitor picks a date + time slot
-- and fills the form ahead of time. On arrival they are checked in, which
-- creates a real visit (and badge) and links it back here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT    NOT NULL UNIQUE,
  full_name      TEXT    NOT NULL,
  company        TEXT,
  email          TEXT,
  phone          TEXT,
  host_name      TEXT,
  reason         TEXT,
  site_id        INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  reserved_date  TEXT    NOT NULL,                 -- 'YYYY-MM-DD' (local)
  time_slot      TEXT    NOT NULL,                 -- 'HH:MM' start of slot (local)
  status         TEXT    NOT NULL DEFAULT 'reserved'
                         CHECK (status IN ('reserved','checked_in','cancelled')),
  custom_data    TEXT,                             -- JSON of extra form fields
  visit_id       INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  checked_in_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_date  ON reservations(reserved_date, time_slot);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Kiosks: devices that want to run the on-site kiosk UI. A device registers
-- (status 'pending') and an administrator must accept it from the console before
-- it can show the kiosk. Each device carries an opaque public_id (stored in the
-- browser) and a short human code the admin references to accept it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kiosks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT NOT NULL UNIQUE,          -- device id from the browser
  code          TEXT NOT NULL,                 -- short code shown on the device
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','accepted','revoked','rejected')),
  user_agent    TEXT,
  ip            TEXT,
  requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at   TEXT,
  last_seen_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_kiosks_status ON kiosks(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings: simple key/value for tunable system config managed by admins.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
