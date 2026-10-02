'use strict';

// Seed script: creates the schema, a demo site/rooms/desks, default settings and
// an initial admin + sample staff user. Safe to re-run (skips existing rows).
//
//   npm run seed

const { migrate } = require('./connection');
const config = require('../config');
const repo = require('../repositories/repo');
const authService = require('../services/auth.service');

// Idempotent seeding. Exported so the packaged .exe can run it via `--seed`
// as well as the `npm run seed` dev script.
async function runSeed() {
  await migrate();

  // ── Settings defaults ──────────────────────────────────────────────────────
  const defaults = {
    org_name: 'VisiSign Demo Co.',
    require_photo: 'false',
    require_host: 'true',
    theme_default: 'system',
    // End-of-day auto-checkout: sign everyone out at this time each day.
    auto_signout_enabled: 'true',
    auto_signout_time: '17:00', // 5:00 pm
    // Kiosk devices must be accepted from the console before showing the kiosk UI.
    kiosk_require_approval: 'true',
    // Badge printing (server-side, via the Windows printer chosen in Admin).
    badge_printer: '',          // empty = not configured yet
    badge_autoprint: 'false',   // print automatically on sign-in / check-in
    badge_width_mm: '62',       // label size (Brother QL 62mm continuous by default)
    badge_height_mm: '90',
    // Where badges print: 'server' = the Windows printer on this PC,
    // 'device' = the tablet's own printing (AirPrint on iPad, Mopria on Android),
    // 'off' = don't print.
    badge_print_mode: 'server',
    // Reservation / pre-check-in window and slot sizing (capacity is unlimited).
    open_time: '09:00',
    close_time: '17:00',
    slot_minutes: '30',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!(await repo.settings.get(k))) await repo.settings.set(k, v);
  }

  // ── A site with rooms + desks ──────────────────────────────────────────────
  const sites = await repo.places.listSites();
  if (sites.length === 0) {
    const s = await repo.places.createSite({
      name: 'HQ — Main Building',
      address: '1 Market St',
      timezone: process.env.VISISIGN_TZ || process.env.TZ || 'UTC',
    });
    const siteId = s.lastInsertRowid;
    const r1 = await repo.places.createRoom({ site_id: siteId, name: 'Reception', floor: '1', capacity: 10 });
    const r2 = await repo.places.createRoom({ site_id: siteId, name: 'Open Plan', floor: '2', capacity: 40 });
    await repo.places.createDesk({ room_id: r1.lastInsertRowid, label: 'Front Desk' });
    for (let i = 1; i <= 6; i++) {
      await repo.places.createDesk({ room_id: r2.lastInsertRowid, label: `Desk ${i}` });
    }
    console.log('  ✓ Seeded site, rooms and desks');
  }

  // ── Default admin ──────────────────────────────────────────────────────────
  // Credentials come from the environment so a cloud deployment never ships
  // with a known password. On-premise keeps the familiar root/root default,
  // which is fine for a machine behind a reception desk but must not be exposed
  // to the internet — hence the hard refusal in production below.
  const adminUser = (process.env.SEED_ADMIN_USER || 'root').toLowerCase().trim();
  const adminPass = process.env.SEED_ADMIN_PASSWORD || 'root';

  if (config.isProd && adminPass === 'root') {
    throw new Error(
      'Refusing to seed the default root/root administrator in production.\n' +
      '  Set SEED_ADMIN_PASSWORD (and optionally SEED_ADMIN_USER) to a strong secret and run the seed again.'
    );
  }

  if (!(await repo.users.byEmail(adminUser))) {
    await authService.createUser({
      username: adminUser,
      password: adminPass,
      fullName: 'System Administrator',
      role: 'admin',
      accessLevel: 9,
      profile: { scope: 'global' },
    });
    const shown = process.env.SEED_ADMIN_PASSWORD ? '(from SEED_ADMIN_PASSWORD)' : `/  password: ${adminPass}`;
    console.log(`  ✓ Created admin  username: ${adminUser}  ${shown}`);
  } else {
    console.log(`  • Admin "${adminUser}" already exists — left untouched`);
  }

  console.log('\nSeed complete.\n');
}

module.exports = { runSeed };

// Allow running directly as a script: `node src/db/seed.js`.
if (require.main === module) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
