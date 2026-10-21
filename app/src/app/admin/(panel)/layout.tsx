import { Shell } from "@/components/admin/Shell";
import { UndoProvider } from "@/components/admin/UndoBar";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

// Everything under (panel) is for signed-in admins. The layout is the first line of defence; it does not run again
// when the visitor moves between pages inside it, so each page (and action, and route handler) checks for itself.
// It also holds the Shell (admin UX pass, spec C2): the sidebar and the top line stay on screen while a page loads (loading.tsx)
// or fails (error.tsx), and the sidebar reads its active entry from the address.
// The UndoProvider (README §1.7) sits inside Shell's main, round the page: one „Võta tagasi“ bar for every screen (useUndo).
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const email = await requireAdmin();
  return (
    <Shell email={email}>
      <UndoProvider>{children}</UndoProvider>
    </Shell>
  );
}
