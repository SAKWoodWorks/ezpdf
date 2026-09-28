import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin, readJson } from "@/lib/http";
import { createJob, validateCreateJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const job = await createJob(validateCreateJob(await readJson(request)), user.id);
    return Response.json({ id: job.id, status: "uploading" }, { status: 201 });
  } catch (error) { return apiError(error); }
}
