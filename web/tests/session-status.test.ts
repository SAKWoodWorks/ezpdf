import { afterEach, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as status } from "@/app/api/jobs/[id]/route";
import { listOwnedJobs } from "@/lib/job-history";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const context = { params: Promise.resolve({ id: "abcdefghijklmno" }) };
const session = { cookie: `pb_auth=${encodeURIComponent(JSON.stringify({ token: "user-token" }))}` };
const job = { id: "abcdefghijklmno", jobKey: "private-path", owner: "owner-a", operation: "merge_pdf", inputNames: ["a.pdf", "b.pdf"], options: {}, status: "ready", outputName: "result.pdf", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" };
function setup(items = [job]) {
  vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
  vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "server-password");
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("auth-refresh")) return Response.json({ record: { id: "owner-a", collectionName: "users" } });
    if (String(url).includes("auth-with-password")) return Response.json({ token: "server-token" });
    return Response.json({ items });
  });
}

it("requires a session to read status", async () => {
  expect((await status(new Request("http://localhost/api/jobs/abcdefghijklmno"), context)).status).toBe(401);
});

it("treats a rejected PocketBase auth refresh as an expired session", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ message: "Failed to refresh token" }, { status: 400 }));
  expect((await status(new Request("http://localhost/api/jobs/abcdefghijklmno", { headers: session }), context)).status).toBe(401);
});

it("exposes only safe owner status fields and computes expiry", async () => {
  setup();
  const response = await status(new Request("http://localhost/api/jobs/abcdefghijklmno", { headers: session }), context);
  const data = await response.json();
  expect(data.status).toBe("ready");
  expect(data.jobKey).toBeUndefined();
  expect(data.owner).toBeUndefined();
  expect(response.headers.get("cache-control")).toContain("no-store");
  setup([{ ...job, expiresAt: "2000-01-01T00:00:00Z" }]);
  expect((await (await status(new Request("http://localhost/api/jobs/abcdefghijklmno", { headers: session }), context)).json()).status).toBe("expired");
});

it("rejects another owner's status and filters stale or foreign dashboard records", async () => {
  setup([{ ...job, owner: "owner-b" }]);
  expect((await status(new Request("http://localhost/api/jobs/abcdefghijklmno", { headers: session }), context)).status).toBe(404);
  setup([job, { ...job, owner: "owner-b" }, { ...job, expiresAt: "2000-01-01T00:00:00Z" }, { ...job, status: "expired" }]);
  expect(await listOwnedJobs("owner-a")).toHaveLength(1);
});

it("authenticates on the server and returns only an httpOnly same-site cookie", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ token: "user-token", record: { id: "owner-a", collectionName: "users" } }));
  const response = await login(new Request("https://localhost/api/auth/login", { method: "POST", body: JSON.stringify({ email: "person@example.test", password: "password123" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=lax");
  expect(cookie).toContain("Secure");
  expect(JSON.parse(decodeURIComponent(cookie.split(";")[0].slice("pb_auth=".length)))).toEqual({ token: "user-token" });
});

it("rejects cross-site auth writes and invalid registration before upstream calls", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect((await login(new Request("http://localhost/api/auth/login", { method: "POST", headers: { origin: "https://foreign.test" } }))).status).toBe(403);
  expect((await register(new Request("http://localhost/api/auth/register", { method: "POST", body: JSON.stringify({ email: "person@example.test", password: "short", passwordConfirm: "different" }) }))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});

it("clears the session on logout", async () => {
  const response = await logout(new Request("http://localhost/api/auth/logout", { method: "POST" }));
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});

it("registers only allowed account fields and starts an ordinary user session", async () => {
  setup();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    if (url.includes("_superusers")) return Response.json({ token: "server-secret" });
    if (url.endsWith("/users/records")) return Response.json({ id: "owner-a" });
    return Response.json({ token: "ordinary-user-token", record: { id: "owner-a", collectionName: "users" } });
  });
  const response = await register(new Request("http://localhost/api/auth/register", { method: "POST", body: JSON.stringify({ email: " person@example.test ", password: "password123", passwordConfirm: "password123", verified: true, role: "admin" }) }));
  expect(response.status).toBe(200);
  expect(calls[1].body).toEqual({ email: "person@example.test", password: "password123", passwordConfirm: "password123" });
  expect(response.headers.get("set-cookie")).toContain("ordinary-user-token");
  expect(response.headers.get("set-cookie")).not.toContain("server-secret");
});

it("maps a rejected registration to a stable error without upstream details", async () => {
  setup();
  vi.stubGlobal("fetch", async (url: string) => url.includes("_superusers") ? Response.json({ token: "server-secret" }) : Response.json({ message: "private validation details" }, { status: 400 }));
  const response = await register(new Request("http://localhost/api/auth/register", { method: "POST", body: JSON.stringify({ email: "person@example.test", password: "password123", passwordConfirm: "password123" }) }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "REGISTRATION_FAILED" });
});
