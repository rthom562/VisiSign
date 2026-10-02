'use strict';

// VisiSign interactive console (REPL).
//   VisiSign.exe --console      (or: node server.js --console)
//
// It talks to the backend services/repository directly, so it works whether or
// not the HTTP server is running, and it works against either database backend:
// with SQLite (WAL mode) it shares the one file with a live server safely, and
// with Postgres it is simply another client. Commands may be typed with or
// without a leading "/".
//
// A container has no terminal attached, so a cloud deployment does not run the
// console at all (config.enableConsole) — administer that one through the web
// admin page, or point a local console at the same Postgres with DATABASE_URL.

const readline = require('readline');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const config = require('./config');
const db = require('./db/connection');
const { migrate } = require('./db/connection');
const repo = require('./repositories/repo');
const authService = require('./services/auth.service');
const visitService = require('./services/visit.service');
const reservationService = require('./services/reservation.service');
const adminService = require('./services/admin.service');
const kioskService = require('./services/kiosk.service');
const printService = require('./services/print.service');

// ── little helpers ────────────────────────────────────────────────────────────
const out = (...a) => console.log(...a);
const err = (m) => console.log('  ! ' + m);
const okmsg = (m) => console.log('  ' + m);

function tokenize(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function table(rows, cols) {
  if (!rows.length) { out('  (none)'); return; }
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const header = cols.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  out('  ' + header);
  out('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) out('  ' + cols.map((c, i) => String(c.get(r) ?? '').padEnd(widths[i])).join('  '));
}

// ── command registry ──────────────────────────────────────────────────────────
const commands = [];
const byName = new Map();
function cmd(spec) { commands.push(spec); byName.set(spec.name, spec); (spec.alias || []).forEach((a) => byName.set(a, spec)); }

// ── HELP ──────────────────────────────────────────────────────────────────────
cmd({
  name: 'help', usage: '/help [extra]', desc: 'Show commands. "/help extra" lists advanced commands.',
  run: (args) => {
    const extra = (args[0] || '').toLowerCase() === 'extra';
    const list = commands.filter((c) => !!c.extra === extra);
    out('');
    out(extra ? '  Advanced commands:' : '  Commands:');
    for (const c of list) out('    ' + c.usage.padEnd(42) + c.desc);
    out('');
    if (!extra) out('  Type /help extra for advanced commands.  Commands work with or without "/".');
    else out('  Type /help for the common commands.');
    out('');
  },
});

// ── STATUS / SYSTEM ───────────────────────────────────────────────────────────
cmd({
  name: 'status', usage: '/status', desc: 'Server state + live counts.',
  run: async () => {
    const running = await healthCheck(config.port);
    const o = await repo.stats.overview();
    out('');
    okmsg(`HTTP server : ${running ? 'RUNNING on http://localhost:' + config.port : 'not detected on port ' + config.port}`);
    okmsg(`Database    : ${config.db.client} - ${db.describe()}`);
    okmsg(`Printing    : ${config.print.transport}`);
    okmsg(`Guests on site : ${o.guests_onsite}`);
    okmsg(`Staff on site  : ${o.staff_onsite}`);
    okmsg(`Visits today   : ${o.visits_today}`);
    okmsg(`Open alerts    : ${o.open_alerts}`);
    out('');
  },
});
cmd({ name: 'stats', extra: true, usage: '/stats', desc: 'Same as /status counts (no server ping).',
  run: async () => { const o = await repo.stats.overview(); out('  ' + JSON.stringify(o)); } });
cmd({ name: 'version', extra: true, usage: '/version', desc: 'Show version + environment.',
  run: () => okmsg(`VisiSign ${require('../package.json').version} · ${config.env} · packaged=${config.packaged}`) });
cmd({ name: 'clear', extra: true, usage: '/clear', desc: 'Clear the screen.', run: () => console.clear() });

// ── VISITS ────────────────────────────────────────────────────────────────────
function printVisits(rows) {
  table(rows, [
    { label: 'VISIT ID', get: (r) => r.public_id },
    { label: 'TYPE', get: (r) => r.type },
    { label: 'NAME', get: (r) => r.guest_name || r.staff_name || '-' },
    { label: 'COMPANY/HOST', get: (r) => r.guest_company || r.host_name || '-' },
    { label: 'IN', get: (r) => r.signed_in_at },
    { label: 'STATUS', get: (r) => r.status },
  ]);
}
cmd({
  name: 'onsite', alias: ['live'], usage: '/onsite', desc: 'Everyone currently signed in.',
  run: async () => printVisits(await visitService.live({})),
});
cmd({
  name: 'signin', usage: '/signin "<name>" [company] [host] [reason]', desc: 'Sign in a guest now.',
  run: async (a) => {
    if (!a[0]) return err('Usage: /signin "<name>" [company] [host] [reason]');
    const r = await visitService.guestSignIn(null, { fullName: a[0], company: a[1], host: a[2], reason: a[3] });
    okmsg(`Signed in. Visit ${r.visitId}  ·  Badge ${r.badge.code}`);
  },
});
cmd({
  name: 'signout', usage: '/signout <visitId|all>', desc: 'Sign out one visit, or everyone.',
  run: async (a) => {
    if (!a[0]) return err('Usage: /signout <visitId|all>');
    if (a[0].toLowerCase() === 'all') {
      const open = await visitService.live({});
      for (const v of open) await visitService.signOut(null, v.public_id, null);
      return okmsg(`Signed out ${open.length} visit(s).`);
    }
    await visitService.signOut(null, a[0], null);
    okmsg(`Signed out ${a[0]}.`);
  },
});
cmd({
  name: 'search', usage: '/search <query>', desc: 'Search visit history.',
  run: async (a) => printVisits(await visitService.search({ q: a.join(' '), limit: 25 })),
});
cmd({
  name: 'visits', extra: true, usage: '/visits [n]', desc: 'Most recent visits (default 20).',
  run: async (a) => printVisits(await visitService.search({ q: '', limit: Number(a[0]) || 20 })),
});

// ── RESERVATIONS ──────────────────────────────────────────────────────────────
cmd({
  name: 'reservations', alias: ['res'], usage: '/reservations [date]', desc: 'Reservations for a date (default today).',
  run: async (a) => {
    const rows = await reservationService.listForAdmin(a[0] || today());
    table(rows, [
      { label: 'RES ID', get: (r) => r.public_id },
      { label: 'SLOT', get: (r) => r.time_slot },
      { label: 'NAME', get: (r) => r.full_name },
      { label: 'HOST', get: (r) => r.host_name || '-' },
      { label: 'STATUS', get: (r) => r.status },
    ]);
  },
});
cmd({
  name: 'checkin', usage: '/checkin <reservationId>', desc: 'Check a reservation in (issues a badge).',
  run: async (a) => {
    if (!a[0]) return err('Usage: /checkin <reservationId>');
    const r = await reservationService.checkIn(null, a[0]);
    okmsg(`Checked in ${r.name}. Visit ${r.visitId} · Badge ${r.badge.code}`);
  },
});
cmd({
  name: 'reserve', extra: true, usage: '/reserve "<name>" <date> <slot> [company] [host]', desc: 'Create a reservation.',
  run: async (a) => {
    if (a.length < 3) return err('Usage: /reserve "<name>" <YYYY-MM-DD> <HH:MM> [company] [host]');
    const r = await reservationService.create(null, { fullName: a[0], date: a[1], slot: a[2], company: a[3], host: a[4] });
    okmsg(`Reserved ${r.name} for ${r.date} ${r.slot}. Ref ${r.reservationId}`);
  },
});
cmd({
  name: 'cancelres', extra: true, usage: '/cancelres <reservationId>', desc: 'Cancel a reservation.',
  run: async (a) => {
    if (!a[0]) return err('Usage: /cancelres <reservationId>');
    const row = await repo.reservations.byPublicId(a[0]);
    if (!row) return err('Reservation not found.');
    await repo.reservations.cancel(row.id);
    okmsg('Cancelled.');
  },
});
cmd({
  name: 'slots', extra: true, usage: '/slots [date]', desc: 'List bookable time slots for a date.',
  run: async (a) => okmsg((await reservationService.listSlots(a[0] || today())).slots.map((s) => s.slot).join('  ')),
});

// ── USERS / ADMINS ────────────────────────────────────────────────────────────
cmd({
  name: 'users', usage: '/users [query]', desc: 'List admin/staff users.',
  run: async (a) => {
    const rows = await repo.users.list({ q: a.join(' '), limit: 100, offset: 0 });
    table(rows, [
      { label: 'USERNAME', get: (r) => r.email },
      { label: 'NAME', get: (r) => r.full_name },
      { label: 'ROLE', get: (r) => r.role },
      { label: 'LVL', get: (r) => r.access_level },
      { label: 'ACTIVE', get: (r) => (r.is_active ? 'yes' : 'no') },
    ]);
  },
});
cmd({
  name: 'adduser', alias: ['addadmin'], usage: '/adduser <username> <password> ["Full Name"] [role]',
  desc: 'Create a user (role defaults to admin).',
  run: async (a) => {
    if (a.length < 2) return err('Usage: /adduser <username> <password> ["Full Name"] [role]');
    const [username, password, fullName, role] = a;
    const u = await authService.createUser({
      username, password, fullName: fullName || username, role: role || 'admin',
    });
    okmsg(`Created ${u.role} "${u.username}".`);
  },
});
cmd({
  name: 'passwd', usage: '/passwd <username> <newPassword>', desc: 'Reset a user password.',
  run: async (a) => {
    if (a.length < 2) return err('Usage: /passwd <username> <newPassword>');
    const u = await repo.users.byEmail(String(a[0]).toLowerCase().trim());
    if (!u) return err('User not found.');
    await repo.users.setPassword(u.id, await bcrypt.hash(String(a[1]), 10));
    okmsg(`Password updated for "${u.email}".`);
  },
});
cmd({
  name: 'deluser', extra: true, usage: '/deluser <username>', desc: 'Delete a user.',
  run: async (a) => {
    const u = await repo.users.byEmail(String(a[0] || '').toLowerCase().trim());
    if (!u) return err('User not found.');
    await repo.users.remove(u.id);
    okmsg(`Deleted "${u.email}".`);
  },
});
cmd({
  name: 'disable', extra: true, usage: '/disable <username>', desc: 'Disable a user account.',
  run: async (a) => {
    const u = await repo.users.byEmail(String(a[0] || '').toLowerCase().trim());
    if (!u) return err('User not found.');
    await repo.users.update(u.id, { is_active: 0 });
    okmsg(`Disabled "${u.email}".`);
  },
});
cmd({
  name: 'enable', extra: true, usage: '/enable <username>', desc: 'Re-enable a user account.',
  run: async (a) => {
    const u = await repo.users.byEmail(String(a[0] || '').toLowerCase().trim());
    if (!u) return err('User not found.');
    await repo.users.update(u.id, { is_active: 1 });
    okmsg(`Enabled "${u.email}".`);
  },
});
cmd({
  name: 'resetadmin', extra: true, usage: '/resetadmin [username] [password]',
  desc: 'Reset (or create) an admin. Defaults to root/root.',
  run: async (a) => {
    const username = (a[0] || 'root').toLowerCase();
    const password = a[1] || 'root';
    const existing = await repo.users.byEmail(username);
    if (existing) {
      await repo.users.setPassword(existing.id, await bcrypt.hash(password, 10));
      await repo.users.update(existing.id, { role: 'admin', is_active: 1, access_level: 9 });
      okmsg(`Reset admin "${username}" (password set).`);
    } else {
      await authService.createUser({ username, password, fullName: 'Administrator', role: 'admin', accessLevel: 9 });
      okmsg(`Created admin "${username}".`);
    }
  },
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
cmd({
  name: 'settings', usage: '/settings', desc: 'Show all settings.',
  run: async () => table(await repo.settings.all(), [
    { label: 'KEY', get: (r) => r.key }, { label: 'VALUE', get: (r) => r.value },
  ]),
});
cmd({
  name: 'set', usage: '/set <key> <value>', desc: 'Change a setting.',
  run: async (a) => {
    if (a.length < 2) return err('Usage: /set <key> <value>');
    await repo.settings.set(a[0], a.slice(1).join(' '));
    okmsg(`${a[0]} = ${a.slice(1).join(' ')}`);
  },
});
cmd({
  name: 'get', extra: true, usage: '/get <key>', desc: 'Read one setting.',
  run: async (a) => { const r = await repo.settings.get(a[0]); okmsg(r ? `${a[0]} = ${r.value}` : 'not set'); },
});

// ── PLACES ────────────────────────────────────────────────────────────────────
cmd({ name: 'sites', extra: true, usage: '/sites', desc: 'List sites.',
  run: async () => table(await repo.places.listSites(), [{ label: 'ID', get: (r) => r.id }, { label: 'NAME', get: (r) => r.name }, { label: 'ADDRESS', get: (r) => r.address || '-' }]) });
cmd({ name: 'addsite', extra: true, usage: '/addsite "<name>" [address]', desc: 'Add a site.',
  run: async (a) => { if (!a[0]) return err('name required'); const r = await repo.places.createSite({ name: a[0], address: a[1] }); okmsg('Site #' + r.lastInsertRowid); } });
cmd({ name: 'rooms', extra: true, usage: '/rooms [siteId]', desc: 'List rooms.',
  run: async (a) => table(await repo.places.listRooms(a[0] ? Number(a[0]) : null), [{ label: 'ID', get: (r) => r.id }, { label: 'SITE', get: (r) => r.site_id }, { label: 'NAME', get: (r) => r.name }]) });
cmd({ name: 'addroom', extra: true, usage: '/addroom <siteId> "<name>"', desc: 'Add a room.',
  run: async (a) => { if (a.length < 2) return err('Usage: /addroom <siteId> "<name>"'); const r = await repo.places.createRoom({ site_id: Number(a[0]), name: a[1] }); okmsg('Room #' + r.lastInsertRowid); } });
cmd({ name: 'desks', extra: true, usage: '/desks [roomId]', desc: 'List desks.',
  run: async (a) => table(await repo.places.listDesks(a[0] ? Number(a[0]) : null), [{ label: 'ID', get: (r) => r.id }, { label: 'ROOM', get: (r) => r.room_id }, { label: 'LABEL', get: (r) => r.label }]) });
cmd({ name: 'adddesk', extra: true, usage: '/adddesk <roomId> "<label>"', desc: 'Add a desk.',
  run: async (a) => { if (a.length < 2) return err('Usage: /adddesk <roomId> "<label>"'); const r = await repo.places.createDesk({ room_id: Number(a[0]), label: a[1] }); okmsg('Desk #' + r.lastInsertRowid); } });

// ── ALERTS / LOGS ─────────────────────────────────────────────────────────────
cmd({ name: 'alerts', extra: true, usage: '/alerts', desc: 'Open alerts.',
  run: async () => table(await repo.alerts.open(), [{ label: 'ID', get: (r) => r.id }, { label: 'LEVEL', get: (r) => r.level }, { label: 'MESSAGE', get: (r) => r.message }, { label: 'RAISED', get: (r) => r.created_at }]) });
cmd({ name: 'resolvealert', extra: true, usage: '/resolvealert <id>', desc: 'Resolve an alert.',
  run: async (a) => { if (!a[0]) return err('id required'); await repo.alerts.resolve(Number(a[0])); okmsg('Resolved.'); } });
cmd({ name: 'logs', extra: true, usage: '/logs [n]', desc: 'Recent audit log (default 20).',
  run: async (a) => table(await repo.logs.recent(Number(a[0]) || 20), [{ label: 'TIME', get: (r) => r.created_at }, { label: 'ACTOR', get: (r) => r.actor_type }, { label: 'ACTION', get: (r) => r.action }]) });

// ── DATA / MAINTENANCE ────────────────────────────────────────────────────────
cmd({
  name: 'export', usage: '/export [file]', desc: 'Export visit history to a CSV file.',
  run: async (a) => {
    const file = a[0] || path.join(config.appDir, `visisign-visits-${today()}.csv`);
    fs.writeFileSync(file, await adminService.exportVisitsCsv({}));
    okmsg('Wrote ' + file);
  },
});
cmd({
  name: 'backup', extra: true, usage: '/backup [file]', desc: 'Write a consistent copy of the database.',
  run: async (a) => {
    // Copying the file is only a backup when the database IS a file. The
    // Postgres equivalent is pg_dump or the provider's snapshots (Cloud SQL and
    // RDS both take daily ones), which this console deliberately does not wrap.
    if (config.db.client !== 'sqlite') {
      return err(
        'This VisiSign stores its data in Postgres, so there is no file to copy. ' +
        'Use pg_dump, or your provider automated backups.'
      );
    }
    const file = a[0] || path.join(config.appDir, `visisign-backup-${today()}.db`);
    // Fold the WAL into the main file first, so the copy is self-contained.
    try { await repo.run('PRAGMA wal_checkpoint(FULL)'); } catch (_) { /* best effort */ }
    fs.copyFileSync(config.dbFile, file);
    okmsg('Backed up to ' + file);
  },
});

// ── KIOSKS ────────────────────────────────────────────────────────────────────
// Kiosk lists are cached so `/kiosk accept <Tab>` can offer pending device codes
// instantly: reading them is a database round-trip now, and the tab-completer
// has to answer synchronously.
const kioskCache = { accepted: [], pending: [] };

async function refreshKiosks() {
  try {
    const [accepted, pending] = await Promise.all([
      kioskService.listAccepted(),
      kioskService.listPending(),
    ]);
    kioskCache.accepted = accepted;
    kioskCache.pending = pending;
  } catch (_) {
    /* leave the previous lists in place */
  }
  return kioskCache;
}

function printKiosks(rows, title) {
  out('  ' + title + ':');
  table(rows, [
    { label: 'CODE', get: (r) => r.code },
    { label: 'NAME', get: (r) => r.name || '-' },
    { label: 'STATUS', get: (r) => r.status },
    { label: 'REQUESTED', get: (r) => r.requested_at },
    { label: 'LAST SEEN', get: (r) => r.last_seen_at || '-' },
  ]);
}
cmd({
  name: 'kiosk',
  usage: '/kiosk [request | accept <code> | revoke <code> | reject <code>]',
  desc: 'Manage kiosk devices. No args = list accepted kiosks.',
  subcommands: ['request', 'requests', 'accept', 'revoke', 'reject', 'list'],
  // Dynamic tab-completion: subcommands, then matching codes for accept/revoke/reject.
  // Tab-completion must answer synchronously, but reading kiosks is now a
  // database round-trip, so completion serves a cache that every /kiosk run
  // refreshes. Worst case, a device that registered seconds ago is one Tab stale.
  complete: (parts) => {
    if (parts.length <= 1) return ['request', 'accept', 'revoke', 'reject', 'list'];
    const sub = parts[0].toLowerCase();
    if (sub === 'accept' || sub === 'reject') return kioskCache.pending.map((k) => k.code);
    if (sub === 'revoke') return kioskCache.accepted.map((k) => k.code);
    return [];
  },
  run: async (a) => {
    const sub = (a[0] || '').toLowerCase();
    const fresh = await refreshKiosks();
    if (!sub || sub === 'list') return printKiosks(fresh.accepted, 'Accepted kiosks');
    if (sub === 'request' || sub === 'requests') return printKiosks(fresh.pending, 'Pending requests');
    if (sub === 'accept') {
      if (!a[1]) return err('Usage: /kiosk accept <code>');
      const r = await kioskService.accept(a[1]);
      await refreshKiosks();
      return okmsg(`Accepted kiosk ${r.code}${r.name ? ' (' + r.name + ')' : ''}.`);
    }
    if (sub === 'reject') {
      if (!a[1]) return err('Usage: /kiosk reject <code>');
      const r = await kioskService.reject(a[1]);
      await refreshKiosks();
      return okmsg(`Rejected kiosk ${r.code}.`);
    }
    if (sub === 'revoke') {
      if (!a[1]) return err('Usage: /kiosk revoke <code>');
      const r = await kioskService.revoke(a[1]);
      await refreshKiosks();
      return okmsg(`Revoked kiosk ${r.code}.`);
    }
    return err('Unknown /kiosk subcommand. Try: request, accept, revoke, reject.');
  },
});

// ── BADGE PRINTING ────────────────────────────────────────────────────────────
// Installed printers are cached so `/setprinter <Tab>` can offer them instantly
// (listing them is async; the tab-completer must be synchronous).
let printerCache = [];
async function refreshPrinters() {
  try { printerCache = await printService.listPrinters(); } catch (_) { /* ignore */ }
  return printerCache;
}
cmd({
  name: 'printers', extra: true, usage: '/printers', desc: 'List installed printers.',
  run: async () => {
    const list = await refreshPrinters();
    if (!list.length) return okmsg('(no printers found)');
    list.forEach((p) => okmsg('- ' + p));
  },
});
cmd({
  name: 'setprinter', extra: true, usage: '/setprinter <printer>',
  desc: 'Choose the badge printer (press Tab to pick from installed printers).',
  wholeArg: true,                 // the whole argument is one value (names have spaces)
  complete: () => printerCache,   // dropdown of installed printers
  run: async (a) => {
    const name = a.join(' ').trim(); // join in case an unquoted multi-word name was typed
    if (!name) return err('Usage: /setprinter <printer>  (press Tab to pick one)');
    await repo.settings.set('badge_printer', name);
    okmsg('Badge printer set to: ' + name);
  },
});
cmd({
  name: 'autoprint', extra: true, usage: '/autoprint <on|off>', subcommands: ['on', 'off'],
  desc: 'Auto-print a badge on sign-in / check-in.',
  run: async (a) => {
    const v = (a[0] || '').toLowerCase();
    if (v !== 'on' && v !== 'off') return err('Usage: /autoprint <on|off>');
    await repo.settings.set('badge_autoprint', v === 'on' ? 'true' : 'false');
    okmsg('Auto-print ' + (v === 'on' ? 'enabled' : 'disabled') + '.');
  },
});
cmd({
  name: 'printerinfo', extra: true, usage: '/printerinfo [printer]',
  desc: "Show a printer's supported label sizes (Tab to pick a printer).",
  wholeArg: true,
  complete: () => printerCache,
  run: async (a) => {
    const info = await printService.printerInfo(a.join(' ').trim() || undefined);
    if (!info.valid) return err(info.reason || 'Printer not found or invalid.');
    okmsg('Default label: ' + info.default.name + '  (' + info.default.wmm + ' x ' + info.default.hmm + ' mm)');
    okmsg('Supported label sizes (set /set badge_width_mm & badge_height_mm to match):');
    info.papers.forEach((p) => okmsg('  - ' + p.name + '  (' + p.wmm + ' x ' + p.hmm + ' mm)'));
  },
});
cmd({
  name: 'printtest', extra: true, usage: '/printtest', desc: 'Print a sample badge to the configured printer.',
  run: async () => {
    const r = await printService.testPrint({});
    if (!r.printed) return okmsg('Test badge queued (job ' + r.jobId + ') for the on-premise print agent.');
    okmsg(r.file ? ('Test badge written to ' + r.file + (r.opened ? ' (opened for preview)' : ''))
                 : ('Test badge sent to ' + (r.printer || 'the printer') + '.'));
  },
});
cmd({
  name: 'printbadge', extra: true, usage: '/printbadge <visitId>', desc: 'Print the badge for a visit.',
  run: async (a) => {
    if (!a[0]) return err('Usage: /printbadge <visitId>');
    const r = await printService.printBadgeForVisit(a[0], {});
    okmsg(r.printed ? 'Badge sent to the printer.'
                    : 'Badge queued (job ' + r.jobId + ') for the on-premise print agent.');
  },
});

// ── EXIT ──────────────────────────────────────────────────────────────────────
cmd({ name: 'exit', alias: ['quit'], usage: '/exit', desc: 'Leave the console.', run: () => { /* handled in loop */ } });

// ── REPL loop ─────────────────────────────────────────────────────────────────
async function handle(line) {
  const raw = line.trim();
  if (!raw) return;
  const tokens = tokenize(raw.startsWith('/') ? raw.slice(1) : raw);
  const name = (tokens[0] || '').toLowerCase();
  const spec = byName.get(name);
  if (!spec) { err(`Unknown command "${name}". Type /help.`); return; }
  try {
    await spec.run(tokens.slice(1));
  } catch (e) {
    err(e && e.message ? e.message : String(e));
  }
}

// Suggestion engine — the list of possible completions for the text typed so far.
// Completes command names, then per-command subcommands / dynamic values
// (e.g. after "/kiosk accept " it lists the pending device codes). `replaced` is
// the token that a chosen suggestion replaces.
function suggestions(text) {
  const hasSlash = text.startsWith('/');
  const parts = (hasSlash ? text.slice(1) : text).split(/\s+/);

  // First token → command name.
  if (parts.length <= 1) {
    const word = (parts[0] || '').toLowerCase();
    const names = [...new Set(commands.map((c) => c.name))].sort();
    const hits = names.filter((n) => n.startsWith(word));
    const pref = hasSlash ? '/' : '';
    return { list: hits.map((n) => pref + n), replaced: (hasSlash ? '/' : '') + (parts[0] || '') };
  }

  // Later tokens → arguments for a known command.
  const spec = byName.get(parts[0].toLowerCase());

  // Whole-argument commands (e.g. /setprinter): everything after the command name
  // is ONE value, so we complete against the full remaining text (values may have
  // spaces, like printer names) and a chosen value replaces the whole thing.
  if (spec && spec.wholeArg) {
    const raw = hasSlash ? text.slice(1) : text;
    const afterCmd = raw.slice(parts[0].length).replace(/^\s+/, '');
    const cands = typeof spec.complete === 'function' ? (spec.complete([afterCmd]) || []) : (spec.subcommands || []);
    const w = afterCmd.toLowerCase();
    return { list: cands.filter((c) => String(c).toLowerCase().startsWith(w)), replaced: afterCmd };
  }

  const argParts = parts.slice(1);
  const word = (argParts[argParts.length - 1] || '').toLowerCase();
  let candidates = [];
  if (spec && typeof spec.complete === 'function') {
    try { candidates = spec.complete(argParts) || []; } catch (_) { candidates = []; }
  } else if (spec && spec.subcommands && argParts.length === 1) {
    candidates = spec.subcommands;
  }
  const hits = candidates.filter((c) => String(c).toLowerCase().startsWith(word));
  return { list: hits, replaced: argParts[argParts.length - 1] || '' };
}

// readline-style completer (used only for the piped / non-TTY fallback).
function completer(line) {
  const { list, replaced } = suggestions(line);
  return [list, replaced];
}

// Parse a command's parameter placeholders from its `usage` string, e.g.
// "/adduser <username> <password> [\"Full Name\"] [role]"
//   -> ['<username>', '<password>', '["Full Name"]', '[role]']
function paramsOf(spec) {
  if (spec._params) return spec._params;
  const rest = (spec.usage || '').replace(/^\/?\S+\s*/, ''); // drop the "/name" part
  spec._params = rest.match(/<[^>]*>|\[[^\]]*\]|"[^"]*"|\S+/g) || [];
  return spec._params;
}

// The "filler" ghost hint: the remaining parameter placeholders for what's typed so
// far. The current argument is left out when the dropdown already offers its values
// or when the user is actively typing it, so the hint always points at what's next.
function paramHint(text) {
  const body = text.startsWith('/') ? text.slice(1) : text;
  const firstSpace = body.indexOf(' ');
  if (firstSpace === -1) return '';                 // still typing the command name
  const spec = byName.get(body.slice(0, firstSpace).toLowerCase());
  if (!spec) return '';
  const params = paramsOf(spec);
  if (!params.length) return '';
  const rest = body.slice(firstSpace + 1);
  const endsSpace = rest === '' || /\s$/.test(rest);
  const args = rest.trim() ? rest.trim().split(/\s+/) : [];
  const currentIdx = endsSpace ? args.length : Math.max(0, args.length - 1);
  const hasDropdown = suggestions(text).list.length > 0;
  const start = currentIdx + ((hasDropdown || !endsSpace) ? 1 : 0);
  return params.slice(start).join(' ');
}

const PROMPT = 'visisign> ';
const MAXROWS = 8;

// Build the terminal frame (prompt line + suggestion box below) as an ANSI string.
// Pure function so it can be unit-tested. Shows a sliding window of the full list
// that scrolls to keep the highlighted item (`sel`) visible — no "…N more" line.
function frame(input, cursor, sel, scroll = 0) {
  const list = input.trim() ? suggestions(input.slice(0, cursor)).list : [];
  const n = list.length;
  if (n === 0) { sel = 0; scroll = 0; }
  else {
    sel = Math.max(0, Math.min(sel, n - 1));
    const maxScroll = Math.max(0, n - MAXROWS);
    scroll = Math.max(0, Math.min(scroll, maxScroll));
    if (sel < scroll) scroll = sel;                          // scrolled above the window
    else if (sel >= scroll + MAXROWS) scroll = sel - MAXROWS + 1; // below the window
  }
  const win = list.slice(scroll, scroll + MAXROWS);
  // Inline "filler" ghost hint of the remaining parameters, dimmed after the input.
  const ghost = input.trim() ? paramHint(input.slice(0, cursor)) : '';
  const ghostText = ghost ? (/\s$/.test(input) ? '' : ' ') + ghost : '';
  let buf = '\r\x1b[J' + PROMPT + input + (ghostText ? `\x1b[90m${ghostText}\x1b[0m` : '');
  const box = win.map((r, i) => {
    const idx = scroll + i;
    return idx === sel ? `\x1b[30;42m ${r} \x1b[0m` : `\x1b[90m ${r}\x1b[0m`;
  });
  if (box.length) {
    buf += box.map((l) => '\n' + l).join('');
    buf += `\x1b[${box.length}A`; // back up to the prompt line
  }
  const col = (PROMPT + input.slice(0, cursor)).length;
  buf += '\r' + (col > 0 ? `\x1b[${col}C` : '');
  return buf;
}

// ── Interactive editor with a live suggestion box (used on a real terminal) ────
// As you type, a dropdown of matching commands appears just below the prompt
// (like a game console). ↑/↓ move the highlight, Tab/→ accepts it, Enter runs.
function runInteractive() {
  let input = '';
  let cursor = 0;
  let sel = 0;     // index into the FULL suggestion list
  let scroll = 0;  // first visible row of the sliding window
  let busy = false;

  const curSug = () => (input.trim() ? suggestions(input.slice(0, cursor)) : { list: [], replaced: '' });
  const render = () => process.stdout.write(frame(input, cursor, sel, scroll));
  const resetSel = () => { sel = 0; scroll = 0; };

  // Move the highlight through the whole list (wrapping), scrolling to keep it in view.
  function move(delta) {
    const n = curSug().list.length;
    if (!n) return;
    sel = (sel + delta + n) % n;
    if (sel < scroll) scroll = sel;
    else if (sel >= scroll + MAXROWS) scroll = sel - MAXROWS + 1;
    const maxScroll = Math.max(0, n - MAXROWS);
    scroll = Math.max(0, Math.min(scroll, maxScroll));
    render();
  }

  function accept() {
    const { list, replaced } = curSug();
    if (!list.length) return false;
    const choice = list[Math.min(sel, list.length - 1)];
    const left = input.slice(0, cursor);
    const right = input.slice(cursor);
    const newLeft = left.slice(0, left.length - replaced.length) + choice + ' ';
    input = newLeft + right;
    cursor = newLeft.length;
    resetSel();
    return true;
  }

  function quit() {
    process.stdout.write('\r\x1b[J');
    out('\n  Goodbye.');
    try { process.stdin.setRawMode(false); } catch (_) { /* not a tty */ }
    process.exit(0);
  }

  function submit() {
    const line = input;
    process.stdout.write('\r\x1b[J' + PROMPT + line + '\n'); // commit the line, clear the box
    input = ''; cursor = 0; resetSel();
    const nm = (tokenize(line.trim().replace(/^\//, ''))[0] || '').toLowerCase();
    if (nm === 'exit' || nm === 'quit') return quit();
    if (!line.trim()) return render();
    busy = true;
    Promise.resolve()
      .then(() => handle(line))
      .catch((e) => err(e && e.message ? e.message : String(e)))
      .then(() => { busy = false; render(); });
  }

  function onKey(str, key) {
    if (busy) return;
    key = key || {};
    const name = key.name;
    if (key.ctrl && name === 'c') return quit();
    if (key.ctrl && name === 'd') { if (!input) return quit(); return; }
    if (name === 'return' || name === 'enter') return submit();
    if (name === 'tab' || (name === 'right' && cursor === input.length)) { if (accept()) render(); return; }
    if (name === 'up') return move(-1);
    if (name === 'down') return move(1);
    if (name === 'left') { if (cursor > 0) cursor--; render(); return; }
    if (name === 'right') { if (cursor < input.length) cursor++; render(); return; }
    if (name === 'home') { cursor = 0; render(); return; }
    if (name === 'end') { cursor = input.length; render(); return; }
    if (name === 'backspace') { if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor--; resetSel(); } render(); return; }
    if (name === 'delete') { if (cursor < input.length) { input = input.slice(0, cursor) + input.slice(cursor + 1); resetSel(); } render(); return; }
    if (name === 'escape') { resetSel(); render(); return; }
    // Printable input (strip any control chars, supports paste).
    if (str && !key.ctrl && !key.meta) {
      const clean = String(str).replace(/[\x00-\x1f]/g, '');
      if (clean) { input = input.slice(0, cursor) + clean + input.slice(cursor); cursor += clean.length; resetSel(); render(); }
    }
  }

  readline.emitKeypressEvents(process.stdin);
  try { process.stdin.setRawMode(true); } catch (_) { /* not a tty */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('keypress', onKey);
  out('  (start typing — suggestions appear below; ↑/↓ choose, Tab accepts, Enter runs)');
  out('');
  render();
}

// ── Plain line reader (used when input is piped / not a terminal) ──────────────
function runPiped() {
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt: PROMPT, completer,
  });
  rl.on('SIGINT', () => rl.close());
  let closed = false;
  const prompt = () => { if (!closed) { try { rl.prompt(); } catch (_) { /* closing */ } } };
  let queue = Promise.resolve();
  const enqueue = (fn) => { queue = queue.then(fn).catch((e) => err(e && e.message ? e.message : String(e))); };
  prompt();
  rl.on('line', (line) => {
    enqueue(async () => {
      const name = (tokenize(line.trim().replace(/^\//, ''))[0] || '').toLowerCase();
      if (name === 'exit' || name === 'quit') { rl.close(); return; }
      await handle(line);
      prompt();
    });
  });
  rl.on('close', () => { closed = true; enqueue(async () => { out('\n  Goodbye.'); process.exit(0); }); });
}

async function runConsole(opts = {}) {
  await migrate(); // ensure tables exist (idempotent)

  out('');
  if (opts.withServer) {
    out('  VisiSign server + console (one program).');
    out(`  Serving http://localhost:${opts.port || config.port}   ·   type /help, or /exit to stop everything.`);
  } else {
    out('  VisiSign console. Type /help for commands, /exit to quit.');
  }
  out(`  Database: ${config.db.client} - ${db.describe()}`);
  out('');

  // Warm the caches the synchronous tab-completer reads.
  refreshPrinters(); // so /setprinter can offer installed printers via Tab
  refreshKiosks();   // so /kiosk accept can offer pending device codes via Tab

  // A real terminal gets the live suggestion box; piped input uses a plain reader.
  if (process.stdin.isTTY && process.stdout.isTTY) runInteractive();
  else runPiped();
}

module.exports = { runConsole, completer, suggestions, frame, paramHint, refreshPrinters, refreshKiosks };
