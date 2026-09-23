import "server-only";
import { ApiError } from "./http";
import { adminRequest } from "./pocketbase";
import type { JobRecord } from "./jobs";
import type { PublicJob } from "./tool-info";

export function publicJob(job: JobRecord): PublicJob {
  const expiry = Date.parse(job.expiresAt);
  return {
    id: job.id, operation: job.operation, inputNames: job.inputNames,
    status: !Number.isFinite(expiry) || expiry <= Date.now() ? "expired" : job.status,
    createdAt: job.createdAt, expiresAt: job.expiresAt,
    ...(job.status === "ready" ? { outputName: job.outputName } : {}),
    ...(job.status === "failed" ? { errorCode: job.errorCode } : {}),
  };
}

export async function listOwnedJobs(userId: string): Promise<PublicJob[]> {
  if (!userId) throw new ApiError("UNAUTHENTICATED", 401);
  const now = new Date().toISOString().replace("T", " ");
  const filter = `owner = ${JSON.stringify(userId)} && expiresAt > ${JSON.stringify(now)} && status != "expired"`;
  const result = await adminRequest<{ items: JobRecord[] }>(`collections/jobs/records?${new URLSearchParams({ filter, sort: "-createdAt", perPage: "50" })}`);
  return result.items.filter(job => job.owner === userId && job.status !== "expired" && Date.parse(job.expiresAt) > Date.now()).map(publicJob);
}
