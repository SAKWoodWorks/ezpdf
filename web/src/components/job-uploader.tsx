"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Operation } from "@/lib/jobs";
import { errorMessage, TOOLS, type PublicJob } from "@/lib/tool-info";
import { renderPdfFirstPage } from "@/lib/pdf-preview";
import { JobStatus } from "./job-status";

function isPreviewable(file: File): boolean {
  return /\.(png|jpe?g)$/i.test(file.name) && typeof URL.createObjectURL === "function";
}

function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name);
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}`;
}

export function JobUploader({ operation }: { operation: Operation }) {
  const tool = TOOLS[operation];
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const urlCache = useRef(new Map<string, string>());
  const rendering = useRef(new Set<string>());
  const [pageRange, setPageRange] = useState("");
  const [imageFormat, setImageFormat] = useState("png");
  const [preset, setPreset] = useState("balanced");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<PublicJob | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const uploading = useRef(false);

  function previewUrl(file: File): string | null {
    const key = fileKey(file);
    const cached = urlCache.current.get(key);
    if (cached) return cached;
    if (!isPreviewable(file)) return null;
    const url = URL.createObjectURL(file);
    urlCache.current.set(key, url);
    return url;
  }

  function queuePdfPreview(file: File) {
    const key = fileKey(file);
    if (rendering.current.has(key)) return;
    rendering.current.add(key);
    renderPdfFirstPage(file).then(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      urlCache.current.set(key, url);
      setPreviews(current => (current[key] ? current : { ...current, [key]: url }));
    }).catch(() => undefined).finally(() => { rendering.current.delete(key); });
  }

  function replaceSelection(next: File[]) {
    setPendingId(null); setError(""); setFiles(next);
    const nextPreviews: Record<string, string> = {};
    for (const file of next) {
      const url = previewUrl(file);
      if (url) nextPreviews[fileKey(file)] = url;
    }
    setPreviews(nextPreviews);
    for (const file of next) {
      if (isPdf(file) && !urlCache.current.has(fileKey(file))) queuePdfPreview(file);
    }
  }

  useEffect(() => () => {
    urlCache.current.forEach(url => URL.revokeObjectURL(url));
    urlCache.current.clear();
  }, []);

  function appendFiles(incoming: File[]) {
    if (uploading.current || !incoming.length) return;
    if (!tool.multiple) { replaceSelection([incoming[incoming.length - 1]]); return; }
    const merged = [...files];
    for (const file of incoming) {
      if (!merged.some(existing => fileKey(existing) === fileKey(file))) merged.push(file);
    }
    if (merged.length === files.length) { setPendingId(null); setError(""); return; }
    replaceSelection(merged);
  }

  function moveFile(index: number, offset: number) {
    const next = [...files];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    replaceSelection(next);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading.current) return;
    setError("");
    if (!files.length || files.length > 100 || (!tool.multiple && files.length !== 1) || (operation === "merge_pdf" && files.length < 2)) {
      setError(operation === "merge_pdf" ? "Choose between 2 and 100 PDF files." : tool.multiple ? "Choose between 1 and 100 images." : "Choose one PDF file."); return;
    }
    if (files.some(file => !file.size || !(operation === "image_to_pdf" ? /\.(png|jpe?g)$/i : /\.pdf$/i).test(file.name))) { setError(errorMessage("UNSUPPORTED_TYPE")); return; }
    if (files.reduce((total, file) => total + file.size, 0) > 200 * 1024 * 1024) { setError(errorMessage("INPUT_TOO_LARGE")); return; }
    const pages = pageRange.replace(/\s/g, "");
    if (operation === "split_pdf" && (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages) || pages.split(",").some(part => { const [start, end = start] = part.split("-").map(Number); return !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start; }))) { setError("Enter valid pages, such as 1-3,5."); return; }
    uploading.current = true; setBusy(true);
    try {
      const options: Record<string, string> = operation === "split_pdf" ? { pageRange: pages } : operation === "pdf_to_image" ? { imageFormat } : operation === "compress_pdf" ? { preset } : {};
      let uploadId = pendingId;
      if (!uploadId) {
        setStage("Preparing your job…");
        const response = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, inputNames: files.map(file => file.name), options }) });
        const result = await response.json();
        if (!response.ok) { setError(errorMessage(result.error)); return; }
        uploadId = result.id;
        setPendingId(uploadId);
      }
      setStage("Uploading your files…");
      const form = new FormData();
      files.forEach(file => form.append("files", file));
      const response = await fetch(`/api/jobs/${uploadId}/upload`, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) {
        if (result.error === "INVALID_JOB_STATE") {
          // The original upload may have succeeded even if its response was lost.
          // Keep the ID on uncertain/queued results so retries can republish it.
          setStage("Checking your job…");
          const statusResponse = await fetch(`/api/jobs/${uploadId}`, { cache: "no-store" });
          const current = await statusResponse.json();
          if (!statusResponse.ok) { setError(errorMessage(current.error)); return; }
          if (current.id === uploadId && ["processing", "ready", "failed", "downloaded", "expired"].includes(current.status)) {
            setJob({ operation, inputNames: files.map(file => file.name), ...current });
            setPendingId(null);
            return;
          }
        }
        setError(errorMessage(result.error));
        if (["JOB_EXPIRED", "JOB_NOT_FOUND", "UPLOAD_MISMATCH"].includes(result.error)) setPendingId(null);
        return;
      }
      setJob({ id: uploadId!, status: "queued", operation, inputNames: files.map(file => file.name) });
      setPendingId(null);
    } catch { setError(errorMessage(null)); }
    finally { uploading.current = false; setBusy(false); setStage(""); }
  }

  if (job) return <section aria-label="Your job"><JobStatus initialJob={job} /><button className="button secondary" onClick={() => { setJob(null); setFiles([]); setError(""); }}>Start another job</button></section>;
  return <form onSubmit={submit} className="upload-form">
    <fieldset disabled={busy}>
      <legend className="sr-only">Upload and options</legend>
      <div className="upload-surface" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); appendFiles(Array.from(event.dataTransfer.files)); }}>
        <svg aria-hidden="true" width="44" height="50" viewBox="0 0 44 50" fill="none"><path d="M8 2h20l9 9v36H8V2Z" stroke="currentColor" strokeWidth="2"/><path d="M28 2v10h9M15 29l7-7 7 7M22 22v16" stroke="currentColor" strokeWidth="2"/></svg>
        <h2>Add your documents</h2><p>Drop files here, or choose them from your device. Picking more files adds them.</p>
        <label className="file-label" htmlFor={`files-${operation}`}>Choose files</label>
        <input id={`files-${operation}`} className="file-input" type="file" accept={tool.accept} multiple={tool.multiple} aria-describedby="file-help" onChange={event => { appendFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <p id="file-help" className="field-help">{tool.input}. Up to 200 MB total.</p>
      </div>
      {files.length > 0 && <div className="selected-files"><h3>{files.length} {files.length === 1 ? "file" : "files"} selected</h3>{tool.multiple && <p className="field-help">Files are processed in this order.</p>}<ol>{files.map((file, index) => <li key={`${index}-${file.name}`}>{previews[fileKey(file)] && <img className="file-thumb" src={previews[fileKey(file)]} alt={`${file.name} preview`} width={200} height={280} />}<span className="file-name">{file.name}<small>{(file.size / 1024).toFixed(1)} KB</small></span><div className="file-actions">{tool.multiple && <><button type="button" className="icon-button" aria-label={`Move ${file.name} up`} disabled={index === 0} onClick={() => moveFile(index, -1)}>↑</button><button type="button" className="icon-button" aria-label={`Move ${file.name} down`} disabled={index === files.length - 1} onClick={() => moveFile(index, 1)}>↓</button></>}<button type="button" className="text-button" aria-label={`Remove ${file.name}`} onClick={() => replaceSelection(files.filter((_, position) => position !== index))}>Remove</button></div></li>)}</ol></div>}
      {operation === "split_pdf" && <div className="tool-option"><label htmlFor="pageRange">Pages to extract</label><input id="pageRange" value={pageRange} onChange={event => { setPendingId(null); setPageRange(event.target.value); }} placeholder="1-3,5" required maxLength={1000} aria-describedby="pages-help" /><p id="pages-help" className="field-help">Use commas for separate pages and a hyphen for a range, such as 1-3,5.</p></div>}
      {operation === "pdf_to_image" && <div className="tool-option"><label htmlFor="imageFormat">Image format</label><select id="imageFormat" value={imageFormat} onChange={event => { setPendingId(null); setImageFormat(event.target.value); }}><option value="png">PNG</option><option value="jpg">JPG</option></select></div>}
      {operation === "compress_pdf" && <div className="tool-option"><label htmlFor="preset">Compression</label><select id="preset" value={preset} onChange={event => { setPendingId(null); setPreset(event.target.value); }}><option value="balanced">Balanced</option><option value="smallest">Smallest</option></select><p className="field-help">Balanced preserves more detail. Smallest favors file size over image quality.</p></div>}
    </fieldset>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="submit-row"><button className="button primary" disabled={busy || !files.length}>{busy ? stage : pendingId ? "Retry upload" : tool.title}</button><p role="status">{busy ? "Keep this page open while your files upload." : "Files are available for a limited time."}</p></div>
  </form>;
}
