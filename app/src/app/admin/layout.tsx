import type { Metadata } from "next";
import { adminEt } from "@/i18n/dict/admin";
import { fontVariables } from "../fonts";
import "@/styles/tokens.css";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: adminEt.meta.title,
  robots: { index: false, follow: false },
};

// Root layout of the admin area (Estonian only; Maria and Dim). Pages inside are signed-in only, except /admin/login,
// and are never cached.
export const dynamic = "force-dynamic";

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="et" className={fontVariables} data-admin="">
      <body>{children}</body>
    </html>
  );
}
