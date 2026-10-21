"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Logo } from "@/components/site/Logo";
import { fill } from "@/i18n/format";
import { lockPageScroll } from "@/lib/modal";
import { AdminIcon, type AdminIconName } from "./AdminIcon";
import { readMenuState, type MenuState, type NavBadge, type TodayCard } from "./menu-state";
import { activeSection, GROUPS, sectionHref, type GroupId, type Section } from "./sections";
import styles from "./Sidebar.module.css";

export type NavItem = { key: Section; href: string; icon: AdminIconName; label: string; badge?: NavBadge };

export type SidebarTexts = {
  label: string;
  nav: string;
  home: string;
  openMenu: string;
  closeMenu: string;
  /** „Vaata kodulehte“: the phone menu's footer link (the desktop's is in the top line). */
  viewSite: string;
  newWindow: string;
  signedIn: string;
  logout: string;
  groups: Record<GroupId, string>;
  /** „TÄNA {time}“ and „Protokollid · {course}“: the phone menu's card. */
  today: string;
  todayLine: string;
};

export type { TodayCard };

/** The menu's badges, as /api/admin/margid answers them (menu.ts menuOf builds the same for the first paint). */
const BADGES_URL = "/api/admin/margid";

/** From this width the sidebar stands on the left; below it the page has the phone top bar with the menu (README §1.1; Sidebar.module.css and Shell.module.css say the same). */
const WIDE = "(min-width: 900px)";

/** The folding group's open/closed choice, kept in this browser. */
const FOLD_KEY = "mslab-nav-fold";
type FoldChoice = "open" | "closed";

const foldListeners = new Set<() => void>();

/** Reads inside try/catch: a browser that refuses storage (private mode, blocked site data) throws here. */
function readFold(): FoldChoice | null {
  try {
    const stored = window.localStorage.getItem(FOLD_KEY);
    return stored === "open" || stored === "closed" ? stored : null;
  } catch {
    return null;
  }
}

/** Writes inside try/catch; false when the browser refused. */
function writeFold(choice: FoldChoice): boolean {
  let saved = true;
  try {
    window.localStorage.setItem(FOLD_KEY, choice);
  } catch {
    saved = false;
  }
  foldListeners.forEach((listener) => listener());
  return saved;
}

