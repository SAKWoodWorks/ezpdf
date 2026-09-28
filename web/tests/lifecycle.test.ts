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

  it("accepts a configured limit above 100 MiB up to the 200 MiB hard cap", async () => {
    vi.stubEnv("MAX_UPLOAD_BYTES", "1048576000");
    record.operation = "image_to_pdf";
    record.inputNames = ["big.png"];
    const bytes = new Uint8Array(150 * 1024 * 1024);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(await uploadJob(upload([new File([bytes], "big.png", { type: "image/png" })]), "abcdefghijklmno", "owner-a"))
      .toEqual({ status: "queued" });
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
    const changed = upload([new File(["%PDF-1.7 changed"], "private.pdf", { type: "application/pdf" })]);
    await expect(uploadJob(changed, "abcdefghijklmno", "owner-a")).rejects.toThrow("UPLOAD_MISMATCH");
    expect(enqueueJob).toHaveBeenCalledOnce();
    expect(await readFile(path.join(root, jobKey, "input", "0001"), "utf8")).toBe("%PDF-1.7\ncontent");
  });

  it("cleans inputs after a definite metadata transition failure and permits a fresh retry", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => args[1]?.method === "PATCH"
      ? Response.json({}, { status: 503 }) : originalFetch(...args));
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("SERVICE_UNAVAILABLE");
    expect(record.status).toBe("uploading");
    expect(await readdir(path.join(root, jobKey, "input"))).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
    vi.mocked(fetch).mockImplementation(originalFetch);
    expect(await uploadJob(upload(), "abcdefghijklmno", "owner-a")).toEqual({ status: "queued" });
  });

  it("reconciles a committed metadata transition whose response was lost", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await originalFetch(...args);
      if (args[1]?.method === "PATCH") throw new Error("connection lost");
      return response;
    });
    expect(await uploadJob(upload(), "abcdefghijklmno", "owner-a")).toEqual({ status: "queued" });
    expect(record.status).toBe("queued");
    expect(enqueueJob).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves inputs during an unknown metadata outcome (committed: %s) and retries safely", async committed => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let unavailable = false;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (args[1]?.method === "PATCH") {
        if (committed) await originalFetch(...args);
        unavailable = true;
      }
      if (unavailable) throw new Error("connection lost");
      return originalFetch(...args);
    });
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("connection lost");
    expect(await readFile(path.join(root, jobKey, "input", "0001"), "utf8")).toBe("%PDF-1.7\ncontent");
    vi.mocked(fetch).mockImplementation(originalFetch);
    expect(await uploadJob(upload(), "abcdefghijklmno", "owner-a")).toEqual({ status: "queued" });
    expect(enqueueJob).toHaveBeenCalledOnce();
  });

  it("rechecks expiry after reconciling an uncertain metadata transition", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await originalFetch(...args);
      if (args[1]?.method === "PATCH") {
        record.expiresAt = "2000-01-01T00:00:00Z";
        throw new Error("connection lost");
      }
      return response;
    });
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("JOB_EXPIRED");
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, jobKey, "input", "0001"), "utf8")).toBe("%PDF-1.7\ncontent");
  });

  it("does not reconstruct missing queued inputs during a retry", async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("Redis unavailable");
    await rm(path.join(root, jobKey, "input", "0001"));
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_JOB_STATE");
    expect(await readdir(path.join(root, jobKey, "input"))).toEqual([]);
    expect(enqueueJob).toHaveBeenCalledOnce();
  });

  it("republishes the exact validated upload after a Redis failure", async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("Redis unavailable");
    expect(record.status).toBe("queued");
    expect(await readFile(path.join(root, jobKey, "input", "0001"), "utf8")).toBe("%PDF-1.7\ncontent");
    expect(await uploadJob(upload(), "abcdefghijklmno", "owner-a")).toEqual({ status: "queued" });
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });

  it("republishes an ambiguous Redis write without resetting processing or changing inputs", async () => {
    const published: unknown[] = [];
    vi.mocked(enqueueJob).mockImplementationOnce(async job => {
      published.push(job); throw new Error("publication response lost");
    }).mockImplementation(async job => { published.push(job); });
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("publication response lost");
    expect(await uploadJob(upload(), "abcdefghijklmno", "owner-a")).toEqual({ status: "queued" });
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ id: "abcdefghijklmno", jobKey, owner: "owner-a", inputNames: ["private.pdf"] });
    record.status = "processing";
    await expect(uploadJob(upload(), "abcdefghijklmno", "owner-a")).rejects.toThrow("INVALID_JOB_STATE");
    expect(record.status).toBe("processing");
    expect(enqueueJob).toHaveBeenCalledTimes(2);
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
