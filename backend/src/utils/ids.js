'use strict';

const crypto = require('crypto');

// Opaque, URL-safe public ids so we never leak sequential integer keys to clients.
function publicId(prefix) {
  const rand = crypto.randomBytes(9).toString('base64url'); // 12 chars
  return prefix ? `${prefix}_${rand}` : rand;
}

// A short human-friendly badge code, e.g. "VS-7K2Q9F".
function badgeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `VS-${out}`;
}

// A short, easy-to-read code (no ambiguous chars), e.g. for kiosk pairing: "7K2Q".
function shortCode(len = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of crypto.randomBytes(len)) out += alphabet[b % alphabet.length];
  return out;
}

// QR payload — a signed-ish opaque string the kiosk/scanner can read.
// (Encoded as a compact JSON string; the frontend renders it as a QR image.)
function qrPayload(data) {
  return JSON.stringify({ v: 1, ...data });
}

module.exports = { publicId, badgeCode, shortCode, qrPayload };
