import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export default function RegisterPage() {
  return <main id="main-content" className="auth-page"><Link className="wordmark" href="/">EZpdf<span className="wordmark-dot">.</span></Link><div className="auth-intro"><h1>A place for your PDF tasks.</h1><p>Create an account to convert, combine, split, and compress your documents.</p></div><AuthForm mode="register" /></main>;
}
