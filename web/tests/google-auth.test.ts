import { afterEach, expect, it, vi } from "vitest";
import { GET as googleStart } from "@/app/api/auth/google/route";
import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { POST as register } from "@/app/api/auth/register/route";

vi.mock("@/lib/google", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/google")>()), freshPassword: () => "fresh-pass" }));

const redirectUri = "http%3A%2F%2Flocalhost%3A8007%2Fapi%2Fauth%2Fgoogle%2Fcallback";

function startRequest() {
  return new Request(`http://localhost:8007/api/auth/google`, { headers: { "x-forwarded-host": "localhost:8007", "x-forwarded-proto": "http" } });
}

function stubGoogleEnv() {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id-123");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret-456");
  vi.stubEnv("GOOGLE_ALLOWED_DOMAIN", "sakww.com");
  vi.stubEnv("POCKETBASE_SUPERUSER_EMAIL", "admin@example.test");
  vi.stubEnv("POCKETBASE_SUPERUSER_PASSWORD", "server-password");
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("start redirects to google with domain hint and a state cookie", async () => {
  stubGoogleEnv();
  const response = await googleStart(startRequest());
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.host).toBe("accounts.google.com");
  expect(location.searchParams.get("client_id")).toBe("client-id-123");
  expect(location.searchParams.get("redirect_uri")).toBe(`http://localhost:8007/api/auth/google/callback`);
  expect(location.searchParams.get("hd")).toBe("sakww.com");
  expect(location.searchParams.get("state")).toBeTruthy();
  const cookie = response.headers.getSetCookie().find(c => c.startsWith("g_state="))!;
  expect(cookie).toContain(location.searchParams.get("state")!);
  expect(cookie).toContain("HttpOnly");
});

it("callback rejects a state that does not match the cookie", async () => {
  stubGoogleEnv();
  const response = await googleCallback(new Request(`http://localhost:8007/api/auth/google/callback?code=c&state=wrong`, {
    headers: { cookie: "g_state=expected" },
  }));
  expect(response.status).toBe(400);
});

it("callback denies emails outside the workspace domain", async () => {
  stubGoogleEnv();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "g-token" });
    return Response.json({ email: "outsider@gmail.com", email_verified: true });
  }));
  const response = await googleCallback(new Request(`http://localhost:8007/api/auth/google/callback?code=c&state=expected`, {
    headers: { cookie: "g_state=expected" },
  }));
  expect(response.headers.get("location")).toBe("http://localhost:8007/login?error=domain");
});

it("callback denies unverified google emails", async () => {
  stubGoogleEnv();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "g-token" });
    return Response.json({ email: "u@sakww.com", email_verified: false });
  }));
  const response = await googleCallback(new Request(`http://localhost:8007/api/auth/google/callback?code=c&state=expected`, {
    headers: { cookie: "g_state=expected" },
  }));
  expect(response.headers.get("location")).toBe("http://localhost:8007/login?error=domain");
});

it("callback signs the workspace user in and sets the session cookie", async () => {
  stubGoogleEnv();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    let body: Record<string, unknown> = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
    if (target.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "g-token" });
    if (target.includes("openidconnect.googleapis.com/v1/userinfo")) return Response.json({ email: "user@sakww.com", email_verified: true });
    if (target.includes("auth-with-password")) {
      if (body.identity === "admin@example.test") return Response.json({ token: "server-token" });
      if (body.password === "fresh-pass") return Response.json({ token: "session-token", record: { id: "u1", collectionName: "users" } });
      return Response.json({ message: "nope" }, { status: 401 });
    }
    if (init?.method === "POST" && target.endsWith("/records")) return Response.json({ id: "u1" });
    if (init?.method === "PATCH") return Response.json({ id: "u1" });
    return Response.json({ items: [{ id: "u1" }] });
  }));
  const response = await googleCallback(new Request(`http://localhost:8007/api/auth/google/callback?code=c&state=expected`, {
    headers: { cookie: "g_state=expected" },
  }));
  expect(response.headers.get("location")).toBe("http://localhost:8007/");
  const cookie = response.headers.getSetCookie().find(c => c.startsWith("pb_auth="))!;
  expect(decodeURIComponent(cookie)).toContain("session-token");
});

it("register is rejected when google-only mode is on", async () => {
  vi.stubEnv("GOOGLE_ONLY", "true");
  const response = await register(new Request("http://localhost:8007/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@example.test", password: "testpass123", passwordConfirm: "testpass123" }),
  }));
  expect(response.status).toBe(403);
  expect((await response.json()).error).toBe("AUTH_GOOGLE_ONLY");
});
