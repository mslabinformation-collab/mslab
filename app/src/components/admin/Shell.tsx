import { adminEt } from "@/i18n/dict/admin";
import { adminName } from "@/server/auth";
import { getAdminCounts } from "./data";
import { menuOf } from "./menu";
import { ReadyMark } from "./ReadyMark";
import { SECTIONS } from "./sections";
import { Sidebar, type NavItem, type SidebarTexts } from "./Sidebar";
import styles from "./Shell.module.css";

/**
 * Prototype B `adminShell()`: the dark sidebar on the left, the main column with the top line ("MS LAB ·
 * Halduskeskkond" and who is signed in) and the page. The (panel) layout renders it once around every admin page
 * (admin UX pass, spec C2), so loading.tsx and error.tsx keep the menu on screen. The menu's badges are read here for the first paint
 * (menu.ts menuOf); the layout does not render again when the visitor moves between pages, so the sidebar asks /api/admin/margid for them
 * again then. The active entry is not known here: the sidebar reads it from the address (sections.ts activeSection).
 */
export async function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  const menu = menuOf(await getAdminCounts(email));
  const t = adminEt.shell;
  const items: NavItem[] = SECTIONS.map((s) => ({ ...s, href: menu.hrefs[s.key] ?? s.href, label: adminEt.nav[s.key], badge: menu.badges[s.key] }));
  const name = adminName(email);
  const texts: SidebarTexts = {
    label: t.label,
    nav: t.nav,
    home: t.home,
    openMenu: t.openMenu,
    closeMenu: t.closeMenu,
    viewSite: t.preview,
    newWindow: t.newWindow,
    signedIn: t.signedIn,
    logout: t.logout,
    groups: adminEt.nav.groups,
    today: t.today,
    todayLine: t.todayLine,
  };
  const sidebar = {
    items,
    // the phone's ≡ button: what the menu's numeric badges add up to
    total: menu.total,
    t: texts,
    email,
    // the first session on today's date, for the phone menu's card
    today: menu.today,
  };

  return (
    <div className={styles.layout}>
      <ReadyMark />
      <a href="#main" className={styles.skip}>
        {t.skip}
      </a>
      <Sidebar {...sidebar} />
      <main id="main" className={styles.main} tabIndex={-1}>
        {/* data-admin-top: ReadyMark tells the shell's own line from the page's content */}
        <div className={styles.top} data-admin-top="">
          <span>{t.top}</span>
          <span className={styles.end}>
            {/* The site behind the coming-soon gate: the route gives this admin the preview cookie, then opens the home
                page (a plain link: it is an API route). Opener only. The one „Vaata kodulehte“ of the desktop screen; the phone menu's
                footer has its own. */}
            <a href="/api/admin/preview" target="_blank" rel="noopener" className={styles.preview} data-admin-preview="">
              {t.preview} <span aria-hidden="true">↗</span>
              <span className={styles.sr}> ({t.newWindow})</span>
            </a>
            {/* no tooltip: a touch screen has none, and the sidebar's footer names the signed-in e-mail */}
            <span className={styles.who}>
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
