"use client";
import { useEffect, useState } from "react";
import { errorMessage, TOOLS, type PublicJob } from "@/lib/tool-info";

const LABELS = { uploading: "Upload incomplete", queued: "Queued", processing: "Processing", ready: "Ready", failed: "Failed", expired: "Expired", downloaded: "Downloaded" };
export function JobStatus({ initialJob }: { initialJob: PublicJob }) {
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    if (job.status !== "ready") { setPages(0); return; }
    const controller = new AbortController();
    fetch(`/api/jobs/${job.id}/thumbnails`, { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : { pages: 0 })
      .then(result => setPages(Number(result.pages) || 0))
      .catch(() => undefined);
    return () => controller.abort();
  }, [job.id, job.status]);

  useEffect(() => {
    if (job.status !== "queued" && job.status !== "processing") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      let again = true;
      try {
        const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(errorMessage(result.error));
          if ([401, 404, 410].includes(response.status)) again = false;
          if (response.status === 410) setJob(current => ({ ...current, status: "expired" }));
        } else {
          setJob(current => ({ ...current, ...result })); setError("");
          again = result.status === "queued" || result.status === "processing";
        }
      } catch { if (!cancelled) setError("Could not check progress. Retrying shortly."); }
      if (!cancelled && again) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [job.id, job.status]);

  useEffect(() => {
    if (!job.expiresAt || job.status === "expired" || job.status === "downloaded") return;
    const delay = Date.parse(job.expiresAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => setJob(current => ({ ...current, status: "expired" })), Math.max(0, Math.min(delay, 2147483647)));
    return () => clearTimeout(timer);
  }, [job.expiresAt, job.status]);

  async function download() {
    setDownloading(true); setError("");
    try {
      const response = await fetch(`/api/jobs/${job.id}/download`, { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json(); setError(errorMessage(result.error));
        if (response.status === 410) setJob(current => ({ ...current, status: "expired" }));
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = job.outputName === "result.zip" ? "result.zip" : "result.pdf";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setJob(current => ({ ...current, status: "downloaded" }));
    } catch { setError("Download could not finish. Please try again before the files expire."); }
    finally { setDownloading(false); }
  }

  return <article className="job-row" aria-label={job.operation ? TOOLS[job.operation]?.title : "Job status"}>
    <div className="job-details">{job.operation && <h3>{TOOLS[job.operation]?.title}</h3>}{job.inputNames && <p className="job-filenames">{job.inputNames.join(", ")}</p>}
      <p role="status" className={`status status-${job.status}`}><span aria-hidden="true" />{LABELS[job.status]}</p>
      {job.status === "queued" && <p className="field-help">Your files are waiting to be processed.</p>}
      {job.status === "processing" && <p className="field-help">Working on your document. You can return to Recent jobs.</p>}
      {job.status === "failed" && <p className="error-message">{errorMessage(job.errorCode ?? "processing_failed")}</p>}
      {job.status === "expired" && <p className="field-help">Temporary files have expired. Upload your originals to start again.</p>}
      {job.status === "uploading" && <p className="field-help">The upload did not finish. Return to the upload tab to retry, or start a new job.</p>}
      {job.status === "downloaded" && <p className="field-help">Download delivered. Temporary files are being removed.</p>}
      {job.status === "ready" && <p className="field-help">Download once to keep your result. Temporary files are removed afterward.</p>}
      {job.expiresAt && !["expired", "downloaded"].includes(job.status) && <p className="field-help">Expires <time dateTime={job.expiresAt}>{new Date(job.expiresAt).toISOString().replace("T", " ").slice(0, 16)} UTC</time></p>}
      {error && <p role="alert" className="error-message">{error}</p>}
    </div>
    {job.status === "ready" && pages > 0 && (
      <div className="thumb-strip" aria-label="Page previews">
        {Array.from({ length: Math.min(pages, 50) }, (_, index) => (
          <img key={index + 1} src={`/api/jobs/${job.id}/thumbnails/${index + 1}`} alt={`Page ${index + 1} preview`} loading="lazy" width={240} height={240} />
        ))}
      </div>
    )}
    {job.status === "ready" && <button className="button primary" disabled={downloading} onClick={download}>{downloading ? "Downloading…" : "Download result"}</button>}
  </article>;
}
