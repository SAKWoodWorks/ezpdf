# EZpdf

A local PDF workbench with email/password accounts, image-to-PDF, PDF-to-image,
merge, split, and Balanced/Smallest compression. Next.js handles authenticated
requests; a single Python worker consumes a Redis queue. PocketBase stores
accounts and job metadata only. File bytes live temporarily in `runtime/jobs`.
Cloudflare R2 storage is intentionally deferred.

## Requirements

- Docker Desktop with Linux containers and Docker Compose v2, or Docker Engine
  with Compose v2 on Linux. Allow Docker access to this project directory.
- Windows PowerShell 5.1 or PowerShell 7 for the smoke script.
- Free loopback ports (web defaults to 8007, PocketBase to 8009; both configurable
  via `WEB_PORT`/`POCKETBASE_PORT` in `.env`); internet access during image builds.

## First local start

Run these commands from the repository root:

```powershell
Copy-Item .env.example .env
```

Edit `.env`. Set `POCKETBASE_SUPERUSER_EMAIL` and a strong, unique
`POCKETBASE_SUPERUSER_PASSWORD` (at least 10 characters). These are server-only
credentials. `.env` is ignored by Git; never commit it or share `compose config`
output, which can contain resolved secrets.

```powershell
docker compose up --build -d
docker compose exec pocketbase sh -c 'pocketbase superuser upsert "$POCKETBASE_SUPERUSER_EMAIL" "$POCKETBASE_SUPERUSER_PASSWORD" --dir=/pb_data'
```

The second command creates the first PocketBase superuser using the values
already present inside the container. Run it again only when intentionally
synchronizing those credentials. The worker retries until setup is complete.
Open <http://localhost:8009/_/> to sign in to the administrator dashboard.
Both migrations run automatically at startup and create the `jobs` collection
with owner-scoped reads and server-only writes. Do not enable public job writes.

Open <http://localhost:3000/register> and create a regular user account. This
account is separate from the PocketBase superuser. Then sign in and use a tool.

PocketBase is built from its pinned [official v0.26.6 release](https://github.com/pocketbase/pocketbase/releases/tag/v0.26.6),
following its [Docker guidance](https://pocketbase.io/docs/going-to-production/#using-docker).
The previous third-party image tag was unavailable. The Dockerfile supports
amd64 and arm64 release binaries.

## Configuration

| Variable | Compose behavior |
| --- | --- |
| `POCKETBASE_SUPERUSER_EMAIL`, `POCKETBASE_SUPERUSER_PASSWORD` | Required in `.env`; used only by trusted services and initial setup. |
| `MAX_UPLOAD_BYTES` | Optional; defaults to 209715200 bytes (200 MiB). The web upload body limit cannot exceed 200 MiB. Multipart overhead counts toward this limit. |
| `JOB_TTL_SECONDS` | Optional; defaults to 3600 seconds from job creation. Must be a positive integer. |
| `POCKETBASE_URL` | Fixed to `http://pocketbase:8090` inside Compose. |
| `REDIS_URL` | Fixed to `redis://redis:6379/0` inside Compose. |
| `JOBS_DIR` | Fixed to `/jobs` inside Compose, bound to `./runtime/jobs`. |

The last three values in `.env.example` also describe direct process defaults;
editing them in `.env` does not change Compose's internal wiring. Restart with
`docker compose up -d` after changing Compose environment settings.

Web and worker run as UID/GID 10001. A short initialization service owns the
jobs root for that user, including on Linux bind mounts. This lets the worker
read web-created numbered input files with mode 0600 without relaxing their
permissions. Existing files from earlier deployments may need their ownership
corrected manually before reuse. Only web and PocketBase publish ports, both on
127.0.0.1. Worker and Redis remain on an internal Docker network with no host ports.
Run one worker only; processing recovery assumes one consumer.

## Verification

After first setup, with the stack running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
docker compose run --rm worker pytest -q
docker compose run --rm web npm test -- --run
docker compose run --rm web npm run lint
docker compose run --rm web npm run typecheck
```

On PowerShell 7, use `pwsh -File scripts/smoke-test.ps1`. The smoke script creates
a unique regular test account through registration, logs in with it, writes a
small PNG under a unique `runtime/smoke` subdirectory, uploads it, waits for the
worker, downloads a result beginning with `%PDF-`, and verifies that the exact
job directory existed and was removed after download. It reads that job's
private directory key through `docker compose exec worker`, so it must run on
the same host and project as Compose. No administrator credentials leave the
container. Smoke source/download files are deleted in `finally`; the test user
and expired metadata remain in PocketBase for inspection. Each run is isolated.

`GET /api/health` returns `{"status":"ok"}` only after Redis responds to PING;
an unavailable or stalled Redis connection returns 503 within five seconds.
This endpoint checks queue connectivity; the smoke test checks the full pipeline.

## Lifetime and shutdown

Successful download marks a job downloaded. The worker removes its inputs and
outputs on its next cleanup pass (normally within five seconds while idle),
then marks it expired. Abandoned, failed, and undownloaded jobs are cleaned after
their TTL. Interrupted processing is marked failed and cleaned on worker restart.
Filesystem cleanup retries after temporary failures. PocketBase metadata remains;
it does not contain file binaries. A stopped worker cannot clean files until it
runs again. Redis has no persistent queue configuration; this is a local workflow,
not a durable distributed job service.

```powershell
docker compose logs --tail 100 web worker
docker compose down
```

`down` stops only this Compose project and preserves its PocketBase volume and
host bind mount. Avoid `down --volumes` unless you intend to permanently remove
this project's accounts and metadata. Downloaded files and expired temporary
files are removed permanently by normal cleanup. If startup fails, check Docker
is running, ports are free, `.env` is populated, and first superuser setup ran.
