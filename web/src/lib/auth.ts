import "server-only";
import { cookies } from "next/headers";
import { ApiError } from "./http";
import { pocketbaseRequest } from "./pocketbase";

export const SESSION_COOKIE = "pb_auth";

export async function requireUser(request?: Request): Promise<{ id: string }> {
  const value = request
    ? request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
    : (await cookies()).get(SESSION_COOKIE)?.value;
  let token: unknown;
  try { token = JSON.parse(decodeURIComponent(value ?? "")).token; }
  catch { throw new ApiError("UNAUTHENTICATED", 401); }
  if (typeof token !== "string" || !token || token.length > 8192) throw new ApiError("UNAUTHENTICATED", 401);
  const auth = await pocketbaseRequest<{ record: { id: string; collectionName: string } }>("collections/users/auth-refresh", {
    method: "POST", headers: { Authorization: token },
  });
  if (auth.record?.collectionName !== "users" || !auth.record.id) throw new ApiError("UNAUTHENTICATED", 401);
  return { id: auth.record.id };
}
