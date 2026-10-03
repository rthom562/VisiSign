/* branding.js — applies the organisation's look to the page.

   Colours, logo, wording and the ticker all live in settings on the server and
   are served by the PUBLIC /api/branding endpoint, because the kiosk needs them
   and the kiosk never logs in.

   How it is applied:
     * colours become CSS custom properties on <html>, overriding the defaults
       in base.css. Everything already reads those variables, so one assignment
       re-skins the whole app with no per-component work.
     * the logo replaces the "VS" text mark in the header.
     * the ticker is appended to <body> and scrolls continuously.

   Two details that matter:
     * Values are SANITISED here as well as on the server. The server validates
       on write, but this is the last line before text becomes CSS, and a colour
       that is not a colour would otherwise be an injection point.
     * Branding is cached in localStorage and applied SYNCHRONOUSLY on the next
       load, so a kiosk does not flash default blue before the real colours
       arrive. The cache is refreshed from the network every time.  */

(function () {
  'use strict';

  const CACHE_KEY = 'visisign.branding';

  // Only ever write a value through one of these.
  const isColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  const isDataImage = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v);

  // Maps branding.colors -> the CSS custom properties base.css already uses.
  const COLOR_VARS = {
    brand: '--brand',
    brand600: '--brand-600',
    brandContrast: '--brand-contrast',
    bg: '--bg',
    surface: '--surface',
    text: '--text',
    textMuted: '--text-muted',
    border: '--border',
    ok: '--ok',
    warn: '--warn',
    danger: '--danger',
  };

  function applyColors(colors) {
    if (!colors) return;
    const root = document.documentElement;
    for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
      const value = colors[key];
      if (isColor(value)) root.style.setProperty(cssVar, value);
    }
    // A readable surface-2 is derived rather than configured: one more colour
    // for an administrator to get wrong, for very little gain.
    if (isColor(colors.surface) && isColor(colors.bg)) {
      root.style.setProperty('--surface-2', colors.bg);
    }
  }

  function applyRadius(radius) {
    const n = Number(radius);
    if (!Number.isFinite(n) || n < 0 || n > 40) return;
    const root = document.documentElement;
    root.style.setProperty('--radius', `${n}px`);
    root.style.setProperty('--radius-sm', `${Math.max(0, Math.round(n * 0.64))}px`);
  }

  /** Swap the "VS" text mark for the organisation's logo. */
  function applyLogo(b) {
    document.querySelectorAll('.brand-mark').forEach((el) => {
      if (isDataImage(b.logo)) {
        el.innerHTML = '';
        el.classList.add('has-logo');
        const img = document.createElement('img');
        img.src = b.logo;
        img.alt = b.orgName || 'Logo';
        el.appendChild(img);
      } else {
        el.classList.remove('has-logo');
        // textContent, never innerHTML — this is operator-supplied text.
        el.textContent = (b.markText || 'VS').slice(0, 4);
      }
    });

    // The wordmark next to the logo follows the organisation name.
    if (b.orgName) {
      document.querySelectorAll('.brand-name').forEach((el) => {
        const suffix = el.querySelector('.brand-suffix');
        el.textContent = b.orgName;
        if (suffix) el.appendChild(suffix); // keep the "Admin" tag
      });
      document.title = document.title.replace(/^VisiSign/, b.orgName);
    }
  }

  /**
   * Build the scrolling ticker along the bottom of the page.
   *
   * The text is duplicated so the loop has no visible gap when it wraps, and
   * the whole thing is hidden from screen readers: it repeats forever, which is
   * worse than useless when read aloud. The same text is exposed once, static,
   * for assistive technology.
   */
  function applyTicker(t) {
    const existing = document.getElementById('vsTicker');
    if (existing) existing.remove();
    document.body.classList.remove('has-ticker');

    if (!t || !t.enabled || !String(t.text || '').trim()) return;

    const bar = document.createElement('div');
    bar.id = 'vsTicker';
    bar.className = 'ticker';
    if (isColor(t.bg)) bar.style.background = t.bg;
    if (isColor(t.color)) bar.style.color = t.color;

    const speed = Math.min(600, Math.max(5, Number(t.speed) || 60));

    const track = document.createElement('div');
    track.className = 'ticker-track';
    track.setAttribute('aria-hidden', 'true');
    track.style.animationDuration = `${speed}s`;

    // Two copies back to back make the wrap seamless.
    for (let i = 0; i < 2; i++) {
      const span = document.createElement('span');
      span.className = 'ticker-item';
      span.textContent = t.text; // operator text — never parsed as HTML
      track.appendChild(span);
    }

    // The accessible copy: present once, not animated, not repeated.
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = t.text;

    bar.appendChild(track);
    bar.appendChild(sr);
    document.body.appendChild(bar);
    document.body.classList.add('has-ticker');
  }

  function apply(b) {
    if (!b) return;
    applyColors(b.colors);
    applyRadius(b.radius);
    applyLogo(b);
    applyTicker(b.ticker);
    window.branding = b;
    document.dispatchEvent(new CustomEvent('branding', { detail: b }));
  }

  /** Apply the last known branding immediately, to avoid a flash of defaults. */
  function applyCached() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) apply(JSON.parse(raw));
    } catch (_) {
      /* a corrupt cache is not worth reporting; the network copy follows */
    }
  }

  /** Fetch the live branding and apply it. */
  async function load() {
    try {
      const b = await window.api.branding();
      apply(b);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(b)); } catch (_) { /* private mode */ }
      return b;
    } catch (_) {
      // Offline or server down: whatever was cached is already on screen.
      return window.branding || null;
    }
  }

  window.visiBranding = { apply, applyCached, load, CACHE_KEY };

  // Paint the cached look as early as possible.
  applyCached();
})();
