'use strict';

// SQLite driver — the on-premise / packaged-.exe backend.
//
// Uses Node's BUILT-IN `node:sqlite` module (Node >= 22.5): no native build
// step, no database server, one file on disk. WAL mode lets many readers run
// concurrently with a single writer, which is what a sign-in system wants.
//
// node:sqlite is synchronous. The driver interface is async (because Postgres
// has to be), so every method here returns an already-resolved promise. That
// costs a microtask per query and buys one shared repository layer.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function createSqliteDriver(config) {
  // Make sure the directory for the database file exists (a fresh install, or a
  // mounted volume that starts empty).
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

  const db = new DatabaseSync(config.dbFile);

  // Concurrency + integrity pragmas.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;'); // wait rather than fail during a concurrent write

  // node:sqlite binds anonymous `?` parameters positionally via spread args.
  const exec = {
    get: async (sql, params = []) => db.prepare(sql).get(...params),
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    run: async (sql, params = []) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    // INSERT that needs the new row's id back. SQLite hands it to us directly.
    insert: async (sql, params = []) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
  };

  return {
    name: 'sqlite',
    exec,

    // Describes where the data lives, for the startup banner.
    describe: () => config.dbFile,

    async migrate() {
      const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      db.exec(schema);
    },

    // Add a column to an existing table if it is not already there.
    //
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
    // so new columns on an installed database need this. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so inspect the table first.
    async ensureColumn(table, column, definition) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (cols.some((c) => c.name === column)) return false;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    },

    // One connection, so a transaction is just BEGIN/COMMIT around the handle.
    // Nested calls are not supported (and the app never nests).
    async tx(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn(exec);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch (_) {
          /* the transaction was already unwound */
        }
        throw err;
      }
    },

    // SQLite has no cross-process advisory locks; a single-file deployment runs
    // one server, so the caller always "holds" the lock.
    async withAdvisoryLock(_key, fn) {
      return fn();
    },

    async close() {
      try {
        db.close();
      } catch (_) {
        /* already closed */
      }
    },
  };
}

module.exports = { createSqliteDriver };
