# Local PDF Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker Compose localhost PDF utility with authenticated users, temporary job files, and five basic PDF operations.

**Architecture:** The Next.js web service owns authentication checks, upload/download endpoints, and job records in PocketBase. A Python worker consumes Redis jobs and reads/writes only `runtime/jobs/<uuid>` through a shared bind mount, using native PDF tools. Cleanup removes each job directory after download or 60-minute expiry.

**Tech Stack:** Next.js + TypeScript, PocketBase, Redis list queue, Python 3.12, qpdf, Ghostscript, Poppler, img2pdf, Pillow, Docker Compose, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-09-22-local-pdf-manager-design.md`

## Global Constraints

- Support image-to-PDF, PDF-to-image, merge, split, and compress only.
- Limit a job upload to 100 MB.
- Store user files only under `./runtime/jobs/<uuid>/`; add this path to `.gitignore` and never use a Docker named volume for it.
- Delete job files after successful download or after 60 minutes.
- PocketBase stores users and job metadata only, never file binaries.
- Run one conversion job concurrently at first; worker resource limits are one CPU and 1.5 GB memory.
- Expose no public ports for worker or Redis.
- Use non-root execution and avoid shell interpolation for native processing commands.

---

## Target file structure

```text
.
├── docker-compose.yml
├── .env.example
├── .gitignore
├── web/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/app/
│   ├── src/components/
│   ├── src/lib/auth.ts
│   ├── src/lib/jobs.ts
│   ├── src/lib/queue.ts
│   └── tests/
├── worker/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── app/config.py
│   ├── app/contracts.py
│   ├── app/processor.py
│   ├── app/cleanup.py
│   ├── app/worker.py
│   └── tests/
├── pocketbase/
│   └── pb_migrations/1700000000_create_jobs.js
└── runtime/jobs/.gitkeep
```

### Task 1: Compose foundation and local service contract

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `web/Dockerfile`
- Create: `worker/Dockerfile`
- Create: `worker/requirements.txt`
- Create: `runtime/jobs/.gitkeep`

**Interfaces:**
- Produces Docker service DNS names `web`, `worker`, `redis`, and `pocketbase`.
- Produces shared absolute container directory `/jobs` mapped from `./runtime/jobs` for `web` and `worker`.
- Produces environment variables `POCKETBASE_URL`, `REDIS_URL`, `JOBS_DIR`, `MAX_UPLOAD_BYTES`, and `JOB_TTL_SECONDS`.

- [ ] **Step 1: Create the failing Compose smoke-check script**

```powershell
docker compose config
if ($LASTEXITCODE -ne 0) { throw 'Compose configuration is invalid' }
```

- [ ] **Step 2: Run the smoke check before Compose exists**

Run: `docker compose config`

Expected: FAIL because `docker-compose.yml` does not exist.

- [ ] **Step 3: Add Compose configuration and Dockerfiles**

`docker-compose.yml` must declare this exact service intent:

```yaml
services:
  web:
    build: ./web
    environment:
      POCKETBASE_URL: http://pocketbase:8090
      REDIS_URL: redis://redis:6379/0
      JOBS_DIR: /jobs
      MAX_UPLOAD_BYTES: "104857600"
      JOB_TTL_SECONDS: "3600"
    volumes: [./runtime/jobs:/jobs]
    ports: ["3000:3000"]
  worker:
    build: ./worker
    environment:
      POCKETBASE_URL: http://pocketbase:8090
      REDIS_URL: redis://redis:6379/0
      JOBS_DIR: /jobs
      JOB_TTL_SECONDS: "3600"
    volumes: [./runtime/jobs:/jobs]
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 1536M }
  redis:
    image: redis:7-alpine
  pocketbase:
    image: spectado/pocketbase:0.26.7
    volumes: [pocketbase_data:/pb_data]
volumes:
  pocketbase_data:
