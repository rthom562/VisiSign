'use strict';

const express = require('express');
const visitService = require('../services/visit.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');
const authService = require('../services/auth.service');

const router = express.Router();

// PUBLIC — guest self sign-in from the kiosk/dashboard. No login required.
router.post(
  '/guest/signin',
  validateBody({
    fullName: { required: true, type: 'string', max: 120 },
    company: { type: 'string', max: 120 },
    host: { type: 'string', max: 120 },
    reason: { type: 'string', max: 400 },
  }),
  asyncHandler(async (req, res) => ok(res, await visitService.guestSignIn(req, req.body), 201))
);

// PUBLIC — who is on site right now (minimal fields). Powers the kiosk sign-out
// screen where a visitor picks their name instead of typing a Visit ID.
router.get('/onsite', asyncHandler(async (_req, res) => ok(res, await visitService.onsite())));

// PUBLIC — sign a guest out by their visit id (from the name picker or badge QR).
router.post(
  '/:visitId/signout',
  validateBody({}),
  asyncHandler(async (req, res) => ok(res, await visitService.signOut(req, req.params.visitId, null)))
);

// ADMIN — live "who is on site" list.
router.get(
  '/live',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { type, siteId } = req.query;
    ok(res, await visitService.live({ type: type || null, site_id: siteId ? Number(siteId) : null }));
  })
);

// ADMIN — searchable full history.
router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { q, type, from, to, limit, offset } = req.query;
    ok(res, await visitService.search({
      q: q || '',
      type: type || null,
      from: from || null,
      to: to || null,
      limit: Math.min(Number(limit) || 100, 500),
      offset: Number(offset) || 0,
    }));
  })
);

module.exports = router;
