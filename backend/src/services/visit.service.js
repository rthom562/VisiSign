'use strict';

const fs = require('fs');
const path = require('path');
const repo = require('../repositories/repo');
const config = require('../config');
const { ApiError } = require('../utils/http');
const { publicId, badgeCode, qrPayload } = require('../utils/ids');
const logService = require('./log.service');
const printService = require('./print.service');

// Save a kiosk-captured photo (a data: URL) to the photos folder and return just
// the file NAME (resolved against config.photosDir later, so the install can move).
function savePhoto(dataUrl) {
  try {
    if (typeof dataUrl !== 'string') return null;
    const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
    fs.mkdirSync(config.photosDir, { recursive: true });
    const name = `${publicId('pho')}.${m[1] === 'png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(config.photosDir, name), buf);
    return name;
  } catch (_) {
    return null; // a photo must never break sign-in
  }
}

// Guest self sign-in. Creates (or reuses) a guest record, opens a visit and
// issues a badge with a QR payload — all in one transaction.
function guestSignIn(req, input) {
  const fullName = String(input.fullName || '').trim();
  if (!fullName) throw new ApiError(400, 'Your name is required');

  const result = repo.tx(() => {
    const gpid = publicId('gst');
    const g = repo.guests.create({
      public_id: gpid,
      full_name: fullName,
      company: input.company,
      email: input.email,
      phone: input.phone,
      photo_url: savePhoto(input.photoUrl),
    });
    const guestId = g.lastInsertRowid;

    const vpid = publicId('vis');
    const v = repo.visits.create({
      public_id: vpid,
      type: 'guest',
      guest_id: guestId,
      host_name: input.host,
      site_id: input.siteId,
      room_id: input.roomId,
      desk_id: input.deskId,
      reason: input.reason,
      custom_data: input.customData ? JSON.stringify(input.customData) : null,
    });
    const visitId = v.lastInsertRowid;

    const code = badgeCode();
    repo.badges.create({
      visit_id: visitId,
      code,
      qr_payload: qrPayload({ visit: vpid, guest: gpid, code }),
    });

    return { visitId, vpid, gpid, code };
  })();

  logService.record(req, {
    actorType: 'guest',
    action: 'visit.guest_signin',
    targetTable: 'visits',
    targetId: result.visitId,
    detail: { name: fullName, company: input.company || null },
  });

  // Auto-print the badge at reception if configured (fire-and-forget; never blocks
  // sign-in and never throws). Covers walk-ins AND reservation check-ins, since
  // check-in creates its visit through this function.
  printService.autoPrint(result.vpid);

  return {
    visitId: result.vpid,
    guestId: result.gpid,
    badge: { code: result.code },
    status: 'signed_in',
  };
}

// Sign out any visit by its public id. Revokes the badge.
function signOut(req, visitPublicId, actor) {
  const visit = repo.visits.byPublicId(String(visitPublicId || ''));
  if (!visit) throw new ApiError(404, 'Visit not found');
  if (visit.status === 'signed_out') throw new ApiError(409, 'Already signed out', 'already');

  repo.tx(() => {
    repo.visits.signOut(visit.id);
    repo.badges.revoke(visit.id);
  })();

  logService.record(req, {
    actorType: actor?.role || 'guest',
    actorId: actor?.id || null,
    action: 'visit.signout',
    targetTable: 'visits',
    targetId: visit.id,
  });

  return { visitId: visit.public_id, status: 'signed_out' };
}

const live = (filter = {}) => repo.visits.live(filter);
const search = (filter = {}) => repo.visits.search(filter);

// Minimal PUBLIC list of guests currently on site — used by the kiosk sign-out
// screen so a visitor can pick their name instead of typing a Visit ID. Returns
// only what the kiosk needs to show (no email/phone).
function onsite() {
  return repo.visits.live({ type: 'guest', site_id: null }).map((v) => ({
    visitId: v.public_id,
    name: v.guest_name,
    company: v.guest_company,
    host: v.host_name,
    since: v.signed_in_at,
  }));
}

module.exports = { guestSignIn, signOut, live, search, onsite };
