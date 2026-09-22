import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";
import { uploadJob } from "@/lib/lifecycle";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return Response.json(await uploadJob(request, id, user.id));
  } catch (error) { return apiError(error); }
}
