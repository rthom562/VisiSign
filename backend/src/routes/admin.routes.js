'use strict';

const express = require('express');
const adminService = require('../services/admin.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// Everything here is admin-only.
router.use(requireAuth, requireRole('admin'));

// ── Overview / alerts ────────────────────────────────────────────────────────
router.get('/overview', asyncHandler(async (_req, res) => ok(res, adminService.overview())));
router.get('/alerts', asyncHandler(async (_req, res) => ok(res, adminService.openAlerts())));
router.post('/alerts/:id/resolve', asyncHandler(async (req, res) =>
  ok(res, adminService.resolveAlert(req, req.user, req.params.id))
));

// ── Users ────────────────────────────────────────────────────────────────────
router.get('/users', asyncHandler(async (req, res) =>
  ok(res, adminService.listUsers({
    q: req.query.q || '',
    limit: Math.min(Number(req.query.limit) || 100, 500),
    offset: Number(req.query.offset) || 0,
  }))
));

router.post(
  '/users',
  validateBody({
    username: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
    fullName: { required: true, type: 'string' },
    role: { required: true, type: 'string' },
  }),
  asyncHandler(async (req, res) => ok(res, await adminService.createUser(req, req.user, req.body), 201))
);

router.patch('/users/:id', asyncHandler(async (req, res) =>
  ok(res, adminService.updateUser(req, req.user, req.params.id, req.body || {}))
));

router.delete('/users/:id', asyncHandler(async (req, res) =>
  ok(res, adminService.deleteUser(req, req.user, req.params.id))
));

// ── Settings ─────────────────────────────────────────────────────────────────
router.get('/settings', asyncHandler(async (_req, res) => ok(res, adminService.getSettings())));
router.put('/settings', asyncHandler(async (req, res) =>
  ok(res, adminService.updateSettings(req, req.user, req.body || {}))
));

// ── Places ───────────────────────────────────────────────────────────────────
router.get('/sites', asyncHandler(async (_req, res) => ok(res, adminService.listSites())));
router.get('/rooms', asyncHandler(async (req, res) => ok(res, adminService.listRooms(req.query.siteId))));
router.get('/desks', asyncHandler(async (req, res) => ok(res, adminService.listDesks(req.query.roomId))));

// ── Logs ─────────────────────────────────────────────────────────────────────
router.get('/logs', asyncHandler(async (req, res) =>
  ok(res, adminService.recentLogs(Math.min(Number(req.query.limit) || 100, 500)))
));

// ── Export (CSV) ─────────────────────────────────────────────────────────────
router.get('/export/visits.csv', asyncHandler(async (req, res) => {
  const csv = adminService.exportVisitsCsv({
    q: req.query.q || '',
    type: req.query.type || null,
    from: req.query.from || null,
    to: req.query.to || null,
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="visisign-visits.csv"');
  res.send(csv);
}));

module.exports = router;
