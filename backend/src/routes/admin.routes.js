'use strict';

const express = require('express');
const adminService = require('../services/admin.service');
const settingsService = require('../services/settings.service');
const visitService = require('../services/visit.service');
const logService = require('../services/log.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// Everything here is admin-only.
router.use(requireAuth, requireRole('admin'));

// ── Overview / alerts ────────────────────────────────────────────────────────
router.get('/overview', asyncHandler(async (_req, res) => ok(res, await adminService.overview())));
router.get('/alerts', asyncHandler(async (_req, res) => ok(res, await adminService.openAlerts())));
router.post('/alerts/:id/resolve', asyncHandler(async (req, res) =>
  ok(res, await adminService.resolveAlert(req, req.user, req.params.id))
));

// ── Users ────────────────────────────────────────────────────────────────────
router.get('/users', asyncHandler(async (req, res) =>
  ok(res, await adminService.listUsers({
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
  ok(res, await adminService.updateUser(req, req.user, req.params.id, req.body || {}))
));

router.delete('/users/:id', asyncHandler(async (req, res) =>
  ok(res, await adminService.deleteUser(req, req.user, req.params.id))
));

// ── Settings ─────────────────────────────────────────────────────────────────
// The flat key/value map (used by the kiosk panel and older callers).
router.get('/settings', asyncHandler(async (_req, res) => ok(res, await adminService.getSettings())));

// The full schema — groups, types, ranges, help text — plus current values.
// This is what builds the Settings panel, so a new setting needs no UI work.
router.get('/settings/schema', asyncHandler(async (_req, res) =>
  ok(res, await settingsService.describe())
));

router.put('/settings', asyncHandler(async (req, res) =>
  ok(res, await adminService.updateSettings(req, req.user, req.body || {}))
));

// ── Appearance templates ─────────────────────────────────────────────────────
router.get('/templates', asyncHandler(async (_req, res) =>
  ok(res, { templates: require('../settings/templates').list() })
));

router.post('/templates/:key/apply', asyncHandler(async (req, res) => {
  const out = await settingsService.applyTemplate(req.params.key);
  logService.record(req, {
    actorType: 'admin', actorId: req.user.id, action: 'settings.template',
    detail: { template: out.applied },
  });
  ok(res, out);
}));

// ── .vsf customisation files ─────────────────────────────────────────────────
// Download the current look as a single portable file, and load one back.
// Deliberately branding-only: printer names and cutoff times belong to one
// building and must not travel between installs.
router.get('/customisation/export', asyncHandler(async (req, res) => {
  const bundle = await settingsService.exportVsf({ name: req.query.name });
  const safe = String(bundle.name).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'visisign';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.vsf"`);
  logService.record(req, {
    actorType: 'admin', actorId: req.user.id, action: 'settings.export',
    detail: { name: bundle.name },
  });
  res.send(JSON.stringify(bundle, null, 2));
}));

router.post('/customisation/import', asyncHandler(async (req, res) => {
  const body = req.body || {};
  // Accept either the bundle itself or { bundle, dryRun } so the UI can preview.
  const bundle = body.bundle || body;
  const out = await settingsService.importVsf(bundle, { dryRun: !!body.dryRun });
  if (!out.dryRun) {
    logService.record(req, {
      actorType: 'admin', actorId: req.user.id, action: 'settings.import',
      detail: { name: out.name, applied: out.appliedCount },
    });
  }
  ok(res, out);
}));

// ── Places ───────────────────────────────────────────────────────────────────
router.get('/sites', asyncHandler(async (_req, res) => ok(res, await adminService.listSites())));
router.get('/rooms', asyncHandler(async (req, res) => ok(res, await adminService.listRooms(req.query.siteId))));
router.get('/desks', asyncHandler(async (req, res) => ok(res, await adminService.listDesks(req.query.roomId))));

// ── Signed terms ─────────────────────────────────────────────────────────────
// The acceptance record for a visit: who signed, which version of the terms,
// and the hash of the exact text they agreed to.
router.get('/signatures', asyncHandler(async (req, res) =>
  ok(res, { signatures: await adminService.recentSignatures(Math.min(Number(req.query.limit) || 100, 500)) })
));

router.get('/signatures/:visitId', asyncHandler(async (req, res) => {
  const sig = await visitService.signatureFor(req.params.visitId);
  if (!sig) return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'No signature for that visit' } });
  ok(res, sig);
}));

// ── Logs ─────────────────────────────────────────────────────────────────────
router.get('/logs', asyncHandler(async (req, res) =>
  ok(res, await adminService.recentLogs(Math.min(Number(req.query.limit) || 100, 500)))
));

// ── Export (CSV) ─────────────────────────────────────────────────────────────
router.get('/export/visits.csv', asyncHandler(async (req, res) => {
  const csv = await adminService.exportVisitsCsv({
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
