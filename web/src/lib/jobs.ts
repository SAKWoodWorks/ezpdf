import "server-only";
import { randomUUID } from "node:crypto";
import { ApiError } from "./http";
import { adminRequest } from "./pocketbase";

export const OPERATIONS = ["image_to_pdf", "pdf_to_image", "merge_pdf", "split_pdf", "compress_pdf"] as const;
export type Operation = typeof OPERATIONS[number];
export type JobStatus = "uploading" | "queued" | "processing" | "ready" | "failed" | "downloaded" | "expired";
export type CreateJobInput = { operation: Operation; inputNames: string[]; options: Record<string, string> };
export type JobRecord = CreateJobInput & {
  id: string; jobKey: string; owner: string; status: JobStatus;
  createdAt: string; expiresAt: string; outputName?: string; errorCode?: string; downloadedAt?: string;
};

export function assertOwnedJob(job: { owner: string }, userId: string): void {
  if (!userId || job.owner !== userId) throw new ApiError("JOB_NOT_FOUND", 404);
}

export function assertSafeName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") {
    throw new ApiError("INVALID_INPUT");
  }
}

export function validateCreateJob(value: unknown): CreateJobInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_INPUT");
  const { operation, inputNames, options = {} } = value as Record<string, unknown>;
  if (!OPERATIONS.includes(operation as Operation) || !Array.isArray(inputNames) || !inputNames.length || inputNames.length > 100) throw new ApiError("INVALID_INPUT");
  const op = operation as Operation;
  if ((op === "merge_pdf" && inputNames.length < 2) || (!["merge_pdf", "image_to_pdf"].includes(op) && inputNames.length !== 1)) throw new ApiError("INVALID_INPUT");
  for (const name of inputNames) {
    assertSafeName(name);
    if (!(op === "image_to_pdf" ? /\.(png|jpe?g)$/i : /\.pdf$/i).test(name)) throw new ApiError("UNSUPPORTED_TYPE");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new ApiError("INVALID_INPUT");
  const opts = options as Record<string, unknown>;
  const allowed = op === "compress_pdf" ? ["preset"] : op === "pdf_to_image" ? ["imageFormat"] : op === "split_pdf" ? ["pageRange"] : [];
  if (Object.keys(opts).some(key => !allowed.includes(key)) || Object.values(opts).some(item => typeof item !== "string")) throw new ApiError("INVALID_INPUT");
  if (opts.preset !== undefined && !["balanced", "smallest"].includes(String(opts.preset))) throw new ApiError("INVALID_INPUT");
  if (opts.imageFormat !== undefined && !["png", "jpg", "jpeg"].includes(String(opts.imageFormat))) throw new ApiError("INVALID_INPUT");
  if (opts.pageRange !== undefined) {
    const spec = String(opts.pageRange);
    if (spec !== "all") {
      if (spec.length > 1000 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(spec)) throw new ApiError("INVALID_INPUT");
      for (const section of spec.split(",")) {
        const [start, end = start] = section.split("-").map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new ApiError("INVALID_INPUT");
      }
    }
  }
  return { operation: op, inputNames: [...inputNames], options: { ...opts } as Record<string, string> };
}

export async function createJob(input: CreateJobInput, userId: string): Promise<JobRecord> {
  const validated = validateCreateJob(input);
  if (!userId) throw new ApiError("UNAUTHENTICATED", 401);
  const now = Date.now();
  const ttl = Number(process.env.JOB_TTL_SECONDS ?? 3600);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new ApiError("SERVICE_UNAVAILABLE", 503);
  return adminRequest<JobRecord>("collections/jobs/records", {
    method: "POST",
    body: JSON.stringify({ ...validated, jobKey: randomUUID(), owner: userId, status: "uploading", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString() }),
  });
}

export async function getOwnedJob(id: string, userId: string): Promise<JobRecord> {
  if (!/^[a-zA-Z0-9]{15}$/.test(id)) throw new ApiError("JOB_NOT_FOUND", 404);
  const filter = `id = ${JSON.stringify(id)} && owner = ${JSON.stringify(userId)}`;
  const result = await adminRequest<{ items: JobRecord[] }>(`collections/jobs/records?${new URLSearchParams({ filter, perPage: "1" })}`);
  const job = result.items[0];
  if (!job) throw new ApiError("JOB_NOT_FOUND", 404);
  assertOwnedJob(job, userId);
  return job;
}

export function assertLiveJob(job: JobRecord): void {
  const expiry = Date.parse(job.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || job.status === "expired") throw new ApiError("JOB_EXPIRED", 410);
}

export async function markJobQueued(jobId: string, userId: string): Promise<void> {
  const job = await getOwnedJob(jobId, userId);
  assertLiveJob(job);
  if (job.status !== "uploading") throw new ApiError("INVALID_JOB_STATE", 409);
  await adminRequest(`collections/jobs/records/${jobId}`, { method: "PATCH", body: JSON.stringify({ status: "queued" }) });
}

export async function requestCleanup(jobId: string, userId: string): Promise<void> {
  const job = await getOwnedJob(jobId, userId);
  if (job.status !== "ready") return;
  // The worker's cleanup pass handles downloaded records before every BRPOP.
  await adminRequest(`collections/jobs/records/${jobId}`, { method: "PATCH", body: JSON.stringify({ status: "downloaded", downloadedAt: new Date().toISOString() }) });
}
