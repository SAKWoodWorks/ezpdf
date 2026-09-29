// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobUploader } from "@/components/job-uploader";

vi.mock("@/lib/pdf-preview", () => ({ renderPdfFirstPage: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" }) as unknown as Buffer) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fakeObjectUrls() {
  let issued = 0;
  const revoked: string[] = [];
  const createObjectURL = vi.fn(() => `blob:preview-${++issued}`);
  const revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL, revoked };
}

function png(name: string) {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
}

function choose(files: File[]) {
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files } });
}

it("sizes input previews at 200x280", () => {
  fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png")]);
  const image = screen.getByAltText("a.png preview");
  expect(image).toHaveAttribute("width", "200");
  expect(image).toHaveAttribute("height", "280");
});

it("appends a later selection instead of replacing it", () => {
  fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png")]);
  choose([png("b.png")]);
  expect(screen.getByAltText("a.png preview")).toBeInTheDocument();
  expect(screen.getByAltText("b.png preview")).toBeInTheDocument();
  expect(screen.getByText("2 files selected")).toBeInTheDocument();
});

it("keeps one row when the same file is picked again", () => {
  const urls = fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png")]);
  choose([png("a.png")]);
  expect(screen.getAllByAltText("a.png preview")).toHaveLength(1);
  expect(urls.revoked).toEqual([]);
});

it("stacks every selected file as its own preview row", () => {
  fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png"), png("b.png"), png("c.png")]);
  for (const name of ["a.png", "b.png", "c.png"]) {
    expect(screen.getByAltText(`${name} preview`)).toBeInTheDocument();
  }
});

it("replaces the single file for one-file tools", () => {
  fakeObjectUrls();
  render(<JobUploader operation="compress_pdf" />);
  choose([new File(["%PDF-1.7 first"], "x.pdf", { type: "application/pdf" })]);
  choose([new File(["%PDF-1.7 second"], "y.pdf", { type: "application/pdf" })]);
  expect(screen.getByText("y.pdf")).toBeInTheDocument();
  expect(screen.queryByText("x.pdf")).not.toBeInTheDocument();
});

it("previews the first page of pdf inputs", async () => {
  fakeObjectUrls();
  render(<JobUploader operation="merge_pdf" />);
  choose([new File(["%PDF-1.7"], "doc.pdf", { type: "application/pdf" })]);
  expect(await screen.findByAltText("doc.pdf preview")).toBeInTheDocument();
});

it("releases every preview url when the uploader unmounts", async () => {
  const urls = fakeObjectUrls();
  const view = render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png"), png("b.png")]);
  expect(urls.revoked).toEqual([]);
  view.unmount();
  await Promise.resolve();
  expect(urls.revoked).toEqual(["blob:preview-1", "blob:preview-2"]);
});

it("opens a full page popup when a preview is clicked and closes it", async () => {
  const urls = fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png")]);
  expect(screen.queryByAltText("a.png full page")).not.toBeInTheDocument();
  fireEvent.click(screen.getByAltText("a.png preview"));
  const full = screen.getByAltText("a.png full page");
  expect(full).toHaveAttribute("src", "blob:preview-1");
  expect(screen.getByRole("button", { name: "Close preview" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(screen.queryByAltText("a.png full page")).not.toBeInTheDocument();
  expect(urls.revoked).toEqual([]);
});

it("closes the popup with the Escape key", () => {
  fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  choose([png("a.png")]);
  fireEvent.click(screen.getByAltText("a.png preview"));
  expect(screen.getByAltText("a.png full page")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByAltText("a.png full page")).not.toBeInTheDocument();
});
