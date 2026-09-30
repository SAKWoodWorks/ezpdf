import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { googleOnly } from "@/lib/google";

export default async function RegisterPage() {
  if (googleOnly()) redirect("/login");
  return <main id="main-content" className="auth-page"><Link className="wordmark" href="/">EZpdf<span className="wordmark-dot">.</span></Link><div className="auth-intro"><h1>A place for your PDF tasks.</h1><p>Create an account to convert, combine, split, and compress your documents.</p></div><AuthForm mode="register" /></main>;
}
