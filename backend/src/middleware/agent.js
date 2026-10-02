'use strict';

const crypto = require('crypto');
const config = require('../config');
const { ApiError } = require('../utils/http');

// Authenticates the on-premise print agent.
//
// The agent is a machine on a reception desk, not a person, so it does not log
// in: it presents a long shared secret (PRINT_AGENT_TOKEN) as a bearer token.
// The endpoints it can reach are deliberately narrow — claim a print job, report
// the result, fetch a visitor photo for the badge it is printing, and announce
// which printers it has.
//
// If PRINT_AGENT_TOKEN is unset the agent API is closed entirely, so a
// deployment that never prints has no extra surface at all.
function requireAgent(req, _res, next) {
  const expected = config.print.agentToken;
  if (!expected) {
    return next(
      new ApiError(
        503,
        'The print agent API is disabled. Set PRINT_AGENT_TOKEN on the server to enable it.',
        'agent_disabled'
      )
    );
  }

  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  // Compare over fixed-size digests so the check is constant-time regardless of
  // where the strings first differ, and regardless of their lengths.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return next(new ApiError(401, 'Invalid agent token', 'bad_agent_token'));
  }

  // An agent may name itself so several reception desks are distinguishable in
  // the job history.
  req.agentId = String(req.headers['x-agent-id'] || 'agent').slice(0, 64);
  next();
}

module.exports = { requireAgent };
