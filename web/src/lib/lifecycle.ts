import "server-only";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { ApiError, readLimitedBody } from "./http";
import { assertLiveJob, assertSafeName, getOwnedJob, markJobQueued, requestCleanup, validateCreateJob, type JobRecord } from "./jobs";
import { enqueueJob } from "./queue";

const HARD_UPLOAD_LIMIT = 104857600;

async function checkedDirectory(directory: string, create = false): Promise<string> {
  if (create) await mkdir(directory, { recursive: false }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || path.resolve(await realpath(directory)) !== path.resolve(directory)) throw new ApiError("INVALID_INPUT");
  return directory;
}

async function jobDirectory(job: JobRecord, create = false): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.jobKey)) throw new ApiError("INVALID_INPUT");
  const root = path.resolve(process.env.JOBS_DIR ?? "/jobs");
  if (root === path.parse(root).root) throw new ApiError("INVALID_INPUT");
  await checkedDirectory(root);
  return checkedDirectory(path.join(root, job.jobKey), create);
}

async function uploadingJob(id: string, userId: string): Promise<JobRecord> {
  const job = await getOwnedJob(id, userId);
  assertLiveJob(job);
  if (job.status !== "uploading") throw new ApiError("INVALID_JOB_STATE", 409);
  return job;
}

async function validateFile(file: File, job: JobRecord): Promise<void> {
  assertSafeName(file.name);
  if (!file.size) throw new ApiError("INVALID_INPUT");
  const head = Buffer.from(await file.slice(0, 8).arrayBuffer());
  const ext = path.extname(file.name).toLowerCase();
  const pdf = head.subarray(0, 5).toString("ascii") === "%PDF-";
  const png = head.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = head[0] === 255 && head[1] === 216 && head[2] === 255;
  const valid = job.operation === "image_to_pdf"
    ? (ext === ".png" && file.type === "image/png" && png) || ([".jpg", ".jpeg"].includes(ext) && file.type === "image/jpeg" && jpeg)
    : ext === ".pdf" && file.type === "application/pdf" && pdf;
  if (!valid) throw new ApiError("MIME_MISMATCH");
}

export async function uploadJob(request: Request, id: string, userId: string): Promise<{ status: "queued" }> {
  const job = await uploadingJob(id, userId);
  validateCreateJob(job);
  const configuredLimit = Number(process.env.MAX_UPLOAD_BYTES ?? HARD_UPLOAD_LIMIT);
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit <= 0) throw new ApiError("SERVICE_UNAVAILABLE", 503);
  const limit = Math.min(configuredLimit, HARD_UPLOAD_LIMIT);
  const body = await readLimitedBody(request, limit);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;")) throw new ApiError("INVALID_INPUT");
  let form: FormData;
  try { form = await new Response(body as BodyInit, { headers: { "content-type": contentType } }).formData(); }
  catch { throw new ApiError("INVALID_INPUT"); }
  if ([...form.keys()].some(key => key !== "files")) throw new ApiError("INVALID_INPUT");
  const files = form.getAll("files");
  if (files.length !== job.inputNames.length) throw new ApiError("INVALID_INPUT");
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (!(file instanceof File) || file.name !== job.inputNames[index]) throw new ApiError("INVALID_INPUT");
    await validateFile(file, job);
  }

  // Recheck after receiving the body, then acquire an exclusive on-disk lock.
  // This also excludes uploads reaching a second web process.
  await uploadingJob(id, userId);
  const directory = await jobDirectory(job, true);
  const lockPath = path.join(directory, ".upload.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new ApiError("UPLOAD_IN_PROGRESS", 409);
    throw error;
  });
  const written: string[] = [];
  let mayBeQueued = false;
  try {
    await uploadingJob(id, userId);
    const input = await checkedDirectory(path.join(directory, "input"), true);
    for (let index = 0; index < files.length; index++) {
      await uploadingJob(id, userId);
      await checkedDirectory(input);
      const target = path.join(input, String(index + 1).padStart(4, "0"));
      const destination = await open(target, "wx", 0o600);
      written.push(target);
      try { await destination.writeFile(Buffer.from(await (files[index] as File).arrayBuffer())); }
      finally { await destination.close(); }
    }
    // Mark first: the worker intentionally discards messages for uploading jobs.
    // If an upstream response is lost, preserve inputs for the worker/TTL cleanup.
    mayBeQueued = true;
    await markJobQueued(id, userId);
    await enqueueJob(job);
    return { status: "queued" };
  } finally {
    if (!mayBeQueued) {
      for (const target of written) await unlink(target).catch(() => undefined);
    }
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function downloadJob(id: string, userId: string): Promise<Response> {
  const job = await getOwnedJob(id, userId);
  assertLiveJob(job);
  if (job.status !== "ready") throw new ApiError("INVALID_JOB_STATE", 409);
  assertSafeName(job.outputName);
  if (!["result.pdf", "result.zip"].includes(job.outputName)) throw new ApiError("INVALID_INPUT");
  const directory = await jobDirectory(job);
  const output = await checkedDirectory(path.join(directory, "output"));
  const target = path.join(output, job.outputName);
  if ((await lstat(target)).isSymbolicLink()) throw new ApiError("INVALID_INPUT");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await file.close(); } };
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ApiError("INVALID_INPUT");
    const current = await getOwnedJob(id, userId);
    assertLiveJob(current);
    if (current.status !== "ready" || current.jobKey !== job.jobKey || current.outputName !== job.outputName) throw new ApiError("INVALID_JOB_STATE", 409);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await file.read(buffer);
          if (closed) return;
          if (bytesRead) { controller.enqueue(buffer.subarray(0, bytesRead)); return; }
          await close();
          try { await requestCleanup(id, userId); }
          catch { console.error("Download cleanup deferred to expiry"); }
          controller.close();
        } catch (error) { await close(); controller.error(error); }
      },
      async cancel() { await close(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: {
      "Content-Type": job.outputName.endsWith(".zip") ? "application/zip" : "application/pdf",
      "Content-Disposition": `attachment; filename="${job.outputName}"`,
      "Content-Length": String(info.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { await close(); throw error; }
}
