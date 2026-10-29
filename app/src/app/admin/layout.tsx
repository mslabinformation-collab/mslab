import type { Metadata } from "next";
import { adminEt } from "@/i18n/dict/admin";
import { REVIEW_TOOLS } from "@/lib/review-tools";
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

// Review tools until launch (Dim 22.10): the comment bubble (public/feedback.js → /api/feedback) is on every signed-in admin page, under the same
// switch as the site's (NEXT_PUBLIC_REVIEW_TOOLS, switched off at the mslab.ee launch). It is loaded by the (panel) layout, not here: /admin/login
// and the other signed-out pages have none, because while the gate is on a signed-out visitor has no preview cookie and a comment could not be sent.
// data-fb-dir (here, on the html element) tells the script, when it runs, that the page's comments are the admin's (dir "admin"; the site's stay "site").
// On an admin page the bubble stands in the admin's own frame, over the sidebar's or the phone bar's [data-fb-dock] (Sidebar.tsx; admin polish F18), out
// of every page's way; the admin's bottom-fixed bars carry data-fab-avoid, so it steps aside while one lies over that place (and lifts above them in
// the corner, where a page has no such place).
export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="et" className={fontVariables} data-admin="" data-fb-dir={REVIEW_TOOLS ? "admin" : undefined}>
      <body>{children}</body>
    </html>
  );
}
