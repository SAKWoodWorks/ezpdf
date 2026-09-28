import "server-only";
import { createClient } from "redis";
import { ApiError } from "./http";
import type { JobRecord } from "./jobs";

export function queuePayload(job: JobRecord) {
  return { recordId: job.id, jobKey: job.jobKey, ownerId: job.owner, operation: job.operation, inputNames: job.inputNames, options: job.options ?? {} };
}

export async function enqueueJob(job: JobRecord): Promise<void> {
  const client = createClient({ url: process.env.REDIS_URL ?? "redis://redis:6379/0", socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on("error", () => console.error("Queue connection failed"));
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bound the complete operation, including handshake and an LPUSH whose
    // reply is lost. A timeout has an unknown outcome: callers retain inputs.
    await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new ApiError("SERVICE_UNAVAILABLE", 503)); }, 5000);
      }),
      (async () => {
        await client.connect();
        if (!expired) await client.lPush("pdf-jobs", JSON.stringify(queuePayload(job)));
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}
