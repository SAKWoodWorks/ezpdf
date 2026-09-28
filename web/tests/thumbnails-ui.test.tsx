// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobStatus } from "@/components/job-status";

const readyJob = { id: "abcdefghijklmno", operation: "image_to_pdf" as const, inputNames: ["photo.png"], status: "ready" as const, outputName: "result.pdf", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows one preview image per page once the job is ready", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/thumbnails")) return Response.json({ pages: 2 });
    throw new Error(`unexpected fetch ${url}`);
  }));
  render(<JobStatus initialJob={readyJob} />);
  await waitFor(() => expect(screen.getByRole("img", { name: "Page 1 preview" })).toBeInTheDocument());
  expect(screen.getByRole("img", { name: "Page 2 preview" })).toHaveAttribute("src", "/api/jobs/abcdefghijklmno/thumbnails/2");
});

it("shows no preview strip when the worker produced none", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pages: 0 })));
  render(<JobStatus initialJob={readyJob} />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
