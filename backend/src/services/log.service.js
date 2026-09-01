'use strict';

const repo = require('../repositories/repo');

// Thin wrapper so every service records audit entries the same way.
function record(req, { actorType = 'system', actorId = null, action, targetTable, targetId, detail }) {
  try {
    repo.logs.add({
      actor_type: actorType,
      actor_id: actorId,
      action,
      target_table: targetTable,
      target_id: targetId,
      detail,
      ip: req ? req.ip : null,
    });
  } catch (_) {
    // Audit logging must never break the main request.
  }
}

module.exports = { record };
