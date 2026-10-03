'use strict';

// The single database entry point. Picks a driver from config and exposes one
// async interface to the repository layer — which is the only code that imports
// this module. Nothing else touches the database directly.
//
//   DB_CLIENT=sqlite    → one file on disk (on-premise, packaged .exe, LAN host)
//   DB_CLIENT=postgres  → managed Postgres (Cloud SQL, RDS, Neon, docker-compose)
//
// Both drivers implement exactly:
//
//   exec.get(sql, params)     → one row (or undefined)
//   exec.all(sql, params)     → array of rows
//   exec.run(sql, params)     → { changes }
//   exec.insert(sql, params)  → { changes, lastInsertRowid }
//   migrate()                 → apply the schema (idempotent)
//   tx(fn)                    → run fn(exec) in a transaction
//   withAdvisoryLock(key, fn) → run fn only if this instance wins the lock
//   close()                   → release connections
//
// `insert` exists separately from `run` because Postgres has no lastInsertRowid:
// it needs an explicit RETURNING id, and only the INSERTs whose id the caller
// actually uses should pay for it.

const config = require('../config');
const { dialectFor } = require('./dialect');

function build() {
  if (config.db.client === 'postgres') {
    // Required lazily so a SQLite-only install (and the packaged .exe) never
    // needs the `pg` package present.
    const { createPostgresDriver } = require('./drivers/postgres');
    return createPostgresDriver(config);
  }
  const { createSqliteDriver } = require('./drivers/sqlite');
  return createSqliteDriver(config);
}

const driver = build();
const dialect = dialectFor(config.db.client);

// Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves an
// existing table alone, so these have to be applied separately — otherwise an
// install that predates them keeps the old shape and the new code breaks on it.
//
// Each entry is [table, column, definition]. Adding a column is idempotent and
// never destructive, so this runs on every boot.
const ADDED_COLUMNS = [
  // Per-kiosk printing: each kiosk can drive its own printer at its own label
  // size, so a building with several reception desks is not forced onto one.
  ['kiosks', 'printer', 'TEXT'],
  ['kiosks', 'label_width_mm', 'INTEGER'],
  ['kiosks', 'label_height_mm', 'INTEGER'],
  ['kiosks', 'location', 'TEXT'],
  ['kiosks', 'print_mode', 'TEXT'],
];

async function migrate() {
  await driver.migrate();
  for (const [table, column, definition] of ADDED_COLUMNS) {
    try {
      await driver.ensureColumn(table, column, definition);
    } catch (err) {
      // A column that already exists is fine; anything else is worth surfacing.
      if (!/exist/i.test(err.message)) {
        console.error(`[VisiSign] could not add ${table}.${column}:`, err.message);
      }
    }
  }
}

module.exports = {
  driver,
  dialect,
  exec: driver.exec,
  migrate,
  tx: (fn) => driver.tx(fn),
  withAdvisoryLock: (key, fn) => driver.withAdvisoryLock(key, fn),
  close: () => driver.close(),
  describe: () => driver.describe(),
};
