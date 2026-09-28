# EZpdf project guide

## Purpose

EZpdf is a localhost-first PDF workbench. Authenticated users can convert
images to PDF, export PDF pages as images, merge PDFs, split PDFs, and compress
PDFs with either a balanced or smallest-file preset. User files are temporary:
they are deleted after a successful download or when their job expires.
Cloudflare R2 storage is intentionally deferred.

## Repository layout

The application was developed in the `.worktrees/local-pdf-manager` worktree
and has been fully merged into `master`; the repository root is now the
canonical home of the working application.

```text
.
├── docs/superpowers/         # Design spec and implementation plan
├── PROJECT.md                # This guide
├── README.md                 # Operational instructions
├── docker-compose.yml        # Local service stack
├── web/                      # Next.js 16 / React 19 application
├── worker/                   # Python PDF-processing queue worker
├── pocketbase/               # PocketBase image and migrations
├── runtime/jobs/             # Temporary job files (gitignored)
└── scripts/smoke-test.ps1    # End-to-end local smoke test
```

Run application commands from the repository root.

## Architecture

```text
Browser → Next.js web → Redis queue → Python worker
              │                         │
              └──── PocketBase ─────────┘
                         │
                runtime/jobs/<job-id>
```

- **Web (`web`)**: authentication, job APIs, upload/download streaming, and UI.
- **Worker (`worker`)**: validates input and invokes `img2pdf`, Poppler, qpdf,
  and Ghostscript. It processes one queued job at a time.
- **PocketBase**: user accounts and job metadata only; it never stores file
  bytes.
- **Redis**: transient queue transport only, with no persistent queue volume.
- **Job storage**: a shared host bind mount at `runtime/jobs`, mounted as
  `/jobs` in web and worker containers.

Only web (`127.0.0.1:3000`) and PocketBase (`127.0.0.1:8090`) publish host
ports. Redis and the worker remain on an internal Docker network.

## Prerequisites

- Docker Desktop with Linux containers and Docker Compose v2 (or Docker Engine
  plus Compose v2 on Linux)
- PowerShell 5.1+ or PowerShell 7 for the smoke test
- Free loopback ports 3000 and 8090

## Local setup

From the repository root:

```powershell
Copy-Item .env.example .env
```

Set `POCKETBASE_SUPERUSER_EMAIL` and a strong
`POCKETBASE_SUPERUSER_PASSWORD` in `.env`. These credentials are server-only;
do not commit `.env` or share resolved Compose configuration containing secrets.

```powershell
docker compose up --build -d
docker compose exec pocketbase sh -c 'pocketbase superuser upsert "$POCKETBASE_SUPERUSER_EMAIL" "$POCKETBASE_SUPERUSER_PASSWORD" --dir=/pb_data'
```

Create a normal application account at `http://localhost:3000/register`.
PocketBase administration is available at `http://localhost:8090/_/`.

See `README.md` for the detailed operational instructions.

## Verification

With the stack running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
docker compose run --rm worker pytest -q
docker compose run --rm web npm test -- --run
docker compose run --rm web npm run lint
docker compose run --rm web npm run typecheck
```

`GET /api/health` confirms Redis connectivity. The smoke test exercises the
full image-to-PDF flow, verifies the downloaded PDF signature, and confirms
the temporary job directory is removed.

## Data lifecycle and safety

- Every job is owned by one authenticated PocketBase user; APIs check ownership
  before job reads, uploads, and downloads.
- The worker verifies file types and binary content, uses generated filenames,
  runs native commands without a shell, and exposes stable client error codes.
- Successful downloads are marked for cleanup; failed, abandoned, and
  undownloaded jobs are removed after the TTL. Metadata remains for inspection,
  but file bytes do not.
- `docker compose down` preserves the PocketBase volume and the host job mount.
  Do not use `docker compose down --volumes` unless you intend to permanently
  remove accounts and metadata.

## Current development status

All seven implementation-plan tasks are complete and merged into `master`.
The deployed feature set matches
`docs/superpowers/specs/2026-09-22-local-pdf-manager-design.md`, which is the
authoritative product design. Deferred follow-ups include Cloudflare R2 file
storage and any multi-worker queue hardening.
