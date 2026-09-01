'use strict';

const config = require('../config');

// 404 for unmatched API routes.
function notFound(_req, res) {
  res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Resource not found' } });
}

// Central error handler. Services throw ApiError with a status; anything else
// becomes a 500 and is logged. We never leak stack traces to clients.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    // Server-side log only.
    console.error('[VisiSign] error:', err);
  }
  res.status(status).json({
    ok: false,
    error: {
      code: err.code || 'error',
      message: status >= 500 && config.isProd ? 'Internal server error' : err.message,
    },
  });
}

module.exports = { notFound, errorHandler };
