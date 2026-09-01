'use strict';

const path = require('path');
const fs = require('fs');

// `process.pkg` is set when running inside a pkg-built executable.
const packaged = !!process.pkg;

// The directory the app treats as its install/working dir for *writable* files
// (the database) and *external* configuration (.env). When packaged this is the
// folder the .exe sits in; in dev it is the backend folder. This keeps the DB
// and config on real disk even though the code/assets live in the snapshot.
const appDir = packaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

// Load .env from the app directory (so a shipped .exe stays configurable).
require('dotenv').config({ path: path.join(appDir, '.env') });

const config = {
  packaged,
  appDir,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },

  // Allowed dashboard origins. "*" allows any (dev only).
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Database lives next to the executable / in the backend folder (writable).
  dbFile: path.resolve(appDir, process.env.DB_FILE || 'visisign.db'),

  // Visitor photos captured at the kiosk (written next to the database).
  photosDir: path.resolve(appDir, process.env.PHOTOS_DIR || 'photos'),

  serveFrontend: String(process.env.SERVE_FRONTEND || 'true') === 'true',

  // Frontend assets. In dev this is the real folder; inside the .exe the same
  // relative path resolves into the bundled snapshot (read-only).
  frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
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

if (config.isProd && config.jwt.secret.startsWith('dev-only')) {
  // Fail loudly rather than run insecure in production.
  throw new Error('JWT_SECRET must be set to a strong secret in production.');
}

module.exports = config;
