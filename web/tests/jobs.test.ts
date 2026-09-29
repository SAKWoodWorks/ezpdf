import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOwnedJob, validateCreateJob, createJob, getOwnedJob } from "@/lib/jobs";
import { requireUser } from "@/lib/auth";
import { readLimitedBody } from "@/lib/http";
import { queuePayload } from "@/lib/queue";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("job boundaries", () => {
  it("hides jobs owned by another user", () => {
    expect(() => assertOwnedJob({ owner: "user-a" }, "user-b")).toThrow("JOB_NOT_FOUND");
  });

  it.each(["../x.pdf", "a\\x.pdf", ".", "x\u0000.pdf"])("rejects unsafe original name %s", (name) => {
    expect(() => validateCreateJob({ operation: "compress_pdf", inputNames: [name], options: {} })).toThrow();
  });

  it("rejects unsupported operations, counts, extensions, and options", () => {
    for (const input of [
      { operation: "edit_pdf", inputNames: ["a.pdf"] },
      { operation: "merge_pdf", inputNames: ["a.pdf"] },
      { operation: "compress_pdf", inputNames: ["a.jpg"] },
      { operation: "compress_pdf", inputNames: ["a.pdf"], options: { preset: "unsafe" } },
      { operation: "split_pdf", inputNames: ["a.pdf"], options: { pageRange: "3-1" } },
      { operation: "split_pdf", inputNames: ["a.pdf"], options: { pageRange: "0" } },
    ]) expect(() => validateCreateJob(input)).toThrow();
  });

  it("retains supported options and filenames", () => {
    expect(validateCreateJob({ operation: "pdf_to_image", inputNames: ["ไทย.pdf"], options: { imageFormat: "jpg" } }))
      .toEqual({ operation: "pdf_to_image", inputNames: ["ไทย.pdf"], options: { imageFormat: "jpg" } });
  });

  it("accepts several pdf files for pdf_to_image", () => {
    expect(validateCreateJob({ operation: "pdf_to_image", inputNames: ["a.pdf", "b.pdf"], options: {} }))
      .toEqual({ operation: "pdf_to_image", inputNames: ["a.pdf", "b.pdf"], options: {} });
  });

  it("creates trusted owner, UUID, uploading state, and one hour expiry", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
    vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "test-password");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes("auth-with-password")) return Response.json({ token: "server-secret" });
      const body = JSON.parse(String(init.body)); writes.push(body);
      return Response.json({ id: "abcdefghijklmno", ...body });
    }));
    const record = await createJob({ operation: "compress_pdf", inputNames: ["a.pdf"], options: {} }, "owner-a");
    expect(record.owner).toBe("owner-a");
    expect(record.status).toBe("uploading");
    expect(record.jobKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(3_600_000);
    expect(writes).toHaveLength(1);
    expect(queuePayload(record)).toEqual({ recordId: "abcdefghijklmno", jobKey: record.jobKey, ownerId: "owner-a", operation: "compress_pdf", inputNames: ["a.pdf"], options: {} });
  });

  it("filters privileged record reads by both record id and owner", async () => {
    const urls: string[] = [];
    vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
    vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "test-password");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      return Response.json(String(url).includes("auth-with-password") ? { token: "server-secret" } : { items: [] });
    }));
    await expect(getOwnedJob("abcdefghijklmno", "user-a")).rejects.toThrow("JOB_NOT_FOUND");
    const query = new URL(urls.at(-1)!);
    expect(query.searchParams.get("filter")).toBe('id = "abcdefghijklmno" && owner = "user-a"');
  });
});

describe("authentication and body limits", () => {
  it("rejects missing sessions without contacting PocketBase", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(requireUser(new Request("http://localhost/api/jobs"))).rejects.toThrow("UNAUTHENTICATED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the token with PocketBase and ignores a forged cookie user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ record: { id: "actual-user", collectionName: "users" } })));
    const cookie = encodeURIComponent(JSON.stringify({ token: "valid-token", record: { id: "forged" } }));
    expect(await requireUser(new Request("http://localhost/api/jobs", { headers: { cookie: `pb_auth=${cookie}` } }))).toEqual({ id: "actual-user" });
  });

  it("rejects a superuser token in a browser session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ record: { id: "admin", collectionName: "_superusers" } })));
    const cookie = encodeURIComponent(JSON.stringify({ token: "admin-token" }));
    await expect(requireUser(new Request("http://localhost/api/jobs", { headers: { cookie: `pb_auth=${cookie}` } }))).rejects.toThrow("UNAUTHENTICATED");
  });

  it("enforces actual bytes even when Content-Length lies", async () => {
    const request = new Request("http://localhost", { method: "POST", body: "123456", headers: { "content-length": "1" } });
    await expect(readLimitedBody(request, 5)).rejects.toThrow("INPUT_TOO_LARGE");
  });

  it("rejects a declared oversized request before reading", async () => {
    await expect(readLimitedBody(new Request("http://localhost", { method: "POST", body: "1", headers: { "content-length": "104857601" } }), 104857600)).rejects.toThrow("INPUT_TOO_LARGE");
  });
});
