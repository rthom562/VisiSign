'use strict';

const express = require('express');
const reservationService = require('../services/reservation.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// ── PUBLIC (mobile pre-check-in + walk-up check-in) ──────────────────────────

// Available time slots for a date (?date=YYYY-MM-DD, defaults to today).
router.get('/slots', asyncHandler(async (req, res) =>
  ok(res, reservationService.listSlots(req.query.date))
));

// Reservations to show at reception "right now" (defaults to today).
router.get('/current', asyncHandler(async (req, res) =>
  ok(res, reservationService.current(req.query.date))
));

// Create a reservation.
router.post(
  '/',
  validateBody({
    fullName: { required: true, type: 'string', max: 120 },
    date: { required: true, type: 'string' },
    slot: { required: true, type: 'string' },
    company: { type: 'string', max: 120 },
    host: { type: 'string', max: 120 },
    reason: { type: 'string', max: 400 },
    email: { type: 'string', max: 160 },
    phone: { type: 'string', max: 40 },
  }),
  asyncHandler(async (req, res) => ok(res, reservationService.create(req, req.body), 201))
);

// Check in a reservation on arrival (issues a badge/QR).
router.post('/:id/checkin', asyncHandler(async (req, res) =>
  ok(res, reservationService.checkIn(req, req.params.id))
));

// ── ADMIN ────────────────────────────────────────────────────────────────────

// Full reservation list for a date (with contact info).
router.get('/admin', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, reservationService.listForAdmin(req.query.date))
));

// Cancel a reservation.
router.post('/:id/cancel', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, reservationService.cancel(req, req.user, req.params.id))
));

module.exports = router;
