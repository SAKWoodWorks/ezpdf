import Link from "next/link";
import type { ReactNode } from "react";
import { TOOLS } from "@/lib/tool-info";
import type { Operation } from "@/lib/jobs";
import { SignOut } from "./sign-out";

export function Workbench({ children, operation }: { children: ReactNode; operation?: Operation }) {
  return <><header className="site-header"><Link href="/" className="wordmark">EZpdf<span className="wordmark-dot">.</span></Link><span className="header-note">Your document workbench</span><SignOut /></header>
    <div className="workbench"><nav className="tool-nav" aria-label="PDF tools"><Link href="/" aria-current={!operation ? "page" : undefined}>Recent jobs</Link>{Object.entries(TOOLS).map(([key, tool]) => <Link key={key} href={`/tools/${key}`} aria-current={operation === key ? "page" : undefined}>{tool.title}</Link>)}</nav><main id="main-content">{children}</main></div>
    <footer className="site-footer">Temporary files. Download your result before it expires. Files are removed after download or expiry.</footer></>;
}
