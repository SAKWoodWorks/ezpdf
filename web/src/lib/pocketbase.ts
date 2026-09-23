import "server-only";
import { ApiError } from "./http";

export function pocketbaseUrl(): string {
  return (process.env.POCKETBASE_URL ?? "http://pocketbase:8090").replace(/\/$/, "");
}

export async function pocketbaseRequest<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${pocketbaseUrl()}/api/${endpoint}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (response.status === 400 && endpoint === "collections/users/auth-refresh") throw new ApiError("UNAUTHENTICATED", 401);
    if (response.status === 400 && endpoint === "collections/users/records") throw new ApiError("REGISTRATION_FAILED");
    if (response.status === 401 || response.status === 403) throw new ApiError("UNAUTHENTICATED", 401);
    if (response.status === 404) throw new ApiError("JOB_NOT_FOUND", 404);
    throw new ApiError("SERVICE_UNAVAILABLE", 503);
  }
  return response.json() as Promise<T>;
}

// Credentials and tokens exist only in the server module graph. Do not cache a
// shared user auth store; every browser session must be independently verified.
export async function adminRequest<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const identity = process.env.POCKETBASE_SUPERUSER_EMAIL;
  const password = process.env.POCKETBASE_SUPERUSER_PASSWORD;
  if (!identity || !password) throw new ApiError("SERVICE_UNAVAILABLE", 503);
  const auth = await pocketbaseRequest<{ token: string }>("collections/_superusers/auth-with-password", {
    method: "POST", body: JSON.stringify({ identity, password }),
  });
  return pocketbaseRequest<T>(endpoint, { ...init, headers: { ...init.headers, Authorization: auth.token } });
}
