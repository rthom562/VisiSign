'use strict';

const express = require('express');
const kioskService = require('../services/kiosk.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// ── PUBLIC — the device itself ───────────────────────────────────────────────

// A device registers itself and then polls its approval status.
router.post(
  '/register',
  validateBody({ deviceId: { required: true, type: 'string', max: 200 }, name: { type: 'string', max: 60 } }),
  asyncHandler(async (req, res) => ok(res, await kioskService.register(req, req.body), 201))
);

router.get('/status', asyncHandler(async (req, res) =>
  ok(res, await kioskService.status(req, req.query.deviceId))
));

// Kiosk settings. Passing `deviceId` tailors the reply to THAT kiosk's printer
// and label size, so several kiosks can drive several printers.
router.get('/config', asyncHandler(async (req, res) =>
  ok(res, await kioskService.publicConfig(req.query.deviceId))
));

// ── ADMIN — managing the fleet ───────────────────────────────────────────────

// Every device, with its resolved printing config and what it overrides.
router.get('/', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) =>
  ok(res, { kiosks: await kioskService.listDetailed() })
));

// Kept for the console and older callers.
router.get('/summary', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) =>
  ok(res, { accepted: await kioskService.listAccepted(), pending: await kioskService.listPending() })
));

router.post('/:code/accept', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await kioskService.accept(req.params.code))
));

router.post('/:code/reject', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await kioskService.reject(req.params.code))
));

router.post('/:code/revoke', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await kioskService.revoke(req.params.code))
));

// Per-kiosk configuration: its name, location, printer, print mode and label
// size. Sending an empty string for a field clears that override so the kiosk
// follows the organisation default again.
router.patch('/:code', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await kioskService.updateConfig(req, req.user, req.params.code, req.body || {}))
));

// Forget a device entirely. It must register and be approved again.
router.delete('/:code', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await kioskService.remove(req, req.user, req.params.code))
));

module.exports = router;
