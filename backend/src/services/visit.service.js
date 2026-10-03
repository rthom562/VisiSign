'use strict';

const repo = require('../repositories/repo');
const settingsService = require('./settings.service');
const { ApiError } = require('../utils/http');
const { publicId, badgeCode, qrPayload } = require('../utils/ids');
const logService = require('./log.service');
const printService = require('./print.service');

// A drawn signature is a small monochrome PNG. 512 KB is far more than a
// finger-drawn canvas ever produces and still bounds what a client can post.
const MAX_SIGNATURE_BYTES = 512 * 1024;
const SIGNATURE_RE = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

/**
 * Check a submitted signature and normalise it for storage.
 *
 * Returns the data URL to store, or null when there is nothing usable. Terms
 * enforcement happens in guestSignIn — this only vets the image itself.
 */
function cleanSignature(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = SIGNATURE_RE.exec(dataUrl.trim());
  if (!m) return null;
  if (Buffer.from(m[1], 'base64').length > MAX_SIGNATURE_BYTES) return null;
  return dataUrl.trim();
}

/**
 * Guest self sign-in. Creates a guest record, opens a visit, issues a badge with
 * a QR payload, and — when terms are in force — records the signature, all in
 * one transaction.
 *
 * The terms check is enforced HERE rather than in the browser: the kiosk UI
 * showing a terms step is a convenience, not a control, and this endpoint is
 * public.
 */
async function guestSignIn(req, input) {
  const fullName = String(input.fullName || '').trim();
  if (!fullName) throw new ApiError(400, 'Your name is required');

  const terms = (await settingsService.branding()).terms;

  let signature = null;
  if (terms.enabled) {
    if (!input.acceptedTerms) {
      throw new ApiError(400, 'You must accept the terms to sign in.', 'terms_required');
    }
    if (terms.requireSignature) {
      signature = cleanSignature(input.signature);
      if (!signature) {
        throw new ApiError(400, 'A signature is required to sign in.', 'signature_required');
      }
    }
  }

  const termsHash = terms.enabled ? settingsService.hashTerms(terms.text) : null;

  const result = await repo.tx(async (t) => {
    const gpid = publicId('gst');
    const g = await t.guests.create({
      public_id: gpid,
      full_name: fullName,
      company: input.company,
      email: input.email,
      phone: input.phone,
    });
    const guestId = g.lastInsertRowid;

    const vpid = publicId('vis');
    const v = await t.visits.create({
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
    await t.badges.create({
      visit_id: visitId,
      code,
      qr_payload: qrPayload({ visit: vpid, guest: gpid, code }),
    });

    // The signature belongs to the same transaction as the visit — a visit must
    // never exist without the acceptance that allowed it.
    if (terms.enabled) {
      await t.signatures.create({
        visit_id: visitId,
        signer_name: fullName,
        tos_version: terms.version,
        tos_hash: termsHash,
        signature_png: signature,
        ip: req ? req.ip : null,
        user_agent: req && req.headers ? req.headers['user-agent'] : null,
      });
    }

    return { visitId, vpid, gpid, code };
  });

  logService.record(req, {
    actorType: 'guest',
    action: 'visit.guest_signin',
    targetTable: 'visits',
    targetId: result.visitId,
    detail: {
      name: fullName,
      company: input.company || null,
      ...(terms.enabled ? { termsVersion: terms.version, signed: !!signature } : {}),
    },
  });

  // Auto-print the badge at reception if configured. Fire-and-forget: it never
  // blocks sign-in and never throws.
  printService.autoPrint(result.vpid, { kioskId: input.kioskId });

  return {
    visitId: result.vpid,
    guestId: result.gpid,
    badge: { code: result.code },
    status: 'signed_in',
  };
}

// Sign out any visit by its public id. Revokes the badge.
async function signOut(req, visitPublicId, actor) {
  const visit = await repo.visits.byPublicId(String(visitPublicId || ''));
  if (!visit) throw new ApiError(404, 'Visit not found');
  if (visit.status === 'signed_out') throw new ApiError(409, 'Already signed out', 'already');

  await repo.tx(async (t) => {
    await t.visits.signOut(visit.id);
    await t.badges.revoke(visit.id);
  });

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
async function onsite() {
  const rows = await repo.visits.live({ type: 'guest', site_id: null });
  return rows.map((v) => ({
    visitId: v.public_id,
    name: v.guest_name,
    company: v.guest_company,
    host: v.host_name,
    since: v.signed_in_at,
  }));
}

/** The signature recorded for a visit, for the admin record view. */
async function signatureFor(visitPublicId) {
  const visit = await repo.visits.byPublicId(String(visitPublicId || ''));
  if (!visit) throw new ApiError(404, 'Visit not found');
  const sig = await repo.signatures.byVisit(visit.id);
  if (!sig) return null;
  return {
    visitId: visit.public_id,
    signerName: sig.signer_name,
    termsVersion: sig.tos_version,
    termsHash: sig.tos_hash,
    signedAt: sig.signed_at,
    signature: sig.signature_png,
  };
}

module.exports = { guestSignIn, signOut, live, search, onsite, signatureFor };
