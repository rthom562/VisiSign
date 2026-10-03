'use strict';

// Settings: reading, validating, and moving them between installs as .vsf files.
//
// Every setting is declared once in ../settings/schema.js. This service is the
// only thing that writes to the settings table, so a value that reaches the
// database has been checked against its declared type, range and options. That
// matters because these values are rendered straight into the kiosk UI — a
// colour setting that is not actually a colour would otherwise become a CSS
// injection point.

const crypto = require('crypto');
const repo = require('../repositories/repo');
const schema = require('../settings/schema');
const templates = require('../settings/templates');
const { ApiError } = require('../utils/http');

// A logo is inlined as a data URL so a .vsf file is self-contained — one file
// carries the whole look, with no second asset to lose. 256 KB is generous for
// a logo and small enough to sit in a settings row.
const MAX_LOGO_BYTES = 256 * 1024;
const LOGO_RE = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** The current value of every setting, with declared defaults filled in. */
async function all() {
  const rows = await repo.settings.all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...schema.defaults(), ...stored };
}

/** One value, falling back to its declared default. */
async function value(key) {
  const row = await repo.settings.get(key);
  if (row) return row.value;
  const def = schema.get(key);
  return def ? def.default : undefined;
}

/**
 * Validate one setting against its declaration.
 * Returns the normalised string to store, or throws ApiError.
 */
function validate(key, raw) {
  const def = schema.get(key);

  // Unknown keys are rejected rather than stored. Without this, a typo silently
  // creates a dead setting that looks real in the database forever.
  if (!def) {
    if (schema.isInternal(key)) return String(raw);
    throw new ApiError(400, `Unknown setting "${key}"`, 'unknown_setting');
  }

  const v = raw === null || raw === undefined ? '' : String(raw);

  switch (def.type) {
    case 'bool':
      if (!['true', 'false'].includes(v)) {
        throw new ApiError(400, `"${def.label}" must be true or false`, 'validation');
      }
      return v;

    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ApiError(400, `"${def.label}" must be a number`, 'validation');
      if (def.min !== undefined && n < def.min) {
        throw new ApiError(400, `"${def.label}" must be at least ${def.min}`, 'validation');
      }
      if (def.max !== undefined && n > def.max) {
        throw new ApiError(400, `"${def.label}" must be at most ${def.max}`, 'validation');
      }
      return String(n);
    }

    case 'color':
      if (!COLOR_RE.test(v)) {
        throw new ApiError(400, `"${def.label}" must be a colour like #2563eb`, 'validation');
      }
      return v.toLowerCase();

    case 'select':
      if (!def.options.some((o) => o.value === v)) {
        throw new ApiError(400, `"${def.label}" must be one of: ${def.options.map((o) => o.value).join(', ')}`, 'validation');
      }
      return v;

    case 'image': {
      if (v === '') return ''; // clearing the logo
      const m = LOGO_RE.exec(v);
      if (!m) {
        throw new ApiError(400, `"${def.label}" must be a PNG, JPEG, GIF, WebP or SVG image`, 'validation');
      }
      const bytes = Buffer.from(m[2], 'base64').length;
      if (bytes > MAX_LOGO_BYTES) {
        throw new ApiError(
          400,
          `"${def.label}" is ${Math.round(bytes / 1024)} KB — the limit is ${MAX_LOGO_BYTES / 1024} KB. Try a smaller image.`,
          'validation'
        );
      }
      return v;
    }

    case 'text':
    case 'textarea':
    default:
      if (def.max && v.length > def.max) {
        throw new ApiError(400, `"${def.label}" is too long (max ${def.max} characters)`, 'validation');
      }
      if (def.pattern && v !== '' && !new RegExp(def.pattern).test(v)) {
        throw new ApiError(400, `"${def.label}" is not in the expected format`, 'validation');
      }
      return v;
  }
}

/** Write a batch of settings, validating every one BEFORE writing any. */
async function update(patch) {
  const entries = Object.entries(patch || {});
  if (!entries.length) return all();

  // Validate everything first, so a bad value in the middle of a form cannot
  // leave half the settings applied.
  const checked = entries.map(([k, v]) => [k, validate(k, v)]);

  for (const [k, v] of checked) await repo.settings.set(k, v);
  return all();
}

/** The schema plus current values, shaped for the admin UI. */
async function describe() {
  const values = await all();
  const groups = schema.GROUPS.map((g) => ({
    ...g,
    settings: schema.SETTINGS
      .filter((s) => s.group === g.key)
      .map((s) => ({ ...s, value: values[s.key] ?? s.default })),
  })).filter((g) => g.settings.length);

  return { groups, templates: templates.list(), values };
}

/** Apply a colour template by key. Returns the settings it wrote. */
async function applyTemplate(key) {
  const t = templates.get(String(key || ''));
  if (!t) throw new ApiError(404, `No such template "${key}"`, 'not_found');
  await update(t.colors);
  return { applied: t.key, name: t.name, colors: t.colors };
}

