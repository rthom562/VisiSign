'use strict';

// Repository-level tests for the parts of the data layer the HTTP smoke test
// cannot reach — specifically the SQL that genuinely DIFFERS between SQLite and
// Postgres, which is where a two-backend port actually breaks:
//
//   * dialect.now() / today() / dateOf()  — the stored timestamp format, and the
//                                           "is this today?" comparison
//   * dialect.hoursBetween()              — julianday() vs EXTRACT(EPOCH ...)
//   * dialect.like                        — LIKE vs ILIKE case sensitivity
//   * ON CONFLICT upsert                  — settings
//   * COUNT(*) typing                     — Postgres returns bigint as a string
//                                           unless the driver parses it
//   * insert() / lastInsertRowid          — RETURNING id on Postgres
//   * print job claiming                  — the conditional UPDATE that stops two
//                                           agents printing the same badge
//   * advisory locks                      — so a multi-instance deploy sweeps once
//
// Run it against each backend:
//   node test/db.js
//   DATABASE_URL=postgres://... node test/db.js

const assert = require('assert');

const config = require('../src/config');
const db = require('../src/db/connection');
const repo = require('../src/repositories/repo');
const { publicId, badgeCode } = require('../src/utils/ids');

let pass = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name} -- ${err.message}`);
  }
}

(async () => {
  console.log(`\nVisiSign data-layer tests -> ${config.db.client} (${db.describe()})\n`);
  await db.migrate();

  const tag = `dbtest-${Date.now()}`;

  // ── Stored timestamp format ────────────────────────────────────────────────
  // Both backends must write 'YYYY-MM-DD HH:MM:SS'. Everything else in the
  // query layer leans on that: range filters, ORDER BY, and substr() for dates.
  await test('dialect.now() yields the shared YYYY-MM-DD HH:MM:SS format', async () => {
    const row = await db.exec.get(`SELECT ${db.dialect.now()} AS t`);
    assert.match(row.t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `got "${row.t}"`);
  });

  await test('dialect.today() yields YYYY-MM-DD and agrees with now()', async () => {
    const row = await db.exec.get(
      `SELECT ${db.dialect.today()} AS d, ${db.dialect.now()} AS t`
    );
    assert.match(row.d, /^\d{4}-\d{2}-\d{2}$/, `got "${row.d}"`);
    assert.strictEqual(row.d, row.t.slice(0, 10), 'today() and now() disagree on the date');
  });

  await test('stored timestamps are UTC, not the local clock', async () => {
    const row = await db.exec.get(`SELECT ${db.dialect.now()} AS t`);
    const stored = new Date(row.t.replace(' ', 'T') + 'Z');
    const drift = Math.abs(stored.getTime() - Date.now());
    assert.ok(drift < 120_000, `stored timestamp is ${Math.round(drift / 1000)}s from UTC now`);
  });

  // ── Duration arithmetic ────────────────────────────────────────────────────
  // SQLite uses julianday(); Postgres has to cast TEXT to timestamp and divide
  // an epoch interval. Both must agree, including on fractions.
  await test('dialect.hoursBetween() computes whole hours', async () => {
    const row = await db.exec.get(
      `SELECT ${db.dialect.hoursBetween("'2026-01-01 09:00:00'", "'2026-01-01 17:00:00'")} AS h`
    );
    assert.ok(Math.abs(Number(row.h) - 8) < 1e-6, `expected 8, got ${row.h}`);
  });

  await test('dialect.hoursBetween() computes fractional hours', async () => {
    const row = await db.exec.get(
      `SELECT ${db.dialect.hoursBetween("'2026-01-01 09:00:00'", "'2026-01-01 09:45:00'")} AS h`
    );
    assert.ok(Math.abs(Number(row.h) - 0.75) < 1e-6, `expected 0.75, got ${row.h}`);
  });

  await test('dialect.hoursBetween() spans midnight', async () => {
    const row = await db.exec.get(
      `SELECT ${db.dialect.hoursBetween("'2026-01-01 23:30:00'", "'2026-01-02 00:30:00'")} AS h`
    );
    assert.ok(Math.abs(Number(row.h) - 1) < 1e-6, `expected 1, got ${row.h}`);
  });

  // ── COUNT(*) must arrive as a number ───────────────────────────────────────
  // node-postgres returns bigint as a STRING by default, which would silently
  // turn the admin overview counters into string concatenation.
  await test('COUNT(*) comes back as a number, not a string', async () => {
    const row = await db.exec.get('SELECT COUNT(*) AS n FROM settings');
    assert.strictEqual(typeof row.n, 'number', `COUNT(*) was a ${typeof row.n}`);
  });

  // ── Settings upsert (ON CONFLICT) ──────────────────────────────────────────
  await test('settings.set() inserts then updates the same key', async () => {
    const key = `${tag}-setting`;
    await repo.settings.set(key, 'first');
    assert.strictEqual((await repo.settings.get(key)).value, 'first');
    await repo.settings.set(key, 'second');
    assert.strictEqual((await repo.settings.get(key)).value, 'second');
    const all = await repo.settings.all();
    assert.strictEqual(all.filter((r) => r.key === key).length, 1, 'upsert duplicated the row');
  });

  // ── insert() must report the new id on both backends ───────────────────────
  let siteId;
  await test('insert() returns lastInsertRowid', async () => {
    const r = await repo.places.createSite({ name: `${tag} Site`, address: '1 Test St' });
    assert.strictEqual(typeof r.lastInsertRowid, 'number', `got ${typeof r.lastInsertRowid}`);
    assert.ok(r.lastInsertRowid > 0);
    siteId = r.lastInsertRowid;
  });

  await test('rooms and desks chain off that id', async () => {
    const room = await repo.places.createRoom({ site_id: siteId, name: `${tag} Room` });
    assert.ok(room.lastInsertRowid > 0);
    const desk = await repo.places.createDesk({ room_id: room.lastInsertRowid, label: `${tag} Desk` });
    assert.ok(desk.lastInsertRowid > 0);
    const rooms = await repo.places.listRooms(siteId);
    assert.strictEqual(rooms.length, 1, `expected 1 room for the new site, got ${rooms.length}`);
  });

  await test('listRooms()/listDesks() with no filter return everything', async () => {
    assert.ok((await repo.places.listRooms(null)).length >= 1);
    assert.ok((await repo.places.listDesks(null)).length >= 1);
  });

  // ── Transactions ───────────────────────────────────────────────────────────
  await test('a transaction commits every statement', async () => {
    const pid = publicId('gst');
    const out = await repo.tx(async (t) => {
      const g = await t.guests.create({ public_id: pid, full_name: `${tag} Committed` });
      return g.lastInsertRowid;
    });
    const row = await repo.guests.byId(out);
    assert.ok(row, 'the committed guest is missing');
    assert.strictEqual(row.public_id, pid);
  });

  await test('a failed transaction rolls everything back', async () => {
    const pid = publicId('gst');
    let threw = false;
    try {
      await repo.tx(async (t) => {
        await t.guests.create({ public_id: pid, full_name: `${tag} RolledBack` });
        throw new Error('deliberate failure');
      });
    } catch (e) {
      threw = e.message === 'deliberate failure';
    }
    assert.ok(threw, 'the transaction did not surface its error');
    const found = await db.exec.get('SELECT id FROM guests WHERE public_id = ?', [pid]);
    assert.ok(!found, 'the rolled-back guest was still written');
  });

  // ── Case-insensitive search (LIKE vs ILIKE) ────────────────────────────────
  await test('history search is case-insensitive', async () => {
    const gpid = publicId('gst');
    const vpid = publicId('vis');
    await repo.tx(async (t) => {
      const g = await t.guests.create({
        public_id: gpid,
        full_name: `${tag} MiXeDcAsE Person`,
        company: 'ZanyCorp',
      });
      const v = await t.visits.create({
        public_id: vpid,
        type: 'guest',
        guest_id: g.lastInsertRowid,
        host_name: 'Reception',
      });
      await t.badges.create({
        visit_id: v.lastInsertRowid,
        code: badgeCode(),
        qr_payload: '{}',
      });
    });

    const lower = await repo.visits.search({ q: 'zanycorp' });
    const upper = await repo.visits.search({ q: 'ZANYCORP' });
    assert.ok(lower.some((v) => v.public_id === vpid), 'lowercase query missed the visit');
    assert.ok(upper.some((v) => v.public_id === vpid), 'uppercase query missed the visit');
  });

  await test('an empty search query returns rows rather than nothing', async () => {
    assert.ok((await repo.visits.search({ q: '', limit: 5 })).length >= 1);
  });

  await test('search filters still apply alongside a query', async () => {
    const staffOnly = await repo.visits.search({ q: 'ZanyCorp', type: 'staff' });
    assert.strictEqual(staffOnly.length, 0, 'type filter was ignored');
  });

  await test('live() filters by type', async () => {
    const guests = await repo.visits.live({ type: 'guest' });
    assert.ok(guests.every((v) => v.type === 'guest'));
    assert.ok(guests.length >= 1);
  });

  // ── "Today" counting (substr + today()) ────────────────────────────────────
  await test('overview counts today\'s visits as numbers', async () => {
    const o = await repo.stats.overview();
    for (const k of ['guests_onsite', 'staff_onsite', 'visits_today', 'open_alerts']) {
      assert.strictEqual(typeof o[k], 'number', `${k} was a ${typeof o[k]}`);
    }
    assert.ok(o.visits_today >= 1, 'the visit just created was not counted as today');
  });

  // ── Staff session hours (the hoursBetween query in anger) ──────────────────
  await test('staffSessions() reports hours for a closed session', async () => {
    const upid = publicId('usr');
    const u = await repo.users.create({
      public_id: upid,
      email: `${tag}-staff`,
      password_hash: 'x',
      full_name: `${tag} Staff`,
      role: 'staff',
      access_level: 1,
    });
    const userId = u.lastInsertRowid;

    await db.exec.run(
      `INSERT INTO visits (public_id, type, staff_user_id, status, signed_in_at, signed_out_at)
       VALUES (?, 'staff', ?, 'signed_out', '2026-01-01 09:00:00', '2026-01-01 17:30:00')`,
      [publicId('vis'), userId]
    );

    const rows = await repo.visits.staffSessions(userId);
    assert.strictEqual(rows.length, 1, `expected 1 session, got ${rows.length}`);
    assert.ok(Math.abs(Number(rows[0].hours) - 8.5) < 1e-6, `expected 8.5 hours, got ${rows[0].hours}`);
  });

  await test('staffSessions() leaves an open session null', async () => {
    const upid = publicId('usr');
    const u = await repo.users.create({
      public_id: upid,
      email: `${tag}-staff2`,
      password_hash: 'x',
      full_name: `${tag} Staff2`,
      role: 'staff',
      access_level: 1,
    });
    const userId = u.lastInsertRowid;
    await db.exec.run(
      `INSERT INTO visits (public_id, type, staff_user_id, status) VALUES (?, 'staff', ?, 'signed_in')`,
      [publicId('vis'), userId]
    );
    const rows = await repo.visits.staffSessions(userId);
    assert.strictEqual(rows[0].hours, null, `expected null hours, got ${rows[0].hours}`);
    const open = await repo.visits.openStaffSession(userId);
    assert.ok(open, 'the open staff session was not found');
  });

  await test('staffSessions() honours a date range', async () => {
    const rows = await repo.visits.staffSessions(-1, '2026-01-01 00:00:00', '2026-01-02 00:00:00');
    assert.ok(Array.isArray(rows));
  });

  // ── Case-insensitive kiosk codes ───────────────────────────────────────────
  // The code must be unique PER RUN: kiosks.code is not a unique column, and
  // these tests run repeatedly against a persistent Postgres, so a fixed code
  // would make byCode() return a kiosk left behind by an earlier run.
  const kioskCode = `K${Date.now().toString(36).slice(-3).toUpperCase()}`;
  const kioskDevId = `${tag}-device`;

  await test('kiosk lookup by code ignores case', async () => {
    await repo.kiosks.create({ public_id: kioskDevId, code: kioskCode, status: 'pending' });
    assert.ok(await repo.kiosks.byCode(kioskCode.toLowerCase()), 'lowercase code missed');
    assert.ok(await repo.kiosks.byCode(kioskCode), 'exact code missed');
    assert.ok(
      await repo.kiosks.byCode(kioskCode[0] + kioskCode.slice(1).toLowerCase()),
      'mixed-case code missed'
    );
  });

  await test('kiosk setStatus() stamps accepted_at only when accepting', async () => {
    const k = await repo.kiosks.byPublicId(kioskDevId);
    assert.ok(!k.accepted_at, 'a new kiosk should not have accepted_at set');

    await repo.kiosks.setStatus(k.id, 'revoked');
    assert.ok(!(await repo.kiosks.byPublicId(kioskDevId)).accepted_at, 'revoking set accepted_at');

    await repo.kiosks.setStatus(k.id, 'accepted');
    const accepted = await repo.kiosks.byPublicId(kioskDevId);
    assert.ok(accepted.accepted_at, 'accepting did not set accepted_at');

    // Revoking afterwards keeps the historical acceptance time rather than
    // clearing it — the CASE only ever writes on accept.
    await repo.kiosks.setStatus(k.id, 'revoked');
    const after = await repo.kiosks.byPublicId(kioskDevId);
    assert.strictEqual(after.accepted_at, accepted.accepted_at, 'revoking cleared accepted_at');
    assert.strictEqual(after.status, 'revoked');
  });

  // ── Print queue: claiming must be exactly-once ─────────────────────────────
  await test('a queued print job can be claimed exactly once', async () => {
    const jobPid = publicId('prn');
    await repo.printJobs.create({ public_id: jobPid, visit_id: null, payload: '{"kind":"badge"}' });
    const job = await repo.printJobs.byPublicId(jobPid);

    const first = await repo.printJobs.claim(job.id, 'agent-a');
    const second = await repo.printJobs.claim(job.id, 'agent-b');
    assert.strictEqual(first.changes, 1, 'the first agent failed to claim the job');
    assert.strictEqual(second.changes, 0, 'a second agent also claimed the same job');

    const after = await repo.printJobs.byPublicId(jobPid);
    assert.strictEqual(after.status, 'claimed');
    assert.strictEqual(after.agent_id, 'agent-a');
    assert.strictEqual(after.attempts, 1, `attempts should be 1, got ${after.attempts}`);
  });

  await test('finishing a print job records its outcome', async () => {
    const jobPid = publicId('prn');
    await repo.printJobs.create({ public_id: jobPid, visit_id: null, payload: '{}' });
    const job = await repo.printJobs.byPublicId(jobPid);
    await repo.printJobs.claim(job.id, 'agent-a');
    await repo.printJobs.finish(job.id, { ok: false, error: 'printer offline' });
    const done = await repo.printJobs.byPublicId(jobPid);
    assert.strictEqual(done.status, 'failed');
    assert.strictEqual(done.error, 'printer offline');
    assert.ok(done.finished_at, 'finished_at was not stamped');
  });

  await test('stale claimed jobs are re-queued, fresh ones are left alone', async () => {
    const stalePid = publicId('prn');
    const freshPid = publicId('prn');
    await repo.printJobs.create({ public_id: stalePid, visit_id: null, payload: '{}' });
    await repo.printJobs.create({ public_id: freshPid, visit_id: null, payload: '{}' });
    const stale = await repo.printJobs.byPublicId(stalePid);
    const fresh = await repo.printJobs.byPublicId(freshPid);

    await repo.printJobs.claim(stale.id, 'agent-gone');
    await repo.printJobs.claim(fresh.id, 'agent-busy');
    // Backdate the stale one's claim.
    await db.exec.run('UPDATE print_jobs SET claimed_at = ? WHERE id = ?', [
      '2000-01-01 00:00:00',
      stale.id,
    ]);

    await repo.printJobs.requeueStale('2020-01-01 00:00:00');
    assert.strictEqual((await repo.printJobs.byPublicId(stalePid)).status, 'queued', 'stale job not re-queued');
    assert.strictEqual((await repo.printJobs.byPublicId(freshPid)).status, 'claimed', 'fresh job was wrongly re-queued');
  });

  await test('queued() returns oldest first and respects its limit', async () => {
    const rows = await repo.printJobs.queued(2);
    assert.ok(rows.length <= 2, `limit ignored: got ${rows.length}`);
    assert.ok(rows.every((r) => r.status === 'queued'));
  });

  // ── Advisory lock ──────────────────────────────────────────────────────────
  // On Postgres this is what keeps several instances from all running the
  // end-of-day sweep. On SQLite there is one instance, so it just runs.
  await test('withAdvisoryLock() runs the work and returns its value', async () => {
    const out = await db.withAdvisoryLock('visisign:test-lock', async () => 'ran');
    assert.strictEqual(out, 'ran');
  });

  await test('withAdvisoryLock() releases the lock afterwards', async () => {
    await db.withAdvisoryLock('visisign:test-lock', async () => 'first');
    const out = await db.withAdvisoryLock('visisign:test-lock', async () => 'second');
    assert.strictEqual(out, 'second', 'the lock was not released');
  });

  await test('withAdvisoryLock() releases the lock even when the work throws', async () => {
    try {
      await db.withAdvisoryLock('visisign:test-lock', async () => {
        throw new Error('boom');
      });
    } catch (_) {
      /* expected */
    }
    const out = await db.withAdvisoryLock('visisign:test-lock', async () => 'after-throw');
    assert.strictEqual(out, 'after-throw', 'a thrown error left the lock held');
  });

  // ── Users: COALESCE partial update ─────────────────────────────────────────
  await test('a partial user update leaves unspecified fields alone', async () => {
    const pid = publicId('usr');
    const u = await repo.users.create({
      public_id: pid,
      email: `${tag}-coalesce`,
      password_hash: 'x',
      full_name: 'Original Name',
      role: 'staff',
      access_level: 3,
    });
    await repo.users.update(u.lastInsertRowid, { full_name: 'New Name' });
    const after = await repo.users.byId(u.lastInsertRowid);
    assert.strictEqual(after.full_name, 'New Name');
    assert.strictEqual(after.access_level, 3, 'access_level was clobbered');
    assert.strictEqual(Number(after.is_active), 1, 'is_active was clobbered');
  });

  await test('user list search matches name and username', async () => {
    const byName = await repo.users.list({ q: 'Original', limit: 50, offset: 0 });
    assert.strictEqual(byName.length, 0, 'the renamed user should no longer match "Original"');
    const byNew = await repo.users.list({ q: 'New Name', limit: 50, offset: 0 });
    assert.ok(byNew.length >= 1, 'search by full name missed');
    const byUser = await repo.users.list({ q: `${tag}-coalesce`, limit: 50, offset: 0 });
    assert.ok(byUser.length >= 1, 'search by username missed');
  });

  await test('booleans round-trip as 0/1 on both backends', async () => {
    const sites = await repo.places.listSites();
    assert.ok(sites.length >= 1, 'is_active = 1 filter returned nothing');
    assert.ok([0, 1].includes(Number(sites[0].is_active)));
  });

  // ── Result ─────────────────────────────────────────────────────────────────
  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} -- ${pass} passed, ${failures.length} failed`);
  await db.close();
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(async (err) => {
  console.error('\nData-layer tests crashed:', err);
  try {
    await db.close();
  } catch (_) {
    /* going down anyway */
  }
  process.exit(1);
});
