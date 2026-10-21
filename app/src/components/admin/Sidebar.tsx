"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/site/Logo";
import { lockPageScroll } from "@/lib/modal";
import { AdminIcon, type AdminIconName } from "./AdminIcon";
import { activeSection, type Section } from "./sections";
import styles from "./Sidebar.module.css";

export type NavItem = { key: Section; href: string; icon: AdminIconName; label: string; badge?: { n: number; label: string } };

export type SidebarTexts = {
  label: string;
  nav: string;
  home: string;
  openMenu: string;
  closeMenu: string;
  viewSite: string;
  newWindow: string;
  logout: string;
};

/** Below this width the sidebar is a top bar with a menu button (the drawer); B turned it into a scrolling strip. */
const WIDE = "(min-width: 641px)";

function NavContent({ items, active, t }: { items: NavItem[]; active: Section | null; t: SidebarTexts }) {
  return (
    <nav aria-label={t.nav} className={styles.navWrap}>
      <ul className={styles.nav}>
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className={styles.link}
              aria-current={item.key === active ? "page" : undefined}
              data-nav={item.key}
            >
              <AdminIcon name={item.icon} />
              <span className={styles.text}>{item.label}</span>
              {item.badge && (
                <span className={styles.badge} data-badge={item.key}>
                  <span aria-hidden="true">{item.badge.n}</span>
                  <span className={styles.sr}>, {item.badge.label}</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <ul className={styles.nav + " " + styles.foot}>
        <li>
          {/* The home page through the coming-soon gate: api/admin/preview gives this admin the preview cookie, then
              opens "/" (a plain link: it is an API route). Opener only: a Referer to the public site is harmless, and
              admin forms must keep sending Origin. */}
          <a href="/api/admin/preview" target="_blank" rel="noopener" className={styles.link} data-admin-view-site="">
            <AdminIcon name="up" />
            <span className={styles.text}>
              {t.viewSite} <span aria-hidden="true">↗</span>
              <span className={styles.sr}> ({t.newWindow})</span>
            </span>
          </a>
        </li>
        <li>
          <form method="post" action="/api/auth/logout">
            <button type="submit" className={styles.link}>
              <AdminIcon name="logout" />
              <span className={styles.text}>{t.logout}</span>
            </button>
          </form>
        </li>
      </ul>
    </nav>
  );
}

type SidebarProps = { items: NavItem[]; t: SidebarTexts; total: number };

/**
 * Prototype B's dark admin sidebar (logo, "Koolituskeskuse haldus", the menu with count badges, then "Vaata lehte ↗"
 * and "Logi välja"). Up to 640px wide it becomes a top bar with the logo and a menu button that opens the same menu
 * as a drawer (modal dialog: Esc, the close button, the backdrop or a link closes it). `active` is the entry to mark, or
 * null for none.
 */
function SidebarFrame({ items, active, t, total }: SidebarProps & { active: Section | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // Close the drawer when the window grows into the sidebar layout.
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) dialog.current?.close();
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // The page behind the drawer stays still.
  useEffect(() => {
    if (!open) return;
    return lockPageScroll();
  }, [open]);

  return (
    <>
      <aside className={styles.sidebar}>
        <Logo href="/admin" label={t.home} className={styles.logo} eager />
        <p className={styles.label}>{t.label}</p>
        <NavContent items={items} active={active} t={t} />
      </aside>

      <header className={styles.bar}>
        <Logo href="/admin" label={t.home} className={styles.barLogo} eager />
        <button
          type="button"
          className={styles.menuButton}
          aria-label={t.openMenu}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-admin-menu=""
          onClick={() => {
            dialog.current?.showModal();
            setOpen(true);
          }}
        >
          <AdminIcon name="menu" size={22} />
          {total > 0 && (
            <span className={styles.dot} aria-hidden="true">
              {total}
            </span>
          )}
        </button>
      </header>

      <dialog
        ref={dialog}
        className={styles.drawer}
        aria-label={t.nav}
        data-admin-drawer=""
        onClose={() => setOpen(false)}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target === e.currentTarget || target.closest("a")) dialog.current?.close();
        }}
      >
        <div className={styles.drawerBody}>
          <div className={styles.drawerHead}>
            <Logo href="/admin" label={t.home} className={styles.logo} />
            <button type="button" className={styles.closeButton} aria-label={t.closeMenu} onClick={() => dialog.current?.close()}>
              <AdminIcon name="close" size={22} />
            </button>
          </div>
          <p className={styles.label}>{t.label}</p>
          <NavContent items={items} active={active} t={t} />
        </div>
      </dialog>
    </>
  );
}

/**
 * The sidebar of the (panel) layout. Shell lives in that layout, which does not render again when the visitor moves between pages,
 * so the active entry is read from the address here, in the browser (admin UX pass, README §1.1; activeSection).
 */
export function Sidebar(props: SidebarProps) {
  const active = activeSection(usePathname(), useSearchParams());
  return <SidebarFrame {...props} active={active} />;
}

/**
 * The same sidebar with no entry marked: Shell's <Suspense> fallback. useSearchParams needs a boundary above it (Next.js), and the menu
 * must not flash empty while the address is read.
 */
export function SidebarWithoutActive(props: SidebarProps) {
  return <SidebarFrame {...props} active={null} />;
}
