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

module.exports = {
  driver,
  dialect,
  exec: driver.exec,
  migrate: () => driver.migrate(),
  tx: (fn) => driver.tx(fn),
  withAdvisoryLock: (key, fn) => driver.withAdvisoryLock(key, fn),
  close: () => driver.close(),
  describe: () => driver.describe(),
};
