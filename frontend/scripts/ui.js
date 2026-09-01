/* ui.js — render helpers: DOM building, escaping, toasts, modals, formatting.
   Keeps app.js focused on page logic. */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = () => document.getElementById('view');

  // Safe text escaping for any value we drop into innerHTML.
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Render HTML into the main view and run an optional setup callback.
  function render(html, setup) {
    view().innerHTML = html;
    window.scrollTo(0, 0);
    if (typeof setup === 'function') setup(view());
  }

  function loader(msg = 'Loading…') {
    return `<div class="loader">${esc(msg)}</div>`;
  }
  function empty(msg = 'Nothing here yet.') {
    return `<div class="empty">${esc(msg)}</div>`;
  }

  // ── Toasts ─────────────────────────────────────────────────────────────────
  function toast(message, kind = 'info', ms = 3500) {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 250);
    }, ms);
  }
  const toastOk = (m) => toast(m, 'ok');
  const toastErr = (m) => toast(m, 'error', 5000);

  // Turn any thrown error into a friendly toast.
  function showError(err) {
    const msg = err && err.message ? err.message : 'Something went wrong';
    toastErr(msg);
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function modal(innerHtml, setup) {
    close();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'modalBackdrop';
    backdrop.innerHTML = `<div class="card modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
    if (typeof setup === 'function') setup(backdrop);

    function close() {
      const ex = document.getElementById('modalBackdrop');
      if (ex) ex.remove();
    }
    return close;
  }
  function closeModal() {
    const ex = document.getElementById('modalBackdrop');
    if (ex) ex.remove();
  }

  // ── Formatting ─────────────────────────────────────────────────────────────
  function fmtDateTime(iso) {
    if (!iso) return '—';
    // SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC.
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtHours(h) {
    if (h === null || h === undefined) return '—';
    return `${Number(h).toFixed(2)} h`;
  }
  function statusPill(status) {
    return status === 'signed_in'
      ? '<span class="pill in">On site</span>'
      : '<span class="pill out">Signed out</span>';
  }
  function typePill(type) {
    return type === 'guest'
      ? '<span class="pill guest">Guest</span>'
      : '<span class="pill staff">Staff</span>';
  }

  // Render a real, scannable QR code into an element using the locally bundled
  // qrcode-generator library (works offline inside the packaged .exe). Falls
  // back to plain text only if the library somehow failed to load.
  function renderQR(el, text, sizePx = 190) {
    try {
      if (!window.qrcode) { el.textContent = text; return; }
      const qr = window.qrcode(0, 'M'); // type 0 = auto-size, 'M' error correction
      qr.addData(String(text));
      qr.make();
      el.innerHTML = qr.createImgTag(6, 8); // cell size, margin
      const img = el.querySelector('img');
      if (img) {
        img.alt = 'QR code';
        img.setAttribute('style', `width:${sizePx}px;height:${sizePx}px;image-rendering:pixelated`);
      }
    } catch (_) {
      el.textContent = text;
    }
  }

  window.ui = {
    $, view, esc, render, loader, empty,
    toast, toastOk, toastErr, showError,
    modal, closeModal,
    fmtDateTime, fmtHours, statusPill, typePill, renderQR,
  };
})();
