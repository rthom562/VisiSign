'use strict';

// End-to-end tests for customisation, terms/signatures and multi-kiosk printing.
//
//   node test/features.js [baseUrl]
//
// Covers the things that are easy to get subtly wrong:
//   * settings are VALIDATED, not just stored (these values render into the UI)
//   * colour templates apply to the real settings and stay editable afterwards
//   * a .vsf file round-trips, and refuses files it should refuse
//   * .vsf carries branding ONLY — never printer names or cutoff times
//   * terms are enforced SERVER-side, not just shown by the kiosk
//   * a signature is stored with the hash of the exact text agreed to
//   * each kiosk resolves its own printer, inheriting what it does not override

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4800').replace(/\/$/, '');

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// A 1x1 transparent PNG — stands in for a drawn signature and a logo.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  console.log(`\nVisiSign customisation + terms tests -> ${BASE}\n`);

  const login = await api('POST', '/api/auth/login', {
    body: { username: process.env.SMOKE_USER || 'root', password: process.env.SMOKE_PASS || 'root' },
  });
  const token = login.json?.data?.token;
  check('admin login succeeds', !!token, `got ${login.status}`);
  if (!token) { console.log('\nCannot continue without a session.'); process.exit(1); }

  // ── Settings schema drives the admin UI ────────────────────────────────────
  const schema = await api('GET', '/api/admin/settings/schema', { token });
  check('settings schema responds', schema.status === 200, `got ${schema.status}`);
  const groups = schema.json?.data?.groups || [];
  check('schema is grouped', groups.length >= 6, `${groups.length} groups`);
  check('every group has settings', groups.every((g) => g.settings.length > 0));
  check('every setting declares a type and label', groups.every((g) =>
    g.settings.every((s) => !!s.type && !!s.label)));
  check('every setting carries its current value', groups.every((g) =>
    g.settings.every((s) => s.value !== undefined)));
  check('schema ships colour templates', (schema.json?.data?.templates || []).length >= 5);

  const allKeys = groups.flatMap((g) => g.settings.map((s) => s.key));
  check('the photo setting is gone', !allKeys.includes('require_photo'));
  for (const expected of ['brand_logo', 'color_brand', 'ticker_enabled', 'tos_enabled', 'ui_radius']) {
    check(`schema includes ${expected}`, allKeys.includes(expected));
  }

  // ── Validation ─────────────────────────────────────────────────────────────
  const badColor = await api('PUT', '/api/admin/settings', { token, body: { color_brand: 'not-a-colour' } });
  check('a bad colour is rejected', badColor.status === 400, `got ${badColor.status}`);

  const badNumber = await api('PUT', '/api/admin/settings', { token, body: { ui_radius: '999' } });
  check('a number outside its range is rejected', badNumber.status === 400, `got ${badNumber.status}`);

  const badBool = await api('PUT', '/api/admin/settings', { token, body: { ticker_enabled: 'yes' } });
  check('a non-boolean for a toggle is rejected', badBool.status === 400, `got ${badBool.status}`);

  const badSelect = await api('PUT', '/api/admin/settings', { token, body: { theme_default: 'neon' } });
  check('an invalid select option is rejected', badSelect.status === 400, `got ${badSelect.status}`);

  const unknown = await api('PUT', '/api/admin/settings', { token, body: { not_a_real_setting: 'x' } });
  check('an unknown setting key is rejected', unknown.status === 400, `got ${unknown.status}`);

  const badImage = await api('PUT', '/api/admin/settings', { token, body: { brand_logo: 'http://example.com/logo.png' } });
  check('a non-data-URL logo is rejected', badImage.status === 400, `got ${badImage.status}`);

  // A rejected batch must not half-apply.
  const beforeMixed = (await api('GET', '/api/admin/settings', { token })).json?.data?.org_name;
  const mixed = await api('PUT', '/api/admin/settings', {
    token, body: { org_name: 'Should Not Stick', color_brand: 'nope' },
  });
  const afterMixed = (await api('GET', '/api/admin/settings', { token })).json?.data?.org_name;
  check('a batch with one bad value applies none of it', mixed.status === 400 && afterMixed === beforeMixed,
    `org_name went from "${beforeMixed}" to "${afterMixed}"`);

  // ── Valid writes ───────────────────────────────────────────────────────────
  const good = await api('PUT', '/api/admin/settings', {
    token,
    body: {
      org_name: 'Acme Industries',
      color_brand: '#7C3AED',
      ui_radius: '18',
      brand_logo: TINY_PNG,
      brand_mark_text: 'AC',
      ticker_enabled: 'true',
      ticker_text: 'Hard hats required beyond reception',
      ticker_speed: '45',
    },
  });
  check('valid settings are accepted', good.status === 200, `got ${good.status} ${good.text.slice(0, 160)}`);
  check('a colour is normalised to lower case', good.json?.data?.color_brand === '#7c3aed', good.json?.data?.color_brand);

  // ── The public branding endpoint reflects them, without a login ────────────
  const brand = await api('GET', '/api/branding');
  check('branding is public (no token needed)', brand.status === 200, `got ${brand.status}`);
  const b = brand.json?.data;
  check('branding carries the org name', b?.orgName === 'Acme Industries', b?.orgName);
  check('branding carries the new brand colour', b?.colors?.brand === '#7c3aed', b?.colors?.brand);
  check('branding carries the logo', b?.logo === TINY_PNG);
  check('branding carries the text mark', b?.markText === 'AC', b?.markText);
  check('branding carries the corner radius', b?.radius === 18, String(b?.radius));
  check('branding reports the ticker is on', b?.ticker?.enabled === true);
  check('branding carries the ticker text', b?.ticker?.text === 'Hard hats required beyond reception');
  check('branding carries the ticker speed', b?.ticker?.speed === 45, String(b?.ticker?.speed));
  check('branding leaks no printer settings', b && !('badge_printer' in b) && !JSON.stringify(b).includes('badge_printer'));

  // ── Colour templates ───────────────────────────────────────────────────────
  const tpl = await api('GET', '/api/admin/templates', { token });
  const templates = tpl.json?.data?.templates || [];
  check('templates list responds', tpl.status === 200 && templates.length >= 5, `${templates.length} templates`);
  check('each template has preview swatches', templates.every((t) => (t.preview || []).length >= 3));

  const applied = await api('POST', '/api/admin/templates/forest/apply', { token });
  check('a template applies', applied.status === 200, `got ${applied.status} ${applied.text.slice(0, 160)}`);
  const afterTpl = (await api('GET', '/api/branding')).json?.data;
  check('the template changed the live colours', afterTpl?.colors?.brand === '#059669', afterTpl?.colors?.brand);
  check('the template left the logo alone', afterTpl?.logo === TINY_PNG);
  check('the template left the org name alone', afterTpl?.orgName === 'Acme Industries');

  const noTpl = await api('POST', '/api/admin/templates/does-not-exist/apply', { token });
  check('an unknown template 404s', noTpl.status === 404, `got ${noTpl.status}`);

  // Colours stay editable after applying a template.
  await api('PUT', '/api/admin/settings', { token, body: { color_brand: '#123456' } });
  check('colours remain editable after a template',
    (await api('GET', '/api/branding')).json?.data?.colors?.brand === '#123456');

  // ── .vsf export / import ───────────────────────────────────────────────────
  const exported = await api('GET', '/api/admin/customisation/export?name=Acme%20Look', { token });
  check('export responds 200', exported.status === 200, `got ${exported.status}`);
  const disp = exported.headers.get('content-disposition') || '';
  check('export downloads as a .vsf file', /\.vsf"?$/.test(disp.trim()), disp);
  const bundle = exported.json;
  check('the bundle declares its format', bundle?.format === 'visisign/customisation', bundle?.format);
  check('the bundle declares a version', Number(bundle?.version) >= 1);
  check('the bundle names itself', bundle?.name === 'Acme Look', bundle?.name);
  check('the bundle records when it was made', !!bundle?.exportedAt);
  check('the bundle carries branding settings', !!bundle?.settings?.color_brand);
  check('the bundle carries the logo', bundle?.settings?.brand_logo === TINY_PNG);
  check('the bundle carries the terms text', typeof bundle?.settings?.tos_text === 'string');

  // The critical one: a .vsf must not carry building-specific operations.
  for (const forbidden of ['badge_printer', 'badge_autoprint', 'auto_signout_time', 'kiosk_require_approval', 'open_time']) {
    check(`the bundle excludes ${forbidden}`, !(forbidden in (bundle?.settings || {})));
  }

  // Change things, then restore from the bundle.
  await api('PUT', '/api/admin/settings', {
    token, body: { org_name: 'Something Else', color_brand: '#ff0000', brand_logo: '' },
  });
  const imported = await api('POST', '/api/admin/customisation/import', { token, body: { bundle } });
  check('import responds 200', imported.status === 200, `got ${imported.status} ${imported.text.slice(0, 200)}`);
  check('import reports what it applied', (imported.json?.data?.appliedCount || 0) > 5, String(imported.json?.data?.appliedCount));

  const restored = (await api('GET', '/api/branding')).json?.data;
  check('import restored the org name', restored?.orgName === 'Acme Industries', restored?.orgName);
  check('import restored the colour', restored?.colors?.brand === '#123456', restored?.colors?.brand);
  check('import restored the logo', restored?.logo === TINY_PNG);

  // Dry run previews without writing.
  const dry = await api('POST', '/api/admin/customisation/import', {
    token, body: { bundle: { ...bundle, settings: { ...bundle.settings, org_name: 'Dry Run Co' } }, dryRun: true },
  });
  check('a dry-run import reports as such', dry.json?.data?.dryRun === true);
  check('a dry-run import changes nothing',
    (await api('GET', '/api/branding')).json?.data?.orgName === 'Acme Industries');

  // Bad bundles are refused clearly.
  const notVsf = await api('POST', '/api/admin/customisation/import', { token, body: { bundle: { hello: 'world' } } });
  check('a file that is not a .vsf is refused', notVsf.status === 400, `got ${notVsf.status}`);

  const futureVsf = await api('POST', '/api/admin/customisation/import', {
    token, body: { bundle: { format: 'visisign/customisation', version: 99, settings: { org_name: 'x' } } },
  });
  check('a newer bundle format is refused with a clear reason',
    futureVsf.status === 400 && /newer version/i.test(futureVsf.json?.error?.message || ''),
    futureVsf.json?.error?.message);

  // An unknown key inside an otherwise valid bundle is skipped, not fatal.
  const partial = await api('POST', '/api/admin/customisation/import', {
    token,
    body: { bundle: { ...bundle, settings: { ...bundle.settings, future_setting: 'x' } } },
  });
  check('an unknown key in a bundle is skipped, not fatal',
    partial.status === 200 && (partial.json?.data?.skipped || []).some((s) => s.key === 'future_setting'),
    JSON.stringify(partial.json?.data?.skipped || []).slice(0, 120));

  // ── Terms and signature ────────────────────────────────────────────────────
  await api('PUT', '/api/admin/settings', {
    token,
    body: {
      tos_enabled: 'true', tos_require_signature: 'true',
      tos_version: '2.1', tos_text: 'Hard hats must be worn at all times.',
      tos_title: 'Site safety rules',
    },
  });

  const pub = (await api('GET', '/api/branding')).json?.data;
  check('branding announces that terms are required', pub?.terms?.enabled === true);
  check('branding carries the terms text for display', pub?.terms?.text === 'Hard hats must be worn at all times.');
  check('branding carries the terms version', pub?.terms?.version === '2.1');
  check('branding says a signature is required', pub?.terms?.requireSignature === true);

  // Server-side enforcement: the kiosk UI is a convenience, not the control.
  const noAccept = await api('POST', '/api/visits/guest/signin', { body: { fullName: 'Unagreeing Visitor' } });
  check('sign-in without accepting terms is refused', noAccept.status === 400, `got ${noAccept.status}`);
  check('refusal explains why', noAccept.json?.error?.code === 'terms_required', noAccept.json?.error?.code);

  const noSig = await api('POST', '/api/visits/guest/signin', {
    body: { fullName: 'Unsigning Visitor', acceptedTerms: true },
  });
  check('sign-in without a signature is refused', noSig.status === 400, `got ${noSig.status}`);
  check('refusal names the missing signature', noSig.json?.error?.code === 'signature_required', noSig.json?.error?.code);

  const junkSig = await api('POST', '/api/visits/guest/signin', {
    body: { fullName: 'Junk Sig', acceptedTerms: true, signature: 'data:text/html,<script>alert(1)</script>' },
  });
  check('a non-PNG signature is refused', junkSig.status === 400, `got ${junkSig.status}`);

  const signedIn = await api('POST', '/api/visits/guest/signin', {
    body: { fullName: 'Properly Signed', company: 'Acme', host: 'Reception', acceptedTerms: true, signature: TINY_PNG },
  });
  check('sign-in with terms accepted and signed succeeds', signedIn.status === 201,
    `got ${signedIn.status} ${signedIn.text.slice(0, 200)}`);
  const signedVisitId = signedIn.json?.data?.visitId;

  const sig = await api('GET', `/api/admin/signatures/${signedVisitId}`, { token });
  check('the signature is retrievable for the visit', sig.status === 200, `got ${sig.status}`);
  check('the signature stores the image', sig.json?.data?.signature === TINY_PNG);
  check('the signature records the signer', sig.json?.data?.signerName === 'Properly Signed');
  check('the signature records the terms version in force', sig.json?.data?.termsVersion === '2.1',
    sig.json?.data?.termsVersion);
  check('the signature records a hash of the exact text', /^[0-9a-f]{64}$/.test(sig.json?.data?.termsHash || ''),
    sig.json?.data?.termsHash);

  const capturedHash = sig.json?.data?.termsHash;

  // Editing the terms must NOT retroactively change what someone signed.
  await api('PUT', '/api/admin/settings', { token, body: { tos_text: 'Completely different rules now.' } });
  const sigAfter = await api('GET', `/api/admin/signatures/${signedVisitId}`, { token });
  check('editing the terms does not alter an existing signature record',
    sigAfter.json?.data?.termsHash === capturedHash, 'hash changed after editing the terms');

  const sigList = await api('GET', '/api/admin/signatures?limit=10', { token });
  check('signatures are listable', (sigList.json?.data?.signatures || []).length >= 1);
  check('the signature list omits the heavy image',
    !(sigList.json?.data?.signatures || []).some((s) => 'signature_png' in s));

  // With signature not required, a tick box alone is enough.
  await api('PUT', '/api/admin/settings', { token, body: { tos_require_signature: 'false' } });
  const tickOnly = await api('POST', '/api/visits/guest/signin', {
    body: { fullName: 'Tickbox Only', acceptedTerms: true },
  });
  check('a tick box alone works when signatures are optional', tickOnly.status === 201, `got ${tickOnly.status}`);

  // With terms off entirely, sign-in is unencumbered again.
  await api('PUT', '/api/admin/settings', { token, body: { tos_enabled: 'false' } });
  const plain = await api('POST', '/api/visits/guest/signin', { body: { fullName: 'No Terms Needed' } });
  check('sign-in works normally when terms are off', plain.status === 201, `got ${plain.status}`);

  // ── Multiple kiosks, multiple printers ─────────────────────────────────────
  await api('PUT', '/api/admin/settings', {
    token, body: { badge_printer: 'Office Default Printer', badge_width_mm: '62', badge_height_mm: '90' },
  });

  const devA = `feat-lobby-${Date.now()}`;
  const devB = `feat-dock-${Date.now()}`;
  const regA = await api('POST', '/api/kiosk/register', { body: { deviceId: devA, name: 'Lobby' } });
  const regB = await api('POST', '/api/kiosk/register', { body: { deviceId: devB, name: 'Loading bay' } });
  check('two kiosks register independently', regA.status === 201 && regB.status === 201);
  const codeA = regA.json?.data?.code;
  const codeB = regB.json?.data?.code;
  check('each kiosk gets its own code', !!codeA && !!codeB && codeA !== codeB, `${codeA} / ${codeB}`);

  await api('POST', `/api/kiosk/${codeA}/accept`, { token });
  await api('POST', `/api/kiosk/${codeB}/accept`, { token });

  // Both inherit the default until given their own.
  const cfgA0 = await api('GET', `/api/kiosk/config?deviceId=${devA}`);
  check('a kiosk inherits the default printer label size',
    cfgA0.json?.data?.label?.widthMm === 62, JSON.stringify(cfgA0.json?.data?.label));

  // Give each its own printer.
  const patchA = await api('PATCH', `/api/kiosk/${codeA}`, {
    token, body: { location: 'Main lobby', printer: 'Brother QL-820NWB', labelWidthMm: '62', labelHeightMm: '100' },
  });
  check('a kiosk accepts its own printer config', patchA.status === 200, `got ${patchA.status} ${patchA.text.slice(0, 160)}`);

  await api('PATCH', `/api/kiosk/${codeB}`, { token, body: { printer: 'Zebra ZD421', printMode: 'device' } });

  const cfgA = await api('GET', `/api/kiosk/config?deviceId=${devA}`);
  const cfgB = await api('GET', `/api/kiosk/config?deviceId=${devB}`);
  check('kiosk A reports its own label height', cfgA.json?.data?.label?.heightMm === 100,
    JSON.stringify(cfgA.json?.data?.label));
  check('kiosk B keeps the default label height', cfgB.json?.data?.label?.heightMm === 90,
    JSON.stringify(cfgB.json?.data?.label));
  check('kiosk B uses its own print mode', cfgB.json?.data?.printMode === 'device', cfgB.json?.data?.printMode);
  check('kiosk A keeps the default print mode', cfgA.json?.data?.printMode === 'server', cfgA.json?.data?.printMode);
  check('a kiosk reports its location', cfgA.json?.data?.kiosk?.location === 'Main lobby', cfgA.json?.data?.kiosk?.location);

  const fleet = await api('GET', '/api/kiosk', { token });
  const rows = fleet.json?.data?.kiosks || [];
  const rowA = rows.find((k) => k.code === codeA);
  const rowB = rows.find((k) => k.code === codeB);
  check('the admin fleet list includes both kiosks', !!rowA && !!rowB, `${rows.length} kiosks`);
  check('the fleet list resolves each printer',
    rowA?.printing?.printer === 'Brother QL-820NWB' && rowB?.printing?.printer === 'Zebra ZD421',
    `${rowA?.printing?.printer} / ${rowB?.printing?.printer}`);
  check('the fleet list marks which values are overridden', rowA?.printing?.overrides?.printer === true);
  check('the fleet list marks inherited values as not overridden', rowB?.printing?.overrides?.label === false);

  // Clearing an override returns the kiosk to the default.
  await api('PATCH', `/api/kiosk/${codeA}`, { token, body: { printer: '' } });
  const cfgACleared = await api('GET', `/api/kiosk/config?deviceId=${devA}`);
  check('clearing an override falls back to the default printer',
    (await api('GET', '/api/kiosk', { token })).json.data.kiosks.find((k) => k.code === codeA)
      ?.printing?.printer === 'Office Default Printer');
  check('clearing the printer leaves the label override intact',
    cfgACleared.json?.data?.label?.heightMm === 100, JSON.stringify(cfgACleared.json?.data?.label));

  const badMode = await api('PATCH', `/api/kiosk/${codeB}`, { token, body: { printMode: 'telepathy' } });
  check('an invalid print mode is rejected', badMode.status === 400, `got ${badMode.status}`);

  const badLabel = await api('PATCH', `/api/kiosk/${codeB}`, { token, body: { labelWidthMm: '5000' } });
  check('an absurd label size is rejected', badLabel.status === 400, `got ${badLabel.status}`);

  const delB = await api('DELETE', `/api/kiosk/${codeB}`, { token });
  check('a kiosk can be removed', delB.status === 200, `got ${delB.status}`);
  check('a removed kiosk is gone from the fleet list',
    !((await api('GET', '/api/kiosk', { token })).json.data.kiosks || []).some((k) => k.code === codeB));

  // Tidy up.
  await api('DELETE', `/api/kiosk/${codeA}`, { token });

  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} -- ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nFeature tests crashed:', err);
  process.exit(1);
});
