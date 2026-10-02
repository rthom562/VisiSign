'use strict';

// SQL dialect differences between the two supported backends.
//
// VisiSign runs on SQLite (the single-file, on-premise / .exe build) and on
// PostgreSQL (the cloud build). The repository layer writes ONE set of queries
// and reaches for these helpers wherever the two dialects genuinely diverge —
// which is a short list, because the schema deliberately stays portable:
//
//   * timestamps are stored as TEXT in 'YYYY-MM-DD HH:MM:SS' UTC form in BOTH
//     backends, so every range comparison, sort and substring in the queries is
//     a plain lexicographic string operation that behaves identically;
//   * booleans are stored as 0/1 integers in BOTH backends, so `is_active = 1`
//     needs no translation;
//   * `||` string concatenation and `ON CONFLICT ... DO UPDATE` are already
//     common to both.
//
// Keeping timestamps as TEXT is a deliberate trade: it gives up Postgres
// interval arithmetic and timezone handling at the column level, and in exchange
// the entire query layer is shared and the two backends cannot silently
// disagree about dates. Timezone handling happens in the application instead
// (see config.timezone).

const SQLITE = {
  name: 'sqlite',

  // Current UTC timestamp, in the stored TEXT format.
  now: () => "datetime('now')",

  // Current UTC date as 'YYYY-MM-DD'.
  today: () => "date('now')",

  // The date part of a stored timestamp column.
  dateOf: (col) => `substr(${col}, 1, 10)`,

  // Fractional hours between two stored timestamps (later minus earlier).
  hoursBetween: (from, to) => `(julianday(${to}) - julianday(${from})) * 24`,

  // Case-insensitive substring match operator.
  like: 'LIKE',
};

const POSTGRES = {
  name: 'postgres',

  // `now()` is timezone-aware; force UTC then format to match SQLite exactly.
  now: () => "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')",

  today: () => "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",

  // substr() is identical in Postgres, so the stored TEXT format pays off here.
  dateOf: (col) => `substr(${col}, 1, 10)`,

  // Cast the TEXT timestamps to real timestamps just for the subtraction.
  hoursBetween: (from, to) =>
    `(EXTRACT(EPOCH FROM (${to}::timestamp - ${from}::timestamp)) / 3600.0)`,

  // Postgres LIKE is case-sensitive; ILIKE matches SQLite's ASCII behaviour.
  like: 'ILIKE',
};

function dialectFor(client) {
  if (client === 'postgres') return POSTGRES;
  if (client === 'sqlite') return SQLITE;
  throw new Error(`Unknown database client "${client}" (expected "sqlite" or "postgres")`);
}

module.exports = { dialectFor, SQLITE, POSTGRES };
