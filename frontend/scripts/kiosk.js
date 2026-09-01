/* kiosk.js — on-site KIOSK controller + hash router (served at /kiosk).
   This page shows visitors ONLY: guest sign-in and self sign-out.
   Admin lives on a separate page (admin.html). All data goes through
   window.api (the secure REST layer). */

(function () {
  'use strict';

  const { render, esc, showError, toastOk, renderQR, loader, empty } = window.ui;

  // Kiosk settings from the server (loaded once the device is approved):
  //   photo     — capture a visitor photo and print it on the badge
  //   printMode — 'server' (Windows printer on the VisiSign PC),
  //               'device' (AirPrint on iPad / Mopria on Android), or 'off'
  //   label     — label size in mm, used for the device print page size
  let kioskCfg = { photo: false, printMode: 'server', label: { widthMm: 62, heightMm: 90 } };

  // ───────────────────────────────────────────────────────────── Home
  function homePage() {
    render(`
      <section class="stack">
        <div class="center" style="margin-bottom:6px">
          <h1>Welcome to VisiSign</h1>
          <p class="muted">Please sign in for your visit.</p>
        </div>
        <div class="tiles">
          <button class="tile" data-go="#/guest">
            <div class="emoji">🧑‍💼</div>
            <h3>Sign in</h3>
            <p>New visitor? Sign in here — it's quick and easy.</p>
          </button>
          <button class="tile" data-go="#/reservations">
            <div class="emoji">🎫</div>
            <h3>I have a reservation</h3>
            <p>Pre-checked in? See today's reservations and check in.</p>
          </button>
          <button class="tile" data-go="#/signout">
            <div class="emoji">👋</div>
            <h3>Sign out</h3>
            <p>Leaving? Sign out with your badge code.</p>
          </button>
        </div>
      </section>
    `, (root) => {
      root.querySelectorAll('[data-go]').forEach((b) =>
        b.addEventListener('click', () => (location.hash = b.dataset.go)));
    });
  }

  // ─────────────────────────────────────────────── Reservations (walk-up check-in)
  async function reservationsPage() {
    render(loader('Loading today\'s reservations…'));
    try {
      const list = await window.api.reservations.current();
      const rows = list.length ? list.map((r) => `
        <tr class="${r.isNow ? 'row-now' : ''}">
          <td><strong>${esc(r.slot)}</strong>${r.isNow ? ' <span class="pill in">now</span>' : ''}</td>
          <td>${esc(r.name)}</td>
          <td>${esc(r.company || '—')}</td>
          <td>${esc(r.host || '—')}</td>
          <td><button class="btn btn-primary" data-checkin="${esc(r.id)}">Check in</button></td>
        </tr>`).join('') : '';

      render(`
        <section class="stack">
          <div class="row">
            <div><h1>Today's reservations</h1>
            <p class="muted">Find your name and tap <strong>Check in</strong>.</p></div>
            <div class="spacer"></div>
            <button class="btn" id="refresh">↻ Refresh</button>
            <button class="btn btn-ghost" data-go="#/">Back</button>
          </div>
          <div class="card">
            ${list.length ? `<div class="table-wrap"><table>
              <thead><tr><th>Time</th><th>Name</th><th>Company</th><th>Host</th><th></th></tr></thead>
              <tbody>${rows}</tbody></table></div>`
              : empty('No reservations for today. If you have a booking for another day, please sign in as a walk-in guest.')}
          </div>
          <p class="center muted">Don't see your reservation? <a href="#/guest">Sign in as a guest →</a></p>
        </section>
      `, (root) => {
        root.querySelector('#refresh').addEventListener('click', reservationsPage);
        root.querySelector('[data-go]').addEventListener('click', () => (location.hash = '#/'));
        root.querySelectorAll('[data-checkin]').forEach((b) =>
          b.addEventListener('click', async () => {
            b.disabled = true; b.textContent = 'Checking in…';
            try {
              const res = await window.api.reservations.checkIn(b.dataset.checkin);
              showBadge(res, { name: res.name });
            } catch (err) {
              showError(err); b.disabled = false; b.textContent = 'Check in';
            }
          }));
      });
    } catch (err) { showError(err); render(empty('Could not load reservations.')); }
  }

  // ─────────────────────────────────────────── Photo capture (for the badge)
  // Uses the live camera when the browser allows it (needs a secure context), and
  // otherwise falls back to the device's native camera via a file input — which
  // works on iPad/Android over plain HTTP.
  let capturedPhoto = null;

  function toJpeg(source, w, h) {
    const max = 480;
    const scale = Math.min(1, max / Math.max(w || 1, h || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((w || max) * scale));
    c.height = Math.max(1, Math.round((h || max) * scale));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  }
  function shrinkDataUrl(dataUrl, cb) {
    const img = new Image();
    img.onload = () => cb(toJpeg(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  const photoFieldHtml = () => `
    <div class="field">
      <label>Photo for your badge *</label>
      <div class="photo-box" id="photoBox">
        <video id="camVideo" playsinline autoplay muted></video>
        <img id="photoThumb" class="shot" alt="Captured photo" />
        <div class="row" style="margin-top:8px">
          <button type="button" class="btn" id="camShot">📷 Take photo</button>
          <button type="button" class="btn btn-ghost" id="camRetake" style="display:none">Retake</button>
        </div>
        <input type="file" id="camFile" accept="image/*" capture="user" style="display:none" />
        <div class="muted" id="camNote" style="font-size:.8rem;margin-top:4px"></div>
      </div>
    </div>`;

  async function initCamera(root) {
    capturedPhoto = null;
    const video = root.querySelector('#camVideo');
    const thumb = root.querySelector('#photoThumb');
    const shot = root.querySelector('#camShot');
    const retake = root.querySelector('#camRetake');
    const file = root.querySelector('#camFile');
    const note = root.querySelector('#camNote');
    let stream = null;

    const canLive = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

    async function startLive() {
      if (!canLive) { note.textContent = 'Tap “Take photo” to use this device’s camera.'; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false });
        video.srcObject = stream;
        video.style.display = 'block';
        note.textContent = '';
      } catch (_) {
        note.textContent = 'Camera blocked — tap “Take photo” to use this device’s camera app.';
      }
    }
    function stopLive() {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      video.style.display = 'none';
    }
    function setPhoto(dataUrl) {
      capturedPhoto = dataUrl;
      thumb.src = dataUrl;
      thumb.style.display = 'block';
      stopLive();
      shot.style.display = 'none';
      retake.style.display = '';
      note.textContent = '';
    }

    shot.addEventListener('click', () => {
      if (stream && video.videoWidth) setPhoto(toJpeg(video, video.videoWidth, video.videoHeight));
      else file.click(); // native camera (no HTTPS needed)
    });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => shrinkDataUrl(String(fr.result), setPhoto);
      fr.readAsDataURL(f);
    });
    retake.addEventListener('click', async () => {
      capturedPhoto = null;
      thumb.style.display = 'none';
      shot.style.display = '';
      retake.style.display = 'none';
      file.value = '';
      await startLive();
    });

    await startLive();
  }

  // ───────────────────────────────────────────────────────────── Guest sign-in
  function guestPage() {
    const wantPhoto = !!(kioskCfg && kioskCfg.photo);
    render(`
      <section class="card" style="max-width:560px;margin:0 auto">
        <h2>Guest sign-in</h2>
        <p class="card-lead">Welcome! Tell us a little about your visit.</p>
        <form id="guestForm" class="stack" novalidate>
          <div class="field">
            <label for="g_name">Your full name *</label>
            <input class="input" id="g_name" name="fullName" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="g_company">Company</label>
            <input class="input" id="g_company" name="company" autocomplete="organization" />
          </div>
          <div class="field">
            <label for="g_host">Who are you visiting? (Host)</label>
            <input class="input" id="g_host" name="host" />
          </div>
          <div class="field">
            <label for="g_reason">Reason for visit</label>
            <textarea class="textarea" id="g_reason" name="reason" placeholder="Meeting, delivery, interview…"></textarea>
          </div>
          ${wantPhoto ? photoFieldHtml() : ''}
          <button class="btn btn-primary btn-xl btn-block" type="submit">Sign in</button>
        </form>
      </section>
    `, (root) => {
      if (wantPhoto) initCamera(root);
      root.querySelector('#guestForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const payload = {
          fullName: f.fullName.value.trim(),
          company: f.company.value.trim(),
          host: f.host.value.trim(),
          reason: f.reason.value.trim(),
          photoUrl: capturedPhoto || undefined,
        };
        if (!payload.fullName) return showError({ message: 'Please enter your name.' });
        if (wantPhoto && !capturedPhoto) return showError({ message: 'Please take a photo for your badge.' });
        const btn = f.querySelector('button[type="submit"]');
        btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          const res = await window.api.visits.guestSignIn(payload);
          showBadge(res, { name: payload.fullName, company: payload.company, host: payload.host });
        } catch (err) {
          showError(err);
          btn.disabled = false; btn.textContent = 'Sign in';
        }
      });
    });
  }

  // Build a QR image (data URL) for the printable badge.
  function qrDataUrl(text) {
    if (!window.qrcode) return '';
    try {
      const q = window.qrcode(0, 'M');
      q.addData(String(text));
      q.make();
      return q.createDataURL(6, 8);
    } catch (_) { return ''; }
  }

  // Print from THIS device using its own print system:
  // iPad → AirPrint, Android → Mopria / the built-in print service.
  function devicePrint(b) {
    const L = (kioskCfg && kioskCfg.label) || { widthMm: 62, heightMm: 90 };
    let st = document.getElementById('printPageStyle');
    if (!st) { st = document.createElement('style'); st.id = 'printPageStyle'; document.head.appendChild(st); }
    st.textContent = `@page { size: ${L.widthMm}mm ${L.heightMm}mm; margin: 3mm; }`;

    document.getElementById('printArea').innerHTML = `
      ${b.photo ? `<img class="pb-photo" src="${b.photo}" alt="" />` : ''}
      <div class="pb-title">VISITOR</div>
      <div class="pb-name">${esc(b.name || '')}</div>
      ${b.company ? `<div class="pb-sub">${esc(b.company)}</div>` : ''}
      ${b.host ? `<div class="pb-sub">Host: ${esc(b.host)}</div>` : ''}
      <div class="pb-sub">${esc(b.date || '')}</div>
      ${b.qr ? `<img class="pb-qr" src="${b.qr}" alt="" />` : ''}
      <div class="pb-code">${esc(b.code || '')}</div>`;
    window.print();
  }

  function showBadge(res, info) {
    info = info || {};
    const name = info.name || res.name || '';
    const mode = (kioskCfg && kioskCfg.printMode) || 'server';
    const photo = capturedPhoto; // present when this device just took one
    render(`
      <section class="card badge-card" style="max-width:480px;margin:0 auto">
        <div class="emoji" style="font-size:2.4rem">✅</div>
        <h2>You're signed in${name ? ', ' + esc(name.split(' ')[0]) : ''}!</h2>
        <p class="muted">Show this badge if asked. Keep the code to sign out.</p>
        ${photo ? `<img src="${photo}" alt="" style="width:110px;border-radius:10px;border:1px solid var(--border)" />` : ''}
        <div class="qr" id="qr"></div>
        <div class="badge-code">${esc(res.badge.code)}</div>
        <p class="muted">Visit ID: <span class="kbd">${esc(res.visitId)}</span></p>
        <div class="row" style="justify-content:center;margin-top:14px">
          ${mode === 'off' ? '' : '<button class="btn" id="printBadge">🖨️ Print badge</button>'}
          <button class="btn btn-primary" data-go="#/">Done</button>
        </div>
      </section>
    `, (root) => {
      const payload = JSON.stringify({ visit: res.visitId, code: res.badge.code });
      renderQR(root.querySelector('#qr'), payload);
      root.querySelector('[data-go]').addEventListener('click', () => {
        capturedPhoto = null;
        location.hash = '#/';
      });

      const btn = root.querySelector('#printBadge');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        if (mode === 'device') {
          // Hand off to the tablet's own printing (AirPrint / Mopria).
          devicePrint({
            name, company: info.company, host: info.host,
            date: new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
            code: res.badge.code, qr: qrDataUrl(payload), photo,
          });
          return;
        }
        btn.disabled = true; btn.textContent = 'Printing…';
        try { await window.api.print.badge(res.visitId); toastOk('Badge sent to the printer.'); }
        catch (err) { showError(err); }
        finally { btn.disabled = false; btn.textContent = '🖨️ Print badge'; }
      });
    });
  }

  // ───────────────────────────────────────────────────────── Self sign-out
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return isNaN(d) ? iso : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  async function signOutPage() {
    render(loader('Loading…'));
    let list;
    try {
      list = await window.api.visits.onsite();
    } catch (err) {
      showError(err);
      return render(empty('Could not load the list. Please ask reception.'));
    }

    if (!list.length) {
      return render(`
        <section class="card" style="max-width:480px;margin:0 auto">
          <h2>Sign out</h2>
          <div class="empty">No one is currently signed in.</div>
          <button class="btn btn-block" data-go="#/">Back</button>
        </section>
      `, (root) => root.querySelector('[data-go]').addEventListener('click', () => (location.hash = '#/')));
    }

    const rowsHtml = (items) => items.map((v) => `
      <button class="pick" data-id="${esc(v.visitId)}"
              data-search="${esc(((v.name || '') + ' ' + (v.company || '')).toLowerCase())}">
        <span class="pick-name">${esc(v.name || 'Guest')}</span>
        <span class="pick-sub">${esc(v.company || '')}${v.company ? ' · ' : ''}in since ${esc(fmtTime(v.since))}</span>
      </button>`).join('');

    render(`
      <section class="card" style="max-width:540px;margin:0 auto">
        <h2>Sign out</h2>
        <p class="card-lead">Tap your name to sign out.</p>
        <input class="input" id="soSearch" placeholder="Search your name…" autocomplete="off"
               autocapitalize="none" style="margin-bottom:12px" />
        <div class="picklist" id="soList">${rowsHtml(list)}</div>
        <div class="empty" id="soNone" style="display:none">No matching name.</div>
        <button class="btn btn-ghost btn-block" data-go="#/" style="margin-top:12px">Cancel</button>
      </section>
    `, (root) => {
      const listEl = root.querySelector('#soList');
      const noneEl = root.querySelector('#soNone');

      root.querySelector('#soSearch').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        let shown = 0;
        listEl.querySelectorAll('.pick').forEach((b) => {
          const match = !q || b.dataset.search.includes(q);
          b.style.display = match ? '' : 'none';
          if (match) shown++;
        });
        noneEl.style.display = shown ? 'none' : '';
      });

      root.querySelector('[data-go]').addEventListener('click', () => (location.hash = '#/'));

      listEl.querySelectorAll('.pick').forEach((b) =>
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await window.api.visits.signOut(b.dataset.id);
            toastOk('Signed out. Thanks for visiting!');
            location.hash = '#/';
          } catch (err) {
            showError(err);
            b.disabled = false;
          }
        }));
    });
  }

  // ───────────────────────────────────────────────────────────── Router
  const routes = {
    '': homePage, '/': homePage,
    '/guest': guestPage,
    '/reservations': reservationsPage,
    '/signout': signOutPage,
  };

  function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    (routes[hash] || routes['/'])();
    // Active link highlight.
    document.querySelectorAll('.topnav a').forEach((a) =>
      a.classList.toggle('active', a.getAttribute('href') === (location.hash || '#/')));
  }

  // ─────────────────────────────────────────────── Kiosk pairing / approval gate
  const DEVICE_KEY = 'visisign.kiosk.device';

  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID()
        : 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  let kioskStarted = false;
  async function startKiosk() {
    if (kioskStarted) return;
    kioskStarted = true;
    // Load kiosk settings (photo capture on/off, print mode, label size) before
    // rendering, so the sign-in form knows whether to ask for a photo.
    try { kioskCfg = await window.api.kiosk.config(); } catch (_) { /* keep defaults */ }
    const nav = document.getElementById('topnav');
    if (nav) nav.style.visibility = '';
    window.addEventListener('hashchange', route);
    route();
  }

  let pollTimer = null;
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function showWaiting(code) {
    stopPolling();
    render(`
      <section class="card center" style="max-width:480px;margin:0 auto">
        <div class="emoji" style="font-size:2.6rem">🖥️</div>
        <h2>Waiting for approval</h2>
        <p class="muted">This device needs to be accepted as a kiosk by an administrator.</p>
        <p class="muted" style="margin-bottom:4px">On the VisiSign command console, run:</p>
        <div class="badge-code">/kiosk accept ${esc(code)}</div>
        <p class="muted">This device's code is <strong>${esc(code)}</strong>.</p>
        <p class="muted" id="waitStatus" style="font-size:.85rem">Checking every few seconds…</p>
      </section>
    `);
    pollTimer = setInterval(pollStatus, 3000);
  }

  function showRemoved(code) {
    stopPolling();
    render(`
      <section class="card center" style="max-width:480px;margin:0 auto">
        <div class="emoji" style="font-size:2.6rem">🚫</div>
        <h2>Kiosk access removed</h2>
        <p class="muted">An administrator revoked this device (code <strong>${esc(code || '')}</strong>).</p>
        <button class="btn btn-primary" id="reRequest">Request access again</button>
      </section>
    `, (root) => {
      root.querySelector('#reRequest').addEventListener('click', registerDevice);
    });
  }

  function applyKioskState(res) {
    if (!res) return;
    if (res.status === 'accepted') { stopPolling(); startKiosk(); }
    else if (res.status === 'revoked' || res.status === 'rejected') showRemoved(res.code);
    else showWaiting(res.code); // pending / unknown
  }

  async function pollStatus() {
    try {
      const res = await window.api.kiosk.status(deviceId());
      if (res.status === 'unknown') return registerDevice(); // server lost us — re-register
      applyKioskState(res);
    } catch (_) { /* keep waiting; transient */ }
  }

  async function registerDevice() {
    try {
      const res = await window.api.kiosk.register(deviceId(), navigator.platform || 'Kiosk');
      applyKioskState(res);
    } catch (err) {
      render(`<section class="card center" style="max-width:480px;margin:0 auto">
        <h2>Can't reach the server</h2><p class="muted">${esc(err.message || 'Network error')}</p>
        <button class="btn btn-primary" id="retry">Retry</button></section>`,
        (root) => root.querySelector('#retry').addEventListener('click', registerDevice));
    }
  }

  // ───────────────────────────────────────────────────────────── Boot
  function boot() {
    window.store.applyTheme();
    document.getElementById('themeToggle').addEventListener('click', () => {
      const t = window.store.cycleTheme();
      window.ui.toast(`Theme: ${t}`, 'info', 1500);
    });
    // Hide the kiosk nav until this device is approved.
    const nav = document.getElementById('topnav');
    if (nav) nav.style.visibility = 'hidden';
    registerDevice();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
