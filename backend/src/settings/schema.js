'use strict';

// Every setting VisiSign has, described once.
//
// This file is the single source of truth. It drives:
//   * the seeded defaults                    (db/seed.js)
//   * validation on write                    (services/settings.service.js)
//   * the whole admin Settings panel         (frontend/scripts/admin.js)
//   * what a .vsf customisation file carries (services/settings.service.js)
//   * the public branding payload the kiosk reads before anyone logs in
//
// Adding a setting means adding ONE entry here. The admin UI grows a correctly
// typed field for it automatically, it is validated, and it travels in .vsf
// exports if it is marked as branding.
//
// Field types the admin UI understands:
//   text  number  bool  select  color  textarea  image  info
//
// `branding: true` means the setting describes how VisiSign LOOKS or what it
// SAYS — those are what a .vsf file carries between installs. Operational
// settings (printer names, cutoff times, approval rules) are deliberately not
// included, because they are specific to one building.

const GROUPS = [
  { key: 'general', label: 'General', icon: '🏢', help: 'Your organisation and how the kiosk greets people.' },
  { key: 'appearance', label: 'Appearance', icon: '🎨', help: 'Colours, logo and theme. Shared via .vsf files.' },
  { key: 'ticker', label: 'Ticker', icon: '📰', help: 'The scrolling message bar along the bottom of the kiosk.' },
  { key: 'terms', label: 'Terms & signature', icon: '✍️', help: 'What visitors must agree to and sign before they are signed in.' },
  { key: 'reservations', label: 'Reservations', icon: '🗓️', help: 'Bookable hours and slot length.' },
  { key: 'kiosk', label: 'Kiosk & devices', icon: '🖥️', help: 'How kiosk devices are approved.' },
  { key: 'printing', label: 'Badge printing', icon: '🖨️', help: 'Default printer and label size. Each kiosk can override these.' },
  { key: 'signout', label: 'Auto sign-out', icon: '🌙', help: 'Clearing the building at the end of the day.' },
];

