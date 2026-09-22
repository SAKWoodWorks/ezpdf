import "server-only";
import { createClient } from "redis";
import type { JobRecord } from "./jobs";

export function queuePayload(job: JobRecord) {
  return { recordId: job.id, jobKey: job.jobKey, ownerId: job.owner, operation: job.operation, inputNames: job.inputNames, options: job.options ?? {} };
}

export async function enqueueJob(job: JobRecord): Promise<void> {
  const client = createClient({ url: process.env.REDIS_URL ?? "redis://redis:6379/0", socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on("error", () => console.error("Queue connection failed"));
  try {
    await client.connect();
    await client.lPush("pdf-jobs", JSON.stringify(queuePayload(job)));
  } finally { if (client.isOpen) client.destroy(); }
}
