'use strict';

const express = require('express');
const kioskService = require('../services/kiosk.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// PUBLIC — a device registers itself and then polls its approval status.
router.post(
  '/register',
  validateBody({ deviceId: { required: true, type: 'string', max: 200 }, name: { type: 'string', max: 60 } }),
  asyncHandler(async (req, res) => ok(res, kioskService.register(req, req.body), 201))
);

router.get('/status', asyncHandler(async (req, res) =>
  ok(res, kioskService.status(req, req.query.deviceId))
));

// PUBLIC — kiosk settings (photo capture on/off, print mode, label size).
router.get('/config', asyncHandler(async (_req, res) => ok(res, kioskService.publicConfig())));

// ADMIN — list / accept / revoke kiosks (mirrors the console commands).
router.get('/', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) =>
  ok(res, { accepted: kioskService.listAccepted(), pending: kioskService.listPending() })
));
router.post('/:code/accept', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, kioskService.accept(req.params.code))
));
router.post('/:code/revoke', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, kioskService.revoke(req.params.code))
));

module.exports = router;
