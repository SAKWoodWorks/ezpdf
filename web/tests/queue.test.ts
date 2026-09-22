import { expect, it, vi } from "vitest";
import type { JobRecord } from "@/lib/jobs";
import { enqueueJob } from "@/lib/queue";

const client = vi.hoisted(() => ({ connect: vi.fn(), lPush: vi.fn(), destroy: vi.fn(), on: vi.fn(), isOpen: true }));
vi.mock("redis", () => ({ createClient: () => client }));

it("publishes worker-compatible UTF-8 JSON using LPUSH", async () => {
  const job = { id: "abcdefghijklmno", jobKey: "44d04b2f-16d8-4e06-8514-cbe29bb2d03a", owner: "owner-a", operation: "merge_pdf", inputNames: ["ไทย.pdf", "a.pdf"], options: {} } as JobRecord;
  await enqueueJob(job);
  expect(client.lPush).toHaveBeenCalledWith("pdf-jobs", '{"recordId":"abcdefghijklmno","jobKey":"44d04b2f-16d8-4e06-8514-cbe29bb2d03a","ownerId":"owner-a","operation":"merge_pdf","inputNames":["ไทย.pdf","a.pdf"],"options":{}}');
  expect(client.destroy).toHaveBeenCalledOnce();
});
