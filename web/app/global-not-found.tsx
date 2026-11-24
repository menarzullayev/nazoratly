import Link from "next/link";
import "./globals.css";

export const metadata = { title: "404 | nazoratly", robots: { index: false } };

export default function GlobalNotFound() {
  return (
    <html lang="uz-Latn">
      <body>
        <main className="mx-auto max-w-xl px-5 py-24">
          <h1 className="text-3xl font-semibold">404</h1>
          <p className="mt-3 text-zinc-300">Sahifa topilmadi · Страница не найдена · Page not found</p>
          <p className="mt-6">
            <Link className="underline" href="/">nazoratly</Link>
          </p>
        </main>
      </body>
    </html>
  );
}
