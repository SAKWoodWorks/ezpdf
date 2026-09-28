// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ToolPage from "@/app/tools/[operation]/page";
import { JobUploader } from "@/components/job-uploader";
import { JobStatus } from "@/components/job-status";
import { AuthForm } from "@/components/auth-form";

vi.mock("@/lib/page-auth", () => ({ requirePageUser: async () => ({ id: "owner-a" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: () => { throw new Error("NOT_FOUND"); } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("renders each tool with its supported file picker", async () => {
  for (const [operation, title, accept, multiple] of [
    ["merge_pdf", "Merge PDF", ".pdf,application/pdf", true],
    ["split_pdf", "Split PDF", ".pdf,application/pdf", false],
    ["compress_pdf", "Compress PDF", ".pdf,application/pdf", false],
    ["pdf_to_image", "PDF to image", ".pdf,application/pdf", false],
    ["image_to_pdf", "Image to PDF", ".png,.jpg,.jpeg,image/png,image/jpeg", true],
  ] as const) {
    render(await ToolPage({ params: Promise.resolve({ operation }) }));
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    const input = screen.getByLabelText("Choose files") as HTMLInputElement;
    expect(input.accept).toBe(accept);
    expect(input.multiple).toBe(multiple);
    cleanup();
  }
});

it("rejects unknown tool routes", async () => {
  await expect(ToolPage({ params: Promise.resolve({ operation: "unknown" }) })).rejects.toThrow("NOT_FOUND");
});

it("requires split pages and limits output and compression options", () => {
  const { unmount } = render(<JobUploader operation="split_pdf" />);
  expect(screen.getByLabelText("Pages to extract")).toBeRequired();
  unmount();
  const compression = render(<JobUploader operation="compress_pdf" />);
  expect(screen.getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["balanced", "smallest"]);
  compression.unmount();
  render(<JobUploader operation="pdf_to_image" />);
  expect(screen.getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["png", "jpg"]);
});

it("creates a job then uploads files in the displayed order", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json(url.endsWith("/upload") ? { status: "queued" } : { id: "abcdefghijklmno", status: "uploading" });
  });
  render(<JobUploader operation="merge_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pdf"], "first.pdf", { type: "application/pdf" }), new File(["pdf"], "second.pdf", { type: "application/pdf" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Move second.pdf up" }));
  fireEvent.click(screen.getByRole("button", { name: "Merge PDF" }));
  await screen.findByText("Queued");
  expect(requests.map(request => request.url)).toEqual(["/api/jobs", "/api/jobs/abcdefghijklmno/upload"]);
  expect(JSON.parse(requests[0].init.body as string)).toEqual({ operation: "merge_pdf", inputNames: ["second.pdf", "first.pdf"], options: {} });
  expect((requests[1].init.body as FormData).getAll("files").map(file => (file as File).name)).toEqual(["second.pdf", "first.pdf"]);
});

it("polls only active jobs and exposes download only when ready", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "abcdefghijklmno", status: "ready", outputName: "result.pdf" }));
  vi.stubGlobal("fetch", fetcher);
  render(<JobStatus initialJob={{ id: "abcdefghijklmno", status: "queued" }} />);
  expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  const statusPolls = fetcher.mock.calls.filter(([url]) => String(url) === "/api/jobs/abcdefghijklmno");
  expect(statusPolls).toHaveLength(1);
});

it("retries an interrupted upload against the same job", async () => {
  const paths: string[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    paths.push(url);
    if (url.endsWith("/upload")) return ++uploads === 1 ? Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 }) : Response.json({ status: "queued" });
    return Response.json({ id: "abcdefghijklmno", status: "uploading" });
  });
  render(<JobUploader operation="compress_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pdf"], "a.pdf", { type: "application/pdf" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Compress PDF" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry upload" }));
  await screen.findByText("Queued");
  expect(paths).toEqual(["/api/jobs", "/api/jobs/abcdefghijklmno/upload", "/api/jobs/abcdefghijklmno/upload"]);
});

