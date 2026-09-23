import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", path: "/", maxAge: 0 });
    return response;
  } catch (error) { return apiError(error); }
}
