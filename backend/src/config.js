'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// `process.pkg` is set when running inside a pkg-built executable.
const packaged = !!process.pkg;

// Are we in a container / cloud runtime? Used only to pick sensible DEFAULTS
// (every one of them can still be overridden by an explicit env var).
const containerised =
  String(process.env.VISISIGN_CONTAINER || '') === 'true' ||
  fs.existsSync('/.dockerenv') ||
  !!process.env.K_SERVICE ||           // Cloud Run
  !!process.env.AWS_EXECUTION_ENV ||   // ECS / App Runner / Lambda
  !!process.env.KUBERNETES_SERVICE_HOST;

// The directory the app treats as its install/working dir for *writable* files
// and *external* configuration (.env). When packaged this is the folder the
// .exe sits in; in a container it is a mounted data dir; in dev it is the
// backend folder.
const appDir = process.env.APP_DIR
  ? path.resolve(process.env.APP_DIR)
  : packaged
    ? path.dirname(process.execPath)
    : containerised
      ? '/data'
      : path.resolve(__dirname, '..');

// Load .env from the app directory (so a shipped .exe stays configurable).
// In a container, environment variables are injected by the platform instead.
require('dotenv').config({ path: path.join(appDir, '.env') });

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : String(v) === 'true');

// ── Database backend ─────────────────────────────────────────────────────────
// `sqlite`   — one file on disk: the .exe, the reception PC, a LAN Docker host.
// `postgres` — managed Postgres: Cloud SQL, RDS, Neon, or docker-compose.
//
// A DATABASE_URL is taken as "use Postgres" without further ceremony, since
// that is how every cloud platform injects a database.
const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const dbClient = (process.env.DB_CLIENT || (pgUrl ? 'postgres' : 'sqlite')).toLowerCase();

if (!['sqlite', 'postgres'].includes(dbClient)) {
  throw new Error(`DB_CLIENT must be "sqlite" or "postgres" (got "${dbClient}")`);
}
if (dbClient === 'postgres' && !pgUrl) {
  throw new Error('DB_CLIENT=postgres requires DATABASE_URL (e.g. postgres://user:pass@host:5432/visisign)');
}

// Managed Postgres generally requires TLS; a local container or a Cloud SQL
// unix socket does not. Default accordingly, and let PG_SSL override.
function sslDefault(url) {
  try {
    if (/^\/|host=\//.test(url) || url.includes('/cloudsql/')) return false; // unix socket
    if (/sslmode=disable/.test(url)) return false;
    const host = new URL(url).hostname;
    return !['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host);
  } catch (_) {
    return false;
  }
}

const config = {
  packaged,
  containerised,
  appDir,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,

  // The timezone the business day is measured in: reservation dates, time slots
  // and the end-of-day auto-signout cutoff. On the reception PC the machine
  // clock is the right answer; a cloud container runs in UTC, so this must be
  // set explicitly or "5pm" means 5pm UTC.
  timezone: process.env.VISISIGN_TZ || process.env.TZ || (containerised ? 'UTC' : undefined),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  // Allowed dashboard origins. "*" allows any (dev only).
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    client: dbClient,
  },

  pg: {
    url: pgUrl,
    poolMax: Number(process.env.PG_POOL_MAX) || 10,
    ssl: bool(process.env.PG_SSL, sslDefault(pgUrl)),
  },

  // SQLite database file (ignored when DB_CLIENT=postgres).
  dbFile: path.resolve(appDir, process.env.DB_FILE || 'visisign.db'),

  serveFrontend: bool(process.env.SERVE_FRONTEND, true),

  // Number of proxy hops to trust for req.ip and rate limiting. Cloud Run, ALB
  // and App Runner all put exactly one proxy in front of the container.
  trustProxy: process.env.TRUST_PROXY === 'false' ? false : Number(process.env.TRUST_PROXY || 1),

  // ── Badge printing ─────────────────────────────────────────────────────────
  // `direct` drives a Windows printer from this process via PowerShell — only
  // possible when the server IS the reception PC. `queue` writes print jobs to
  // the database for the on-premise print agent to collect, which is what a
  // cloud or Linux deployment must do. Device printing (iPad AirPrint, Android
  // Mopria) is handled entirely in the browser and works in every mode.
  print: {
    transport: (process.env.PRINT_TRANSPORT || (os.platform() === 'win32' && !containerised ? 'direct' : 'queue')).toLowerCase(),
    // Shared secret the on-premise agent authenticates with. Required before
    // the agent endpoints will serve anything.
    agentToken: process.env.PRINT_AGENT_TOKEN || '',
    // Re-queue a job an agent claimed but never finished, after this long.
    staleJobSeconds: Number(process.env.PRINT_STALE_SECONDS) || 180,
  },

  // The interactive admin console needs a real terminal. A container has no
  // stdin attached, so it is off by default there.
  enableConsole: bool(process.env.ENABLE_CONSOLE, !containerised),

  // Background jobs (end-of-day auto-signout, stale print-job requeue). With
  // several instances running, an advisory lock keeps the sweep to one.
  enableScheduler: bool(process.env.ENABLE_SCHEDULER, true),

  // Frontend assets. In dev this is the real folder; inside the .exe the same
  // relative path resolves into the bundled snapshot (read-only).
  frontendDir: process.env.FRONTEND_DIR
    ? path.resolve(process.env.FRONTEND_DIR)
    : path.resolve(__dirname, '..', '..', 'frontend'),
};

// LIVE EDITING: if a `frontend` folder sits next to the running .exe, serve from
// THAT instead of the bundled snapshot. This lets you change the dashboard (HTML/
// CSS/JS) while the app keeps running — just edit the files and refresh the
// browser; no rebuild, no restart. The static server reads each file fresh per
// request, so edits show up immediately.
if (packaged) {
  const externalFrontend = path.join(appDir, 'frontend');
  if (fs.existsSync(path.join(externalFrontend, 'index.html'))) {
    config.frontendDir = externalFrontend;
    config.liveFrontend = true;
  }
}

config.isProd = config.env === 'production';

// Applying the timezone to the process makes `new Date()` — which the slot and
// auto-signout logic read — report local time for the configured zone.
if (config.timezone) process.env.TZ = config.timezone;

// ── Production guard rails ───────────────────────────────────────────────────
// Fail loudly at boot rather than run insecure, and say exactly what to fix.
if (config.isProd) {
  const problems = [];
  if (config.jwt.secret.startsWith('dev-only')) {
    problems.push('JWT_SECRET must be set to a strong random secret (e.g. `openssl rand -hex 32`).');
  }
  if (config.corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS must list your real origins instead of "*" (e.g. https://visisign.example.com).');
  }
  // SQLite in a container is a real footgun: the database dies with the
  // instance, and two instances writing one file corrupts it. Allow it only if
  // the operator asked for SQLite by name (they have mounted a volume and know
  // to keep max-instances at 1).
  if (config.db.client === 'sqlite' && config.containerised && !process.env.DB_CLIENT) {
    problems.push(
      'A container with SQLite loses its database when the instance restarts, and corrupts the file if ' +
      'more than one instance runs. Set DATABASE_URL to use Postgres, or — if you have mounted a ' +
      'persistent volume and pinned the service to one instance — set DB_CLIENT=sqlite to confirm.'
    );
  }
  if (problems.length) {
    throw new Error(`VisiSign refused to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = config;
