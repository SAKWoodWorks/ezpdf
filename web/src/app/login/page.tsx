import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export default function LoginPage() {
  return <main id="main-content" className="auth-page"><Link className="wordmark" href="/">EZpdf<span className="wordmark-dot">.</span></Link><div className="auth-intro"><h1>Back to your documents.</h1><p>Sign in to work with your PDFs and find your recent results.</p></div><AuthForm mode="login" /></main>;
}
