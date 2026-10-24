"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { fill } from "@/i18n/format";
import { adminEt } from "@/i18n/dict/admin";
import styles from "./LeaveGuard.module.css";

/** How long a move waits for a save on its way (README §1.5): then it goes on, and the copy in this browser keeps the text. */
export const LEAVE_WAIT_MS = 3000;

/**
 * Why a source's text is not confirmed: the engine's reasons (autosave/engine.ts Unconfirmed), an upload still running, and a record typed into that its
 * one explicit button has not created yet (piece3-texts S3-P3-g: a new course, a new session).
 */
export type GuardReason = "offline" | "error" | "invalid" | "signedOut" | "upload" | "notCreated";

/**
 * Something on the page that holds text the server may not have yet (useAutosave registers each form part; an upload may register too).
 * - `label`: the visible name of the field concerned, for the notice („Muudatust „{field}“ …“). Every source names one: the design has no
 *   sentence without it.
 * - `flush`: save now; true when the text is confirmed. A source that cannot save now (an upload running) answers false at once.
 * - `unconfirmed`: null when the server holds it all; else why not, and for "notCreated" the thing that is not created yet, in the partitive and
 *   capitalised (`thing`: „Koolitust“ → „Koolitust pole veel lisatud.“).
 * - `focus`: „Jää siia“ puts the focus on the field concerned.
 */
export type GuardSource = {
  id: string;
  label: () => string;
  flush: () => Promise<boolean>;
  unconfirmed: () => { reason: GuardReason; thing?: string } | null;
  focus: () => void;
};

/** What is left: a page (every source of it, its drawer's too) or a drawer (only the sources inside the drawer). */
export type LeaveWhere = "page" | "drawer";

type Entry = { scope: LeaveWhere; get: () => GuardSource };
type Notice = {
  /** Where it is shown: at the top of the page's main, or at the top of the open drawer (the page behind a modal drawer cannot be pressed). */
  at: LeaveWhere;
  /** The address it was asked on: once the page has moved on (by any way), it is not shown. */
  route: string;
  source: string;
  label: string;
  reason: GuardReason;
  thing: string;
  stay: () => void;
  go: () => void;
};
/** What the sources and the drawers use: the same object for the life of the provider (a source re-registering would drop its notice). */
type Api = {
  requestLeave: (go: () => void, where: LeaveWhere) => void;
  register: (id: string, entry: Entry) => () => void;
  changed: () => void;
};
/** What the notices show. */
type Shown = { notice: Notice | null; route: string; stay: () => void; leave: () => void };

const GuardContext = createContext<Api | null>(null);
const NoticeContext = createContext<Shown | null>(null);
/** Inside a drawer (Drawer.tsx provides "drawer"): its sources are the ones a drawer's close leaves. */
const ScopeContext = createContext<LeaveWhere>("page");

