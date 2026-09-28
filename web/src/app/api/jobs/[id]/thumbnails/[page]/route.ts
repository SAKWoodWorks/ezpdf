import { requireUser } from "@/lib/auth";
import { ApiError, apiError } from "@/lib/http";
import { getOwnedJob, assertLiveJob } from "@/lib/jobs";
import { readThumbnail } from "@/lib/lifecycle";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; page: string }> }) {
  try {
    const user = await requireUser(request);
    const { id, page } = await context.params;
    const job = await getOwnedJob(id, user.id);
    assertLiveJob(job);
    if (job.status !== "ready") throw new ApiError("INVALID_JOB_STATE", 409);
    const data = await readThumbnail(job, Number(page));
    if (!data) throw new ApiError("JOB_NOT_FOUND", 404);
    return new Response(new Uint8Array(data), { headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return apiError(error); }
}