```

Use an internal Compose network for all services. Do not define `ports` for `worker` or `redis`. Make both Dockerfiles create and select a non-root user. Install `qpdf`, `ghostscript`, `poppler-utils`, and worker Python packages in the worker image. Add `runtime/`, `.env`, `.next/`, `node_modules/`, `web/node_modules/`, `web/.next/`, `__pycache__/`, and `.pytest_cache/` to `.gitignore`, with an exception for `runtime/jobs/.gitkeep`.

- [ ] **Step 4: Run Compose validation**

Run: `docker compose config`

Expected: PASS and output includes `web`, `worker`, `redis`, and `pocketbase`.

- [ ] **Step 5: Commit the foundation when Git has been initialized**

```bash
git add .gitignore .env.example docker-compose.yml web/Dockerfile worker/Dockerfile worker/requirements.txt runtime/jobs/.gitkeep
git commit -m "chore: add local PDF service compose foundation"
```

### Task 2: PocketBase schema and worker contracts

**Files:**
- Create: `pocketbase/pb_migrations/1700000000_create_jobs.js`
- Create: `worker/app/contracts.py`
- Create: `worker/tests/test_contracts.py`

**Interfaces:**
- Produces PocketBase `jobs` collection fields: `owner`, `operation`, `status`, `inputNames`, `outputName`, `errorCode`, `createdAt`, `expiresAt`, `downloadedAt`.
- Produces `JobPayload` with `id: str`, `owner_id: str`, `operation: Operation`, `input_names: list[str]`, and `options: dict[str, object]`.
- Produces allowed operations `image_to_pdf`, `pdf_to_image`, `merge_pdf`, `split_pdf`, and `compress_pdf`.

- [ ] **Step 1: Write failing contract tests**

```python
import pytest
from app.contracts import JobPayload, Operation

def test_payload_accepts_known_operation():
    job = JobPayload.from_dict({"id": "j1", "ownerId": "u1", "operation": "merge_pdf", "inputNames": ["a.pdf"], "options": {}})
    assert job.operation is Operation.MERGE_PDF

def test_payload_rejects_unknown_operation():
    with pytest.raises(ValueError, match="Unsupported operation"):
        JobPayload.from_dict({"id": "j1", "ownerId": "u1", "operation": "edit_pdf", "inputNames": [], "options": {}})
```

- [ ] **Step 2: Run the contract tests**

Run: `docker compose run --rm worker pytest tests/test_contracts.py -q`

Expected: FAIL because `app.contracts` does not exist.

- [ ] **Step 3: Implement schema and contracts**

Implement `Operation` as a string enum and `JobPayload.from_dict()` with explicit required-key checks. The migration creates an authenticated-only `jobs` collection with `owner` as a required relation to `_pb_users_auth_`; its list/view/update/delete rules must constrain records to `owner = @request.auth.id`. Web service uses PocketBase admin credentials only server-side; browser never receives them.

- [ ] **Step 4: Run contract tests again**

Run: `docker compose run --rm worker pytest tests/test_contracts.py -q`

Expected: PASS.

- [ ] **Step 5: Commit schema and contracts**

```bash
git add pocketbase/pb_migrations worker/app/contracts.py worker/tests/test_contracts.py
git commit -m "feat: define job schema and queue contracts"
```

### Task 3: Worker validation and PDF processing primitives

**Files:**
- Create: `worker/app/config.py`
- Create: `worker/app/processor.py`
- Create: `worker/tests/test_processor.py`

**Interfaces:**
- Consumes `JobPayload` from `app.contracts` and a job directory at `/jobs/<job-id>`.
- Produces `process_job(job: JobPayload, jobs_dir: Path) -> ProcessingResult`.
- Produces one output file named `result.pdf`, `result.zip`, or a deterministic split archive; never uses a submitted filename as a path.

- [ ] **Step 1: Write failing processor tests**

```python
from pathlib import Path
from app.contracts import JobPayload
from app.processor import validate_input_file

