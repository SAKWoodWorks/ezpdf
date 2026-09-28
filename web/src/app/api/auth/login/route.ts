import { authenticate } from "@/lib/session";
export const runtime = "nodejs";
export async function POST(request: Request) { return authenticate(request); }
