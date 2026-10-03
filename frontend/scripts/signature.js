/* signature.js — the drawing pad visitors sign on.

   Built on pointer events, so one code path covers finger, stylus and mouse.
   Points stream straight to the canvas as they arrive; nothing is buffered, so
   the line keeps up with a fast signature on a tablet.

   Two things worth knowing:

   * The canvas is sized in DEVICE pixels and scaled back down with CSS, so a
     signature is crisp on a Retina iPad rather than a blurry upscale.

   * The exported PNG is TRIMMED to the ink and re-rendered on white. A raw
     canvas export is mostly empty transparent pixels, which prints as a grey
     box on a label printer and wastes space in the database.  */

(function () {
  'use strict';

  function createSignaturePad(container, { onChange } = {}) {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    let drawing = false;
    let hasInk = false;
    let last = null;

    // Track the ink's bounding box as we draw, so trimming later is free.
    let bounds = null;

    function noteBounds(x, y) {
      if (!bounds) bounds = { minX: x, maxX: x, minY: y, maxY: y };
      else {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }

    /** Match the backing store to the element's real pixel size. */
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rect = container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      // Resizing clears the canvas, so keep what is already drawn.
      const prev = hasInk ? canvas.toDataURL('image/png') : null;

      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Read the ink colour from the theme so it works in dark mode too.
      ctx.strokeStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--text').trim() || '#111';

      if (prev) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
        img.src = prev;
      }
    }

    const posOf = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function start(e) {
      // Ignore secondary mouse buttons; a right-click should not draw.
      if (e.button !== undefined && e.button !== 0) return;
      drawing = true;
      last = posOf(e);
      noteBounds(last.x, last.y);
      // Keep receiving moves even if the finger leaves the canvas.
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not captured */ }
      // A single tap should still leave a visible dot.
      ctx.beginPath();
      ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      markInk();
      e.preventDefault();
    }

    function move(e) {
      if (!drawing) return;
      const p = posOf(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      noteBounds(p.x, p.y);
      last = p;
      e.preventDefault();
    }

    function end(e) {
      if (!drawing) return;
      drawing = false;
      last = null;
      if (e) e.preventDefault();
    }

    function markInk() {
      if (hasInk) return;
      hasInk = true;
      container.classList.add('signed');
      if (onChange) onChange(true);
    }

    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);

    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    // The pad is often created inside a freshly rendered view, so wait a frame
    // for layout before measuring it.
    requestAnimationFrame(resize);

    return {
      canvas,

      isEmpty: () => !hasInk,

      clear() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasInk = false;
        bounds = null;
        container.classList.remove('signed');
        if (onChange) onChange(false);
      },

      /**
       * The signature as a PNG data URL: cropped to the ink, with a small
       * margin, flattened onto white so it prints correctly.
       * Returns null when nothing has been drawn.
       */
      toDataURL() {
        if (!hasInk || !bounds) return null;

        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const pad = 8;
        const sx = Math.max(0, (bounds.minX - pad) * dpr);
        const sy = Math.max(0, (bounds.minY - pad) * dpr);
        const sw = Math.min(canvas.width - sx, (bounds.maxX - bounds.minX + pad * 2) * dpr);
        const sh = Math.min(canvas.height - sy, (bounds.maxY - bounds.minY + pad * 2) * dpr);
        if (sw <= 0 || sh <= 0) return canvas.toDataURL('image/png');

        const out = document.createElement('canvas');
        out.width = Math.round(sw);
        out.height = Math.round(sh);
        const octx = out.getContext('2d');
        // White, not transparent: a label printer renders transparency as grey.
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, out.width, out.height);
        octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      },

      destroy() {
        window.removeEventListener('resize', onResize);
      },
    };
  }

  window.createSignaturePad = createSignaturePad;
})();