def test_rejects_pdf_named_as_image(tmp_path: Path):
    fake = tmp_path / "photo.png"
    fake.write_bytes(b"%PDF-1.7")
    assert validate_input_file(fake, "image_to_pdf") == "mime_mismatch"

def test_job_directory_is_uuid_scoped(tmp_path: Path):
    job = JobPayload.from_dict({"id": "550e8400-e29b-41d4-a716-446655440000", "ownerId": "u", "operation": "merge_pdf", "inputNames": ["a.pdf"], "options": {}})
    assert (tmp_path / job.id).name == job.id
```

- [ ] **Step 2: Run the processor tests**

Run: `docker compose run --rm worker pytest tests/test_processor.py -q`

Expected: FAIL because `app.processor` does not exist.

- [ ] **Step 3: Implement safe native command execution and operations**

Implement `run_tool(args: list[str], timeout_seconds: int = 300)` using `subprocess.run(args, shell=False, check=True, timeout=timeout_seconds)`. Implement:

```python
def process_image_to_pdf(inputs: list[Path], output: Path) -> None: ...
def process_pdf_to_images(input_pdf: Path, output_dir: Path, image_format: str) -> Path: ...
def process_merge(inputs: list[Path], output: Path) -> None: ...
def process_split(input_pdf: Path, output_dir: Path, page_spec: str) -> Path: ...
def process_compress(input_pdf: Path, output: Path, preset: str) -> None: ...
```

Use `img2pdf` for image-to-PDF, `pdftoppm` followed by zip creation for PDF-to-image, `qpdf --empty --pages` for merge, `qpdf --split-pages` for split, and Ghostscript PDF settings selected only from `balanced` or `smallest` for compression. Validate PDF signature (`%PDF-`) and image content using Pillow before invoking native tools. Return stable client error codes including `unsupported_type`, `mime_mismatch`, `password_protected`, `invalid_page_range`, `tool_timeout`, and `processing_failed`.

- [ ] **Step 4: Add representative fixture tests and run them**

Add a 1-page generated PDF and a generated PNG fixture inside test setup, then run:

Run: `docker compose run --rm worker pytest tests/test_processor.py -q`

Expected: PASS for validation plus image-to-PDF, merge, split, PDF-to-image ZIP, and both compression presets.

- [ ] **Step 5: Commit the processor**

```bash
git add worker/app/config.py worker/app/processor.py worker/tests/test_processor.py
git commit -m "feat: add safe PDF processing worker primitives"
```

### Task 4: Queue consumer, metadata transitions, and cleanup

**Files:**
- Create: `worker/app/pocketbase_client.py`
- Create: `worker/app/cleanup.py`
- Create: `worker/app/worker.py`
- Create: `worker/tests/test_cleanup.py`
- Create: `worker/tests/test_worker.py`

**Interfaces:**
- Consumes `JobPayload`, `process_job`, Redis queue `pdf-jobs`, and PocketBase job records.
- Produces `enqueue` payload shape `{ id, ownerId, operation, inputNames, options }`.
- Produces statuses `queued`, `processing`, `ready`, `failed`, `downloaded`, and `expired`.

- [ ] **Step 1: Write failing cleanup and status-transition tests**

```python
from datetime import UTC, datetime, timedelta
from app.cleanup import expired_job_directories

def test_expired_job_is_selected_for_removal(tmp_path):
    folder = tmp_path / "job-1"
    folder.mkdir()
    old = datetime.now(UTC) - timedelta(seconds=3601)
    assert expired_job_directories(tmp_path, {"job-1": old}, 3600) == [folder]
