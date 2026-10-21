import { Shell } from "@/components/admin/Shell";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

// Everything under (panel) is for signed-in admins. The layout is the first line of defence; it does not run again
// when the visitor moves between pages inside it, so each page (and action, and route handler) checks for itself.
// It also holds the Shell (admin UX pass, spec C2): the sidebar and the top line stay on screen while a page loads (loading.tsx)
// or fails (error.tsx), and the sidebar reads its active entry from the address.
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const email = await requireAdmin();
  return <Shell email={email}>{children}</Shell>;
}