const SETTINGS = [
  // ── General ────────────────────────────────────────────────────────────────
  {
    key: 'org_name', group: 'general', type: 'text', default: 'VisiSign Demo Co.',
    label: 'Organisation name', branding: true, max: 80,
    help: 'Shown in the kiosk header and on printed badges.',
  },
  {
    key: 'kiosk_welcome_title', group: 'general', type: 'text', default: 'Welcome',
    label: 'Kiosk heading', branding: true, max: 80,
    help: 'The large greeting on the kiosk home screen.',
  },
  {
    key: 'kiosk_welcome_text', group: 'general', type: 'text', default: 'Please sign in for your visit.',
    label: 'Kiosk subheading', branding: true, max: 160,
  },
  {
    key: 'require_host', group: 'general', type: 'bool', default: 'true',
    label: 'Require a host name', help: 'Visitors must say who they are visiting.',
  },

  // ── Appearance ─────────────────────────────────────────────────────────────
  {
    key: 'theme_default', group: 'appearance', type: 'select', default: 'system',
    label: 'Default theme', branding: true,
    options: [
      { value: 'system', label: 'Follow the device' },
      { value: 'light', label: 'Always light' },
      { value: 'dark', label: 'Always dark' },
    ],
  },
  {
    key: 'brand_logo', group: 'appearance', type: 'image', default: '',
    label: 'Logo', branding: true,
    help: 'Replaces the "VS" mark everywhere. PNG or SVG, up to 256 KB. Leave empty to use the text mark below.',
  },
  {
    key: 'brand_mark_text', group: 'appearance', type: 'text', default: 'VS',
    label: 'Text mark', branding: true, max: 4,
    help: 'Used when no logo is set. Two or three characters work best.',
  },
  {
    key: 'color_brand', group: 'appearance', type: 'color', default: '#2563eb',
    label: 'Brand / buttons', branding: true,
  },
  {
    key: 'color_brand_600', group: 'appearance', type: 'color', default: '#1d4ed8',
    label: 'Brand (pressed)', branding: true,
  },
  {
    key: 'color_brand_contrast', group: 'appearance', type: 'color', default: '#ffffff',
    label: 'Text on brand', branding: true,
  },
  {
    key: 'color_bg', group: 'appearance', type: 'color', default: '#f4f6fb',
    label: 'Page background', branding: true,
  },
  {
    key: 'color_surface', group: 'appearance', type: 'color', default: '#ffffff',
    label: 'Card background', branding: true,
  },
  {
    key: 'color_text', group: 'appearance', type: 'color', default: '#0f172a',
    label: 'Text', branding: true,
  },
  {
    key: 'color_text_muted', group: 'appearance', type: 'color', default: '#5b6577',
    label: 'Muted text', branding: true,
  },
  {
    key: 'color_border', group: 'appearance', type: 'color', default: '#e2e8f0',
    label: 'Borders', branding: true,
  },
  {
    key: 'color_ok', group: 'appearance', type: 'color', default: '#16a34a',
    label: 'Success', branding: true,
  },
  {
    key: 'color_warn', group: 'appearance', type: 'color', default: '#d97706',
    label: 'Warning', branding: true,
  },
  {
    key: 'color_danger', group: 'appearance', type: 'color', default: '#dc2626',
    label: 'Danger', branding: true,
  },
  {
    key: 'ui_radius', group: 'appearance', type: 'number', default: '14',
    label: 'Corner rounding (px)', branding: true, min: 0, max: 40,
  },

  // ── Ticker ─────────────────────────────────────────────────────────────────
  {
    key: 'ticker_enabled', group: 'ticker', type: 'bool', default: 'false',
    label: 'Show the ticker', branding: true,
    help: 'A scrolling message bar fixed to the bottom of the kiosk and reservations pages.',
  },
  {
    key: 'ticker_text', group: 'ticker', type: 'textarea', default: 'Welcome to our offices · Please sign in at the kiosk · Visitors must be accompanied at all times',
    label: 'Message', branding: true, max: 2000,
    help: 'Separate items with " · ". The text loops continuously.',
  },
  {
    key: 'ticker_speed', group: 'ticker', type: 'number', default: '60',
    label: 'Seconds per loop', branding: true, min: 5, max: 600,
    help: 'Higher is slower. 60 suits a sentence or two.',
  },
  {
    key: 'ticker_bg', group: 'ticker', type: 'color', default: '#0f172a',
    label: 'Ticker background', branding: true,
  },
  {
    key: 'ticker_color', group: 'ticker', type: 'color', default: '#ffffff',
    label: 'Ticker text', branding: true,
  },

  // ── Terms & signature ──────────────────────────────────────────────────────
  {
    key: 'tos_enabled', group: 'terms', type: 'bool', default: 'false',
    label: 'Require visitors to accept terms', branding: true,
    help: 'Shown as a step during sign-in. Nobody is signed in until they accept.',
  },
  {
    key: 'tos_require_signature', group: 'terms', type: 'bool', default: 'true',
    label: 'Require a drawn signature', branding: true,
    help: 'Visitors sign with a finger or stylus. Turn off to accept with a tick box alone.',
  },
  {
    key: 'tos_title', group: 'terms', type: 'text', default: 'Terms and conditions', branding: true, max: 120,
    label: 'Heading',
  },
  {
    key: 'tos_version', group: 'terms', type: 'text', default: '1.0', branding: true, max: 20,
    label: 'Version',
    help: 'Recorded with every signature. Raise it whenever you change the text below, so old signatures stay attributable to the text that was actually agreed to.',
  },
  {
    key: 'tos_text', group: 'terms', type: 'textarea', default:
      'By signing in you agree to follow site safety rules, to wear your visitor badge at all times, '
      + 'and to be accompanied by your host in restricted areas. Personal data collected during sign-in '
      + 'is kept for security and safety purposes only.',
    label: 'Terms text', branding: true, max: 20000,
    help: 'Plain text. Visitors scroll this before signing.',
  },

  // ── Reservations ───────────────────────────────────────────────────────────
  { key: 'open_time', group: 'reservations', type: 'text', default: '09:00', label: 'First bookable slot', pattern: '^\\d{2}:\\d{2}$', help: '24-hour, e.g. 09:00' },
  { key: 'close_time', group: 'reservations', type: 'text', default: '17:00', label: 'Last bookable slot', pattern: '^\\d{2}:\\d{2}$', help: '24-hour, e.g. 17:00' },
  { key: 'slot_minutes', group: 'reservations', type: 'number', default: '30', label: 'Slot length (minutes)', min: 5, max: 240 },

  // ── Kiosk ──────────────────────────────────────────────────────────────────
  {
    key: 'kiosk_require_approval', group: 'kiosk', type: 'bool', default: 'true',
    label: 'New devices need approval',
    help: 'A device that opens the kiosk page waits until an administrator accepts it. Leave this on.',
  },

  // ── Printing (defaults; each kiosk can override) ───────────────────────────
  {
    key: 'badge_print_mode', group: 'printing', type: 'select', default: 'server',
    label: 'Where badges print',
    options: [
      { value: 'server', label: 'A real printer (this PC, or the print agent)' },
      { value: 'device', label: "From the tablet — AirPrint (iPad) / Mopria (Android)" },
      { value: 'off', label: "Don't print badges" },
    ],
  },
  { key: 'badge_printer', group: 'printing', type: 'text', default: '', label: 'Default printer', help: 'The default for kiosks that do not name their own.' },
  { key: 'badge_width_mm', group: 'printing', type: 'number', default: '62', label: 'Label width (mm)', min: 10, max: 300 },
  { key: 'badge_height_mm', group: 'printing', type: 'number', default: '90', label: 'Label height (mm)', min: 10, max: 300 },
  { key: 'badge_autoprint', group: 'printing', type: 'bool', default: 'false', label: 'Print automatically on sign-in' },

  // ── Auto sign-out ──────────────────────────────────────────────────────────
  { key: 'auto_signout_enabled', group: 'signout', type: 'bool', default: 'true', label: 'Sign everyone out at the end of the day' },
  {
    key: 'auto_signout_time', group: 'signout', type: 'text', default: '17:00', label: 'Cutoff time',
    pattern: '^\\d{2}:\\d{2}$',
    help: '24-hour, in the site timezone set by VISISIGN_TZ on the server.',
  },
];

// Settings written by the system rather than a person. They are never shown in
// the admin UI and never travel in a .vsf file.
const INTERNAL = new Set([
  'auto_signout_last_run',
  'agent_printers',
  'agent_last_seen',
  'agent_id',
]);

const byKey = new Map(SETTINGS.map((s) => [s.key, s]));

/** Every default, as the flat key/value map the settings table stores. */
function defaults() {
  const out = {};
  for (const s of SETTINGS) out[s.key] = s.default;
  return out;
}

/** The keys a .vsf customisation file carries. */
function brandingKeys() {
  return SETTINGS.filter((s) => s.branding).map((s) => s.key);
}

const get = (key) => byKey.get(key) || null;
const isInternal = (key) => INTERNAL.has(key);

module.exports = { GROUPS, SETTINGS, defaults, brandingKeys, get, isInternal, byKey };
