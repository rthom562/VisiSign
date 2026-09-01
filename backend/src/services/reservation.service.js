'use strict';

const repo = require('../repositories/repo');
const visitService = require('./visit.service');
const { ApiError } = require('../utils/http');
const { publicId, qrPayload } = require('../utils/ids');
const logService = require('./log.service');

// ── Time / slot helpers ──────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

function localNow() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    minutes: d.getHours() * 60 + d.getMinutes(),
  };
}
const slotToMinutes = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};
const minutesToSlot = (t) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;

// Slot configuration comes from settings (admin-tunable) with sane defaults.
function slotConfig() {
  const g = (k, d) => {
    const row = repo.settings.get(k);
    return row ? row.value : d;
  };
  return {
    open: g('open_time', '09:00'),
    close: g('close_time', '17:00'),
    minutes: Number(g('slot_minutes', '30')) || 30,
  };
}

function generateSlots(cfg) {
  const out = [];
  const end = slotToMinutes(cfg.close);
  for (let t = slotToMinutes(cfg.open); t < end; t += cfg.minutes) out.push(minutesToSlot(t));
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

// Time slots for a date. Capacity is unlimited — every slot is always available.
function listSlots(date) {
  const d = date || localNow().date;
  const cfg = slotConfig();
  const slots = generateSlots(cfg).map((s) => ({
    slot: s,
    label: `${s}–${minutesToSlot(slotToMinutes(s) + cfg.minutes)}`,
  }));
  return { date: d, slots };
}

// Create a reservation (pre-check-in). Public — no login.
function create(req, input) {
  const fullName = String(input.fullName || '').trim();
  const date = String(input.date || '').trim();
  const slot = String(input.slot || '').trim();
  if (!fullName) throw new ApiError(400, 'Your name is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'A valid date is required');
  if (!/^\d{2}:\d{2}$/.test(slot)) throw new ApiError(400, 'A valid time slot is required');

  const cfg = slotConfig();
  const { date: today } = localNow();
  if (date < today) throw new ApiError(400, 'That date is in the past', 'past_date');
  if (!generateSlots(cfg).includes(slot)) throw new ApiError(400, 'That time slot is not available', 'bad_slot');
  // No capacity limit — any number of visitors may reserve the same slot.

  const pid = publicId('res');
  const res = repo.reservations.create({
    public_id: pid,
    full_name: fullName,
    company: input.company,
    email: input.email,
    phone: input.phone,
    host_name: input.host,
    reason: input.reason,
    site_id: input.siteId,
    reserved_date: date,
    time_slot: slot,
    custom_data: input.customData ? JSON.stringify(input.customData) : null,
  });

  logService.record(req, {
    actorType: 'guest', action: 'reservation.create',
    targetTable: 'reservations', targetId: res.lastInsertRowid,
    detail: { name: fullName, date, slot },
  });

  return {
    reservationId: pid,
    name: fullName,
    date,
    slot,
    qr: qrPayload({ res: pid, date, slot }),
    status: 'reserved',
  };
}

// Reservations to show at reception. Public but returns MINIMAL fields (no
// email/phone) since it is displayed on the walk-up kiosk. Defaults to today
// and flags the ones whose slot is around the current time.
function current(date) {
  const { date: today, minutes: now } = localNow();
  const d = date || today;
  return repo.reservations.openForDate(d).map((r) => ({
    id: r.public_id,
    name: r.full_name,
    company: r.company,
    host: r.host_name,
    reason: r.reason,
    slot: r.time_slot,
    isNow: d === today && Math.abs(slotToMinutes(r.time_slot) - now) <= 60,
  }));
}

// Check a reservation in on arrival: creates a real visit (+ badge/QR) and marks
// the reservation as checked in.
function checkIn(req, reservationPublicId) {
  const r = repo.reservations.byPublicId(String(reservationPublicId || ''));
  if (!r) throw new ApiError(404, 'Reservation not found');
  if (r.status === 'checked_in') throw new ApiError(409, 'Already checked in', 'already');
  if (r.status !== 'reserved') throw new ApiError(409, 'This reservation is no longer active', 'inactive');

  let custom;
  try { custom = r.custom_data ? JSON.parse(r.custom_data) : undefined; } catch (_) { custom = undefined; }

  const signed = visitService.guestSignIn(req, {
    fullName: r.full_name,
    company: r.company,
    host: r.host_name,
    reason: r.reason,
    email: r.email,
    phone: r.phone,
    siteId: r.site_id,
    customData: custom,
  });

  const visitRow = repo.visits.byPublicId(signed.visitId);
  if (visitRow) repo.reservations.markCheckedIn(r.id, visitRow.id);

  logService.record(req, {
    actorType: 'guest', action: 'reservation.checkin',
    targetTable: 'reservations', targetId: r.id, detail: { visit: signed.visitId },
  });

  return { ...signed, reservationId: r.public_id, status: 'checked_in', name: r.full_name };
}

// ── Admin ────────────────────────────────────────────────────────────────────
function listForAdmin(date) {
  return repo.reservations.allForDate(date || localNow().date);
}

function cancel(req, admin, reservationPublicId) {
  const r = repo.reservations.byPublicId(reservationPublicId);
  if (!r) throw new ApiError(404, 'Reservation not found');
  repo.reservations.cancel(r.id);
  logService.record(req, {
    actorType: 'admin', actorId: admin.id, action: 'reservation.cancel',
    targetTable: 'reservations', targetId: r.id,
  });
  return { id: reservationPublicId, status: 'cancelled' };
}

module.exports = { listSlots, create, current, checkIn, listForAdmin, cancel };
