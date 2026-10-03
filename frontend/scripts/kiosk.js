/* kiosk.js — on-site KIOSK controller + hash router (served at /kiosk).
   This page shows visitors ONLY: guest sign-in and self sign-out.
   Admin lives on a separate page (admin.html). All data goes through
   window.api (the secure REST layer). */

(function () {
  'use strict';

  const { render, esc, showError, toastOk, renderQR, loader, empty } = window.ui;

  // Kiosk settings from the server, fetched once this device is approved.
  // They are resolved FOR THIS KIOSK: a site can run several kiosks, each with
  // its own printer and label size, so these are not necessarily the
  // organisation defaults.
  //   printMode — 'server' (a real printer, via this PC or the print agent),
  //               'device' (AirPrint on iPad / Mopria on Android), or 'off'
  //   label     — label size in mm, used for the device print page size
  let kioskCfg = { printMode: 'server', label: { widthMm: 62, heightMm: 90 }, kiosk: null };

  // Branding (colours, wording, terms) from the PUBLIC /api/branding endpoint.
  const brand = () => window.branding || {};
  const terms = () => brand().terms || { enabled: false };

  // ───────────────────────────────────────────────────────────── Home
  function homePage() {
    render(`
      <section class="stack">
        <div class="center" style="margin-bottom:6px">
          <h1>${esc((brand().welcome && brand().welcome.title) || 'Welcome')}</h1>
          <p class="muted">${esc((brand().welcome && brand().welcome.text) || 'Please sign in for your visit.')}</p>
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

  // ───────────────────────────────────────────────────────────── Guest sign-in
  function guestPage() {
    const requireHost = brand().requireHost === true;
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
            <label for="g_host">Who are you visiting? (Host)${requireHost ? ' *' : ''}</label>
            <input class="input" id="g_host" name="host" ${requireHost ? 'required' : ''} />
          </div>
          <div class="field">
            <label for="g_reason">Reason for visit</label>
            <textarea class="textarea" id="g_reason" name="reason" placeholder="Meeting, delivery, interview…"></textarea>
          </div>
          <button class="btn btn-primary btn-xl btn-block" type="submit">
            ${terms().enabled ? 'Continue' : 'Sign in'}
          </button>
        </form>
      </section>
    `, (root) => {
      root.querySelector('#guestForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.target;
        const payload = {
          fullName: f.fullName.value.trim(),
          company: f.company.value.trim(),
          host: f.host.value.trim(),
          reason: f.reason.value.trim(),
        };
        if (!payload.fullName) return showError({ message: 'Please enter your name.' });
        if (requireHost && !payload.host) return showError({ message: 'Please tell us who you are visiting.' });

        // When terms are in force the visitor reads and signs them before the
        // sign-in is submitted at all.
        if (terms().enabled) return termsPage(payload);
        submitSignIn(payload, f.querySelector('button[type="submit"]'));
      });
    });
  }

  // ─────────────────────────────────────────────── Terms & signature
  // Shown between the details form and the actual sign-in when an administrator
  // has switched terms on. The server enforces this too — the step here is for
  // the visitor's benefit, not a security control.
  function termsPage(payload) {
    const t = terms();
    const needSig = t.requireSignature !== false;
    let pad = null;

    render(`
      <section class="card" style="max-width:620px;margin:0 auto">
        <h2>${esc(t.title || 'Terms and conditions')}</h2>
        <p class="card-lead">Please read the following, then ${needSig ? 'sign below' : 'confirm'} to finish signing in.</p>

        <div class="tos-text" id="tosText" tabindex="0" role="region"
             aria-label="${esc(t.title || 'Terms and conditions')}">${esc(t.text || '')}</div>

        ${t.version ? `<p class="muted" style="font-size:.78rem;margin-top:6px">Version ${esc(t.version)}</p>` : ''}

        <label class="row" style="gap:10px;cursor:pointer;margin-top:14px;align-items:flex-start">
          <input type="checkbox" id="tosAgree" style="margin-top:3px" />
          <span>I have read and agree to the terms above.</span>
        </label>

        ${needSig ? `
          <div class="field" style="margin-top:14px">
            <label>Your signature *</label>
            <div class="sig-pad" id="sigPad">
              <div class="sig-hint">Sign here with your finger or a stylus</div>
            </div>
            <div class="row" style="margin-top:8px">
              <button type="button" class="btn btn-ghost" id="sigClear">Clear</button>
            </div>
          </div>` : ''}

        <div class="row" style="margin-top:16px">
          <button class="btn btn-ghost" id="tosBack">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary btn-xl" id="tosSubmit" disabled>Agree &amp; sign in</button>
        </div>
      </section>
    `, (root) => {
      const agree = root.querySelector('#tosAgree');
      const submit = root.querySelector('#tosSubmit');

      if (needSig) {
        pad = window.createSignaturePad(root.querySelector('#sigPad'), { onChange: refresh });
        root.querySelector('#sigClear').addEventListener('click', () => { pad.clear(); refresh(); });
      }

      function refresh() {
        submit.disabled = !agree.checked || (needSig && (!pad || pad.isEmpty()));
      }
      agree.addEventListener('change', refresh);
      refresh();

      root.querySelector('#tosBack').addEventListener('click', () => {
        if (pad) pad.destroy();
        guestPage();
      });

      submit.addEventListener('click', () => {
        const signature = needSig && pad ? pad.toDataURL() : undefined;
        if (needSig && !signature) return showError({ message: 'Please sign in the box above.' });
        if (pad) pad.destroy();
        submitSignIn({ ...payload, acceptedTerms: true, signature }, submit);
      });
    });
  }

  // The one place a sign-in is actually submitted.
  async function submitSignIn(payload, btn) {
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    try {
      const res = await window.api.visits.guestSignIn({ ...payload, kioskId: deviceId() });
      showBadge(res, { name: payload.fullName, company: payload.company, host: payload.host });
    } catch (err) {
      showError(err);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
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
    render(`
      <section class="card badge-card" style="max-width:480px;margin:0 auto">
        <div class="emoji" style="font-size:2.4rem">✅</div>
        <h2>You're signed in${name ? ', ' + esc(name.split(' ')[0]) : ''}!</h2>
        <p class="muted">Show this badge if asked. Keep the code to sign out.</p>
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
            code: res.badge.code, qr: qrDataUrl(payload),
          });
          return;
        }
        btn.disabled = true; btn.textContent = 'Printing…';
        try {
          // Pass this kiosk's id so the badge prints on THIS desk's printer.
          const out = await window.api.print.badge(res.visitId, deviceId());
          toastOk(out && out.printed === false
            ? 'Badge queued for the reception printer.'
            : 'Badge sent to the printer.');
        }
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
    // Load THIS kiosk's settings (its printer, label size and print mode) and
    // the organisation's branding before rendering, so the first screen is
    // already correct rather than flashing defaults.
    try { kioskCfg = await window.api.kiosk.config(deviceId()); } catch (_) { /* keep defaults */ }
    try { await window.visiBranding.load(); } catch (_) { /* cached branding stands */ }
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
    // Paint the cached look immediately, then refresh it from the server.
    window.visiBranding.load();
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
