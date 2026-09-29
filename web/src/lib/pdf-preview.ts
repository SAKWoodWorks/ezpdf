"use client";

let workerConfigured = false;

export async function renderPdfFirstPage(file: File, edge = 400): Promise<Blob | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    if (!workerConfigured) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      workerConfigured = true;
    }
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(edge / base.width, edge / base.height, 4);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) return null;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      return await new Promise<Blob | null>(resolve => canvas.toBlob(blob => resolve(blob), "image/jpeg", 0.75));
    } finally { doc.cleanup(); }
  } catch { return null; }
}
