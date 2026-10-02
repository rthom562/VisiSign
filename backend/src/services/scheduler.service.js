'use strict';

// Background scheduler. Two jobs:
//
//   1. End-of-day auto-checkout — sign out everyone still on site once the
//      daily cutoff (default 17:00) has passed. It runs once per day: after the
//      cutoff the first tick sweeps everyone out and records the date, so people
//      who sign in later that evening are NOT swept again.
//
//   2. Re-queue stale print jobs — a badge an on-premise agent claimed but never
//      finished (its PC slept, lost network, or the printer jammed) goes back on
//      the queue so another agent, or the same one when it returns, can print it.
//
// ── Timing ──────────────────────────────────────────────────────────────────
// "5 o'clock" means 5pm where the kiosk is, which is NOT the server's clock
// once VisiSign runs in the cloud. All timing goes through utils/time.js and
// the configured business timezone.
//
// ── Running more than one instance ──────────────────────────────────────────
// A cloud deployment can have several containers alive at once, and each would
// otherwise run its own sweep. Every tick therefore takes a database advisory
// lock first, so exactly one instance does the work; the rest return
// immediately. (On SQLite there is only ever one instance, and the lock is a
// no-op.)
//
// The cutoff and on/off switch are admin settings:
//   auto_signout_enabled = 'true' | 'false'
//   auto_signout_time    = 'HH:MM'   (24-hour, e.g. '17:00')

const repo = require('../repositories/repo');
const config = require('../config');
const { withAdvisoryLock } = require('../db/connection');
const { localNow, toMinutes, utcStampSecondsAgo } = require('../utils/time');
const logService = require('./log.service');

async function settings() {
  const rows = await repo.settings.all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return (key, dflt) => (map.has(key) ? map.get(key) : dflt);
}

// Sign out everyone currently on site. Returns how many were closed.
async function signOutEveryone(reason) {
  const open = await repo.visits.live({});
  if (!open.length) return 0;

  await repo.tx(async (t) => {
    for (const v of open) {
      await t.visits.signOut(v.id);
      await t.badges.revoke(v.id);
    }
  });

  await logService.record(null, {
    actorType: 'system',
    action: 'visit.auto_signout',
    detail: { count: open.length, reason },
  });

  try {
    await repo.alerts.create({
      level: 'info',
      message: `Auto-signed out ${open.length} visitor(s) — ${reason}.`,
    });
  } catch (_) {
    /* the alert is best-effort */
  }

  return open.length;
}

// Put jobs an agent claimed but never finished back on the queue.
async function requeueStalePrintJobs() {
  const cutoff = utcStampSecondsAgo(config.print.staleJobSeconds);
  const r = await repo.printJobs.requeueStale(cutoff);
  if (r.changes > 0) {
    console.log(`  [print] re-queued ${r.changes} stale print job(s).`);
  }
  return r.changes;
}

// The actual work of one tick, run while holding the lock.
async function runDueWork() {
  const get = await settings();

  if (get('auto_signout_enabled', 'true') === 'true') {
    const cutoff = get('auto_signout_time', '17:00');
    const { date, minutes } = localNow();
    if (minutes >= toMinutes(cutoff) && get('auto_signout_last_run', '') !== date) {
      const n = await signOutEveryone(`end-of-day cutoff ${cutoff}`);
      await repo.settings.set('auto_signout_last_run', date); // mark done for today
      console.log(`  [auto-checkout] cutoff ${cutoff} reached — signed out ${n} visitor(s).`);
    }
  }

  await requeueStalePrintJobs();
}

// One scheduler tick — cheap, safe to call every minute.
async function tick() {
  try {
    // Only the instance that wins the lock does the work; the others no-op.
    await withAdvisoryLock('visisign:scheduler', runDueWork);
  } catch (e) {
    // Never let a scheduler tick crash the server.
    console.error('  [scheduler] tick error:', e && e.message ? e.message : e);
  }
}

let timer = null;

function start() {
  if (timer) return;
  if (!config.enableScheduler) {
    console.log('  Scheduler disabled (ENABLE_SCHEDULER=false).');
    return;
  }
  // Run immediately so a server that starts after the cutoff still sweeps.
  tick();
  timer = setInterval(tick, 60 * 1000); // check every minute
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick, signOutEveryone, requeueStalePrintJobs };
