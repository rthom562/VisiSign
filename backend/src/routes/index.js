'use strict';

const express = require('express');
const { exec } = require('../db/connection');
const config = require('../config');

const router = express.Router();

// ── Health ───────────────────────────────────────────────────────────────────
// Two different questions, which cloud platforms ask separately:
//
//   /health  — liveness. "Is the process up?" Must not touch the database: if
//              Postgres blips, restarting the container does not help and a
//              failing liveness probe would just thrash it.
//   /ready   — readiness. "Can it serve traffic?" This one DOES check the
//              database, so a load balancer stops sending requests to an
//              instance that cannot reach it.
router.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'visisign', time: new Date().toISOString() })
);

router.get('/ready', async (_req, res) => {
  try {
    await exec.get('SELECT 1 AS ok');
    res.json({ ok: true, db: config.db.client, time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({
      ok: false,
      db: config.db.client,
      error: { code: 'db_unavailable', message: err.message },
    });
  }
});

router.use('/auth', require('./auth.routes'));
router.use('/visits', require('./visits.routes'));
router.use('/reservations', require('./reservations.routes'));
router.use('/kiosk', require('./kiosk.routes'));
router.use('/print', require('./print.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;
