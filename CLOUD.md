# Running VisiSign in the cloud

VisiSign now runs in two shapes from one codebase:

| | **On-premise** | **Cloud / container** |
|---|---|---|
| Where | the reception PC | Cloud Run, App Runner, ECS, Fly, a VM, your NAS |
| Package | `VisiSign.exe` | a Docker image |
| Database | SQLite, one file | PostgreSQL (Cloud SQL, RDS, Neon, …) |
| Photos | a folder on disk | S3 / GCS bucket, or a volume |
| Label printer | driven directly | the [print agent](#badge-printing) at reception |
| iPad / Android printing | works | **works, unchanged** |
| Admin console (`--console`) | yes | no terminal; use the web admin |

Nothing about the on-premise build changed. The `.exe` still works exactly as before.

---

## The short version

```bash
cp .env.cloud.example .env     # fill in DATABASE_URL, JWT_SECRET, CORS_ORIGINS, VISISIGN_TZ
docker compose up -d --build
docker compose run --rm app node server.js --seed    # first run only
```

Then open <http://localhost:4000>. That same image is what you deploy to a cloud
provider — only the environment variables differ.

---

## What actually had to change, and why

Four things in the original design assume the server *is* the reception PC. Each
one is a genuine blocker in the cloud, and each is now configurable rather than
assumed.

### 1. SQLite → PostgreSQL

SQLite is a file. A container's filesystem is wiped on every deploy, and two
instances writing one file corrupts it. So the data layer grew a second backend.

Selecting it is one variable:

```bash
DATABASE_URL=postgres://user:pass@host:5432/visisign
```

There is no separate "cloud build". The repository layer writes one set of
queries that run on both, because:

- queries use `?` placeholders and the Postgres driver rewrites them to `$1, $2…`
- **timestamps are stored as TEXT** (`YYYY-MM-DD HH:MM:SS`, UTC) in *both*
  schemas, so every range filter, sort and date comparison is the identical
  string operation either way
- booleans are `0`/`1` integers in both, so `is_active = 1` needs no translation
- the handful of real differences (`datetime('now')` vs `to_char(now() …)`,
  `julianday()` vs `EXTRACT(EPOCH …)`, `LIKE` vs `ILIKE`) go through
  `src/db/dialect.js`

Storing timestamps as TEXT trades Postgres interval arithmetic for a query layer
that cannot silently disagree between backends. Timezone handling moved up into
the application instead — see below.

> **Scale note.** This is a visitor sign-in system: a busy reception does tens of
> writes an hour. The smallest managed Postgres any provider sells is already far
> more than enough.

### 2. The business day is no longer the server's clock

"Sign everyone out at 17:00" meant 5pm on the reception PC. A container runs in
UTC, so that would fire mid-afternoon in New York and overnight in Sydney.

Reservation dates, time slots and the end-of-day sweep now resolve against an
explicit timezone:

```bash
VISISIGN_TZ=America/New_York
```

**If you set nothing else, set this one.** Everything still works without it —
it just measures the day in UTC, which is quietly wrong rather than loudly broken.

### 3. Visitor photos

A photo written by one instance is invisible to the next and gone on redeploy.
Photos now go through a storage interface:

```bash
STORAGE_DRIVER=s3           # or gcs, or local
PHOTOS_BUCKET=my-visisign-photos
```

Credentials are **not** configured — the SDKs read the instance's own IAM role
(Cloud Run service account, ECS task role), so no long-lived keys are deployed.

The SDK is an extra install, only if you use it:

```bash
npm install @aws-sdk/client-s3        # S3, Cloudflare R2, MinIO, Spaces
npm install @google-cloud/storage     # Google Cloud Storage
```

`STORAGE_DRIVER=local` is fine for a single instance with a mounted volume.

### 4. Badge printing

See the dedicated section below — this is the one that genuinely cannot be
solved by configuration alone.

### Also handled

- **Multiple instances** — the end-of-day sweep takes a Postgres advisory lock,
  so it runs once no matter how many containers are up.
- **Graceful shutdown** — `SIGTERM` stops accepting connections, drains in-flight
  requests and closes the pool, so a deploy never cuts a sign-in in half.
- **Schema migration on boot** — guarded by an advisory lock so instances
  starting together cannot race. Prefer a one-shot job? Use `--migrate`.
- **Health endpoints** — `/api/health` is liveness (no database check, so a
  database blip does not thrash restarts); `/api/ready` is readiness and does
  check it.
- **Production guard rails** — the app refuses to boot in production with a
  default `JWT_SECRET`, with `CORS_ORIGINS=*`, or with SQLite in a container
  unless you set `DB_CLIENT=sqlite` to say you meant it. Seeding refuses to
  create the old `root`/`root` admin.

---

## Badge printing

Three routes to paper, and which ones exist depends on where the server runs.

### iPad AirPrint and Android Mopria — works from the cloud, no setup

This was already built (`frontend/scripts/kiosk.js`): the badge is laid out at
the configured label size and the tablet prints it itself. It is entirely
client-side, so **it works from the cloud with no agent and no configuration.**

In Admin → Settings set:

```
badge_print_mode = device
```

An iPad sends it to AirPrint; an Android tablet to Mopria / its print service.
If your reception already prints from the tablet, you are finished — skip the
rest of this section.

### A label printer at reception — needs the print agent

A Brother QL, DYMO or Zebra on a USB cable is not reachable from Google Cloud or
AWS, and you should not want it to be — that means opening a path into the
building.

So badges become a **queue**, and a small agent on the reception PC drains it by
polling **outward** over HTTPS:

```
 kiosk ──▶ cloud VisiSign ──▶ print_jobs row
                                  │   agent polls OUT over HTTPS
                                  ▼
               reception PC ──▶ print agent ──▶ Windows spooler ──▶ label
```

No port forward, no VPN, no tunnel, no static IP.

The agent reuses `print.windows.js` verbatim — the same PowerShell/GDI+ renderer
the on-premise build uses — so a cloud-printed badge is identical to an
on-premise one, down to the driver-specific label sizing.

**Set it up:**

1. On the server, set a shared secret (this also switches the agent API on; leave
   it unset and the API stays closed):

   ```bash
   PRINT_AGENT_TOKEN=$(openssl rand -hex 32)
   ```

2. On the reception PC (Windows, Node 22.5+), from an elevated PowerShell:

   ```powershell
   .\agent\Install-PrintAgent.ps1 `
       -ServerUrl https://visisign.example.com `
       -AgentToken <the same secret>
   ```

   It verifies the server and the token **before** installing anything, then
   registers a task that starts at boot and restarts if it stops.

3. In Admin → Settings, pick the printer. The agent reports the printers it can
   see, so the dropdown is populated even though the server has none.

To watch it work, run it in a window instead:

```powershell
$env:VISISIGN_URL='https://visisign.example.com'
$env:PRINT_AGENT_TOKEN='<secret>'
node agent\agent.js
```

Jobs an agent claims but never finishes (the PC slept, the printer jammed) go
back on the queue after `PRINT_STALE_SECONDS`. Outcomes, including driver
errors, are visible in Admin and at `GET /api/print/jobs`.

### Off

`badge_print_mode = off` — badges exist on screen as QR codes only.

---

## Deploying

The image is provider-neutral. Build once:

```bash
docker build -t visisign .
```

### Google Cloud Run

```bash
PROJECT=my-project
REGION=us-central1

gcloud sql instances create visisign-db --database-version=POSTGRES_16 \
    --tier=db-f1-micro --region=$REGION
gcloud sql databases create visisign --instance=visisign-db

gcloud builds submit --tag gcr.io/$PROJECT/visisign

gcloud run deploy visisign \
  --image gcr.io/$PROJECT/visisign \
  --add-cloudsql-instances $PROJECT:$REGION:visisign-db \
  --set-env-vars "VISISIGN_TZ=America/New_York,CORS_ORIGINS=https://visisign.example.com" \
  --set-secrets "JWT_SECRET=visisign-jwt:latest,DATABASE_URL=visisign-db-url:latest" \
  --region $REGION --allow-unauthenticated
```

The Cloud SQL socket form of the URL:

```
postgres://visisign:PASSWORD@/visisign?host=/cloudsql/PROJECT:REGION:INSTANCE
```

Seed once, as a job:

```bash
gcloud run jobs create visisign-seed --image gcr.io/$PROJECT/visisign \
  --add-cloudsql-instances $PROJECT:$REGION:visisign-db \
  --set-secrets "DATABASE_URL=visisign-db-url:latest,SEED_ADMIN_PASSWORD=visisign-admin-pw:latest" \
  --command node --args "server.js,--seed" --region $REGION
gcloud run jobs execute visisign-seed --region $REGION
```

Grant the service account `roles/storage.objectAdmin` on the photo bucket if you
set `STORAGE_DRIVER=gcs`.

### AWS App Runner / ECS

```bash
aws ecr create-repository --repository-name visisign
docker tag visisign:latest <acct>.dkr.ecr.<region>.amazonaws.com/visisign:latest
docker push <acct>.dkr.ecr.<region>.amazonaws.com/visisign:latest
```

Create an RDS PostgreSQL instance (`db.t4g.micro` is plenty), put `DATABASE_URL`
and `JWT_SECRET` in Secrets Manager, and reference them from the service. Give
the task role `s3:GetObject`/`s3:PutObject` on the photo bucket if you set
`STORAGE_DRIVER=s3`.

Run the seed once as a one-off task with `--seed`.

### Anywhere else

`docker-compose.yml` brings up the app and its own Postgres. That is the whole
deployment for a NAS, an office PC or a small VM.

---

## Testing

Three suites, runnable against either backend:

```bash
cd backend

npm run test:db                      # data layer: dialect, transactions, locks
npm run test:api                     # the whole REST API end to end
npm run test:agent                   # the print agent protocol

# against Postgres
DATABASE_URL=postgres://... npm run test:db
```

`test/db.js` exists specifically to cover the SQL that *differs* between the two
backends — timestamp format, duration arithmetic, `LIKE`/`ILIKE`, `COUNT(*)`
typing, `RETURNING id`, advisory locks — which is where a two-backend port
actually breaks.

Current status: **48/48** API, **33/33** data layer on *both* SQLite and
PostgreSQL 18.6, **35/35** agent protocol.

---

## Configuration reference

Every variable is documented in [`.env.cloud.example`](.env.cloud.example).
In production only four really matter:

| Variable | Why |
|---|---|
| `DATABASE_URL` | selects Postgres; without it you get SQLite |
| `JWT_SECRET` | signs sessions — boot fails on the default |
| `CORS_ORIGINS` | boot fails on `*` |
| `VISISIGN_TZ` | or the business day is measured in UTC |

---

## Migrating existing data

There is no automatic SQLite → Postgres copier. The schemas match table for
table and column for column, so if you have live data worth keeping, the
practical route is a dump and load with a tool like `pgloader`, then
`node server.js --migrate` to confirm the schema, and a spot check of
`visits`, `users` and `settings`.

For a fresh deployment, just `--seed`.
