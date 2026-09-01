'use strict';

const express = require('express');
const printService = require('../services/print.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// ADMIN — list installed Windows printers (for the settings dropdown).
router.get('/printers', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) =>
  ok(res, { printers: await printService.listPrinters() })
));

// ADMIN — a printer's supported label sizes (for calibrating the label size).
router.get('/printer-info', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await printService.printerInfo(req.query.name))
));

// ADMIN — print a sample badge to check the printer/label size.
router.post('/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, await printService.testPrint({ printer: req.body && req.body.printer }))
));

// PUBLIC (kiosk) — print / reprint the badge for a visit.
router.post('/badge/:visitId', asyncHandler(async (req, res) =>
  ok(res, await printService.printBadgeForVisit(req.params.visitId, {}))
));

module.exports = router;
