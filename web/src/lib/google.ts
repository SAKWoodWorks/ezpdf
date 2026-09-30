import "server-only";
import { randomBytes } from "node:crypto";

export const STATE_COOKIE = "g_state";

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleOnly(): boolean {
  return process.env.GOOGLE_ONLY === "true";
}

export function allowedDomain(): string {
  return (process.env.GOOGLE_ALLOWED_DOMAIN ?? "").replace(/^@/, "");
}

// request.url reflects the server bind host, so the browser-facing origin
// comes from the forwarded headers like everywhere else in this app.
export function originOf(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function googleStartUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  const domain = allowedDomain();
  if (domain) params.set("hd", domain);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function newState(): string {
  return randomBytes(24).toString("hex");
}

export function freshPassword(): string {
  return randomBytes(24).toString("base64url");
}
