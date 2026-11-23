import type { ReactNode } from "react";
import { preloadFonts } from "@/components/FontPreload";
import "../globals.css";

export default function Layout({ children }: { children: ReactNode }) {
  preloadFonts(false);
  return (
    <html lang="uz-Latn">
      <body>{children}</body>
    </html>
  );
}
