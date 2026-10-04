/* admin.js — the ADMIN console (separate page: admin.html).
   Login + overview, live list, searchable records, user management, settings and
   CSV export. All data goes through window.api (the secure REST layer). */

(function () {
  'use strict';

  const { render, esc, loader, empty, toastOk, showError, modal, closeModal,
          fmtDateTime, statusPill, typePill } = window.ui;

  // ───────────────────────────────────────────────────────────── Login
  function loginPage() {
    render(`
      <section class="card" style="max-width:420px;margin:0 auto">
        <h2>Admin sign-in</h2>
        <p class="card-lead">Administrators only.</p>
        <form id="loginForm" class="stack">
          <div class="field"><label for="l_user">Username</label>
            <input class="input" id="l_user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required /></div>
          <div class="field"><label for="l_pass">Password</label>
            <input class="input" id="l_pass" type="password" autocomplete="current-password" required /></div>
          <button class="btn btn-primary btn-xl btn-block" type="submit">Sign in</button>
        </form>
      </section>
    `, (root) => {
      root.querySelector('#loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = root.querySelector('#l_user').value.trim();
        const pass = root.querySelector('#l_pass').value;
        const btn = e.target.querySelector('button');
        btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          const user = await window.api.auth.login(username, pass);
          if (user.role !== 'admin') {
            await window.api.auth.logout();
            throw { message: 'This account is not an administrator.' };
          }
          window.store.user = user;
          syncChrome();
          toastOk(`Welcome back, ${user.fullName.split(' ')[0]}.`);
          location.hash = '#/overview';
          route();
        } catch (err) {
          showError(err);
          btn.disabled = false; btn.textContent = 'Sign in';
        }
      });
    });
  }

  // ───────────────────────────────────────────────────────────── Dashboard shell
  function dashboard() {
    const tab = (location.hash.replace(/^#\//, '') || 'overview');
    const tabs = [
      ['overview', 'Overview'], ['live', 'Live'], ['reservations', 'Reservations'],
      ['records', 'Records'], ['users', 'Users'], ['kiosks', 'Kiosks'], ['settings', 'Settings'],
    ];
    const tabBar = `<div class="tabs">${tabs.map(([k, label]) =>
      `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>`;

    render(`<section class="stack"><div class="row"><h1>Admin</h1><div class="spacer"></div>
      <button class="btn" id="exportBtn">⤓ Export CSV</button></div>${tabBar}
      <div id="adminBody">${loader()}</div></section>`, (root) => {
      root.querySelectorAll('[data-tab]').forEach((b) =>
        b.addEventListener('click', () => (location.hash = `#/${b.dataset.tab}`)));
      root.querySelector('#exportBtn').addEventListener('click', exportCsv);
      const body = root.querySelector('#adminBody');
      // Settings and Kiosks live in admin-settings.js — the Settings panel is
      // built from the schema the server sends, so new settings need no UI work.
      const panels = {
        overview, live, reservations, records, users,
        settings: window.adminPanels.renderSettings,
        kiosks: window.adminPanels.renderKiosks,
      };
      (panels[tab] || overview)(body);
    });
  }

  function localDate() {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function reservations(body) {
    const render1 = (date) => {
      body.innerHTML = `
        <div class="card">
          <div class="row">
            <label class="muted" style="font-weight:600">Date</label>
            <input class="input" id="resDate" type="date" value="${date}" style="max-width:200px" />
          </div>
          <div id="resList" style="margin-top:16px">${loader()}</div>
        </div>`;
      body.querySelector('#resDate').addEventListener('change', (e) => render1(e.target.value));
      loadList(date);
    };
    const loadList = async (date) => {
      const el = body.querySelector('#resList');
      el.innerHTML = loader();
      try {
        const rows = await window.api.reservations.adminList(date);
        if (!rows.length) { el.innerHTML = empty('No reservations for this date.'); return; }
        el.innerHTML = `<div class="table-wrap"><table>
          <thead><tr><th>Time</th><th>Name</th><th>Company</th><th>Host</th>
            <th>Contact</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><strong>${esc(r.time_slot)}</strong></td>
            <td>${esc(r.full_name)}</td>
            <td>${esc(r.company || '—')}</td>
            <td>${esc(r.host_name || '—')}</td>
            <td>${esc(r.email || r.phone || '—')}</td>
            <td>${resStatus(r.status)}</td>
            <td>${r.status === 'reserved'
              ? `<button class="btn btn-ghost" data-cancel="${esc(r.public_id)}">Cancel</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`;
        el.querySelectorAll('[data-cancel]').forEach((b) =>
          b.addEventListener('click', async () => {
            if (!confirm('Cancel this reservation?')) return;
            try { await window.api.reservations.cancel(b.dataset.cancel); toastOk('Reservation cancelled.'); loadList(date); }
            catch (err) { showError(err); }
          }));
      } catch (err) { showError(err); el.innerHTML = empty(); }
    };
    render1(localDate());
  }

  function resStatus(s) {
    if (s === 'checked_in') return '<span class="pill in">Checked in</span>';
    if (s === 'cancelled') return '<span class="pill out">Cancelled</span>';
    return '<span class="pill guest">Reserved</span>';
  }

  async function overview(body) {
    try {
      const [o, alerts] = await Promise.all([window.api.admin.overview(), window.api.admin.alerts()]);
      body.innerHTML = `
        <div class="grid cols-3">
          <div class="stat"><div class="num">${o.guests_onsite}</div><div class="label">Guests on site</div></div>
          <div class="stat"><div class="num">${o.visits_today}</div><div class="label">Visits today</div></div>
          <div class="stat"><div class="num">${o.open_alerts}</div><div class="label">Open alerts</div></div>
        </div>
        <div class="card" style="margin-top:18px">
          <h2>Alerts</h2>
          ${alerts.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Level</th><th class="wrap">Message</th><th>Raised</th><th></th></tr></thead>
            <tbody>${alerts.map((a) => `<tr>
              <td>${esc(a.level)}</td><td class="wrap">${esc(a.message)}</td>
              <td>${fmtDateTime(a.created_at)}</td>
              <td><button class="btn btn-ghost" data-resolve="${a.id}">Resolve</button></td>
            </tr>`).join('')}</tbody></table></div>` : empty('No open alerts. All clear.')}
        </div>`;
      body.querySelectorAll('[data-resolve]').forEach((b) =>
        b.addEventListener('click', async () => {
          try { await window.api.admin.resolveAlert(b.dataset.resolve); toastOk('Alert resolved.'); overview(body); }
          catch (err) { showError(err); }
        }));
    } catch (err) { showError(err); body.innerHTML = empty('Could not load overview.'); }
  }

  async function live(body) {
    body.innerHTML = loader('Loading live list…');
    try {
      const rows = await window.api.visits.live();
      body.innerHTML = renderVisitTable(rows, true);
      wireSignOut(body);
    } catch (err) { showError(err); body.innerHTML = empty(); }
  }

  async function records(body) {
    body.innerHTML = `
      <div class="card">
        <div class="row">
          <input class="input" id="q" placeholder="Search name, company, host, reason…" style="max-width:340px" />
          <button class="btn btn-primary" id="searchBtn">Search</button>
        </div>
        <div id="results" style="margin-top:16px">${loader()}</div>
      </div>`;
    const run = async () => {
      const results = body.querySelector('#results');
      results.innerHTML = loader();
      try {
        const rows = await window.api.visits.search({ q: body.querySelector('#q').value.trim() });
        results.innerHTML = renderVisitTable(rows, true);
        wireSignOut(results);
      } catch (err) { showError(err); results.innerHTML = empty(); }
    };
    body.querySelector('#searchBtn').addEventListener('click', run);
    body.querySelector('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    run();
  }

  function renderVisitTable(rows, withActions) {
    if (!rows || !rows.length) return empty('No visits found.');
    return `<div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>Name</th><th>Company / Host</th><th>Site</th>
        <th>Signed in</th><th>Signed out</th><th>Status</th>${withActions ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map((v) => `<tr>
        <td>${typePill(v.type)}</td>
        <td>${esc(v.guest_name || v.staff_name || '—')}</td>
        <td>${esc(v.guest_company || v.host_name || '—')}</td>
        <td>${esc(v.site_name || '—')}</td>
        <td>${fmtDateTime(v.signed_in_at)}</td>
        <td>${fmtDateTime(v.signed_out_at)}</td>
        <td>${statusPill(v.status)}</td>
        ${withActions ? `<td>${v.status === 'signed_in'
          ? `<button class="btn btn-ghost" data-signout="${esc(v.public_id)}">Sign out</button>` : ''}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>`;
  }

  function wireSignOut(scope) {
    scope.querySelectorAll('[data-signout]').forEach((b) =>
      b.addEventListener('click', async () => {
        try { await window.api.visits.signOut(b.dataset.signout); toastOk('Signed out.'); route(); }
        catch (err) { showError(err); }
      }));
  }

  async function users(body) {
    body.innerHTML = loader('Loading users…');
    try {
      const list = await window.api.admin.users();
      body.innerHTML = `
        <div class="row" style="margin-bottom:14px">
          <h2 style="margin:0">Administrators</h2><div class="spacer"></div>
          <button class="btn btn-primary" id="newUser">+ New admin</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Level</th><th>Active</th><th></th></tr></thead>
          <tbody>${list.map((u) => `<tr>
            <td>${esc(u.full_name)}</td><td>${esc(u.email)}</td>
            <td>${esc(u.role)}</td><td>${u.access_level}</td>
            <td>${u.is_active ? 'Yes' : 'No'}</td>
            <td><button class="btn btn-ghost" data-del="${esc(u.public_id)}">Delete</button></td>
          </tr>`).join('')}</tbody></table></div>`;
      body.querySelector('#newUser').addEventListener('click', () => newUserModal(body));
      body.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this user?')) return;
          try { await window.api.admin.deleteUser(b.dataset.del); toastOk('User deleted.'); users(body); }
          catch (err) { showError(err); }
        }));
    } catch (err) { showError(err); body.innerHTML = empty(); }
  }

  function newUserModal(body) {
    modal(`
      <h2>New admin</h2>
      <form id="nuForm" class="stack">
        <div class="field"><label>Full name</label><input class="input" name="fullName" required></div>
        <div class="field"><label>Username</label>
          <input class="input" name="username" type="text" autocapitalize="none" spellcheck="false" required></div>
        <div class="field"><label>Password</label><input class="input" name="password" type="text" required></div>
        <div class="row"><button class="btn btn-primary" type="submit">Create</button>
          <button class="btn btn-ghost" type="button" id="cancel">Cancel</button></div>
      </form>`, (bd) => {
      bd.querySelector('#cancel').addEventListener('click', closeModal);
      bd.querySelector('#nuForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        try {
          await window.api.admin.createUser({
            fullName: f.fullName.value.trim(), username: f.username.value.trim(),
            password: f.password.value, role: 'admin',
          });
          toastOk('Admin created.'); closeModal(); users(body);
        } catch (err) { showError(err); }
      });
    });
  }

  // ───────────────────────────────────────────────────────── Export
  async function exportCsv() {
    try {
      const csv = await window.api.admin.exportCsv();
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'visisign-visits.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toastOk('Export downloaded.');
    } catch (err) { showError(err); }
  }

  // ───────────────────────────────────────────────────────────── Chrome / router
  function syncChrome() {
    const user = window.store.user;
    const session = document.getElementById('session');
    if (user) {
      session.innerHTML = `${esc(user.fullName)} · <a href="#" id="logout">Sign out</a>`;
      session.querySelector('#logout').addEventListener('click', async (e) => {
        e.preventDefault();
        await window.api.auth.logout();
        window.store.clear(); syncChrome(); toastOk('Signed out.'); route();
      });
    } else {
      session.innerHTML = '';
    }
  }

  function route() {
    syncChrome();
    if (!window.store.isRole('admin')) return loginPage();
    dashboard();
  }

  // ───────────────────────────────────────────────────────────── Boot
  async function boot() {
    window.store.applyTheme();
    document.getElementById('themeToggle').addEventListener('click', () => {
      const t = window.store.cycleTheme();
      window.ui.toast(`Theme: ${t}`, 'info', 1500);
    });
    await window.store.refreshSession();
    window.addEventListener('hashchange', () => { if (window.store.isRole('admin')) dashboard(); });
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
