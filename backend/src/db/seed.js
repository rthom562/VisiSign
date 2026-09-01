'use strict';

// Seed script: creates the schema, a demo site/rooms/desks, default settings and
// an initial admin + sample staff user. Safe to re-run (skips existing rows).
//
//   npm run seed

const { migrate } = require('./connection');
const repo = require('../repositories/repo');
const authService = require('../services/auth.service');

// Idempotent seeding. Exported so the packaged .exe can run it via `--seed`
// as well as the `npm run seed` dev script.
async function runSeed() {
  migrate();

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
    if (!repo.settings.get(k)) repo.settings.set(k, v);
  }

  // ── A site with rooms + desks ──────────────────────────────────────────────
  let sites = repo.places.listSites();
  if (sites.length === 0) {
    const s = repo.places.createSite({ name: 'HQ — Main Building', address: '1 Market St', timezone: 'UTC' });
    const siteId = s.lastInsertRowid;
    const r1 = repo.places.createRoom({ site_id: siteId, name: 'Reception', floor: '1', capacity: 10 });
    const r2 = repo.places.createRoom({ site_id: siteId, name: 'Open Plan', floor: '2', capacity: 40 });
    repo.places.createDesk({ room_id: r1.lastInsertRowid, label: 'Front Desk' });
    for (let i = 1; i <= 6; i++) {
      repo.places.createDesk({ room_id: r2.lastInsertRowid, label: `Desk ${i}` });
    }
    console.log('  ✓ Seeded site, rooms and desks');
  }

  // ── Default admin ──────────────────────────────────────────────────────────
  if (!repo.users.byEmail('root')) {
    await authService.createUser({
      username: 'root',
      password: 'root',
      fullName: 'System Administrator',
      role: 'admin',
      accessLevel: 9,
      profile: { scope: 'global' },
    });
    console.log('  ✓ Created admin  username: root  /  password: root');
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
