import { adminEt } from "@/i18n/dict/admin";
import type { TabPill } from "./TabPills";

/**
 * The two tabs of Hindamine and Tunnistused (admin UX pass, A4; README: „Ootab hindamist {n}“ → /admin/hindamine, „Tunnistused“ →
 * /admin/tunnistused): both pages draw them, `current` is the page's own. `waiting` is the number of things that wait for Maria (the first tab's
 * count bubble, 0 included).
 */
export function assessmentTabs(current: "waiting" | "certificates", waiting: number): TabPill[] {
  const t = adminEt.assessment.tabs;
  return [
    { href: "/admin/hindamine", label: t.waiting, count: waiting, current: current === "waiting" },
    { href: "/admin/tunnistused", label: t.certificates, current: current === "certificates" },
  ];
}
