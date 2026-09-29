import type { Operation, JobStatus } from "./jobs";

export const TOOLS: Record<Operation, { title: string; description: string; input: string; accept: string; multiple: boolean }> = {
  image_to_pdf: { title: "Image to PDF", description: "Turn your images into one PDF, in the order you choose.", input: "PNG or JPG images", accept: ".png,.jpg,.jpeg,image/png,image/jpeg", multiple: true },
  pdf_to_image: { title: "PDF to image", description: "Export each page as an image, collected in a ZIP file.", input: "One or more PDF files", accept: ".pdf,application/pdf", multiple: true },
  merge_pdf: { title: "Merge PDF", description: "Bring your PDFs together into a single document.", input: "Two or more PDF files", accept: ".pdf,application/pdf", multiple: true },
  split_pdf: { title: "Split PDF", description: "Extract the pages you need as individual PDF files, collected in a ZIP file.", input: "One PDF file", accept: ".pdf,application/pdf", multiple: false },
  compress_pdf: { title: "Compress PDF", description: "Make a PDF smaller for sharing and everyday use.", input: "One PDF file", accept: ".pdf,application/pdf", multiple: false },
};

export type PublicJob = {
  id: string; status: JobStatus; operation?: Operation; inputNames?: string[];
  createdAt?: string; expiresAt?: string; outputName?: string; errorCode?: string;
};

const ERRORS: Record<string, string> = {
  UNAUTHENTICATED: "Your session ended. Sign in again to continue.",
  INVALID_CREDENTIALS: "Check your email and password, then try again.",
  FORBIDDEN: "This request was blocked. Reload the page and try again.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable. Try again in a moment.",
  INVALID_INPUT: "Check your files and options, then try again.",
  REGISTRATION_FAILED: "Could not create this account. Check your details or sign in if you already have an account.",
  INPUT_TOO_LARGE: "These files are too large. Choose smaller files and try again.",
  UNSUPPORTED_TYPE: "Choose a supported file type for this tool.",
  MIME_MISMATCH: "A file does not match its format. Export it again and retry.",
  JOB_EXPIRED: "These temporary files have expired. Upload your originals to start again.",
  JOB_NOT_FOUND: "This job is no longer available. Upload your originals to start again.",
  INVALID_JOB_STATE: "This job has changed. Refresh the page to see its current status.",
  UPLOAD_IN_PROGRESS: "An upload is already in progress. Wait a moment and try again.",
  UPLOAD_MISMATCH: "These files differ from the original upload. Start a new job.",
  password_protected: "This PDF is password protected. Upload an unlocked copy.",
  invalid_page_range: "Those pages could not be found. Check the page range and try again.",
  tool_timeout: "Processing took too long. Try a smaller document.",
  processing_failed: "This document could not be processed. Check the original file and try again.",
};

export function errorMessage(code: unknown): string {
  if (typeof code !== "string") return "Something went wrong. Please try again.";
  return ERRORS[code] ?? ERRORS[code.toUpperCase()] ?? "Something went wrong. Please try again.";
}
