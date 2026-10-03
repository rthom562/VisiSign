'use strict';

const express = require('express');
const printService = require('../services/print.service');
const repo = require('../repositories/repo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireAgent } = require('../middleware/agent');
const { asyncHandler, ok } = require('../utils/http');

const router = express.Router();

// ── Admin / kiosk ────────────────────────────────────────────────────────────

// ADMIN — which transport is in play, so the UI can explain itself.
router.get('/transport', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) =>
  ok(res, printService.transport())
));

// ADMIN — list available printers (local in `direct` mode, else as last reported
// by the on-premise agent).
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

// ADMIN — recent print jobs and their outcomes (queue transport).
router.get('/jobs', requireAuth, requireRole('admin'), asyncHandler(async (req, res) =>
  ok(res, { jobs: await printService.queue.recent(Math.min(Number(req.query.limit) || 50, 200)) })
));

// PUBLIC (kiosk) — print / reprint the badge for a visit.
// `kioskId` selects that kiosk's own printer and label size, so a site with
// several reception desks prints each badge where it was signed in.
router.post('/badge/:visitId', asyncHandler(async (req, res) =>
  ok(res, await printService.printBadgeForVisit(req.params.visitId, {
    kioskId: (req.body && req.body.kioskId) || req.query.kioskId || null,
  }))
));

// ── On-premise print agent ───────────────────────────────────────────────────
// Everything below is for the agent running on the reception PC. It polls OUT
// over HTTPS, so the building needs no inbound firewall rule, VPN or tunnel.
// See /agent for the client, and services/print.queue.js for the protocol.

// The agent announces itself and the printers it can see. Storing the list lets
// the admin UI offer a real printer dropdown even though the cloud server has
// no printers of its own.
router.post('/agent/hello', requireAgent, asyncHandler(async (req, res) => {
  const printers = Array.isArray(req.body && req.body.printers)
    ? req.body.printers.filter((p) => typeof p === 'string').slice(0, 100)
    : [];
  await repo.settings.set('agent_printers', JSON.stringify(printers));
  await repo.settings.set('agent_last_seen', new Date().toISOString());
  await repo.settings.set('agent_id', req.agentId);
  const cfg = await printService.cfg();
  // Hand back the label settings so the agent always prints at the size the
  // admin chose, without needing its own configuration.
  ok(res, {
    agentId: req.agentId,
    label: { printer: cfg.printer, widthMm: cfg.widthMm, heightMm: cfg.heightMm },
    pollSeconds: 3,
  });
}));

// Claim the next queued job(s). Claiming is a conditional UPDATE, so two agents
// polling at the same moment cannot both take the same badge.
router.get('/agent/jobs', requireAgent, asyncHandler(async (req, res) => {
  const want = Math.min(Number(req.query.limit) || 1, 5);
  const queued = await printService.queue.pending(want * 2);
  const claimed = [];
  for (const job of queued) {
    if (claimed.length >= want) break;
    const got = await printService.queue.claim(job, req.agentId);
    if (got) claimed.push(got);
  }
  ok(res, { jobs: claimed });
}));

// Report the outcome of a job. `ok: false` with an error records the failure;
// the scheduler re-queues anything claimed but never reported.
router.post('/agent/jobs/:jobId/result', requireAgent, asyncHandler(async (req, res) => {
  const succeeded = !!(req.body && req.body.ok);
  const error = req.body && req.body.error ? String(req.body.error).slice(0, 500) : null;
  const out = await printService.queue.finish(req.params.jobId, { ok: succeeded, error });
  if (!out.found) return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Job not found' } });
  ok(res, out);
}));

module.exports = router;