```

- [ ] **Step 2: Run worker tests**

Run: `docker compose run --rm worker pytest tests/test_cleanup.py tests/test_worker.py -q`

Expected: FAIL because cleanup and queue consumer modules do not exist.

- [ ] **Step 3: Implement queue worker and cleanup**

Use a Redis list named `pdf-jobs`, with the web service appending UTF-8 JSON payloads through `LPUSH` and one Python worker blocking on `BRPOP`. Before processing, update the record to `processing`; on success set `ready` and `outputName`; on a handled failure set `failed` and the stable error code. `cleanup.py` must recursively remove only directories whose names match a job ID supplied by PocketBase metadata, never arbitrary paths. It deletes folders after `downloaded` or expiry and updates the record to `expired`. On startup, mark stale `processing` jobs failed, then clean their folders.

- [ ] **Step 4: Run all worker tests**

Run: `docker compose run --rm worker pytest -q`

Expected: PASS.

- [ ] **Step 5: Commit worker orchestration**

```bash
git add worker/app/pocketbase_client.py worker/app/cleanup.py worker/app/worker.py worker/tests
git commit -m "feat: process queued jobs and clean temporary files"
```

### Task 5: Next.js project, authenticated job API, and upload/download lifecycle

**Files:**
- Create: `web/package.json`
- Create: `web/src/lib/auth.ts`
- Create: `web/src/lib/jobs.ts`
- Create: `web/src/lib/queue.ts`
- Create: `web/src/app/api/jobs/route.ts`
- Create: `web/src/app/api/jobs/[id]/upload/route.ts`
- Create: `web/src/app/api/jobs/[id]/download/route.ts`
- Create: `web/tests/jobs.test.ts`

**Interfaces:**
- Consumes authenticated PocketBase user and `POST /api/jobs` body `{ operation, inputNames, options }`.
- Produces job creation response `{ id, status: "uploading" }`.
- Produces upload endpoint that writes only to `/jobs/<id>/input/` and returns `{ status: "queued" }`.
- Produces authenticated download endpoint that streams a `ready` output, then enqueues deletion.

- [ ] **Step 1: Write failing API tests**

```ts
import { describe, expect, it } from "vitest";
import { assertOwnedJob } from "@/lib/jobs";

