"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function signOut() {
    setBusy(true); setError(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      router.push("/login"); router.refresh();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div className="sign-out"><button onClick={signOut} disabled={busy} className="text-button">{busy ? "Signing out…" : "Sign out"}</button>{error && <span role="alert">Could not sign out. Try again.</span>}</div>;
}
