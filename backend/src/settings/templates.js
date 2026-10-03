'use strict';

// Ready-made colour schemes.
//
// Picking one in Admin → Appearance writes these values into the normal colour
// settings — it is a starting point, not a mode, so every colour stays editable
// afterwards and nothing is locked.
//
// Each palette sets the same keys the Appearance group exposes, so adding a
// template here needs no other change anywhere.
//
// Contrast: every palette keeps body text at roughly 7:1 or better against its
// background and ≥4.5:1 for muted text, so a kiosk stays readable under
// reception lighting and for visitors who do not see colour well. If you add
// one, check it the same way.

const TEMPLATES = [
  {
    key: 'default',
    name: 'VisiSign Blue',
    description: 'The standard look — confident blue on a cool grey page.',
    colors: {
      color_brand: '#2563eb',
      color_brand_600: '#1d4ed8',
      color_brand_contrast: '#ffffff',
      color_bg: '#f4f6fb',
      color_surface: '#ffffff',
      color_text: '#0f172a',
      color_text_muted: '#5b6577',
      color_border: '#e2e8f0',
      color_ok: '#16a34a',
      color_warn: '#d97706',
      color_danger: '#dc2626',
      ticker_bg: '#0f172a',
      ticker_color: '#ffffff',
    },
  },
  {
    key: 'graphite',
    name: 'Graphite',
    description: 'Dark, understated and glare-free — good for a dim lobby.',
    colors: {
      color_brand: '#6366f1',
      color_brand_600: '#4f46e5',
      color_brand_contrast: '#ffffff',
      color_bg: '#0b1020',
      color_surface: '#151c30',
      color_text: '#e8edf7',
      color_text_muted: '#9aa6be',
      color_border: '#283355',
      color_ok: '#34d399',
      color_warn: '#fbbf24',
      color_danger: '#f87171',
      ticker_bg: '#6366f1',
      ticker_color: '#ffffff',
    },
  },
  {
    key: 'forest',
    name: 'Forest',
    description: 'Calm green. Suits healthcare, education and civic sites.',
    colors: {
      color_brand: '#059669',
      color_brand_600: '#047857',
      color_brand_contrast: '#ffffff',
      color_bg: '#f2f8f5',
      color_surface: '#ffffff',
      color_text: '#0f2a22',
      color_text_muted: '#4f6b61',
      color_border: '#d5e6de',
      color_ok: '#059669',
      color_warn: '#d97706',
      color_danger: '#dc2626',
      ticker_bg: '#064e3b',
      ticker_color: '#ffffff',
    },
  },
  {
    key: 'crimson',
    name: 'Crimson',
    description: 'Warm red with high contrast. Reads well from across a lobby.',
    colors: {
      color_brand: '#dc2626',
      color_brand_600: '#b91c1c',
      color_brand_contrast: '#ffffff',
      color_bg: '#fdf5f5',
      color_surface: '#ffffff',
      color_text: '#1f1416',
      color_text_muted: '#6b5456',
      color_border: '#f0dcdc',
      color_ok: '#16a34a',
      color_warn: '#d97706',
      color_danger: '#b91c1c',
      ticker_bg: '#7f1d1d',
      ticker_color: '#ffffff',
    },
  },
  {
    key: 'slate',
    name: 'Slate',
    description: 'Neutral and corporate. Lets a coloured logo do the talking.',
    colors: {
      color_brand: '#475569',
      color_brand_600: '#334155',
      color_brand_contrast: '#ffffff',
      color_bg: '#f6f7f9',
      color_surface: '#ffffff',
      color_text: '#111827',
      color_text_muted: '#5b6472',
      color_border: '#e3e7ed',
      color_ok: '#16a34a',
      color_warn: '#d97706',
      color_danger: '#dc2626',
      ticker_bg: '#334155',
      ticker_color: '#ffffff',
    },
  },
  {
    key: 'violet',
    name: 'Violet',
    description: 'Modern purple with a soft page. Popular with studios and tech.',
    colors: {
      color_brand: '#7c3aed',
      color_brand_600: '#6d28d9',
      color_brand_contrast: '#ffffff',
      color_bg: '#f8f6fd',
      color_surface: '#ffffff',
      color_text: '#1b1430',
      color_text_muted: '#5f5577',
      color_border: '#e7e0f5',
      color_ok: '#16a34a',
      color_warn: '#d97706',
      color_danger: '#dc2626',
      ticker_bg: '#4c1d95',
      ticker_color: '#ffffff',
    },
  },
  {
    key: 'highcontrast',
    name: 'High contrast',
    description: 'Maximum legibility — large contrast ratios for accessibility.',
    colors: {
      color_brand: '#0b5fff',
      color_brand_600: '#0040cc',
      color_brand_contrast: '#ffffff',
      color_bg: '#ffffff',
      color_surface: '#ffffff',
      color_text: '#000000',
      color_text_muted: '#3a3a3a',
      color_border: '#767676',
      color_ok: '#006b2d',
      color_warn: '#8a5300',
      color_danger: '#b3001b',
      ticker_bg: '#000000',
      ticker_color: '#ffffff',
    },
  },
];

const byKey = new Map(TEMPLATES.map((t) => [t.key, t]));

/** Templates without their colour payloads, for listing in the UI. */
const list = () => TEMPLATES.map(({ key, name, description, colors }) => ({
  key, name, description,
  // A few swatches so the UI can preview a palette without applying it.
  preview: [colors.color_brand, colors.color_bg, colors.color_surface, colors.color_text],
}));

const get = (key) => byKey.get(key) || null;

module.exports = { TEMPLATES, list, get };
