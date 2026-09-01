'use strict';

// Background scheduler. Its main job: the end-of-day auto-checkout — sign out
// everyone who is still on site once the daily cutoff time (default 17:00 / 5pm)
// has passed. It runs once per day: after the cutoff, the first tick sweeps
// everyone out and records the date, so people who sign in later in the evening
// are NOT swept again that day.
//
// All timing uses the machine's local clock (the reception PC), so "5 o'clock"
// means 5pm where the kiosk is. The cutoff and on/off switch are admin settings:
//   auto_signout_enabled = 'true' | 'false'
//   auto_signout_time     = 'HH:MM'   (24-hour, e.g. '17:00')

const repo = require('../repositories/repo');
const logService = require('./log.service');

const pad = (n) => String(n).padStart(2, '0');

function localNow() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    minutes: d.getHours() * 60 + d.getMinutes(),
  };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function setting(key, def) {
  const row = repo.settings.get(key);
  return row ? row.value : def;
}

// Sign out everyone currently on site. Returns how many were closed.
function signOutEveryone(reason) {
  const open = repo.visits.live({ type: null, site_id: null });
  if (!open.length) return 0;
  repo.tx(() => {
    for (const v of open) {
      repo.visits.signOut(v.id);
      repo.badges.revoke(v.id);
    }
  })();
  logService.record(null, {
    actorType: 'system', action: 'visit.auto_signout',
    detail: { count: open.length, reason },
  });
  try {
    repo.alerts.create({ level: 'info', message: `Auto-signed out ${open.length} visitor(s) — ${reason}.` });
  } catch (_) { /* alert is best-effort */ }
  return open.length;
}

// One scheduler tick — cheap, safe to call every minute.
function tick() {
  try {
    if (setting('auto_signout_enabled', 'true') !== 'true') return;
    const cutoff = setting('auto_signout_time', '17:00');
    const { date, minutes } = localNow();
    if (minutes >= toMinutes(cutoff) && setting('auto_signout_last_run', '') !== date) {
      const n = signOutEveryone(`end-of-day cutoff ${cutoff}`);
      repo.settings.set('auto_signout_last_run', date); // mark done for today
      console.log(`  [auto-checkout] cutoff ${cutoff} reached — signed out ${n} visitor(s).`);
    }
  } catch (e) {
    // Never let a scheduler tick crash the server.
    console.error('  [auto-checkout] tick error:', e && e.message ? e.message : e);
  }
}

let timer = null;
function start() {
  if (timer) return;
  tick(); // run immediately so a server that starts after the cutoff still sweeps
  timer = setInterval(tick, 60 * 1000); // check every minute
  if (timer.unref) timer.unref();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, signOutEveryone };
