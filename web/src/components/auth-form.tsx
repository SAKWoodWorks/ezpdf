"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { errorMessage } from "@/lib/tool-info";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const registration = mode === "register";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) });
      const result = await response.json();
      if (!response.ok) { setError(errorMessage(result.error)); return; }
      router.push("/"); router.refresh();
    } catch { setError(errorMessage(null)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="auth-form">
    <label htmlFor="email">Email</label>
    <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} />
    <label htmlFor="password">Password</label>
    <input id="password" name="password" type="password" autoComplete={registration ? "new-password" : "current-password"} required minLength={registration ? 8 : undefined} maxLength={256} disabled={busy} aria-describedby={registration ? "password-help" : undefined} />
    {registration && <><p className="field-help" id="password-help">Use at least 8 characters.</p><label htmlFor="passwordConfirm">Confirm password</label><input id="passwordConfirm" name="passwordConfirm" type="password" autoComplete="new-password" required minLength={8} maxLength={256} disabled={busy} /></>}
    {error && <p role="alert" className="error-message">{error}</p>}
    <button className="button primary" disabled={busy}>{busy ? "Please wait…" : registration ? "Create account" : "Sign in"}</button>
    <p>{registration ? "Already have an account?" : "New here?"} <Link href={registration ? "/login" : "/register"}>{registration ? "Sign in" : "Create an account"}</Link></p>
  </form>;
}
