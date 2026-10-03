'use strict';

// PostgreSQL driver — the cloud backend (Cloud SQL, RDS, Neon, Supabase, or the
// `postgres` service in docker-compose).
//
// The repository layer writes SQLite-style `?` placeholders; this driver
// rewrites them to Postgres `$1, $2, ...` so one query layer serves both
// backends. See ./sqlite.js for the other half and ../dialect.js for the
// handful of genuine SQL differences.

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// ── Type parsing ─────────────────────────────────────────────────────────────
// node-postgres hands back strings for types that can exceed JS number range.
// The app's counts and computed hours are always small, and the rest of the
// code (and the SQLite driver) expects numbers, so parse them eagerly.
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 / bigint — COUNT(*)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric — computed hours

/**
 * Rewrite `?` placeholders to `$1, $2, ...`.
 *
 * Skips anything inside single-quoted string literals, double-quoted
 * identifiers, dollar-quoted blocks and SQL comments, so a literal question
 * mark in text is never mistaken for a parameter.
 */
function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    // Line comment: -- ... end of line
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Block comment: /* ... */
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Single-quoted literal; '' is an escaped quote.
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // Double-quoted identifier; "" is an escaped quote.
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // The placeholder itself. `??` is not used anywhere, and `?::type` casts
    // keep working because only the single `?` is consumed.
    if (c === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Stable 63-bit-safe integer key for pg_advisory_lock, from a string name. */
function lockKey(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return h;
}

function createPostgresDriver(config) {
  const pool = new Pool({
    connectionString: config.pg.url,
    max: config.pg.poolMax,
    // Cloud SQL / RDS terminate idle connections; keep the pool lean and let it
    // refill rather than holding dead sockets.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(config.pg.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // A connection error on an idle pooled client must not take the process down.
  pool.on('error', (err) => {
    console.error('[VisiSign] postgres pool error:', err.message);
  });

  // Build an executor bound to either the pool or one checked-out client.
  const executorFor = (runner) => ({
    get: async (sql, params = []) => {
      const r = await runner.query(toPgPlaceholders(sql), params);
      return r.rows[0];
    },
    all: async (sql, params = []) => {
      const r = await runner.query(toPgPlaceholders(sql), params);
      return r.rows;
    },
    run: async (sql, params = []) => {
      const r = await runner.query(toPgPlaceholders(sql), params);
      return { changes: r.rowCount, lastInsertRowid: undefined };
    },
    // INSERT whose new id the caller needs. Postgres has no lastInsertRowid, so
    // ask for the id back explicitly. Every table this is used on has an `id`.
    insert: async (sql, params = []) => {
      const text = /returning/i.test(sql) ? sql : `${sql.trimEnd().replace(/;$/, '')} RETURNING id`;
      const r = await runner.query(toPgPlaceholders(text), params);
      return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? Number(r.rows[0].id) : undefined };
    },
  });

  const exec = executorFor(pool);

  // Hide credentials when printing where the data lives.
  const describe = () => {
    try {
      const u = new URL(config.pg.url);
      return `postgres://${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
    } catch (_) {
      return 'postgres (connection string set)';
    }
  };

  return {
    name: 'postgres',
    exec,
    describe,

    async migrate() {
      const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.postgres.sql'), 'utf8');
      // Hold an advisory lock so that several instances starting at once (very
      // normal on Cloud Run / ECS) cannot race each other through CREATE TABLE.
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [lockKey('visisign:migrate')]);
        await client.query(schema);
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey('visisign:migrate')]);
        } catch (_) {
          /* connection already gone */
        }
        client.release();
      }
    },

    // Add a column to an existing table if it is not already there.
    //
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
    // so new columns on an installed database need this. Postgres can express it
    // directly. Held under the same migrate lock by the caller.
    async ensureColumn(table, column, definition) {
      const r = await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`
      );
      return !!r;
    },

    // A transaction needs ONE client for its whole lifetime, so it cannot use
    // the pool directly. The callback gets an executor bound to that client.
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(executorFor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          /* the connection died; the server rolls back for us */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    // Run fn only if this instance wins the named lock. Used so the daily
    // auto-signout sweep fires once across every running instance, instead of
    // once per instance.
    async withAdvisoryLock(key, fn) {
      const client = await pool.connect();
      try {
        const r = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey(key)]);
        if (!r.rows[0] || r.rows[0].got !== true) return undefined; // another instance has it
        try {
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey(key)]);
        }
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresDriver, toPgPlaceholders, lockKey };