function subscribeFold(listener: () => void) {
  foldListeners.add(listener);
  window.addEventListener("storage", listener); // another tab's choice
  return () => {
    foldListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/**
 * The folding group's choice. The server and the first client render know nothing of the browser's storage and show it closed
 * (useSyncExternalStore's server snapshot); the stored choice follows when the page has taken over. `remember` returns the choice for
 * a browser that refused the write: it holds until the page is closed.
 */
function useFoldChoice(): [FoldChoice | null, (choice: FoldChoice) => void] {
  const stored = useSyncExternalStore(subscribeFold, readFold, () => null);
  const [unsaved, setUnsaved] = useState<FoldChoice | null>(null);
  return [unsaved ?? stored, (choice) => setUnsaved(writeFold(choice) ? null : choice)];
}

function NavContent({ items, active, t, fold }: { items: NavItem[]; active: Section; t: SidebarTexts; fold: boolean }) {
  const ids = useId();
  const [choice, choose] = useFoldChoice();
  const byKey = new Map(items.map((item) => [item.key, item]));

  return (
    <nav aria-label={t.nav} className={styles.navWrap}>
      {GROUPS.map((group) => {
        const rows = group.items.map((key) => byKey.get(key)).filter((item): item is NavItem => item !== undefined);
        const label = group.id ? t.groups[group.id] : null;
        const folds = fold && group.fold === true;
        // open whenever the page is inside it; otherwise as chosen (closed until the visitor opens it)
        const inside = rows.some((item) => item.key === active);
        const open = !folds || inside || choice === "open";
        const labelId = `${ids}-${group.id}-label`;
        const listId = `${ids}-${group.id}-items`;
        return (
          <div key={group.id ?? "top"} className={styles.group}>
            {label &&
              (folds ? (
                <button
                  type="button"
                  className={styles.groupButton}
                  aria-expanded={open}
                  aria-controls={listId}
                  // a page inside the group holds it open: closing it would hide the marked entry
                  aria-disabled={inside || undefined}
                  data-nav-fold=""
                  onClick={() => {
                    if (!inside) choose(open ? "closed" : "open");
                  }}
                >
                  <span id={labelId} data-nav-group={group.id}>
                    {label}
                  </span>
                  <span className={styles.chevron} aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                </button>
              ) : (
                <p id={labelId} className={styles.groupLabel} data-nav-group={group.id}>
                  {label}
                </p>
              ))}
            <ul id={listId} className={styles.nav} aria-labelledby={label ? labelId : undefined} hidden={!open} data-nav-items={group.id ?? "top"}>
              {rows.map((item) => (
                <li key={item.key} data-nav-item={item.key}>
                  <Link href={item.href} className={styles.link} aria-current={item.key === active ? "page" : undefined} data-nav={item.key}>
                    <AdminIcon name={item.icon} />
                    <span className={styles.text}>{item.label}</span>
                    {item.badge && (
                      <span className={styles.badge} data-badge={item.key}>
                        <span aria-hidden="true">{"text" in item.badge ? item.badge.text : item.badge.n}</span>
                        <span className={styles.sr}>, {item.badge.label}</span>
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/** „Sisse logitud“, the e-mail, „Logi välja“ (README §1.1); the phone menu adds „Vaata kodulehte ↗“ above „Logi välja“. */
function NavFoot({ email, t, withSite }: { email: string; t: SidebarTexts; withSite: boolean }) {
  return (
    <div className={styles.foot} data-nav-foot="">
      <span className={styles.footLabel}>{t.signedIn}</span>
      <span className={styles.footEmail}>{email}</span>
      {withSite && (
        // The home page through the coming-soon gate: api/admin/preview gives this admin the preview cookie, then opens "/" (a plain link:
        // it is an API route). Opener only: a Referer to the public site is harmless, and admin forms must keep sending Origin.
        <a href="/api/admin/preview" target="_blank" rel="noopener" className={styles.footLink} data-admin-menu-site="">
          <span>
            {t.viewSite} <span aria-hidden="true">↗</span>
            <span className={styles.sr}> ({t.newWindow})</span>
          </span>
        </a>
      )}
      <form method="post" action="/api/auth/logout">
        <button type="submit" className={styles.footLink}>
          {t.logout}
        </button>
      </form>
    </div>
  );
}

/** The phone bar's left side: the name of the current page, or the logo on the overview. */
function BarTitle({ title, t }: { title: string | null; t: SidebarTexts }) {
  return title ? (
    <span className={styles.barTitle} data-admin-bar-title="">
      {title}
    </span>
  ) : (
    <Logo href="/admin" label={t.home} className={styles.barLogo} eager />
  );
}

/**
 * The menu's badges while the visitor moves around. The first paint has the shell's (the props); the layout does not render again on a
 * client-side move, so the badges are asked for again (BADGES_URL) when the address changes after the first paint and when the window comes
 * back (focus, or the tab becoming visible). An answer that is not the latest request's is dropped, and so is an answer to a request made for
 * props that have since been replaced: a server action's refresh() renders the layout again and its numbers win. A failed or unreadable answer
 * leaves what is shown. Null: show the props.
 */
function useLiveMenu(items: NavItem[], route: string): MenuState | null {
  const [live, setLive] = useState<{ items: NavItem[]; menu: MenuState } | null>(null);
  const current = useRef(items);
  const request = useRef<{ seq: number; abort: AbortController | null }>({ seq: 0, abort: null });
  const shownFor = useRef(route);

  useEffect(() => {
    current.current = items;
  }, [items]);

  const refetch = useCallback(() => {
    const mine = ++request.current.seq;
    request.current.abort?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    request.current.abort = controller;
    const asked = current.current;
    fetch(BADGES_URL, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal: controller?.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const menu = readMenuState(body);
        if (menu && mine === request.current.seq) setLive({ items: asked, menu });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (shownFor.current === route) return; // the first paint: the shell has just read them
    shownFor.current = route;
    refetch();
  }, [route, refetch]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisible);
    const asking = request.current;
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisible);
      asking.seq++; // nothing in flight may set state after this
      asking.abort?.abort();
    };
  }, [refetch]);

  return live !== null && live.items === items ? live.menu : null;
}

type SidebarProps = { items: NavItem[]; t: SidebarTexts; total: number; email: string; today: TodayCard | null };

/**
 * Prototype B's dark admin sidebar (logo, "Koolituskeskuse haldus", the grouped menu with count badges, then who is signed in and
 * "Logi välja"). Below 900px it becomes a 64px top bar (the page's name, the ≡ button with the badge sum) and the same menu opens as a
 * panel under it, every group open (modal dialog: Esc, ✕, the backdrop, a link or a change of address closes it).
 *
 * The sidebar of the (panel) layout. Shell lives in that layout, which does not render again when the visitor moves between pages, so the
 * active entry is read from the address here, in the browser (admin UX pass, README §1.1; activeSection). The layout is force-dynamic, so
 * useSearchParams is answered while the page is rendered on the server and needs no <Suspense> boundary: the menu is in the first HTML with its
 * entry marked, its fold and its phone bar title right, and no second copy of it follows.
 */
export function Sidebar({ items: served, t, total: servedTotal, email, today: servedToday }: SidebarProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const active = activeSection(pathname, search);
  // the address the menu was last shown for
  const route = `${pathname}?${search.toString()}`;
  const live = useLiveMenu(served, route);
  const items = live ? served.map((item) => ({ ...item, href: live.hrefs[item.key] ?? sectionHref(item.key), badge: live.badges[item.key] })) : served;
  const total = live ? live.total : servedTotal;
  const today = live ? live.today : servedToday;
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const title = active !== "overview" ? (items.find((item) => item.key === active)?.label ?? null) : null;

  // Close the menu when the window grows into the sidebar layout.
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) dialog.current?.close();
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // The sidebar stays mounted between pages (it is in the layout), so a move that is not a click on a menu link (history Back, an iOS
  // edge swipe) must close the menu too.
  useEffect(() => {
    dialog.current?.close();
  }, [route]);

  // The page behind the menu stays still.
  useEffect(() => {
    if (!open) return;
    return lockPageScroll();
  }, [open]);

  const badgeSum = total > 0 && (
    <span className={styles.dot} aria-hidden="true">
      {total}
    </span>
  );

  return (
    <>
      <aside className={styles.sidebar}>
        <Logo href="/admin" label={t.home} className={styles.logo} eager />
        <p className={styles.label}>{t.label}</p>
        <NavContent items={items} active={active} t={t} fold />
        <NavFoot email={email} t={t} withSite={false} />
      </aside>

      <header className={styles.bar}>
        <BarTitle title={title} t={t} />
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
          <AdminIcon name={open ? "close" : "menu"} size={22} />
          {badgeSum}
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
        {/* The bar again, on top of the page's own: the page behind a modal dialog cannot be pressed, so the ✕ is the dialog's. */}
        <div className={styles.drawerBar}>
          <BarTitle title={title} t={t} />
          <button type="button" className={styles.menuButton} aria-label={t.closeMenu} data-admin-menu-close="" onClick={() => dialog.current?.close()}>
            <AdminIcon name="close" size={22} />
            {badgeSum}
          </button>
        </div>
        <div className={styles.drawerPanel}>
          {today && (
            <Link href={today.href} className={styles.today} data-admin-today="">
              <span className={styles.todayLabel}>{fill(t.today, { time: today.time })}</span>
              <span className={styles.todayLine}>{fill(t.todayLine, { course: today.course })}</span>
            </Link>
          )}
          <NavContent items={items} active={active} t={t} fold={false} />
          <NavFoot email={email} t={t} withSite />
        </div>
      </dialog>
    </>
  );
}
