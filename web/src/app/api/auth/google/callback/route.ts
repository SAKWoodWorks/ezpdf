import { randomBytes } from "node:crypto";
import { adminRequest } from "@/lib/pocketbase";
import { STATE_COOKIE, allowedDomain, freshPassword, googleConfigured, originOf } from "@/lib/google";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

type GoogleUser = { email?: string; email_verified?: boolean };

export async function GET(request: Request) {
  const origin = originOf(request);
  const deny = (reason: string) => Response.redirect(`${origin}/login?error=${reason}`, 302);
  try {
    if (!googleConfigured()) return deny("google");
    const url = new URL(request.url);
    const cookieState = request.headers.get("cookie")
      ?.split(";").map(part => part.trim()).find(part => part.startsWith(`${STATE_COOKIE}=`))
      ?.slice(STATE_COOKIE.length + 1);
    if (!cookieState || cookieState !== url.searchParams.get("state")) {
      return new Response("Invalid OAuth state", { status: 400 });
    }
    const code = url.searchParams.get("code");
    if (!code) return deny("google");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: `${origin}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!tokenResponse.ok) return deny("google");
    const tokens = await tokenResponse.json() as { access_token?: string };
    if (!tokens.access_token) return deny("google");

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!profileResponse.ok) return deny("google");
    const profile = await profileResponse.json() as GoogleUser;
    const email = profile.email?.toLowerCase() ?? "";
    const domain = allowedDomain();
    if (!profile.email_verified || !email || !email.endsWith(`@${domain}`)) {
      console.error("Google domain deny", JSON.stringify({ email, domain, verified: profile.email_verified }));
      return deny("domain");
    }

    const userId = await findOrCreateWorkspaceUser(email);
    const password = freshPassword();
    await adminRequest(`collections/users/records/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ password, passwordConfirm: password }),
    });
    const auth = await fetch(`${process.env.POCKETBASE_URL?.replace(/\/$/, "") ?? "http://pocketbase:8090"}/api/collections/users/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!auth.ok) throw new Error("session failed");
    const session = await auth.json() as { token: string };
    if (typeof session.token !== "string" || !session.token || session.token.length > 8192) throw new Error("bad token");

    const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
    const response = Response.redirect(`${origin}/`, 302);
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(JSON.stringify({ token: session.token }))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${proto === "https" ? "; Secure" : ""}`);
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error("Google sign-in failed", error);
    return deny("google");
  }
}

async function findOrCreateWorkspaceUser(email: string): Promise<string> {
  const filter = `email = ${JSON.stringify(email)}`;
  const found = await adminRequest<{ items: { id: string }[] }>(`collections/users/records?${new URLSearchParams({ filter, perPage: "1" })}`);
  if (found.items[0]) return found.items[0].id;
  const password = freshPassword();
  const created = await adminRequest<{ id: string }>("collections/users/records", {
    method: "POST",
    body: JSON.stringify({ email, password, passwordConfirm: password, emailVisibility: true }),
  });
  return created.id;
}