it.each(["processing", "ready"] as const)("recovers a lost upload response when the original job is %s without creating a duplicate", async status => {
  const requests: { url: string; method: string }[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET" });
    if (url === "/api/jobs") return Response.json({ id: "abcdefghijklmno", status: "uploading" });
    if (url.endsWith("/upload")) {
      if (++uploads === 1) throw new TypeError("Upload response lost");
      return Response.json({ error: "INVALID_JOB_STATE" }, { status: 409 });
    }
    return Response.json({ id: "abcdefghijklmno", status, operation: "compress_pdf", inputNames: ["a.pdf"], outputName: status === "ready" ? "result.pdf" : undefined });
  });
  render(<JobUploader operation="compress_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pdf"], "a.pdf", { type: "application/pdf" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Compress PDF" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry upload" }));
  await screen.findByText(status === "ready" ? "Ready" : "Processing");
  expect(requests).toEqual([
    { url: "/api/jobs", method: "POST" },
    { url: "/api/jobs/abcdefghijklmno/upload", method: "POST" },
    { url: "/api/jobs/abcdefghijklmno/upload", method: "POST" },
    { url: "/api/jobs/abcdefghijklmno", method: "GET" },
    ...(status === "ready" ? [{ url: "/api/jobs/abcdefghijklmno/thumbnails", method: "GET" }] : []),
  ]);
  expect(screen.queryByRole("button", { name: "Retry upload" })).not.toBeInTheDocument();
  if (status === "ready") expect(screen.getByRole("button", { name: "Download result" })).toBeInTheDocument();
});

it("retains the original job when status reconciliation is unavailable", async () => {
  let creations = 0;
  let statusReads = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/jobs") { creations++; return Response.json({ id: "abcdefghijklmno", status: "uploading" }); }
    if (url.endsWith("/upload")) return Response.json({ error: "INVALID_JOB_STATE" }, { status: 409 });
    if (url.endsWith("/thumbnails")) return Response.json({ pages: 1 });
    return ++statusReads === 1 ? Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 }) : Response.json({ id: "abcdefghijklmno", status: "ready", outputName: "result.pdf" });
  });
  render(<JobUploader operation="compress_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pdf"], "a.pdf", { type: "application/pdf" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Compress PDF" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry upload" }));
  await screen.findByText("Ready");
  expect(creations).toBe(1);
  expect(statusReads).toBe(2);
});

it.each([
  ["split_pdf", "Pages to extract", "2-4,6", { pageRange: "2-4,6" }, "Split PDF"],
  ["pdf_to_image", "Image format", "jpg", { imageFormat: "jpg" }, "PDF to image"],
  ["compress_pdf", "Compression", "smallest", { preset: "smallest" }, "Compress PDF"],
] as const)("submits the selected %s options", async (operation, label, value, expected, title) => {
  let submitted: unknown;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url === "/api/jobs") submitted = JSON.parse(init.body as string).options;
    return Response.json(url.endsWith("/upload") ? { status: "queued" } : { id: "abcdefghijklmno", status: "uploading" });
  });
  render(<JobUploader operation={operation} />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pdf"], "a.pdf", { type: "application/pdf" })] } });
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: title }));
  await screen.findByText("Queued");
  expect(submitted).toEqual(expected);
});

it.each(["failed", "expired", "downloaded", "uploading"] as const)("does not poll %s jobs or show a download", async status => {
  vi.useFakeTimers();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<JobStatus initialJob={{ id: "abcdefghijklmno", status, errorCode: "/private/raw/log" }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  expect(screen.queryByText("/private/raw/log")).not.toBeInTheDocument();
});

it("shows a safe auth error without exposing server diagnostics", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: "INTERNAL_STACK_TRACE" }, { status: 500 }));
  render(<AuthForm mode="login" />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/try again/i));
  expect(screen.queryByText("INTERNAL_STACK_TRACE")).not.toBeInTheDocument();
});
