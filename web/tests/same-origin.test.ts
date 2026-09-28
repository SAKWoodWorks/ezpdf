import { describe, expect, it } from "vitest";
import { assertSameOrigin } from "@/lib/http";
import { errorMessage } from "@/lib/tool-info";

function request(url: string, headers: Record<string, string>): Request {
  return new Request(url, { method: "POST", headers });
}

describe("assertSameOrigin", () => {
  it("accepts an Origin whose host matches the forwarded host even when the internal URL differs", () => {
    // Next builds request.url from the bind hostname (0.0.0.0) inside the
    // container; browsers send the host they actually connected to.
    expect(() => assertSameOrigin(request(
      "http://0.0.0.0:3000/api/auth/login",
      { origin: "http://localhost:3000", "x-forwarded-host": "localhost:3000" },
    ))).not.toThrow();
  });

  it("accepts an Origin whose host matches the plain Host header", () => {
    expect(() => assertSameOrigin(request(
      "http://0.0.0.0:3000/api/auth/login",
      { origin: "http://localhost:3000", host: "localhost:3000" },
    ))).not.toThrow();
  });

  it("accepts requests without an Origin header", () => {
    expect(() => assertSameOrigin(request("http://0.0.0.0:3000/api/health", {}))).not.toThrow();
  });

  it("rejects an Origin pointing at another site", () => {
    expect(() => assertSameOrigin(request(
      "http://0.0.0.0:3000/api/auth/login",
      { origin: "http://evil.example", "x-forwarded-host": "localhost:3000" },
    ))).toThrow("FORBIDDEN");
  });

  it("rejects a cross-site fetch even with a matching Origin", () => {
    expect(() => assertSameOrigin(request(
      "http://0.0.0.0:3000/api/auth/login",
      { origin: "http://localhost:3000", "x-forwarded-host": "localhost:3000", "sec-fetch-site": "cross-site" },
    ))).toThrow("FORBIDDEN");
  });

  it("rejects an unparseable Origin", () => {
    expect(() => assertSameOrigin(request(
      "http://0.0.0.0:3000/api/auth/login",
      { origin: "not-a-url", "x-forwarded-host": "localhost:3000" },
    ))).toThrow("FORBIDDEN");
  });
});

describe("errorMessage", () => {
  it("explains blocked and unavailable requests instead of the generic fallback", () => {
    expect(errorMessage("FORBIDDEN")).not.toContain("Something went wrong");
    expect(errorMessage("SERVICE_UNAVAILABLE")).not.toContain("Something went wrong");
  });
});