// ── .vsf customisation files ─────────────────────────────────────────────────
// A .vsf ("VisiSign customisation") file is JSON: the look and wording of an
// install, in one portable file. It deliberately carries ONLY branding settings
// — not printer names, approval rules or cutoff times, which belong to a
// specific building and would be wrong to copy onto another one.

const VSF_FORMAT = 'visisign/customisation';
const VSF_VERSION = 1;

/** Build a .vsf bundle from the current settings. */
async function exportVsf(meta = {}) {
  const values = await all();
  const settings = {};
  for (const key of schema.brandingKeys()) settings[key] = values[key];

  return {
    format: VSF_FORMAT,
    version: VSF_VERSION,
    name: String(meta.name || values.org_name || 'VisiSign customisation').slice(0, 120),
    exportedAt: new Date().toISOString(),
    appVersion: require('../../package.json').version,
    settings,
  };
}

/**
 * Apply a .vsf bundle.
 *
 * Unknown or non-branding keys are reported and skipped rather than failing the
 * whole import — a file from a newer VisiSign should still apply the parts this
 * version understands, instead of being rejected outright.
 */
async function importVsf(bundle, { dryRun = false } = {}) {
  if (!bundle || typeof bundle !== 'object') {
    throw new ApiError(400, 'That file is not a VisiSign customisation file.', 'bad_vsf');
  }
  if (bundle.format !== VSF_FORMAT) {
    throw new ApiError(
      400,
      'That file is not a VisiSign customisation (.vsf) file.',
      'bad_vsf'
    );
  }
  if (Number(bundle.version) > VSF_VERSION) {
    throw new ApiError(
      400,
      `That file was made by a newer version of VisiSign (format ${bundle.version}, this install understands ${VSF_VERSION}).`,
      'bad_vsf'
    );
  }
  if (!bundle.settings || typeof bundle.settings !== 'object') {
    throw new ApiError(400, 'That customisation file has no settings in it.', 'bad_vsf');
  }

  const allowed = new Set(schema.brandingKeys());
  const toApply = {};
  const skipped = [];
  const problems = [];

  for (const [key, raw] of Object.entries(bundle.settings)) {
    if (!allowed.has(key)) {
      skipped.push({ key, reason: 'not a branding setting in this version' });
      continue;
    }
    try {
      toApply[key] = validate(key, raw);
    } catch (err) {
      problems.push({ key, reason: err.message });
    }
  }

  if (!Object.keys(toApply).length) {
    throw new ApiError(
      400,
      problems.length
        ? `Nothing could be applied: ${problems[0].reason}`
        : 'That customisation file had nothing this version of VisiSign can apply.',
      'bad_vsf'
    );
  }

  if (!dryRun) {
    for (const [k, v] of Object.entries(toApply)) await repo.settings.set(k, v);
  }

  return {
    name: bundle.name || null,
    applied: Object.keys(toApply),
    appliedCount: Object.keys(toApply).length,
    skipped,
    problems,
    dryRun,
  };
}

// ── Public branding ──────────────────────────────────────────────────────────
// What every page needs BEFORE anyone logs in: colours, logo, wording, the
// ticker, and whether terms must be signed. Served unauthenticated, so it must
// contain nothing sensitive — only things a visitor standing at the kiosk can
// already see.

async function branding() {
  const s = await all();
  return {
    orgName: s.org_name,
    welcome: { title: s.kiosk_welcome_title, text: s.kiosk_welcome_text },
    logo: s.brand_logo || null,
    markText: s.brand_mark_text || 'VS',
    theme: s.theme_default || 'system',
    radius: Number(s.ui_radius) || 14,
    colors: {
      brand: s.color_brand,
      brand600: s.color_brand_600,
      brandContrast: s.color_brand_contrast,
      bg: s.color_bg,
      surface: s.color_surface,
      text: s.color_text,
      textMuted: s.color_text_muted,
      border: s.color_border,
      ok: s.color_ok,
      warn: s.color_warn,
      danger: s.color_danger,
    },
    ticker: {
      enabled: s.ticker_enabled === 'true',
      text: s.ticker_text || '',
      speed: Number(s.ticker_speed) || 60,
      bg: s.ticker_bg,
      color: s.ticker_color,
    },
    terms: {
      enabled: s.tos_enabled === 'true',
      requireSignature: s.tos_require_signature === 'true',
      title: s.tos_title,
      version: s.tos_version,
      text: s.tos_text,
    },
    requireHost: s.require_host === 'true',
  };
}

/** SHA-256 of the exact terms text, recorded with each signature. */
const hashTerms = (text) => crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');

module.exports = {
  all, value, update, validate, describe,
  applyTemplate,
  exportVsf, importVsf,
  branding, hashTerms,
  VSF_FORMAT, VSF_VERSION,
};
