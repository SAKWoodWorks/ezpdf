import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadJob, downloadJob } from "@/lib/lifecycle";
import { enqueueJob } from "@/lib/queue";

vi.mock("@/lib/queue", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/queue")>(), enqueueJob: vi.fn() }));

let root: string;
const jobKey = "44d04b2f-16d8-4e06-8514-cbe29bb2d03a";
let record: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ezpdf-api-"));
  vi.stubEnv("JOBS_DIR", root);
  vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
  vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "test-password");
  record = { id: "abcdefghijklmno", jobKey, owner: "owner-a", operation: "compress_pdf", inputNames: ["private.pdf"], options: {}, status: "uploading", expiresAt: new Date(Date.now() + 3600000).toISOString() };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (String(url).includes("auth-with-password")) return Response.json({ token: "server-secret" });
    if (init.method === "PATCH") { Object.assign(record, JSON.parse(String(init.body))); return Response.json(record); }
    const filter = new URL(url).searchParams.get("filter") ?? "";
    return Response.json({ items: filter.includes(`owner = "${record.owner}"`) ? [record] : [] });
  }));
  vi.mocked(enqueueJob).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function upload(files = [new File(["%PDF-1.7\ncontent"], "private.pdf", { type: "application/pdf" })]) {
  const form = new FormData(); files.forEach(file => form.append("files", file));
  return new Request("http://localhost/api/jobs/abcdefghijklmno/upload", { method: "POST", body: form });
}

describe("upload lifecycle", () => {
  it("writes only numbered inputs and queues the fully validated job", async () => {
    expect(await uploadJob(upload(), "abcdefghijklmno", "owner-a")).toEqual({ status: "queued" });
    expect(await readdir(path.join(root, jobKey, "input"))).toEqual(["0001"]);
    expect(await readFile(path.join(root, jobKey, "input", "0001"), "utf8")).toBe("%PDF-1.7\ncontent");
    expect(record.status).toBe("queued");
    expect(enqueueJob).toHaveBeenCalledOnce();
  });

  it("rejects another owner before creating folders", async () => {
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-b")).rejects.toThrow("JOB_NOT_FOUND");
    expect(await readdir(root)).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects missing files without queuing", async () => {
    record.operation = "merge_pdf"; record.inputNames = ["private.pdf", "second.pdf"];
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_INPUT");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects path separators in the supplied multipart filename", async () => {
    const form = new FormData();
    form.append("files", new File(["%PDF-1.7"], "private.pdf", { type: "application/pdf" }), "../private.pdf");
    const request = new Request("http://localhost/api/jobs/abcdefghijklmno/upload", { method: "POST", body: form });
    await expect(uploadJob(request, "abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_INPUT");
    expect(await readdir(root)).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("rejects mismatched magic bytes and supplied MIME", async () => {
    for (const file of [new File(["not a pdf"], "private.pdf", { type: "application/pdf" }), new File(["%PDF-1.7"], "private.pdf", { type: "image/png" })]) {
      await expect(uploadJob(upload([file]), "abcdefghijklmno", "owner-a")).rejects.toThrow("MIME_MISMATCH");
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("does not overwrite queued jobs", async () => {
    await uploadJob(upload(), "abcdefghijklmno", "owner-a");
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_JOB_STATE");
    expect(enqueueJob).toHaveBeenCalledOnce();
  });

  it("rechecks ownership before each input write and removes partial inputs", async () => {
    record.operation = "merge_pdf"; record.inputNames = ["private.pdf", "second.pdf"];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let reads = 0;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).includes("/jobs/records?") && ++reads === 5) record.owner = "owner-b";
      return originalFetch(...args);
    });
    const request = upload([
      new File(["%PDF-1.7 first"], "private.pdf", { type: "application/pdf" }),
      new File(["%PDF-1.7 second"], "second.pdf", { type: "application/pdf" }),
    ]);
    await expect(uploadJob(request, "abcdefghijklmno", "owner-a")).rejects.toThrow("JOB_NOT_FOUND");
    expect(await readdir(path.join(root, jobKey, "input"))).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("serializes concurrent uploads without duplicate queue entries", async () => {
    const results = await Promise.allSettled([
      uploadJob(upload(), "abcdefghijklmno", "owner-a"),
      uploadJob(upload(), "abcdefghijklmno", "owner-a"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(enqueueJob).toHaveBeenCalledOnce();
    expect(await readdir(path.join(root, jobKey, "input"))).toEqual(["0001"]);
  });

  it("rejects expired jobs before writing", async () => {
    record.expiresAt = "2000-01-01T00:00:00Z";
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("JOB_EXPIRED");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("download lifecycle", () => {
  async function ready() {
    record.status = "ready"; record.outputName = "result.pdf";
    await mkdir(path.join(root, jobKey, "output"), { recursive: true });
    await writeFile(path.join(root, jobKey, "output", "result.pdf"), "%PDF-1.7\nresult");
  }

  it("requests cleanup only after the complete stream", async () => {
    await ready();
    const response = await downloadJob("abcdefghijklmno", "owner-a");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="result.pdf"');
    expect(record.status).toBe("ready");
    expect(await response.text()).toBe("%PDF-1.7\nresult");
    expect(record.status).toBe("downloaded");
    expect(record.downloadedAt).toEqual(expect.any(String));
  });

  it("retains the ready result if the download is cancelled", async () => {
    await ready();
    const response = await downloadJob("abcdefghijklmno", "owner-a");
    const reader = response.body!.getReader();
    await reader.read(); await reader.cancel();
    expect(record.status).toBe("ready");
  });

  it("hides another owner's result", async () => {
    await ready();
    await expect(downloadJob("abcdefghijklmno", "owner-b")).rejects.toThrow("JOB_NOT_FOUND");
    expect(record.status).toBe("ready");
  });

  it("does not download unfinished output or untrusted output paths", async () => {
    await expect(downloadJob("abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_JOB_STATE");
    await ready(); record.outputName = "../secret.pdf";
    await expect(downloadJob("abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_INPUT");
    expect(record.status).toBe("ready");
  });
});
