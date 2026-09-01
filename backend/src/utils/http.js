'use strict';

// Wrap async route handlers so thrown errors reach the central error middleware.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// A small typed error services can throw to control the HTTP response.
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

module.exports = { asyncHandler, ApiError, ok };
