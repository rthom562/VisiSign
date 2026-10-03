'use strict';

// End-to-end smoke test. Drives the REAL HTTP API the same way the kiosk,
// reservations page and admin console do, so it proves the whole stack works
// against WHICHEVER database backend is configured (sqlite or postgres).
//
//   node test/smoke.js [baseUrl]
//
// Exits non-zero on the first failure. Safe to run repeatedly — every row it
// creates is namespaced with a timestamp.

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4000').replace(/\/$/, '');

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* non-JSON body, e.g. the CSV export */
  }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`\nVisiSign smoke test -> ${BASE}\n`);

  // -- Health -----------------------------------------------------------------
  const health = await api('GET', '/api/health');
  check('health responds 200', health.status === 200, `got ${health.status}`);
  check('health reports ok', health.json && health.json.ok === true);

  // -- Guest sign-in (the kiosk core path: guest + visit + badge in one tx) ----
  const name = `Smoke Tester ${Date.now()}`;
  const signin = await api('POST', '/api/visits/guest/signin', {
    body: { fullName: name, company: 'Smoke Co', host: 'Reception', reason: 'automated test' },
  });
  check('guest sign-in returns 201', signin.status === 201, `got ${signin.status} ${signin.text.slice(0, 200)}`);
  const visitId = signin.json?.data?.visitId;
  const badgeCode = signin.json?.data?.badge?.code;
  check('sign-in returns a visit id', !!visitId);
  check('sign-in issues a badge code', /^VS-/.test(badgeCode || ''), badgeCode);

  // -- Validation is enforced -------------------------------------------------
  const bad = await api('POST', '/api/visits/guest/signin', { body: { company: 'No Name Co' } });
  check('sign-in without a name is rejected', bad.status === 400, `got ${bad.status}`);

  // -- The on-site list reflects the new visit --------------------------------
  const onsite = await api('GET', '/api/visits/onsite');
  check('onsite responds 200', onsite.status === 200);
  const found = (onsite.json?.data || []).find((v) => v.visitId === visitId);
  check('new visit appears on site', !!found);
  check('onsite withholds contact details', found ? !('email' in found) && !('phone' in found) : false);

  // -- Reservations: slots, create, check in ----------------------------------
  const slots = await api('GET', '/api/reservations/slots');
  check('slots responds 200', slots.status === 200);
  const slot = slots.json?.data?.slots?.[0]?.slot;
  const date = slots.json?.data?.date;
  check('slots returns at least one slot', !!slot);

  if (slot && date) {
    const made = await api('POST', '/api/reservations', {
      body: { fullName: `Res ${Date.now()}`, date, slot, company: 'Smoke Co', host: 'Reception' },
    });
    check('reservation created (201)', made.status === 201, `got ${made.status} ${made.text.slice(0, 200)}`);
    const resId = made.json?.data?.reservationId;
    check('reservation returns an id', !!resId);

    const current = await api('GET', `/api/reservations/current?date=${date}`);
    check('reservation shows in the current list', (current.json?.data || []).some((r) => r.id === resId));

    if (resId) {
      const ci = await api('POST', `/api/reservations/${resId}/checkin`);
      check('reservation check-in succeeds', ci.status === 200, `got ${ci.status} ${ci.text.slice(0, 200)}`);
      check('check-in issues its own badge', !!ci.json?.data?.badge?.code);
      const dup = await api('POST', `/api/reservations/${resId}/checkin`);
      check('double check-in is rejected (409)', dup.status === 409, `got ${dup.status}`);
    }

    const past = await api('POST', '/api/reservations', {
      body: { fullName: 'Past Person', date: '2000-01-01', slot },
    });
    check('reservation in the past is rejected', past.status === 400, `got ${past.status}`);
  }

  // -- Sign-out, and that it cannot be repeated -------------------------------
  if (visitId) {
    const out = await api('POST', `/api/visits/${visitId}/signout`, { body: {} });
    check('sign-out succeeds', out.status === 200, `got ${out.status} ${out.text.slice(0, 200)}`);
    const again = await api('POST', `/api/visits/${visitId}/signout`, { body: {} });
    check('second sign-out is rejected (409)', again.status === 409, `got ${again.status}`);
  }

  // -- Auth: protected routes are closed, then open with a token --------------
  const noAuth = await api('GET', '/api/admin/overview');
  check('admin overview requires auth (401)', noAuth.status === 401, `got ${noAuth.status}`);

  const badLogin = await api('POST', '/api/auth/login', {
    body: { username: 'root', password: 'definitely-not-the-password' },
  });
  check('wrong password is rejected (401)', badLogin.status === 401, `got ${badLogin.status}`);

  const login = await api('POST', '/api/auth/login', {
    body: { username: process.env.SMOKE_USER || 'root', password: process.env.SMOKE_PASS || 'root' },
  });
  check('admin login succeeds', login.status === 200, `got ${login.status} ${login.text.slice(0, 200)}`);
  const token = login.json?.data?.token;
  check('login returns a token', !!token);

  if (token) {
    const me = await api('GET', '/api/auth/me', { token });
    check('me returns the session user', me.status === 200 && !!me.json?.data?.user?.id);

    const ov = await api('GET', '/api/admin/overview', { token });
    check(
      'overview responds with counts',
      ov.status === 200 && ov.json?.data && 'visits_today' in ov.json.data,
      JSON.stringify(ov.json?.data || {}).slice(0, 160)
    );
    check('overview counted a visit today', (ov.json?.data?.visits_today || 0) >= 1);

    const live = await api('GET', '/api/visits/live', { token });
    check('live list responds', live.status === 200 && Array.isArray(live.json?.data));

    const hist = await api('GET', `/api/visits?q=${encodeURIComponent('Smoke Co')}`, { token });
    check(
      'history search finds the visit',
      (hist.json?.data || []).some((v) => v.guest_company === 'Smoke Co'),
      `${(hist.json?.data || []).length} rows returned`
    );

    const users = await api('GET', '/api/admin/users', { token });
    check('user list responds', users.status === 200 && Array.isArray(users.json?.data));

    const settings = await api('GET', '/api/admin/settings', { token });
    check('settings respond as an object', settings.status === 200 && typeof settings.json?.data === 'object');

    // Write a REAL setting: unknown keys are rejected by design, so an
    // arbitrary marker would (correctly) fail validation.
    const original = settings.json?.data?.org_name || 'VisiSign';
    const marker = `Smoke Co ${Date.now()}`;
    const put = await api('PUT', '/api/admin/settings', { token, body: { org_name: marker } });
    check('settings can be written and read back', put.json?.data?.org_name === marker,
      `got ${put.status} ${JSON.stringify(put.json?.data?.org_name)}`);

    const bogus = await api('PUT', '/api/admin/settings', { token, body: { not_a_setting: 'x' } });
    check('an unknown setting key is rejected', bogus.status === 400, `got ${bogus.status}`);

    await api('PUT', '/api/admin/settings', { token, body: { org_name: original } }); // put it back

    const logs = await api('GET', '/api/admin/logs?limit=5', { token });
    check('audit log recorded activity', (logs.json?.data || []).length >= 1);

    const sites = await api('GET', '/api/admin/sites', { token });
    check('sites respond', sites.status === 200 && Array.isArray(sites.json?.data));

    const csv = await api('GET', '/api/admin/export/visits.csv', { token });
    check('CSV export has a header row', csv.status === 200 && /visit_id,type,name/.test(csv.text), csv.text.slice(0, 80));
    check('CSV export has data rows', csv.text.trim().split('\n').length > 1);
  }

  // -- Kiosk pairing ----------------------------------------------------------
  const devId = `smoke-dev-${Date.now()}`;
  const reg = await api('POST', '/api/kiosk/register', { body: { deviceId: devId, name: 'Smoke Kiosk' } });
  check('kiosk registers (201)', reg.status === 201, `got ${reg.status} ${reg.text.slice(0, 200)}`);
  check('kiosk starts pending approval', reg.json?.data?.status === 'pending', reg.json?.data?.status);
  const kioskCode = reg.json?.data?.code;

  const st = await api('GET', `/api/kiosk/status?deviceId=${devId}`);
  check('kiosk status is readable', st.status === 200 && st.json?.data?.status === 'pending');

  const kcfg = await api('GET', '/api/kiosk/config');
  check('kiosk config exposes a print mode', kcfg.status === 200 && !!kcfg.json?.data?.printMode, kcfg.json?.data?.printMode);
  check('kiosk config exposes a label size', !!kcfg.json?.data?.label?.widthMm);

  if (token && kioskCode) {
    const acc = await api('POST', `/api/kiosk/${kioskCode}/accept`, { token });
    check('admin can accept a kiosk', acc.status === 200 && acc.json?.data?.status === 'accepted');
    const st2 = await api('GET', `/api/kiosk/status?deviceId=${devId}`);
    check('accepted kiosk reports accepted', st2.json?.data?.status === 'accepted');
    const rev = await api('POST', `/api/kiosk/${kioskCode}/revoke`, { token });
    check('admin can revoke a kiosk', rev.status === 200 && rev.json?.data?.status === 'revoked');
  }

  // -- The frontend is served -------------------------------------------------
  for (const path of ['/', '/kiosk', '/admin']) {
    const r = await fetch(`${BASE}${path}`);
    const body = await r.text();
    check(`serves ${path}`, r.status === 200 && body.toLowerCase().includes('<html'), `status ${r.status}`);
  }

  // -- Unknown API routes 404 as JSON -----------------------------------------
  const nf = await api('GET', '/api/does-not-exist');
  check('unknown API route 404s as JSON', nf.status === 404 && nf.json?.ok === false);

  // -- Result -----------------------------------------------------------------
  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} -- ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
