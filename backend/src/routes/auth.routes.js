'use strict';

const express = require('express');
const authService = require('../services/auth.service');
const { requireAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// POST /api/auth/login — identifier is a username (email not required).
router.post(
  '/login',
  validateBody({ password: { required: true, type: 'string' } }),
  asyncHandler(async (req, res) => {
    const identifier = req.body.username ?? req.body.email;
    const result = await authService.login(identifier, req.body.password);
    ok(res, result);
  })
);

// GET /api/auth/me — current session identity.
router.get('/me', requireAuth, (req, res) => {
  ok(res, { user: authService.publicUser(req.user) });
});

// POST /api/auth/logout — stateless JWT, so the client just drops the token.
// Endpoint exists so the UI has a single place to call and we can audit it.
router.post('/logout', requireAuth, (_req, res) => ok(res, { loggedOut: true }));

module.exports = router;