describe("assertOwnedJob", () => {
  it("rejects a job owned by another user", () => {
    expect(() => assertOwnedJob({ owner: "user-a" }, "user-b")).toThrow("JOB_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run the API test**

Run: `docker compose run --rm web npm test -- jobs.test.ts`

Expected: FAIL because the Next.js project and job modules do not exist.

- [ ] **Step 3: Scaffold web app and implement server-side APIs**

Create a minimal Next.js App Router project. `auth.ts` reads a PocketBase session cookie and returns `{ id: string }` or rejects unauthenticated requests. `jobs.ts` creates/reads updates through PocketBase and exposes:

```ts
export function assertOwnedJob(job: { owner: string }, userId: string): void;
export async function createJob(input: CreateJobInput, userId: string): Promise<JobRecord>;
export async function markJobQueued(jobId: string, userId: string): Promise<void>;
```

The upload route must reject request bodies above `104857600`, reject filenames with path separators, revalidate ownership before every write, and use the server-generated input index filename (`0001`, `0002`) rather than the supplied name. Enqueue only after all declared input files are present and valid. The download route revalidates ownership and `ready` status, streams the output with `Content-Disposition: attachment`, and invokes the cleanup request only after stream completion.

- [ ] **Step 4: Run web tests and lint**

Run: `docker compose run --rm web npm test -- --run && docker compose run --rm web npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit authenticated job APIs**

```bash
git add web/package.json web/src/lib web/src/app/api web/tests
git commit -m "feat: add authenticated job upload and download APIs"
```

### Task 6: Authentication and tool UI

**Files:**
- Create: `web/src/app/login/page.tsx`
- Create: `web/src/app/register/page.tsx`
- Create: `web/src/app/page.tsx`
- Create: `web/src/app/tools/[operation]/page.tsx`
- Create: `web/src/components/auth-form.tsx`
- Create: `web/src/components/job-uploader.tsx`
- Create: `web/src/components/job-status.tsx`
- Create: `web/src/app/api/jobs/[id]/route.ts`
- Create: `web/tests/tool-pages.test.tsx`

**Interfaces:**
- Consumes `POST /api/jobs`, upload endpoint, and `GET /api/jobs/:id` status endpoint.
- Produces pages for the five `Operation` values and authenticated navigation.
- Produces user-visible statuses queued, processing, ready, failed, and expired.

- [ ] **Step 1: Write failing UI tests**

```tsx
import { render, screen } from "@testing-library/react";
import ToolPage from "@/app/tools/[operation]/page";

it("renders merge PDF upload instructions", async () => {
  render(await ToolPage({ params: Promise.resolve({ operation: "merge_pdf" }) }));
  expect(screen.getByText(/merge pdf/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the UI tests**

Run: `docker compose run --rm web npm test -- tool-pages.test.tsx`

Expected: FAIL because pages and components do not exist.

- [ ] **Step 3: Implement pages and controls**

Implement login/registration with PocketBase email-password auth and an httpOnly session cookie created by Next.js. Dashboard shows only the current user's non-expired jobs. `job-uploader.tsx` selects files with per-operation `accept` values and submits job creation then upload. For split, require a page specification such as `1-3,5`; for PDF-to-image offer `png` or `jpg`; for compression offer exactly `balanced` and `smallest`. Poll the status endpoint every two seconds only while queued/processing, expose a download button only while ready, and show mapped stable errors rather than raw worker logs.

- [ ] **Step 4: Run UI tests and build**

Run: `docker compose run --rm web npm test -- --run && docker compose run --rm web npm run build`

Expected: PASS.

- [ ] **Step 5: Commit user interface**

```bash
git add web/src/app web/src/components web/tests/tool-pages.test.tsx
git commit -m "feat: add authenticated PDF tool interface"
```

### Task 7: End-to-end compose verification and operations documentation

**Files:**
- Create: `README.md`
- Create: `scripts/smoke-test.ps1`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes a running `docker compose up --build` stack.
- Produces a documented local startup process and an image-to-PDF smoke-test result.

- [ ] **Step 1: Write the failing smoke test**

```powershell
$health = Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health
if ($health.StatusCode -ne 200) { throw "Web health endpoint failed" }
```

- [ ] **Step 2: Run it before adding health support**

Run: `powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1`

Expected: FAIL because `/api/health` does not exist.

- [ ] **Step 3: Add health endpoint, smoke flow, and README**

Add `/api/health` returning JSON `{ "status": "ok" }` after checking Redis connectivity. The script must create a small PNG in a disposable `runtime/smoke` directory, authenticate a test user through documented local setup, submit image-to-PDF, poll until ready, download the result, assert it begins with `%PDF-`, and assert the job directory is removed. README must document prerequisites, first PocketBase admin setup, environment variables, `docker compose up --build`, test commands, cleanup behavior, and that R2 is intentionally deferred.

- [ ] **Step 4: Run full verification**

Run: `docker compose up --build -d; powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1; docker compose run --rm worker pytest -q; docker compose run --rm web npm test -- --run; docker compose down`

Expected: all commands PASS; downloaded artifact is a PDF and temporary job content is removed.

- [ ] **Step 5: Commit final verification assets**

```bash
git add README.md scripts/smoke-test.ps1 docker-compose.yml web/src/app/api/health
git commit -m "docs: add local setup and end-to-end PDF smoke test"
```

## Plan self-review

- Spec coverage: Tasks 1–7 cover all five PDF tools, authentication, PocketBase metadata, Redis queue, temporary files, expiry, worker restrictions, security validation, UI, tests, Docker Compose, and future R2 isolation.
- No file-binary persistence is introduced: PocketBase stores metadata and only `runtime/jobs` holds file contents.
- Operation and queue types are introduced before their use; all status names are consistent with the design spec.
- The workspace is not currently a Git repository. Commit steps apply only after the implementer initializes or is given a repository; they must not reset or overwrite unrelated files.
