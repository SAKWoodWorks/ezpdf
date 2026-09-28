import "server-only";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "./auth";
import { ApiError, apiError, assertSameOrigin, readJson } from "./http";
import { adminRequest, pocketbaseUrl } from "./pocketbase";

export async function authenticate(request: Request, register = false): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = body?.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== "string" || !password || password.length > 256) throw new ApiError("INVALID_INPUT");
    if (register) {
      if (password.length < 8 || body?.passwordConfirm !== password) throw new ApiError("INVALID_INPUT");
      await adminRequest("collections/users/records", { method: "POST", body: JSON.stringify({ email, password, passwordConfirm: password }) });
    }
    const upstream = await fetch(`${pocketbaseUrl()}/api/collections/users/auth-with-password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }), cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw new ApiError(upstream.status < 500 ? "INVALID_CREDENTIALS" : "SERVICE_UNAVAILABLE", upstream.status < 500 ? 401 : 503);
    const auth = await upstream.json();
    if (typeof auth.token !== "string" || !auth.token || auth.token.length > 8192 || auth.record?.collectionName !== "users" || !auth.record.id) throw new ApiError("SERVICE_UNAVAILABLE", 503);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    // NextResponse encodes the cookie value once on serialization.
    response.cookies.set(SESSION_COOKIE, JSON.stringify({ token: auth.token }), {
      httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", path: "/",
    });
    return response;
  } catch (error) { return apiError(error); }
}
