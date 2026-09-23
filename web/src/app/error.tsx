"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main id="main-content" className="auth-page"><h1>Could not load your workbench.</h1><p className="field-help">The service is temporarily unavailable. Please try again.</p><button className="button secondary" onClick={reset}>Try again</button></main>;
}
