'use strict';

// The `queue` print transport — how a cloud VisiSign prints a badge on a label
// printer sitting at a reception desk it has no route to.
//
// The server cannot reach the printer, so it does not try. It writes a print job
// row instead. The on-premise print agent (see /agent) runs on the reception PC,
// polls for queued jobs over HTTPS, renders them with the very same PowerShell
// code the on-premise build uses (print.windows.js), and reports the outcome
// back. Nothing has to be forwarded into the building, so there is no inbound
// firewall rule, no VPN and no tunnel.
//
//   kiosk ──▶ cloud API ──▶ print_jobs row
//                               │  (agent polls out over HTTPS)
//                               ▼
//              reception PC ──▶ print agent ──▶ Windows spooler ──▶ label
//
// Claiming is a conditional UPDATE, so two agents (or one agent retrying) can
// never both print the same badge. A job claimed but never finished is put back
// by the scheduler after config.print.staleJobSeconds.
//
// This is independent of iPad AirPrint / Android Mopria printing, which happens
// entirely in the browser and needs no agent at all — see the `device` print
// mode in frontend/scripts/kiosk.js.

const repo = require('../repositories/repo');
const { publicId } = require('../utils/ids');

/**
 * Put a badge on the print queue.
 * `spec` is the self-contained render payload the agent will act on.
 */
async function enqueue(visitRowId, spec) {
  const pid = publicId('prn');
  await repo.printJobs.create({
    public_id: pid,
    visit_id: visitRowId ?? null,
    payload: JSON.stringify(spec),
  });
  return { jobId: pid, queued: true };
}

/** Jobs waiting to be printed, oldest first. */
const pending = (limit = 5) => repo.printJobs.queued(limit);

/**
 * Try to take ownership of a job. Returns the job (with its payload parsed) only
 * if this agent won it; null if another agent got there first.
 */
async function claim(job, agentId) {
  const r = await repo.printJobs.claim(job.id, agentId);
  if (!r.changes) return null; // someone else claimed it between the poll and now
  let payload = {};
  try {
    payload = JSON.parse(job.payload);
  } catch (_) {
    /* a malformed payload is reported as a failure below */
  }
  return { id: job.id, jobId: job.public_id, attempts: job.attempts + 1, payload };
}

/** Record the outcome the agent reported. */
async function finish(jobPublicId, { ok, error }) {
  const job = await repo.printJobs.byPublicId(String(jobPublicId || ''));
  if (!job) return { found: false };
  await repo.printJobs.finish(job.id, { ok, error });
  return { found: true, status: ok ? 'done' : 'failed' };
}

/** Recent jobs, for the admin UI and the console. */
const recent = (limit = 50) => repo.printJobs.recent(limit);

module.exports = { enqueue, pending, claim, finish, recent };
