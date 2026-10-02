# VisiSign

A visitor sign-in management system, built as **two strictly separated layers**:

```
┌─────────────────────────┐      HTTPS / JSON       ┌──────────────────────────┐
│  FRONTEND (presentation) │  ───────────────────▶   │  BACKEND (data + logic)  │
│  /frontend               │   secure REST API only  │  /backend                │
│  HTML · CSS · JS         │  ◀───────────────────   │  API · services · DB     │
└─────────────────────────┘    only needed data      └──────────────────────────┘
```

The HTML dashboard **never** touches the database. Every request travels through a
secured REST API. The backend validates input, enforces roles/rules, talks to the
tables, and returns only the data the dashboard needs.

---

## Two ways to run it

| | **On-premise** (this README) | **Cloud / Docker** ([CLOUD.md](CLOUD.md)) |
|---|---|---|
| Package | `VisiSign.exe` on the reception PC | a container image |
| Database | SQLite, one file | PostgreSQL |
| Photos | a folder next to the database | S3 / GCS bucket, or a volume |
| Label printer | driven directly by the host | the on-premise [print agent](CLOUD.md#badge-printing) |
| iPad / Android printing | AirPrint / Mopria | **identical — works from the cloud** |

It is one codebase: the backend picks its database from `DATABASE_URL`, and the
on-premise build is unchanged. Everything below still applies to it.

See **[CLOUD.md](CLOUD.md)** to deploy to Google Cloud, AWS, or your own Docker host.

---

## Folder layout

```
VisiSign/
├── README.md
├── frontend/                 # Layer 1 — what users see
│   ├── index.html            # MAIN page = RESERVATIONS (pick date + slot, book)
│   ├── kiosk.html            # KIOSK (sign-in / sign-out / check-in) — type-in link, needs approval
│   ├── reserve.html          # redirect → / (kept for old links)
│   ├── admin.html            # ADMIN console — a SEPARATE page
│   ├── vendor/
│   │   └── qrcode-generator.js # QR library, bundled locally (works offline)
│   ├── styles/
│   │   ├── base.css          # design tokens, light/dark themes, layout
│   │   └── components.css     # buttons, cards, tables, forms, modals
│   └── scripts/
│       ├── api.js            # the ONLY way the UI talks to the backend
│       ├── store.js          # tiny client state + theme + session
│       ├── ui.js             # render helpers, toasts, QR rendering
│       ├── reserve.js        # reservations controller (the main page)
│       ├── kiosk.js          # kiosk controllers (pairing gate, sign-in/out, check-in)
│       └── admin.js          # admin console controllers (login + dashboard)
│
├── backend/                  # Layer 2 — data + business logic
│   ├── package.json
│   ├── .env.example
│   ├── server.js             # entrypoint (--seed, --migrate, --console)
│   ├── test/                 # run against EITHER database backend
│   │   ├── smoke.js          # the whole REST API, end to end
│   │   ├── db.js             # the SQL that differs between backends
│   │   └── agent.js          # the print-agent protocol
│   └── src/
│       ├── app.js            # express app wiring (security, routes)
│       ├── config.js         # env-driven config + production guard rails
│       ├── db/
│       │   ├── connection.js # picks a driver, exposes one async interface
│       │   ├── dialect.js    # the few real SQLite/Postgres SQL differences
│       │   ├── drivers/
│       │   │   ├── sqlite.js     # node:sqlite, one file (on-premise)
│       │   │   └── postgres.js   # pg pool, ?->$n rewriting (cloud)
│       │   ├── schema.sql            # SQLite tables + indexes + keys
│       │   ├── schema.postgres.sql   # the same schema, Postgres
│       │   └── seed.js       # demo sites/rooms/desks + admin user
│       ├── storage/          # visitor photos: local disk, S3 or GCS
│       │   ├── index.js
│       │   ├── local.js
│       │   ├── s3.js
│       │   └── gcs.js
│       ├── middleware/
│       │   ├── auth.js       # JWT verify + role guards
│       │   ├── agent.js      # print-agent token auth
│       │   ├── error.js      # central error handler
│       │   └── validate.js   # request validation helper
│       ├── services/         # business rules (no HTTP here)
│       │   ├── auth.service.js
│       │   ├── visit.service.js
│       │   ├── admin.service.js
│       │   ├── print.service.js    # picks a print transport
│       │   ├── print.windows.js    # the PowerShell/GDI+ badge renderer
│       │   ├── print.queue.js      # the queue the print agent drains
│       │   └── log.service.js
│       ├── repositories/     # the ONLY code that runs SQL
│       │   └── repo.js
│       ├── routes/           # HTTP surface -> services
│       │   ├── index.js
│       │   ├── auth.routes.js
│       │   ├── visits.routes.js
│       │   ├── print.routes.js
│       │   └── admin.routes.js
│       └── utils/
│           ├── ids.js        # id / key / QR generation
│           ├── time.js       # the business day, in the site's timezone
│           └── http.js       # async wrapper + responses
│
├── agent/                    # on-premise print agent (cloud deployments)
│   ├── agent.js              # polls the server OUT over HTTPS for badges
│   └── Install-PrintAgent.ps1
│
├── Dockerfile                # the container image
├── docker-compose.yml        # app + Postgres, for self-hosting
├── .env.cloud.example        # every cloud setting, documented
└── CLOUD.md                  # deploying to Google Cloud / AWS / Docker
```

---

## Quick start

```bash
cd backend
npm install
cp .env.example .env        # then edit JWT_SECRET for production
npm run seed                # creates DB, tables, demo data + admin
npm run dev                 # API on http://localhost:4000
```

Then open the dashboard. The simplest way is to let the backend serve it:

```
http://localhost:4000/
```

(The backend statically serves `/frontend` for convenience in dev. In production
the two layers can be deployed on separate hosts — the API has CORS + JWT and does
not depend on the frontend being co-located.)

---

## Pages & entry points

| Purpose | Link | Page | Who uses it |
|---------|------|------|-------------|
| **Reservations (MAIN)** | `/` (also `/reserve`) | `index.html` | everyone — the default page |
| **Kiosk** | `/kiosk` (also `/ipad`) — **type it in** | `kiosk.html` | the on-site device; **must be approved from the console** |
| Admin console | `/admin` | `admin.html` | staff/admins |

The **main page is the reservations page** — the root and all the main links land
there. The **kiosk is a separate link you type in** (`/kiosk`); nothing links to it
from the main pages, and a device must be **accepted from the console** before it
shows the kiosk (see [Kiosk devices](#kiosk-devices)).

**Flow**

1. **Reserve** (the main page `/`) — pick a **date** and **time slot**, fill in the
   form, submit. Time slots are **unlimited** — any number of people can book the
   same slot. On success the visitor gets **clear instructions on how to check in on
   the reception kiosk** (no QR/screenshot needed — they're already in the system).
2. **On arrival**, on the **kiosk** (`/kiosk`), the visitor taps
   **“I have a reservation,”** finds their name in today's list (the ones due around
   *now* are highlighted), and taps **Check in** — which creates the visit and issues
   their badge/QR.
3. **Admins** get a **Reservations** tab (pick any date) to see all bookings with
   contact details and cancel if needed.

Slot window/size is admin-tunable via settings: `open_time`, `close_time`,
`slot_minutes`.

Relevant API (reservations go through the same secure layer):
`GET /api/reservations/slots`, `POST /api/reservations`,
`GET /api/reservations/current`, `POST /api/reservations/:id/checkin`,
`GET /api/reservations/admin` *(admin)*, `POST /api/reservations/:id/cancel` *(admin)*.

> **QR codes** (walk-in and check-in badges) are generated by a **locally bundled**
> library (`vendor/`), so they render as real scannable images even offline / inside
> the .exe.

---

## Kiosk devices

The kiosk lives at a link you **type in** (`/kiosk`) and every device must be
**approved from the console** before it will show the kiosk UI:

1. Open `http://<host>:<port>/kiosk` on the device. It shows a **4-character code**
   and "Waiting for approval."
2. In the VisiSign console, run `/kiosk request` to see pending devices, then
   `/kiosk accept <code>`.
3. The device polls and switches to the kiosk automatically once accepted.

Console commands:

| Command | Does |
|---|---|
| `/kiosk` | list accepted kiosks |
| `/kiosk request` | list pending device requests |
| `/kiosk accept <code>` | approve a device |
| `/kiosk revoke <code>` | remove an accepted device |
| `/kiosk reject <code>` | reject a pending request |

The same actions exist on the admin API (`GET /api/kiosk`, `POST /api/kiosk/:code/accept`,
`POST /api/kiosk/:code/revoke`). To skip approval entirely (any device is a kiosk),
set the `kiosk_require_approval` setting to `false`.

---

## Badge printing

VisiSign prints visitor badges **from the VisiSign PC through the Windows print
spooler** — not from the tablet. Connect your label printer (Brother, DYMO, Zebra,
or any printer with a Windows driver) to the machine running VisiSign by **USB or
network**, and the OS/driver own the connection. This is far more reliable than
tablet Bluetooth, and it works with every installed printer.

**Setup (once):**
1. Install the printer's Windows driver on the VisiSign PC and confirm Windows can
   print to it. **Load your label roll and pick that DK/label size in the printer's
   own Windows printing preferences** (esp. Brother QL / DYMO / Zebra).
2. Open **Admin → Settings → 🖨️ Badge printing**.
3. Pick the printer from the dropdown. Its **supported label sizes** appear below —
   click the one you loaded to fill in the width/height (or type them). Then click
   **Print test badge**.
4. Optionally tick **Print a badge automatically on sign-in / check-in**.

> **Label printers only accept sizes their driver defines.** VisiSign never forces
> an unknown size (that's what made a Brother QL test print fail) — it matches a
> supported size or uses the printer's default label. Use **Admin → Badge printing**
> (or console `/printerinfo`) to see the exact sizes your printer supports and set
> the width/height to match your roll.

**How badges get printed:**
- **Automatically** at sign-in / reservation check-in (if auto-print is on).
- **On demand** — the kiosk badge screen has a **🖨️ Print badge** button (reprints too).
- **From the console** — `/printers`, `/printerinfo` (a printer's label sizes),
  `/setprinter` (press **Tab** to pick from your installed printers),
  `/autoprint <on|off>`, `/printtest`, `/printbadge <visitId>`.

Each badge shows the visitor's **photo** (if enabled), name, company, host, date, a
scannable QR, and the badge code. Server-side badges are rendered with .NET
`System.Drawing.Printing` (built into Windows — no extra software). If a print
fails, it's logged and raised as an admin alert rather than blocking sign-in.

### Visitor photo
Tick **“Take the visitor's photo at the kiosk”** in Admin → Badge printing
(setting `require_photo`). The kiosk then asks for a photo during sign-in and prints
it on the badge. It uses the **live camera** where the browser allows it, and
otherwise falls back to the device's **native camera app** via a file input — so it
works on an iPad/Android tablet even over plain HTTP. Photos are stored next to the
database in a `photos/` folder.

> Browsers only allow the *live* camera preview on a secure origin (HTTPS or
> localhost). Over plain HTTP the kiosk automatically uses the tablet's camera app
> instead, which works fine — you just tap **Take photo**.

### Where badges print
Setting `badge_print_mode`:

| Mode | What happens |
|---|---|
| `server` *(default)* | Prints on the Windows printer attached to the **VisiSign PC**. Most reliable. |
| `device` | Prints from the **tablet itself** — **AirPrint** on iPad, **Mopria / the built-in print service** on Android. The kiosk shows the device's print dialog with a badge-sized page. |
| `off` | No badge printing. |

Other settings: `badge_printer`, `badge_autoprint`, `badge_width_mm`,
`badge_height_mm`.

API: `GET /api/print/printers` *(admin)*, `POST /api/print/test` *(admin)*,
`POST /api/print/badge/:visitId`.

---

## Signing out & end-of-day auto-checkout

**Sign out by name (no Visit ID).** On the kiosk, **Sign out** shows a list of the
people currently on site. Visitors just **tap their name** (or type a few letters to
filter) — no badge/ID needed. The list is served by a public, minimal endpoint
(`GET /api/visits/onsite`) that returns only name / company / host / time-in — never
email or phone.

**Everyone is checked out at 5 o'clock.** A background job signs out everyone still
on site at the daily cutoff (default **17:00**). It runs once per day: after the
cutoff the first check sweeps everyone out and records the date, so people who sign
in later that evening aren't swept again. If the app is started after the cutoff, it
sweeps immediately on launch. Each sweep writes an audit log entry and raises an
info alert. Tunable via admin **Settings**:

| Setting | Default | Meaning |
|---|---|---|
| `auto_signout_enabled` | `true` | turn the end-of-day sweep on/off |
| `auto_signout_time` | `17:00` | cutoff time (24-hour, local) |

You can also trigger it manually anytime from the console with `/signout all`.

---

## Command console

VisiSign has a built-in **admin command console** — it lives inside the same
`VisiSign.exe` (no separate program). There are two ways to use it:

**A) All-in-one window — server *and* console in one process:**
- Double-click **`Start-VisiSign.cmd`**, or run **`VisiSign.exe --serve-console`**.
- One window serves the kiosk / reservations / admin pages **and** gives you the
  `visisign>` prompt. Commands act on the very server that's running. `/exit` stops
  everything. (Use this *or* the tray — not both at once; they'd share a port.)

**B) Console only (alongside the tray / a running server):**
- **Tray icon → “Open command console,”** double-click **`VisiSign-Console.cmd`**,
  or run **`VisiSign.exe --console`**.
- Opens just the console; it shares the same live database as the running app, so
  changes appear immediately in the dashboards (SQLite/WAL).

In development, the same modes are `node server.js --serve-console` and
`node server.js --console`.

```
visisign> /help          # common commands
visisign> /help extra    # advanced commands
```

As you type, a **live suggestion box** drops down under the prompt showing the
matching commands (like a game console). Use **↑/↓** to move the highlight — the list
**scrolls** to follow it through all the matches — **Tab** (or **→**) accepts the
highlighted one, and **Enter** runs.

Once you're past the command name, dim **parameter hints** ("fillers") appear inline
showing what to type next — e.g. `/adduser ` shows `<username> <password> ["Full Name"]
[role]`, and they shrink as you fill each one in. Where an argument has known values
(like `/kiosk accept `) the box lists them instead. (When input is piped rather than
typed at a real terminal, it falls back to a plain line reader with Tab completion.)

Commands work with or without a leading `/`. Highlights: `/status`, `/onsite`,
`/signin "<name>"`, `/signout <id|all>`, `/search`, `/reservations`, `/checkin`,
`/kiosk` (accept devices), `/printers` · `/setprinter` · `/printtest` (badges),
`/users`, `/adduser`, `/passwd`, `/resetadmin`, `/settings`, `/set`, `/export`,
`/backup`, and more (see `/help extra`). Type `/exit` to leave.

> Lost the admin password? Open the console and run `/resetadmin` (resets to
> `root`/`root`) or `/resetadmin <username> <password>`.

---

## Running as a system-tray app (no console window)

Ship these files together (they're placed in `dist/` by the build):

```
VisiSign.exe          the host (also contains the command console)
VisiSign-Tray.ps1     the tray controller
VisiSign.vbs          hidden tray launcher  ← double-click for background use
Start-VisiSign.cmd    all-in-one window: server + console together
VisiSign-Console.cmd  opens the command console only (use with the tray)
```

**Double-click `VisiSign.vbs`.** VisiSign starts with **no console window** — just an
icon in the Windows notification area (the hidden-items “^” tray). On first run it
auto-creates the database and admin account.

**Right-click the tray icon** for:
- **Open visitor dashboard**
- **Open admin console**
- **Open command console** (the REPL below, in a new window)
- **Quit VisiSign** (stops the host)

To start it automatically at login, put a shortcut to `VisiSign.vbs` in your
Startup folder (`Win+R` → `shell:startup`).

---

## Building a standalone Windows .exe

The whole host (API + bundled dashboard + built-in SQLite) can be packaged into a
single `VisiSign.exe` that runs on a machine with **no Node.js installed**.

```bash
# from the project root (VisiSign/)
npm install            # installs the packager (@yao-pkg/pkg)
npm run build:exe      # -> dist/VisiSign.exe  (~89 MB, self-contained)
```

Run it:

```bat
:: 1) create the database + first admin (once, in the folder you'll run from)
VisiSign.exe --seed

:: 2) start the host — serves the dashboard + API
VisiSign.exe
```

Then open the **visitor kiosk** at **http://localhost:4000/** and the
**admin console** at **http://localhost:4000/admin.html**.

- The frontend and `schema.sql` are **bundled inside** the exe (read-only snapshot).
- The database file (`visisign.db`) and an optional `.env` are read/written **next
  to the exe**, so run it from a writable folder (not `C:\Program Files`).
- Configure by dropping a `.env` beside the exe, e.g. `PORT=8080` and a strong
  `JWT_SECRET`. See `backend/.env.example` for all keys.

The build targets `node24-win-x64` (whose embedded runtime includes `node:sqlite`).
Change the target in the `build:exe` script in the root `package.json` for other
platforms.

### Default admin (created by the seed)

The login is a **plain username — it does not have to be an email**:

```
username: root
password: root
```

Change it immediately via **Admin → Users**. Usernames can be anything
(`root`, `reception`, `jane`, or an email address if you prefer).

---

## Running while you make changes

You don't have to stop the app to change it.

**Editing the dashboard (HTML/CSS/JS) — no restart, no rebuild:**
- **In development:** run `npm run dev` in `/backend`. The frontend is served
  straight from the `/frontend` folder, so edit a file and refresh the browser.
- **With the packaged .exe:** drop a `frontend/` folder next to `VisiSign.exe`.
  If present, the exe serves the dashboard from that folder (live-editable) instead
  of the copy bundled inside it. Edit a file, refresh — the change is live while the
  app keeps running and visitors stay connected. Startup prints
  `Live frontend: …` when this is active. (Delete the folder to go back to the
  bundled UI.)

**Editing backend logic (routes/services/DB):**
- Run `npm run dev` — it uses `node --watch`, which reloads the server the moment
  you save. (The packaged .exe has its backend compiled in, so backend changes
  there require a `npm run build:exe`.)

So the normal loop is: keep `npm run dev` running and just edit files. Only rebuild
the .exe when you want a new distributable.

---

## The two layers, concretely

### Layer 1 — Frontend (`/frontend`)
- Two separate pages: **`index.html`** (visitor kiosk) and **`admin.html`**
  (admin console). Visitors never see admin code; admin lives on its own page.
- Pure HTML/CSS/JS, **no framework, no build** → fast first paint.
- Responsive for phone / tablet / desktop (CSS grid + clamp typography).
- Light & dark mode (system-aware, user-toggleable, persisted).
- Large touch-friendly buttons for kiosk-style sign-in.
- All network access is funneled through `scripts/api.js`. No SQL, no DB strings,
  no business rules live here.

### Layer 2 — Backend (`/backend`)
- **routes** → thin HTTP adapters.
- **services** → business rules, validation, role checks, history keeping.
- **repositories** → the only place SQL is written.
- **db** → SQLite with WAL mode for many concurrent readers/writers.
- Security: `helmet`, `cors`, rate limiting, `bcrypt` password hashing, JWT
  sessions, parameterised queries everywhere (no string-built SQL).

### Tables (see `backend/src/db/schema.sql`)
`sites`, `rooms`, `desks`, `users`, `staff`, `admins`, `guests`, `visits`,
`badges`, `alerts`, `logs`, `reservations`, plus `settings`.

Everything is linked by integer primary keys and foreign keys; visits reference
guest/staff/site/room/desk; badges reference visits; alerts and logs reference the
actor and target. Full history is preserved (rows are closed, not deleted).

---

## Roles & access levels
| Role  | Page | Can do |
|-------|------|--------|
| guest | `index.html` (visitor kiosk) | self sign-in / sign-out (no login) |
| admin | `admin.html` (separate page) | live lists, search, manage users, export reports, settings |

Access is enforced in `middleware/auth.js` (`requireAuth`, `requireRole`) and again
in the services, so the rules hold no matter which route calls them.

---

## Scaling & safety notes
- Stateless API (JWT) → run many instances behind a load balancer.
- SQLite/WAL is fine for small/medium deployments; the repository layer is the only
  thing that knows about the DB, so swapping in Postgres later touches one folder.
- Input is validated at the edge and rules are re-checked in services.
- Audit `logs` table records who did what, when.
