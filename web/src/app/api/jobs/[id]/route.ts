import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { getOwnedJob } from "@/lib/jobs";
import { publicJob } from "@/lib/job-history";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json(publicJob(await getOwnedJob(id, user.id)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}
