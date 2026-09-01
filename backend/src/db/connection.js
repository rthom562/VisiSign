'use strict';

// Single shared SQLite connection for the whole process, using Node's BUILT-IN
// `node:sqlite` module (Node >= 22.5). No native build step, no external DB
// server. WAL mode lets many readers run concurrently with one writer, which is
// what we want for a multi-user sign-in system. The repository layer is the only
// code that imports this handle — nothing else touches the database directly.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const db = new DatabaseSync(config.dbFile);

// Concurrency + integrity pragmas.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;'); // wait instead of failing during a concurrent write

/** Run the schema file (idempotent — uses IF NOT EXISTS). */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

module.exports = { db, migrate };
