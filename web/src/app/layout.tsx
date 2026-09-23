import type { ReactNode } from "react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/fraunces/600.css";
import "./globals.css";

export const metadata = { title: "EZpdf", description: "Local, temporary PDF tools" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a>{children}</body></html>;
}
