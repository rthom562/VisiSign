'use strict';

const config = require('./src/config');
const { migrate } = require('./src/db/connection');
const { createApp } = require('./src/app');

const argv = process.argv.slice(2);
const has = (...flags) => flags.some((f) => argv.includes(f));

// `VisiSign.exe --seed`: create schema + demo data and the first admin, then exit.
if (has('--seed')) {
  require('./src/db/seed').runSeed()
    .then(() => { console.log('Done. Start VisiSign normally to serve the dashboard.'); process.exit(0); })
    .catch((err) => { console.error('Seed failed:', err); process.exit(1); });
  return;
}

// `VisiSign.exe --console`: the interactive admin console ONLY (no web server).
// Shares the database with a running server (SQLite WAL), so it can run alongside
// the live app.
if (has('--console') || argv[0] === 'console') {
  require('./src/console').runConsole({ withServer: false });
  return;
}

// Starts the web server (kiosk + reservations + admin + API) in THIS process.
function startServer() {
  migrate();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`\n  VisiSign API listening on http://localhost:${config.port}`);
    if (config.serveFrontend) {
      console.log(`  iPad kiosk               http://localhost:${config.port}/`);
      console.log(`  Online reservations      http://localhost:${config.port}/reserve`);
      console.log(`  Admin console            http://localhost:${config.port}/admin`);
    }
    if (config.liveFrontend) {
      console.log(`  Live frontend: editing files in ${config.frontendDir} updates the UI without a restart.`);
    }
    console.log(`  Environment: ${config.env}\n`);
  });

  // Background jobs (end-of-day auto-checkout, etc.).
  require('./src/services/scheduler.service').start();

  // Graceful shutdown (Ctrl+C / termination).
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n${sig} received, shutting down...`);
      server.close(() => process.exit(0));
    });
  }
  return server;
}

const server = startServer();

// `VisiSign.exe --serve-console` (aka --with-console): run the web server AND the
// interactive command console together in ONE process/window. The console shares
// the very same database handle the server uses, so commands take effect live.
if (has('--serve-console', '--with-console', '--server-console') || argv[0] === 'serve-console') {
  require('./src/console').runConsole({ withServer: true, port: config.port });
}
