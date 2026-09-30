import { STATE_COOKIE, googleConfigured, googleStartUrl, newState, originOf } from "@/lib/google";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const origin = originOf(request);
  if (!googleConfigured()) {
    return Response.redirect(`${origin}/login?error=google`, 307);
  }
  const state = newState();
  return new Response(null, {
    status: 307,
    headers: {
      Location: googleStartUrl(origin, state),
      "Set-Cookie": `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
      "Cache-Control": "no-store",
    },
  });
}
