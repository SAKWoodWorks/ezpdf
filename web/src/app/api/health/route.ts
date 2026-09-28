import { createClient } from "redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const client = createClient({ url: process.env.REDIS_URL ?? "redis://redis:6379/0", socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("Health timeout")); }, 5000);
      }),
      (async () => {
        await client.connect();
        if (!expired && await client.ping() !== "PONG") throw new Error("Health check failed");
      })(),
    ]);
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}