/** The drawers' marker (Drawer.tsx): an open one holds the notice and the sources a close leaves. */
const OPEN_DRAWER = "dialog[data-drawer][open]";
/** A link of the admin itself: `a[href^="/admin"]`, not `/administrator` (no lookbehind: old iPads). */
const ADMIN_HREF = /^\/admin(?:[/?#]|$)/;

const openDrawer = (): HTMLElement | null => {
  const open = document.querySelectorAll<HTMLElement>(OPEN_DRAWER);
  return open.length > 0 ? open[open.length - 1] : null;
};

/** The drawer's sources are the drawer's (Drawer.tsx wraps its content in it). */
export function GuardScope({ children }: { children: React.ReactNode }) {
  return <ScopeContext.Provider value="drawer">{children}</ScopeContext.Provider>;
}

/** Where the sources of this component are: in a drawer or on the page (useAutosave focuses its fields there). */
export function useGuardScope(): LeaveWhere {
  return useContext(ScopeContext);
}

/**
 * `requestLeave(go, where)`: `go` runs at once when nothing `where` leaves is unconfirmed; else after the save (at most LEAVE_WAIT_MS), or after
 * „Sulge, tekst jääb seadmesse“. Without the provider (a component rendered alone) it goes at once.
 */
export function useLeaveGuard(): { requestLeave: (go: () => void, where: LeaveWhere) => void } {
  const api = useContext(GuardContext);
  return useMemo(() => ({ requestLeave: api ? api.requestLeave : (go: () => void) => go() }), [api]);
}

/** Registers a source with the guard while the component is mounted (the latest `source` is read each time). No provider: nothing. */
export function useGuardSource(source: GuardSource): void {
  const api = useContext(GuardContext);
  const scope = useContext(ScopeContext);
  const latest = useRef(source);
  useEffect(() => {
    latest.current = source;
  });
  const { id } = source;
  useEffect(() => api?.register(id, { scope, get: () => latest.current }), [api, id, scope]);
  // every render of the source (useAutosave renders on every change of its state): beforeunload follows
  useEffect(() => api?.changed());
}

/**
 * The leave guard (admin UX pass, README §1.5, screens §2.4): leaving a page or closing a drawer while an autosave on it is not confirmed.
 *
 * - What it holds: a click on a link of the admin (`a[href^="/admin"]`, the sidebar and every `Link`; not a new tab, a modifier key or a
 *   download) that goes to another page, or that leaves an open drawer; Back and Forward (popstate) to another page or out of an open drawer;
 *   a drawer's ✕, Esc and backdrop (Drawer.tsx asks `requestLeave`). A link to the same page outside a drawer (a filter, opening a row's
 *   drawer) keeps the page's editors where they are: it goes.
 * - A save in flight or waiting: sent at once and waited for, at most LEAVE_WAIT_MS; then the move goes on (nothing is asked). A save that
 *   cannot go through (offline, a server error, a field its check refuses, signed out, an upload running): an in-place notice at the top of
 *   the page or the drawer, „Muudatust „{field}“ ei saanud veel salvestada.“ + why, „Jää siia“ (the focus to the field) and „Sulge, tekst
 *   jääb seadmesse“ (go: the engine's copy in this browser is resumed the next time the page or the drawer opens).
 * - Next.js's App Router has no way to block a move, so: a capturing click listener on the document stops the click before React's (and
 *   the Link's) handler sees it, and `router.push` goes later; a capturing popstate listener on the window, registered before the router's
 *   (a child's effect runs first), stops the router's handler, puts the page's own history entry back (`history.pushState` with the state
 *   the router wrote for it), and `history.back()` goes later (the entry just pushed sits right after where she was going, Back or Forward).
 * - `beforeunload` (closing the tab, a reload, another site) only while something is not confirmed.
 *
 * Mounted once, in the (panel) layout, inside Shell's main: the page's notice is at the top of the page.
 */
export function LeaveGuardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const route = `${pathname}?${search.toString()}`;
  const [notice, setNotice] = useState<Notice | null>(null);
  const sources = useRef(new Map<string, Entry>());
  /** The latest move asked for: an older one's wait no longer decides anything. */
  const seq = useRef(0);
  /** The page's own address and history state (the router's), put back when Back is held. */
  const here = useRef<{ href: string; state: unknown } | null>(null);
  /** The next popstate is the guard's own `history.back()`: it goes through. */
  const passing = useRef(false);
  const armed = useRef(false);
  const live = useRef({ router, route });
  useEffect(() => {
    live.current = { router, route };
  });

  /** The sources a move leaves that are not confirmed. */
  const pending = useCallback((where: LeaveWhere): Entry[] => {
    return [...sources.current.values()].filter((e) => (where === "page" || e.scope === "drawer") && e.get().unconfirmed() !== null);
  }, []);

  const onUnload = useCallback(
    (e: BeforeUnloadEvent) => {
      if (pending("page").length === 0) return;
      e.preventDefault();
      // older browsers (Chrome and Edge before 119) ask only when returnValue is set to something
      e.returnValue = true;
    },
    [pending],
  );

  const changed = useCallback(() => {
    const any = pending("page").length > 0;
    if (any === armed.current) return;
    armed.current = any;
    if (any) window.addEventListener("beforeunload", onUnload);
    else window.removeEventListener("beforeunload", onUnload);
  }, [pending, onUnload]);

  const register = useCallback(
    (id: string, entry: Entry) => {
      sources.current.set(id, entry);
      changed();
      return () => {
        if (sources.current.get(id) === entry) sources.current.delete(id);
        // the notice of a source that has gone (its drawer closed, its page left) has nothing left to ask about
        setNotice((n) => (n?.source === id ? null : n));
        changed();
      };
    },
    [changed],
  );

  const requestLeave = useCallback(
    (go: () => void, where: LeaveWhere) => {
      const mine = ++seq.current;
      const waiting = pending(where);
      if (waiting.length === 0) {
        setNotice(null);
        go();
        return;
      }
      const answers: (boolean | undefined)[] = waiting.map(() => undefined);
      const saves = Promise.all(
        waiting.map((e, i) =>
          e
            .get()
            .flush()
            .then(
              (ok) => void (answers[i] = ok),
              () => void (answers[i] = false),
            ),
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LEAVE_WAIT_MS);
      });
      void Promise.race([saves, late]).then(() => {
        clearTimeout(timer);
        if (seq.current !== mine) return;
        // one that answered "not saved" and still is not: ask; one still on its way after the wait: go on (its copy keeps the text)
        const failed = waiting.find((e, i) => answers[i] === false && e.get().unconfirmed() !== null);
        const why = failed?.get().unconfirmed();
        if (!failed || !why) {
          setNotice(null);
          go();
          return;
        }
        const source = failed.get();
        setNotice({
          at: where === "drawer" || openDrawer() ? "drawer" : "page",
          route: live.current.route,
          source: source.id,
          label: source.label(),
          reason: why.reason,
          thing: why.thing ?? "",
          stay: () => failed.get().focus(),
          go,
        });
      });
    },
    [pending],
  );

  const stay = useCallback(() => {
    seq.current++;
    const n = notice;
    setNotice(null);
    n?.stay();
  }, [notice]);
  const leave = useCallback(() => {
    seq.current++;
    const n = notice;
    setNotice(null);
    n?.go();
  }, [notice]);

  // the page as the router left it: after every move (the router writes the history entry before the effects run)
  useEffect(() => {
    here.current = { href: window.location.href, state: window.history.state };
    // a move happened: a wait for an earlier one decides nothing now
    seq.current++;
  }, [route]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      const target = a.getAttribute("target");
      if (!ADMIN_HREF.test(href) || a.hasAttribute("download") || (target && target !== "_self")) return;
      const to = new URL(href, window.location.href);
      const where: LeaveWhere | null = to.pathname !== window.location.pathname ? "page" : a.closest(OPEN_DRAWER) ? "drawer" : null;
      if (!where || pending(where).length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // a menu round the link (the phone menu): closed, so the page's notice can be seen and pressed
      const menu = a.closest("dialog");
      if (menu instanceof HTMLDialogElement && menu.open && !menu.matches("[data-drawer]")) menu.close();
      requestLeave(() => live.current.router.push(href), where);
    };
    const onPop = (e: PopStateEvent) => {
      if (passing.current) {
        passing.current = false;
        return;
      }
      const from = here.current;
      if (!from) return;
      const where: LeaveWhere | null = new URL(from.href).pathname !== window.location.pathname ? "page" : openDrawer() ? "drawer" : null;
      if (!where || pending(where).length === 0) return;
      // the router's handler (and anyone else's) does not see it: the page stays, and its entry is put back
      e.stopImmediatePropagation();
      window.history.pushState(from.state, "", from.href);
      requestLeave(() => {
        passing.current = true;
        window.history.back();
      }, where);
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop, true);
    };
  }, [pending, requestLeave]);

  // leaving the admin: no prompt may stay behind
  useEffect(
    () => () => {
      if (armed.current) window.removeEventListener("beforeunload", onUnload);
      armed.current = false;
    },
    [onUnload],
  );

  const api = useMemo<Api>(() => ({ requestLeave, register, changed }), [requestLeave, register, changed]);
  const shown = useMemo<Shown>(() => ({ notice, route, stay, leave }), [notice, route, stay, leave]);

  return (
    <GuardContext.Provider value={api}>
      <NoticeContext.Provider value={shown}>
        <LeaveNotice where="page" />
        {children}
      </NoticeContext.Provider>
    </GuardContext.Provider>
  );
}

