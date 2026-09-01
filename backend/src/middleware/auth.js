'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../repositories/repo');
const { ApiError } = require('../utils/http');

// Verifies the Bearer token and attaches req.user (the live DB row).
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, 'Authentication required', 'no_token'));
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = repo.users.byPublicId(payload.sub);
    if (!user || !user.is_active) throw new Error('inactive');
    req.user = user;
    next();
  } catch (_) {
    next(new ApiError(401, 'Invalid or expired session', 'bad_token'));
  }
}

// Restricts a route to one or more roles. Always use AFTER requireAuth.
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have access to this resource', 'forbidden'));
    }
    next();
  };
}

// Optional minimum access level on top of role.
function requireLevel(min) {
  return (req, _res, next) => {
    if (!req.user || req.user.access_level < min) {
      return next(new ApiError(403, 'Insufficient access level', 'forbidden'));
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requireLevel };
