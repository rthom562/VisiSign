'use strict';

const config = require('./src/config');
const db = require('./src/db/connection');
const storage = require('./src/storage');
const { createApp } = require('./src/app');

const argv = process.argv.slice(2);
const has = (...flags) => flags.some((f) => argv.includes(f));

function fail(err) {
  console.error('\n[VisiSign] startup failed:', err && err.message ? err.message : err);
  if (err && err.stack && !config.isProd) console.error(err.stack);
  process.exit(1);
}

// `VisiSign --seed`: create schema + demo data and the first admin, then exit.
if (has('--seed')) {
  require('./src/db/seed')
    .runSeed()
    .then(() => {
      console.log('Done. Start VisiSign normally to serve the dashboard.');
      return db.close();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
  return;
}

// `VisiSign --migrate`: apply the schema and exit. Useful as a one-shot job in
// a deployment pipeline (Cloud Run job, ECS task, `docker compose run`) when you
// would rather not have web instances migrating on boot.
if (has('--migrate')) {
  db.migrate()
    .then(() => {
      console.log(`Schema applied to ${db.describe()}`);
      return db.close();
    })
    .then(() => process.exit(0))
    .catch(fail);
  return;
}

// `VisiSign --console`: the interactive admin console ONLY (no web server).
// Shares the database with a running server, so it can run alongside the live
// app.
if (has('--console') || argv[0] === 'console') {
  require('./src/console')
    .runConsole({ withServer: false })
    .catch(fail);
  return;
}

// Starts the web server (kiosk + reservations + admin + API) in THIS process.
async function startServer() {
  // Apply the schema before serving. On Postgres this is guarded by an advisory
  // lock, so several instances booting together cannot race each other.
  await db.migrate();

  const app = createApp();

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.on('error', reject);
  });

  console.log(`\n  VisiSign API listening on http://localhost:${config.port}`);
  if (config.serveFrontend) {
    console.log(`  iPad kiosk               http://localhost:${config.port}/`);
    console.log(`  Online reservations      http://localhost:${config.port}/reserve`);
    console.log(`  Admin console            http://localhost:${config.port}/admin`);
  }
  if (config.liveFrontend) {
    console.log(`  Live frontend: editing files in ${config.frontendDir} updates the UI without a restart.`);
  }
  console.log(`  Database     ${config.db.client} — ${db.describe()}`);
  console.log(`  Photos       ${storage.describe()}`);
  console.log(`  Printing     ${config.print.transport}${config.print.agentToken ? ' (agent API enabled)' : ''}`);
  console.log(`  Timezone     ${config.timezone || 'system clock'}`);
  console.log(`  Environment  ${config.env}\n`);

  // Background jobs (end-of-day auto-checkout, stale print-job requeue).
  require('./src/services/scheduler.service').start();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Containers get SIGTERM and a short grace period before SIGKILL. Stop
  // accepting connections, let in-flight requests finish, close the database,
  // and exit — so a deploy never cuts a sign-in in half.
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${sig} received, shutting down...`);

      // Hard deadline, in case a connection refuses to close.
      const killer = setTimeout(() => {
        console.error('  Shutdown timed out — exiting anyway.');
        process.exit(1);
      }, 10_000);
      killer.unref();

      server.close(async () => {
        require('./src/services/scheduler.service').stop();
        try {
          await db.close();
        } catch (_) {
          /* closing on the way out */
        }
        process.exit(0);
      });
    });
  }

  return server;
}

startServer()
  .then(() => {
    // `VisiSign --serve-console` (aka --with-console): run the web server AND the
    // interactive command console together in ONE process/window. The console
    // shares the very same database the server uses, so commands take effect live.
    if (has('--serve-console', '--with-console', '--server-console') || argv[0] === 'serve-console') {
      if (!config.enableConsole) {
        console.log('  Interactive console unavailable in this environment (no terminal attached).');
        return;
      }
      require('./src/console').runConsole({ withServer: true, port: config.port }).catch(fail);
    }
  })
  .catch(fail);