/**
 * The guard's question, where it belongs: the provider shows the page's at the top of the page, Drawer.tsx the drawer's at the top of the
 * drawer. It takes the focus when it appears; Esc is „Jää siia“ (and goes no further: the drawer round it stays open).
 */
export function LeaveNotice({ where }: { where: LeaveWhere }) {
  const api = useContext(NoticeContext);
  const n = api?.notice ?? null;
  const shown = n !== null && n.at === where && n.route === api?.route ? n : null;
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) box.current?.focus();
  }, [shown]);
  if (!shown || !api) return null;
  const t = adminEt.leave;
  return (
    <div
      ref={box}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-reason`}
      tabIndex={-1}
      className={`${styles.notice} ${where === "drawer" ? styles.inDrawer : styles.onPage}`}
      data-leave-notice={where}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        api.stay();
      }}
    >
      <p id={`${ids}-title`} className={styles.title} data-leave-title="">
        {fill(t.notice, { field: shown.label })}
      </p>
      <p id={`${ids}-reason`} className={styles.reason} data-leave-reason="">
        {fill(t.reasons[shown.reason], { thing: shown.thing })}
      </p>
      <div className={styles.buttons}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={api.stay}>
          {t.stay}
        </button>
        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={api.leave}>
          {t.go}
        </button>
      </div>
    </div>
  );
}
