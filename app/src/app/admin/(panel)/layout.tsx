import Script from "next/script";
import { EditLangProvider } from "@/components/admin/EditLang";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { Shell } from "@/components/admin/Shell";
import { UndoProvider } from "@/components/admin/UndoBar";
import { FEEDBACK_SCRIPT, REVIEW_TOOLS } from "@/lib/review-tools";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

// Everything under (panel) is for signed-in admins. The layout is the first line of defence; it does not run again
// when the visitor moves between pages inside it, so each page (and action, and route handler) checks for itself.
// It also holds the Shell (admin UX pass, spec C2): the sidebar and the top line stay on screen while a page loads (loading.tsx)
// or fails (error.tsx), and the sidebar reads its active entry from the address.
// The UndoProvider (README §1.7) sits inside Shell's main, round the page: one „Võta tagasi“ bar for every screen (useUndo). The leave guard
// (README §1.5) is round it: a menu click, Back or a drawer's close waits for (or asks about) the page's unsaved text, and its notice is at the
// top of the page. The EditLangProvider (README §1.9) is round the page too: the ET | RU switch in a page's heading sets the language of its fields, and the
// choice stays when the visitor moves to the next page.
// Review tools until launch (Dim 22.10): the comment bubble (public/feedback.js → /api/feedback) is loaded here, so on every signed-in admin page and on
// none of the signed-out ones (/admin/login): while the gate is on, only a signed-in admin carries the preview cookie the comment API needs. The
// root layout (app/admin) labels the comments as the admin's (data-fb-dir). NEXT_PUBLIC_REVIEW_TOOLS is the site's switch (lib/review-tools.ts).
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const email = await requireAdmin();
  return (
    <>
      <Shell email={email}>
        <LeaveGuardProvider>
          <UndoProvider>
            <EditLangProvider>{children}</EditLangProvider>
          </UndoProvider>
        </LeaveGuardProvider>
      </Shell>
      {REVIEW_TOOLS && <Script src={FEEDBACK_SCRIPT} strategy="afterInteractive" />}
    </>
  );
}
