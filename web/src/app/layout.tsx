import type { ReactNode } from "react";

export const metadata = { title: "EZpdf", description: "Local, temporary PDF tools" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
