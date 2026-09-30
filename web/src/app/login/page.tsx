import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { googleOnly } from "@/lib/google";

const ERRORS: Record<string, string> = {
  domain: "Only @sakww.com workspace accounts can sign in.",
  google: "Google sign-in is unavailable right now. Please try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  if (googleOnly()) {
    return <main id="main-content" className="auth-page"><Link className="wordmark" href="/">EZpdf<span className="wordmark-dot">.</span></Link><div className="auth-intro"><h1>Back to your documents.</h1><p>Sign in with your @sakww.com workspace account.</p></div><a className="button primary google-button" href="/api/auth/google">Sign in with Google</a>{error && <p role="alert" className="error-message">{error}</p>}<p className="field-help">Personal Gmail addresses cannot sign in.</p></main>;
  }
  return <main id="main-content" className="auth-page"><Link className="wordmark" href="/">EZpdf<span className="wordmark-dot">.</span></Link><div className="auth-intro"><h1>Back to your documents.</h1><p>Sign in to work with your PDFs and find your recent results.</p></div>{error && <p role="alert" className="error-message">{error}</p>}<AuthForm mode="login" /></main>;
}
