import { requireUser } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";
import { downloadJob } from "@/lib/lifecycle";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    return await downloadJob(id, user.id);
  } catch (error) { return apiError(error); }
}
