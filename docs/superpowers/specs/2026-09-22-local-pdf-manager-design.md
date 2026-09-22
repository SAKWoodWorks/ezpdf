# Local PDF Manager — Design

## Goal

Build a localhost-first, authenticated PDF utility similar in scope to basic iLovePDF tools. It must provide image-to-PDF, PDF-to-image, merge, split, and compression. User files must never be retained as application history: they are temporary and deleted after download or expiry.

## Scope

- Next.js web application with TypeScript.
- PocketBase authentication and job metadata.
- Redis-backed queue.
- A separate worker container that invokes native PDF utilities.
- Docker Compose local development and production-compatible service boundaries.
- Maximum uploaded input size: 100 MB per job.
- One concurrent conversion job initially.

Out of scope: billing, public sharing, OCR, editing/annotation, permanent file history, Cloudflare R2, and multi-machine scaling.

## Architecture

```text
Browser -> Next.js web -> Redis -> PDF worker
                |                    |
                v                    v
          PocketBase          runtime/jobs/<job-id>
       (users + metadata)       (temporary files only)
```

Services are defined in one Docker Compose project:

| Service | Responsibility | Persistence / network exposure |
| --- | --- | --- |
| `web` | Next.js UI, authenticated APIs, job creation and download authorization | Port exposed locally only in development |
| `worker` | Fetch queue jobs, validate/process files, clean job directories | No public ports; shares temporary `runtime/jobs` directory with `web` |
| `redis` | Job queue only | No persistent volume; internal network only |
| `pocketbase` | User login and job metadata | Persistent `pb_data` named volume; internal network (or localhost port in development) |

Temporary files reside at `./runtime/jobs/<uuid>/` on the host bind mount for the `web` and `worker` containers. The directory is gitignored. It does not use a Docker named volume. Deleting this directory or removing the local workspace deletes all user files. A production deployment can use a dedicated host path with the same cleanup contract.

## User and job flow

1. The user registers or logs in through PocketBase.
2. The web service creates a job record containing the owner, operation, state, original filenames, timestamps, expiry, and safe error information. It stores no file data in PocketBase.
3. The browser uploads one or more files to an authenticated web endpoint. The endpoint limits the request to 100 MB and writes files to the new job directory.
4. The web service enqueues the job in Redis and marks it `queued`.
5. The worker atomically claims the job, marks it `processing`, validates every file, and runs the selected tool.
6. The worker writes results only inside the job directory, removes input files after successful processing where possible, and marks the job `ready`.
7. The authenticated owner downloads one result through a web endpoint. A successful completed response marks the job `downloaded` and schedules deletion immediately.
8. Cleanup deletes input/output folders and marks records expired after 60 minutes, including failed, abandoned, and downloaded jobs.

If services restart, a recovery pass marks interrupted `processing` jobs as failed and removes their job folders. The user can retry by creating a new job.

## PDF processing

The worker image contains pinned native tools and a thin Python service:

| Tool | Usage |
| --- | --- |
| `img2pdf` / Pillow | JPG and PNG to PDF |
| Poppler (`pdftoppm`) | PDF pages to PNG or JPG |
| `qpdf` | Merge and split PDFs, structural validation |
| Ghostscript | Compression presets |

Operations run with explicit page/file limits and a five-minute process timeout. The worker executes jobs as a non-root user and launches native processes without a shell.

## Security and limits

- Every job belongs to exactly one PocketBase user; job APIs query by both job ID and owner ID.
- File extensions, MIME values, and binary signatures are verified before processing.
- Inputs are limited to approved types, 100 MB per job, and operation-specific page/image limits.
- Job directory names are UUIDs; original filenames never form filesystem paths.
- `worker`, Redis, and PocketBase do not expose public ports.
- Docker containers use resource limits. Initial worker limit: one CPU, 1.5 GB memory, and concurrency one.
- Errors returned to clients are generic; detailed diagnostics are written only to container logs without file content.

## UI

- Authentication: login and registration.
- Dashboard lists active jobs only, showing queued, processing, ready, failed, and expired states.
- Five tool pages share an upload/progress/download pattern.
- Compression offers `balanced` and `smallest` presets, warning that aggressive compression can reduce image quality.

## Testing

- Unit tests for operation validation, job ownership, expiry calculation, and queue payload parsing.
- Integration tests with representative PDFs/images for all five operations.
- Negative tests for corrupted files, password-protected PDFs, unsupported types, over-limit uploads, job timeout, and invalid page ranges.
- Authorization tests prove users cannot inspect or download another user's job.
- Cleanup tests verify files are removed after download, expiry, and interrupted work.
- Docker Compose smoke test verifies all services start and complete a simple image-to-PDF job.

## Deployment evolution

The web, worker, and file-storage interfaces are separated. A later R2 migration replaces local upload/download storage with presigned-object operations while preserving PocketBase, queue, job states, PDF tools, and frontend behavior.
