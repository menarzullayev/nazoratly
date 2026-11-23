import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../globals.css";

export const metadata: Metadata = {
  title: "nazoratly lab",
  robots: { index: false, follow: false, nocache: true },
};

export default function LabLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz-Latn">
      <body>{children}</body>
    </html>
  );
}
