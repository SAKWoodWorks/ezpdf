import { requireUser } from "@/lib/auth";
import { ApiError, apiError } from "@/lib/http";
import { getOwnedJob } from "@/lib/jobs";
import { countThumbnails } from "@/lib/lifecycle";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const job = await getOwnedJob(id, user.id);
    if (job.status !== "ready") throw new ApiError("INVALID_JOB_STATE", 409);
    return Response.json({ pages: await countThumbnails(job) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}
