'use strict';

// PUBLIC branding.
//
// Every page needs this before anyone has logged in — the kiosk is never logged
// in at all — so it is deliberately unauthenticated. It therefore carries only
// what a visitor standing in front of the kiosk can already see: colours, the
// logo, the greeting, the ticker, and the terms they are about to be asked to
// sign. No counts, no names, no configuration.

const express = require('express');
const settingsService = require('../services/settings.service');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

router.get('/', asyncHandler(async (_req, res) => {
  const branding = await settingsService.branding();
  // Short cache: a kiosk polls this on load and after an admin saves, and we
  // would rather a colour change appear within seconds than shave a request.
  res.setHeader('Cache-Control', 'no-cache');
  ok(res, branding);
}));

module.exports = router;
