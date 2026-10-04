'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();

  // Correct req.ip behind a load balancer — which matters for rate limiting and
  // for the IP recorded in the audit log. Cloud Run, an ALB and App Runner each
  // add exactly one proxy hop; TRUST_PROXY tunes it for anything else.
  app.set('trust proxy', config.trustProxy);

  // ── Security headers ───────────────────────────────────────────────────────
  app.use(
    helmet({
      // Allow the dashboard's inline-free assets + the QR generator from a CDN.
      contentSecurityPolicy: config.isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"], // all JS (incl. the QR lib) is bundled locally
              styleSrc: ["'self'", "'unsafe-inline'"],
              // data: covers QR codes, the uploaded logo and captured
              // signatures, all of which are inlined rather than stored as files.
              imgSrc: ["'self'", 'data:'],
              // The brand typeface is served from this origin. Stated
              // explicitly rather than relying on the default-src fallback.
              fontSrc: ["'self'"],
              connectSrc: ["'self'"],
            },
          }
        : false,
    })
  );

  // ── CORS — the dashboard and API can live on different hosts ───────────────
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      credentials: false,
    })
  );

  app.use(express.json({ limit: '6mb' })); // headroom for kiosk-captured photos

  // ── Rate limiting ──────────────────────────────────────────────────────────
  // Tight limit on auth to slow brute-force; looser global limit otherwise.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true });
  app.use('/api/auth', authLimiter);
  app.use('/api', apiLimiter);

  // ── The API (the ONLY way into the data layer) ─────────────────────────────
  app.use('/api', apiRoutes);

  // ── Serve the frontend layer ───────────────────────────────────────────────
  // A tiny fs-based static server. We read files with fs.readFileSync so it
  // works identically from real disk (dev) and from the bundled snapshot inside
  // the packaged .exe. Path traversal is blocked; unknown routes fall back to
  // index.html (the dashboard uses hash routing).
  if (config.serveFrontend) {
    const root = path.resolve(config.frontendDir);
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
      // Fonts. Without the right type a browser refuses the file, so the brand
      // font would silently fall back to the system stack.
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
    };
    const mainHtml = () => fs.readFileSync(path.join(root, 'index.html'));

    // The MAIN page (index.html) IS the reservations page, so the root and all the
    // main links land there. The kiosk is a separate page you reach by typing /kiosk.
    //   Reservations (main)  :  /  ,  /reserve , /reservation  -> index.html
    //   Kiosk (type-in only) :  /kiosk , /ipad                 -> kiosk.html
    //   Admin console        :  /admin                         -> admin.html
    const ALIASES = {
      '/': 'index.html',
      '/reserve': 'index.html',
      '/reservation': 'index.html',
      '/kiosk': 'kiosk.html',
      '/ipad': 'kiosk.html',
      '/admin': 'admin.html',
    };

    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      let rel = decodeURIComponent(req.path);
      if (rel.length > 1 && rel.endsWith('/')) rel = rel.slice(0, -1); // drop trailing slash
      if (ALIASES[rel]) rel = '/' + ALIASES[rel];
      const file = path.resolve(root, '.' + path.normalize(rel));
      if (file !== root && !file.startsWith(root + path.sep)) return res.status(403).end();
      try {
        const data = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');

        // Cache policy. Asset filenames are NOT content-hashed, so a cached
        // copy is indistinguishable from a current one by URL alone. Browsers
        // left to their own heuristics will happily serve yesterday's app.js —
        // which silently breaks both the documented "edit a file and refresh"
        // workflow and, worse, a kiosk that keeps running old code after an
        // update.
        //
        // `no-cache` does not mean "don't store": the browser still caches and
        // still revalidates with an If-None-Match, so unchanged files come back
        // as a 304 and cost almost nothing. Fonts are exempt because they are
        // large and effectively immutable.
        if (ext === '.ttf' || ext === '.otf' || ext === '.woff' || ext === '.woff2') {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }

        // A weak validator over size + mtime is enough to answer "has this
        // changed?", and avoids hashing every file on every request.
        try {
          const st = fs.statSync(file);
          res.setHeader('ETag', `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`);
        } catch (_) {
          /* no ETag; the response is still correct, just always revalidated */
        }

        return res.send(data);
      } catch (_) {
        // Missing asset (has an extension) -> 404. Clean path -> main page.
        if (path.extname(file)) return res.status(404).end();
        try {
          res.setHeader('Content-Type', MIME['.html']);
          return res.send(mainHtml());
        } catch (_e) {
          return next();
        }
      }
    });
  }

  // 404 + error handling (API responses stay JSON).
  app.use('/api', notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
