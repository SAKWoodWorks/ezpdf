import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { countThumbnails, readThumbnail } from "@/lib/lifecycle";
import { GET as manifest } from "@/app/api/jobs/[id]/thumbnails/route";
import { GET as thumbnail } from "@/app/api/jobs/[id]/thumbnails/[page]/route";

const jobKey = "44d04b2f-16d8-4e06-8514-cbe29bb2d03a";
const session = { cookie: `pb_auth=${encodeURIComponent(JSON.stringify({ token: "user-token" }))}` };
let root: string;
let record: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ezpdf-thumbs-"));
  vi.stubEnv("JOBS_DIR", root);
  vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
  vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "test-password");
  record = { id: "abcdefghijklmno", jobKey, owner: "owner-a", operation: "merge_pdf", inputNames: ["a.pdf", "b.pdf"], options: {}, status: "ready", outputName: "result.pdf", createdAt: "2026-01-01T00:00:00Z", expiresAt: new Date(Date.now() + 3600000).toISOString() };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("auth-refresh")) return Response.json({ record: { id: "owner-a", collectionName: "users" } });
    if (String(url).includes("auth-with-password")) return Response.json({ token: "server-secret" });
    const filter = String(url).includes("filter=") && new URL(url).searchParams.get("filter") || "";
    return Response.json({ items: filter.includes(`owner = "${record.owner}"`) || !filter.includes("owner") ? [record] : [] });
  }));
  const thumbs = path.join(root, jobKey, "output", "thumbs");
  await mkdir(thumbs, { recursive: true });
  await writeFile(path.join(thumbs, "thumb-1.jpg"), Buffer.from([255, 216, 255, 219, 1]));
  await writeFile(path.join(thumbs, "thumb-2.jpg"), Buffer.from([255, 216, 255, 219, 2]));
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const getJob = () => record as never as Parameters<typeof countThumbnails>[0];
const manifestContext = { params: Promise.resolve({ id: "abcdefghijklmno" }) };
const pageContext = (page: string) => ({ params: Promise.resolve({ id: "abcdefghijklmno", page }) });

it("counts generated thumbnails beside the output", async () => {
  expect(await countThumbnails(getJob())).toBe(2);
  expect(await countThumbnails({ ...getJob(), jobKey: "11111111-2222-3333-4444-555555555555" })).toBe(0);
});

it("reads one thumbnail inside the job directory only", async () => {
  expect(await readThumbnail(getJob(), 1)).toEqual(Buffer.from([255, 216, 255, 219, 1]));
  expect(await readThumbnail(getJob(), 3)).toBeNull();
  expect(await readThumbnail(getJob(), 0)).toBeNull();
  expect(await readThumbnail(getJob(), 51)).toBeNull();
  expect(await readThumbnail(getJob(), Number.NaN)).toBeNull();
});

it("requires a session for the manifest and the image", async () => {
  expect((await manifest(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails"), manifestContext)).status).toBe(401);
  expect((await thumbnail(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails/1"), pageContext("1"))).status).toBe(401);
});

it("hides other owners' thumbnails", async () => {
  record.owner = "owner-b";
  expect((await manifest(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails", { headers: session }), manifestContext)).status).toBe(404);
  expect((await thumbnail(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails/1", { headers: session }), pageContext("1"))).status).toBe(404);
});

it("returns the page count for a ready job", async () => {
  const response = await manifest(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails", { headers: session }), manifestContext);
  expect(await response.json()).toEqual({ pages: 2 });
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("serves one thumbnail as jpeg with no-store", async () => {
  const response = await thumbnail(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails/2", { headers: session }), pageContext("2"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 219, 2]));
});

it("rejects invalid pages and unfinished jobs", async () => {
  expect((await thumbnail(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails/0", { headers: session }), pageContext("0"))).status).toBe(404);
  expect((await thumbnail(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails/nope", { headers: session }), pageContext("nope"))).status).toBe(404);
  record.status = "processing";
  expect((await thumbnail(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails/1", { headers: session }), pageContext("1"))).status).toBe(409);
  expect((await manifest(new Request("http://localhost/api/jobs/abcdefghijklmno/thumbnails", { headers: session }), manifestContext)).status).toBe(409);
});
