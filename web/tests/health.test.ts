import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

const client = vi.hoisted(() => ({ connect: vi.fn(), ping: vi.fn(), destroy: vi.fn(), on: vi.fn(), isOpen: true }));
vi.mock("redis", () => ({ createClient: () => client }));

beforeEach(() => { vi.clearAllMocks(); client.connect.mockResolvedValue(undefined); client.ping.mockResolvedValue("PONG"); });
afterEach(() => { vi.useRealTimers(); });

it("returns uncached health only after Redis responds", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(client.ping).toHaveBeenCalledOnce();
  expect(client.destroy).toHaveBeenCalledOnce();
});

it("does not reveal dependency diagnostics", async () => {
  client.connect.mockRejectedValueOnce(new Error("private connection details"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
  expect(client.destroy).toHaveBeenCalledOnce();
});

it.each(["connect", "ping"] as const)("bounds stalled Redis %s to five seconds", async stage => {
  vi.useFakeTimers();
  client[stage].mockImplementationOnce(() => new Promise(() => {}));
  const pending = GET();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).status).toBe(503);
  expect(client.destroy).toHaveBeenCalledOnce();
});
