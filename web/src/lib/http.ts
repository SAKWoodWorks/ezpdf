export class ApiError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export function apiError(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.code }, { status: error.status });
  // Do not expose paths, tokens, filenames, or upstream diagnostics.
  console.error("Job API request failed");
  return Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("FORBIDDEN", 403);
  }
}

export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ApiError("INPUT_TOO_LARGE", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError("INPUT_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function readJson(request: Request): Promise<unknown> {
  const bytes = await readLimitedBody(request, 65536);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError("INVALID_INPUT"); }
}
