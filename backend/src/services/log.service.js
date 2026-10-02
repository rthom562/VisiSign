'use strict';

const repo = require('../repositories/repo');

// Thin wrapper so every service records audit entries the same way.
//
// Audit logging must never break — or delay — the request that triggered it, so
// this is deliberately fire-and-forget: it returns a promise that NEVER
// rejects, and callers are free to ignore it. Await it only when you need the
// row to exist before doing something else (the tests do).
function record(req, { actorType = 'system', actorId = null, action, targetTable, targetId, detail }) {
  return repo.logs
    .add({
      actor_type: actorType,
      actor_id: actorId,
      action,
      target_table: targetTable,
      target_id: targetId,
      detail,
      ip: req ? req.ip : null,
    })
    .catch((err) => {
      // Swallowed on purpose. Surface it on the server console so a broken
      // audit trail is still visible to an operator.
      console.error('[VisiSign] audit log write failed:', err.message);
    });
}

module.exports = { record };
