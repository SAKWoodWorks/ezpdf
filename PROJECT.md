# EZpdf project guide

## Purpose

EZpdf is a localhost-first PDF workbench. Authenticated users can convert
images to PDF, export PDF pages as images, merge PDFs, split PDFs, and compress
PDFs with either a balanced or smallest-file preset. User files are temporary:
they are deleted after a successful download or when their job expires.

## Repository layout

`master` currently contains the project design and implementation plan only.
The working application is in the linked worktree at
`.worktrees/local-pdf-manager` on branch `feat/local-pdf-manager`.

Run application commands from that worktree unless you are specifically editing
the planning documentation in the repository root.

```text
.
├── docs/superpowers/                 # Design and implementation plan
├── PROJECT.md                        # This guide
└── .worktrees/local-pdf-manager/     # Active application worktree
    ├── web/                          # Next.js 16 / React 19 application
    ├── worker/                       # Python PDF-processing queue worker
    ├── pocketbase/                   # PocketBase image and migrations
    ├── runtime/jobs/                 # Temporary job files (gitignored)
    ├── scripts/smoke-test.ps1        # End-to-end local smoke test
    └── docker-compose.yml            # Local service stack
```

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

From `.worktrees/local-pdf-manager`:

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

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `POCKETBASE_SUPERUSER_EMAIL` | required | PocketBase administrative email |
| `POCKETBASE_SUPERUSER_PASSWORD` | required | PocketBase administrative password |
| `MAX_UPLOAD_BYTES` | `104857600` | Maximum total upload size per job (100 MiB) |
| `JOB_TTL_SECONDS` | `3600` | Temporary file lifetime from job creation |
| `POCKETBASE_URL` | `http://pocketbase:8090` | Internal PocketBase service URL |
| `REDIS_URL` | `redis://redis:6379/0` | Internal Redis service URL |
| `JOBS_DIR` | `/jobs` | Container path for temporary job files |

The Compose stack fixes the internal URLs and job directory; changing their
example values in `.env` does not rewire Compose.

## Verification

With the stack running, run:

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

The active worktree contains the implemented application and has additional
uncommitted end-to-end documentation/health-check changes. Consult its
`README.md` for the most detailed operational instructions, and the root
`docs/superpowers/specs/2026-09-22-local-pdf-manager-design.md` for the
authoritative product design.
