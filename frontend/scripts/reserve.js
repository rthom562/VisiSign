/* reserve.js — MOBILE pre-check-in. A visitor picks a date + time slot, fills
   the form, and reserves ahead of arriving. On success they get a QR pass they
   can show at reception. All data goes through window.api (the REST layer). */

(function () {
  'use strict';

  const { render, esc, showError } = window.ui;

  // Local YYYY-MM-DD for the date input min + default.
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function page() {
    const today = todayStr();
    render(`
      <section class="card" style="max-width:520px;margin:0 auto">
        <h2>Reserve your visit</h2>
        <p class="card-lead">Book a date and time, fill in your details, and skip the
          queue — just show your pass when you arrive.</p>
        <form id="resForm" class="stack" novalidate>
          <div class="grid cols-2">
            <div class="field">
              <label for="r_date">Date *</label>
              <input class="input" id="r_date" type="date" min="${today}" value="${today}" required />
            </div>
            <div class="field">
              <label for="r_slot">Time slot *</label>
              <select class="select" id="r_slot" required><option value="">Loading…</option></select>
            </div>
          </div>
          <div class="field">
            <label for="r_name">Your full name *</label>
            <input class="input" id="r_name" name="fullName" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="r_company">Company</label>
            <input class="input" id="r_company" name="company" autocomplete="organization" />
          </div>
          <div class="field">
            <label for="r_host">Who are you visiting? (Host)</label>
            <input class="input" id="r_host" name="host" />
          </div>
          <div class="grid cols-2">
            <div class="field">
              <label for="r_email">Email</label>
              <input class="input" id="r_email" type="email" autocomplete="email" />
            </div>
            <div class="field">
              <label for="r_phone">Phone</label>
              <input class="input" id="r_phone" type="tel" autocomplete="tel" />
            </div>
          </div>
          <div class="field">
            <label for="r_reason">Reason for visit</label>
            <textarea class="textarea" id="r_reason" name="reason" placeholder="Meeting, delivery, interview…"></textarea>
          </div>
          <button class="btn btn-primary btn-xl btn-block" type="submit">Reserve my visit</button>
          <p class="center muted" style="font-size:.85rem;margin:4px 0 0">
            Already here? Just use the reception iPad to sign in.
          </p>
        </form>
      </section>
    `, (root) => {
      const dateEl = root.querySelector('#r_date');
      loadSlots(root, dateEl.value);
      dateEl.addEventListener('change', () => loadSlots(root, dateEl.value));
      root.querySelector('#resForm').addEventListener('submit', (e) => submit(e, root));
    });
  }

  async function loadSlots(root, date) {
    const sel = root.querySelector('#r_slot');
    sel.innerHTML = '<option value="">Loading…</option>';
    try {
      const { slots } = await window.api.reservations.slots(date);
      const opts = slots.map((s) => `<option value="${esc(s.slot)}">${esc(s.label)}</option>`).join('');
      sel.innerHTML = `<option value="">Select a time…</option>${opts}`;
    } catch (err) {
      sel.innerHTML = '<option value="">Could not load slots</option>';
      showError(err);
    }
  }

  async function submit(e, root) {
    e.preventDefault();
    const val = (id) => root.querySelector(id).value.trim();
    const payload = {
      fullName: val('#r_name'),
      date: val('#r_date'),
      slot: val('#r_slot'),
      company: val('#r_company'),
      host: val('#r_host'),
      email: val('#r_email'),
      phone: val('#r_phone'),
      reason: val('#r_reason'),
    };
    if (!payload.fullName) return showError({ message: 'Please enter your name.' });
    if (!payload.slot) return showError({ message: 'Please choose a time slot.' });

    const btn = root.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Reserving…';
    try {
      const res = await window.api.reservations.create(payload);
      confirmed(res);
    } catch (err) {
      showError(err);
      btn.disabled = false; btn.textContent = 'Reserve & pre-check-in';
    }
  }

  function confirmed(res) {
    const first = res.name ? esc(res.name.split(' ')[0]) : '';
    render(`
      <section class="card" style="max-width:480px;margin:0 auto">
        <div class="center">
          <div class="emoji" style="font-size:2.6rem">✅</div>
          <h2>You're booked${first ? ', ' + first : ''}!</h2>
          <p class="muted">${esc(res.date)} at ${esc(res.slot)}</p>
        </div>

        <hr class="sep" />

        <h3 style="margin-top:0">How to check in when you arrive</h3>
        <ol class="steps">
          <li>Go to the <strong>reception iPad</strong>.</li>
          <li>Tap <strong>“I have a reservation.”</strong></li>
          <li>Find your name — <strong>${esc(res.name || '')}</strong> — in today's list.</li>
          <li>Tap <strong>“Check in”</strong> to get your badge. That's it!</li>
        </ol>

        <p class="muted" style="font-size:.85rem">
          No need to show anything — you're already in the system. If you don't see your
          name, just ask reception or sign in as a walk-in guest.
        </p>
        <p class="muted" style="font-size:.8rem">Reference: <span class="kbd">${esc(res.reservationId)}</span></p>

        <a class="btn btn-ghost btn-block" href="index.html" style="margin-top:8px">Book another visit</a>
      </section>
    `);
  }

  function boot() {
    window.store.applyTheme();
    document.getElementById('themeToggle').addEventListener('click', () => {
      const t = window.store.cycleTheme();
      window.ui.toast(`Theme: ${t}`, 'info', 1500);
    });
    page();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
