'use strict';

// The business day.
//
// Reservation dates, time slots and the end-of-day auto-signout cutoff are all
// meant to be read in the timezone where the kiosk physically stands. On the
// reception PC the machine clock already is that, but a cloud container runs in
// UTC — so "sign everyone out at 17:00" would fire at 5pm UTC, which is the
// middle of the afternoon in New York and the middle of the night in Sydney.
//
// Every one of those decisions therefore goes through here, resolved against an
// explicit timezone (config.timezone, from VISISIGN_TZ / TZ). Using Intl rather
// than process.env.TZ means the answer does not depend on when the environment
// variable was read relative to the first Date() call.

const config = require('../config');

const pad = (n) => String(n).padStart(2, '0');

// Cache the formatter: constructing one is comparatively expensive and the
// scheduler asks for the time once a minute.
let formatter = null;
let formatterZone = null;

function partsFor(zone, date) {
  if (!zone) {
    // No timezone configured — use the machine's own clock, which is the right
    // answer for the on-premise install.
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }

  if (!formatter || formatterZone !== zone) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    formatterZone = zone;
  }

  const out = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  // en-US with hour12:false renders midnight as hour 24; normalise it.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/**
 * "Now", in the configured business timezone.
 *
 *   { date: 'YYYY-MM-DD', minutes: <minutes since local midnight>, time: 'HH:MM' }
 */
function localNow(at = new Date()) {
  const p = partsFor(config.timezone, at);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minutes: p.hour * 60 + p.minute,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** The UTC timestamp string the database stores, for `n` seconds ago. */
function utcStampSecondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** 'HH:MM' → minutes since midnight. */
function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** minutes since midnight → 'HH:MM'. */
function toHhmm(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

module.exports = { localNow, utcStampSecondsAgo, toMinutes, toHhmm, pad };
