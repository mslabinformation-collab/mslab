import { Suspense } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { adminName } from "@/server/auth";
import { getAdminCounts } from "./data";
import { ReadyMark } from "./ReadyMark";
import { SECTIONS, type Section } from "./sections";
import { Sidebar, SidebarWithoutActive, type NavItem } from "./Sidebar";
import styles from "./Shell.module.css";

/**
 * Prototype B `adminShell()`: the dark sidebar on the left, the main column with the top line ("MS LAB ·
 * Halduskeskkond" and who is signed in) and the page. The (panel) layout renders it once around every admin page
 * (admin UX pass, spec C2), so loading.tsx and error.tsx keep the menu on screen. The menu badges are read here: open
 * registrations and requests, and what waits in Hindamine. The active entry is not known here: the sidebar reads it
 * from the address (sections.ts activeSection).
 */
export async function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  const counts = await getAdminCounts();
  const t = adminEt.shell;
  const openRequests = Object.values(counts.openRequests).reduce((a, b) => a + b, 0);
  const badges: Partial<Record<Section, NavItem["badge"]>> = {
    registrations: counts.awaitingPrepayment ? { n: counts.awaitingPrepayment, label: fill(t.badgeRegistrations, { n: counts.awaitingPrepayment }) } : undefined,
    assessment: counts.assessment ? { n: counts.assessment, label: fill(t.badgeAssessment, { n: counts.assessment }) } : undefined,
    requests: openRequests ? { n: openRequests, label: fill(t.badgeRequests, { n: openRequests }) } : undefined,
  };
  const items: NavItem[] = SECTIONS.map((s) => ({ ...s, label: adminEt.nav[s.key], badge: badges[s.key] }));
  const name = adminName(email);
  const sidebar = {
    items,
    total: counts.awaitingPrepayment + openRequests + counts.assessment,
    t: {
      label: t.label,
      nav: t.nav,
      home: t.home,
      openMenu: t.openMenu,
      closeMenu: t.closeMenu,
      viewSite: t.viewSite,
      newWindow: t.newWindow,
      logout: t.logout,
    },
  };

  return (
    <div className={styles.layout}>
      <ReadyMark />
      <a href="#main" className={styles.skip}>
        {t.skip}
      </a>
      {/* useSearchParams (the active entry) needs a boundary; the fallback is the same menu with no entry marked, so the sidebar never flashes empty. */}
      <Suspense fallback={<SidebarWithoutActive {...sidebar} />}>
        <Sidebar {...sidebar} />
      </Suspense>
      <main id="main" className={styles.main} tabIndex={-1}>
        {/* data-admin-top: ReadyMark tells the shell's own line from the page's content */}
        <div className={styles.top} data-admin-top="">
          <span>{t.top}</span>
          <span className={styles.end}>
            {/* The site behind the coming-soon gate: the route gives this admin the preview cookie, then opens the home
                page (a plain link: it is an API route). Opener only, as the sidebar's "Vaata lehte". */}
            <a href="/api/admin/preview" target="_blank" rel="noopener" className={styles.preview} data-admin-preview="">
              {t.preview} <span aria-hidden="true">↗</span>
              <span className={styles.sr}> ({t.newWindow})</span>
            </a>
            <span className={styles.who} title={fill(t.signedInAs, { email })}>
              {name && <span className={styles.whoName}>{name}</span>}
              <span className={styles.avatar} aria-hidden="true">
                {(name || email).charAt(0).toUpperCase()}
              </span>
            </span>
          </span>
        </div>
        {children}
      </main>
    </div>
  );
}
