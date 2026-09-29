// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobUploader } from "@/components/job-uploader";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fakeObjectUrls() {
  let issued = 0;
  const revoked: string[] = [];
  const createObjectURL = vi.fn(() => `blob:preview-${++issued}`);
  const revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL, revoked };
}

it("previews selected image files from the local device", () => {
  const urls = fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "a.png", { type: "image/png" }),
    new File([new Uint8Array([255, 216, 255])], "b.jpg", { type: "image/jpeg" }),
  ] } });
  expect(screen.getByAltText("a.png preview")).toHaveAttribute("src", "blob:preview-1");
  expect(screen.getByAltText("b.jpg preview")).toHaveAttribute("src", "blob:preview-2");
  expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
});

it("does not preview pdf inputs", () => {
  fakeObjectUrls();
  render(<JobUploader operation="merge_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [
    new File(["%PDF-1.7"], "doc.pdf", { type: "application/pdf" }),
  ] } });
  expect(screen.queryByAltText("doc.pdf preview")).not.toBeInTheDocument();
});

it("revokes old preview urls when the selection changes", () => {
  const urls = fakeObjectUrls();
  render(<JobUploader operation="image_to_pdf" />);
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "a.png", { type: "image/png" }),
  ] } });
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "b.png", { type: "image/png" }),
  ] } });
  expect(urls.revoked).toEqual(["blob:preview-1"]);
  expect(screen.getByAltText("b.png preview")).toHaveAttribute("src", "blob:preview-2");
});
