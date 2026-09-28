import { afterEach, expect, it, vi } from "vitest";
import { POST as create } from "@/app/api/jobs/route";
import { POST as upload } from "@/app/api/jobs/[id]/upload/route";
import { GET as download } from "@/app/api/jobs/[id]/download/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("requires a session for every job endpoint", async () => {
  const context = { params: Promise.resolve({ id: "abcdefghijklmno" }) };
  for (const response of [
    await create(new Request("http://localhost/api/jobs", { method: "POST" })),
    await upload(new Request("http://localhost/api/jobs/abcdefghijklmno/upload", { method: "POST" }), context),
    await download(new Request("http://localhost/api/jobs/abcdefghijklmno/download"), context),
  ]) {
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  }
});

it("rejects cross-site writes before authentication", async () => {
  const response = await create(new Request("http://localhost/api/jobs", { method: "POST", headers: { origin: "https://attacker.example" } }));
  expect(response.status).toBe(403);
});

it("returns only the public creation response, never privileged credentials", async () => {
  vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
  vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "server-password");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("auth-refresh")) return Response.json({ record: { id: "owner-a", collectionName: "users" } });
    if (String(url).includes("auth-with-password")) return Response.json({ token: "secret-server-token" });
    return Response.json({ id: "abcdefghijklmno", status: "uploading", owner: "owner-a", jobKey: "private-path", other: "not-for-the-browser" });
  }));
  const cookie = encodeURIComponent(JSON.stringify({ token: "user-token" }));
  const response = await create(new Request("http://localhost/api/jobs", {
    method: "POST", headers: { cookie: `pb_auth=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "compress_pdf", inputNames: ["a.pdf"], options: {} }),
  }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: "abcdefghijklmno", status: "uploading" });
});
