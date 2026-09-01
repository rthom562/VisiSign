'use strict';

const { ApiError } = require('../utils/http');

// Minimal, dependency-free body validator.
// spec = { field: { required, type, max } }
function validateBody(spec) {
  return (req, _res, next) => {
    const body = req.body || {};
    for (const [field, rule] of Object.entries(spec)) {
      const value = body[field];
      if (rule.required && (value === undefined || value === null || value === '')) {
        return next(new ApiError(400, `Field "${field}" is required`, 'validation'));
      }
      if (value !== undefined && value !== null && value !== '') {
        if (rule.type === 'string' && typeof value !== 'string') {
          return next(new ApiError(400, `Field "${field}" must be a string`, 'validation'));
        }
        if (rule.type === 'number' && typeof value !== 'number') {
          return next(new ApiError(400, `Field "${field}" must be a number`, 'validation'));
        }
        if (rule.max && typeof value === 'string' && value.length > rule.max) {
          return next(new ApiError(400, `Field "${field}" is too long`, 'validation'));
        }
      }
    }
    next();
  };
}

module.exports = { validateBody };
