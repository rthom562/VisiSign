'use strict';

// End-to-end test of the on-premise print agent protocol, over real HTTP.
//
// This is the path that keeps a reception label printer working once VisiSign
// moves to the cloud, so it is worth proving rather than assuming:
//
//   * the agent API is closed unless PRINT_AGENT_TOKEN is set
//   * a wrong token is rejected
//   * signing a visitor in with server-side auto-print QUEUES a job instead of
//     trying (and failing) to reach a printer the server cannot see
//   * the queued payload contains everything needed to render the badge
//   * two agents polling at once cannot both claim the same badge
//   * reporting success and failure both land
//
// The server must be running with PRINT_AGENT_TOKEN set and the queue
// transport selected:
//
//   PRINT_AGENT_TOKEN=test-secret PRINT_TRANSPORT=queue PORT=4200 node server.js
//   node test/agent.js http://localhost:4200 test-secret

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4200').replace(/\/$/, '');
const TOKEN = process.argv[3] || process.env.PRINT_AGENT_TOKEN || 'test-secret';

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

async function call(method, path, { body, token, agentId = 'test-agent' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Agent-Id': agentId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* non-JSON */
  }
  return { status: res.status, json, text, raw: res };
}

(async () => {
  console.log(`\nVisiSign print-agent protocol test -> ${BASE}\n`);

  // ── Authentication ─────────────────────────────────────────────────────────
  const noToken = await call('GET', '/api/print/agent/jobs');
  check('agent API rejects a request with no token', noToken.status === 401, `got ${noToken.status}`);

  const badToken = await call('GET', '/api/print/agent/jobs', { token: 'not-the-token' });
  check('agent API rejects a wrong token', badToken.status === 401, `got ${badToken.status}`);

  const hello = await call('POST', '/api/print/agent/hello', {
    token: TOKEN,
    body: { printers: ['Brother QL-820NWB', 'Microsoft Print to PDF'] },
  });
  check('agent handshake succeeds', hello.status === 200, `got ${hello.status} ${hello.text.slice(0, 200)}`);
  check('handshake returns the label settings', !!hello.json?.data?.label, JSON.stringify(hello.json?.data || {}));
  check('handshake echoes the agent id', hello.json?.data?.agentId === 'test-agent', hello.json?.data?.agentId);
  check('handshake suggests a poll interval', Number(hello.json?.data?.pollSeconds) > 0);

  // ── Admin can now see the printers the agent reported ──────────────────────
  const login = await call('POST', '/api/auth/login', {
    body: { username: process.env.SMOKE_USER || 'root', password: process.env.SMOKE_PASS || 'root' },
  });
  const adminToken = login.json?.data?.token;
  check('admin login succeeds', !!adminToken, `got ${login.status}`);

  // Capture the printing settings before changing them, so they can be put back.
  const SNAPSHOT = adminToken
    ? (await call('GET', '/api/admin/settings', { token: adminToken })).json?.data
    : null;

  if (adminToken) {
    const printers = await call('GET', '/api/print/printers', { token: adminToken });
    const list = printers.json?.data?.printers || [];
    check(
      'admin sees the printers the agent reported',
      list.includes('Brother QL-820NWB'),
      JSON.stringify(list)
    );

    const transport = await call('GET', '/api/print/transport', { token: adminToken });
    check('transport reports the queue', transport.json?.data?.transport === 'queue', transport.json?.data?.transport);
    check('transport reports the agent API is on', transport.json?.data?.agentConfigured === true);

    // Turn on server-side auto-printing so a sign-in queues a badge.
    const put = await call('PUT', '/api/admin/settings', {
      token: adminToken,
      body: { badge_autoprint: 'true', badge_print_mode: 'server', badge_printer: 'Brother QL-820NWB' },
    });
    check('auto-print can be enabled', put.json?.data?.badge_autoprint === 'true');
  }

  // ── Drain anything already queued, so the counts below are about our job ───
  for (let i = 0; i < 20; i++) {
    const { json } = await call('GET', '/api/print/agent/jobs?limit=5', { token: TOKEN });
    const jobs = json?.data?.jobs || [];
    if (!jobs.length) break;
    for (const j of jobs) {
      await call('POST', `/api/print/agent/jobs/${j.jobId}/result`, { token: TOKEN, body: { ok: true } });
    }
  }

  // ── A sign-in should QUEUE a badge rather than try to print it ─────────────
  const visitorName = `Agent Test ${Date.now()}`;
  const signin = await call('POST', '/api/visits/guest/signin', {
    body: { fullName: visitorName, company: 'Queue Co', host: 'Reception', reason: 'agent protocol test' },
  });
  check('guest sign-in succeeds', signin.status === 201, `got ${signin.status} ${signin.text.slice(0, 200)}`);
  const visitId = signin.json?.data?.visitId;
  const badgeCode = signin.json?.data?.badge?.code;

  // Auto-print is deliberately fire-and-forget — sign-in returns before the
  // badge is queued, which is the whole point (a jammed printer must never
  // delay a visitor). So poll for the job instead of sleeping a fixed amount.
  let poll = null;
  const deadline = Date.now() + 10_000;
  do {
    poll = await call('GET', '/api/print/agent/jobs?limit=1', { token: TOKEN });
    if ((poll.json?.data?.jobs || []).length) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);

  check('a job was queued by the sign-in', (poll.json?.data?.jobs || []).length === 1,
    `got ${(poll.json?.data?.jobs || []).length} within 10s`);

  const job = (poll.json?.data?.jobs || [])[0];
  if (job) {
    check('job carries a public id', !!job.jobId);
    check('job records the attempt number', job.attempts === 1, String(job.attempts));

    const f = job.payload?.fields || {};
    check('payload carries the visitor name', f.name === visitorName, f.name);
    check('payload carries the badge code', f.code === badgeCode, `${f.code} vs ${badgeCode}`);
    check('payload carries the QR content', typeof f.qrPayload === 'string' && f.qrPayload.length > 0);
    check('payload carries a formatted date', typeof f.dateStr === 'string' && f.dateStr.length > 0, f.dateStr);
    check('payload carries the host', f.hostName === 'Reception', f.hostName);
    check('payload carries the chosen printer', job.payload?.label?.printer === 'Brother QL-820NWB',
      job.payload?.label?.printer);
    check('payload carries the label size', Number(job.payload?.label?.widthMm) > 0);
    check('payload references the visit', job.payload?.visitId === visitId, job.payload?.visitId);

    // ── Claiming is exactly-once, enforced server-side ──────────────────────
    const second = await call('GET', '/api/print/agent/jobs?limit=5', { token: TOKEN, agentId: 'other-agent' });
    const alsoGot = (second.json?.data?.jobs || []).some((j) => j.jobId === job.jobId);
    check('a second agent cannot claim the same job', !alsoGot);

    // ── Reporting success ───────────────────────────────────────────────────
    const done = await call('POST', `/api/print/agent/jobs/${job.jobId}/result`, {
      token: TOKEN,
      body: { ok: true },
    });
    check('reporting success is accepted', done.status === 200 && done.json?.data?.status === 'done',
      `got ${done.status} ${done.text.slice(0, 160)}`);

    const reportedTwice = await call('POST', `/api/print/agent/jobs/${job.jobId}/result`, {
      token: TOKEN,
      body: { ok: true },
    });
    check('reporting an already-finished job is harmless', reportedTwice.status === 200);
  }

  // ── Reporting a failure records the reason ─────────────────────────────────
  if (visitId) {
    const reprint = await call('POST', `/api/print/badge/${visitId}`);
    check('a reprint can be requested', reprint.status === 200, `got ${reprint.status} ${reprint.text.slice(0, 160)}`);
    check('a reprint reports itself as queued, not printed',
      reprint.json?.data?.printed === false && !!reprint.json?.data?.jobId,
      JSON.stringify(reprint.json?.data || {}));

    const poll2 = await call('GET', '/api/print/agent/jobs?limit=1', { token: TOKEN });
    const job2 = (poll2.json?.data?.jobs || [])[0];
    check('the reprint job can be claimed', !!job2);

    if (job2) {
      const failed = await call('POST', `/api/print/agent/jobs/${job2.jobId}/result`, {
        token: TOKEN,
        body: { ok: false, error: 'printer out of labels' },
      });
      check('reporting a failure is accepted', failed.json?.data?.status === 'failed', JSON.stringify(failed.json?.data));

      if (adminToken) {
        const jobs = await call('GET', '/api/print/jobs?limit=20', { token: adminToken });
        const row = (jobs.json?.data?.jobs || []).find((j) => j.public_id === job2.jobId);
        check('admin can see the failed job', !!row);
        check('the failure reason is recorded', row?.error === 'printer out of labels', row?.error);
      }
    }
  }

  // ── Unknown job id ─────────────────────────────────────────────────────────
  const missing = await call('POST', '/api/print/agent/jobs/prn_does_not_exist/result', {
    token: TOKEN,
    body: { ok: true },
  });
  check('an unknown job id 404s', missing.status === 404, `got ${missing.status}`);

  // ── Restore the settings we changed ────────────────────────────────────────
  // This suite turns on auto-printing and points it at a made-up printer. Put
  // the originals back so running it against a real install is harmless.
  if (adminToken && SNAPSHOT) {
    await call('PUT', '/api/admin/settings', {
      token: adminToken,
      body: {
        badge_autoprint: SNAPSHOT.badge_autoprint,
        badge_print_mode: SNAPSHOT.badge_print_mode,
        badge_printer: SNAPSHOT.badge_printer,
      },
    });
  }

  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} -- ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nPrint-agent test crashed:', err);
  process.exit(1);
});
