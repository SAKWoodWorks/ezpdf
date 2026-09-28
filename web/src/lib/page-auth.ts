import "server-only";
import { redirect } from "next/navigation";
import { requireUser } from "./auth";
import { ApiError } from "./http";

export async function requirePageUser() {
  try { return await requireUser(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    throw error;
  }
}
