"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { parseSearch, SEARCH_MAX } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { addressOf, listHref, splitAddress } from "./list-params";
import ui from "./ui.module.css";
import styles from "./ListToolbar.module.css";

/** How long the search waits after the last keystroke before it goes to the address. */
export const SEARCH_DEBOUNCE_MS = 300;

export type ListPill = { href: string; label: string; count?: number; current: boolean };
/**
 * One row of filter pills (a status, a form …): `label` is the row's accessible name. `tone: "light"` draws a secondary row (the prototype's form
 * pills): the chosen pill is the first-light fill with the ink border, not the ink fill of the first row.
 */
export type ListPillRow = { label: string; pills: ListPill[]; tone?: "light" };
/**
 * A scope select. Each option carries the address the page built for it (`href`: the page knows the other filters, and which parameter the
 * option sets: `?koolitus=` for a whole course, `?toimumine=` for one session), so one select can set either. `value` is the chosen option's value.
 *
 * - `params`: the query parameters this select sets (Kalender's course select `["koolitus"]`, its city select `["linn"]`). Only needed with several
 *   selects: a choice made while another select's replace is still on its way takes that select's parameters from the address the list is heading
 *   for, not from its own option's address (the page built that before the other choice).
 * - `short`: on a phone (up to 640 px) the select is drawn as a 44 px pill, as Part 4 draws Kalender's „Linn ▾“: this word while nothing is chosen,
 *   the chosen option's label after it. The select itself stays, invisible over the pill: it keeps its name and opens the same list.
 */
export type ListScope = {
  label: string;
  value: string;
  options: { value: string; label: string; href: string }[];
  params?: string[];
  short?: string;
};

/**
 * The top of an admin list (admin UX pass, README §1.10; the A screens, Task 1): a search field, an optional scope select, one or two rows of
 * filter pills with their counts and the count line. All of it lives in the URL, so a drawer's close link and a back link return to the same view
 * (withListParams, list-params.ts).
 *
 * - Search: typing waits {@link SEARCH_DEBOUNCE_MS} ms after the last keystroke, then `router.replace`s `?otsi=` (taken away when the text is
 *   empty) with `leht` dropped: a new search starts at page 1. Enter sends it at once, and so does the ✕, which also puts the focus back in the
 *   field. The field is never remounted by a replace, so it keeps its focus and its text.
 * - The scope select applies on change by going to the chosen option's own address (`router.replace`, `leht` dropped). The page built that address
 *   before the visitor typed, so the search typed so far goes onto it, and text still waiting for its 300 ms goes with it. A list may have several
 *   (`scopes`: Kalender's course and city; `scope` is the same as a list of one): each select goes to its own option's address, with the other
 *   selects' parameters (`ListScope.params`) taken from the address the list is heading for.
 * - One address for every replace: Next keeps one navigation at a time and drops a pending one when a newer starts, so each replace is built
 *   from the address the list is heading for (the last replace sent), not from the one on the screen; a search and a scope chosen within the
 *   time a page takes to load both arrive. An address that did not come from the toolbar (Back, a row, „Tühjenda otsing ja filtrid“) is the
 *   list now: the field shows its search and what was waiting is dropped. A pill is such a navigation, and a click on one drops a search that
 *   is still waiting (sent after it, the search would take the pill's navigation away); a search already sent loses to the pill the same way.
 * - `pillRows` are rows of plain links, built by the page (they carry the search and the other filters themselves), each a `nav` under its own
 *   label (the row's accessible name; the rows sit side by side, wrapping, as the prototype draws the status and the form pills). The current
 *   pill of a row has aria-current. A row without pills is not drawn.
 * - `placeholder` is the page's own („Otsi nime, e-posti või telefoni järgi“, …) and is the field's accessible name. A list with nothing to search
 *   (Koolitused: six courses, B1) leaves it out and gets no search field at all: the pills and the count line stand alone.
 */
export function ListToolbar({
  placeholder,
  pillRows,
  scope,
  scopes,
  countLine,
}: {
  /** The search field's placeholder and name; without it there is no search field. */
  placeholder?: string;
  pillRows?: ListPillRow[];
  /** One select (an alias of `scopes` with one entry). */
  scope?: ListScope;
  /** Several selects, side by side in this order. */
  scopes?: ListScope[];
  countLine?: string;
}) {
  const t = adminEt.lists;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const committed = addressOf(pathname, params);
  const urlQuery = parseSearch(params.get("otsi") ?? undefined);
  const selects = [...(scope ? [scope] : []), ...(scopes ?? [])];

  const [text, setText] = useState(urlQuery);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The address the list is heading for: the one on the screen, or the last replace sent. Every replace is built from it, never from the
  // screen's address: Next keeps one navigation at a time, so a replace started while another is on its way drops the first, and a replace built
  // from the screen's address would lose what the first one carried (the search, or the scope). `sent` are the replaces not seen on the screen yet.
  const intended = useRef(committed);
  const sent = useRef<string[]>([]);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  /** Replaces the address with `target` (leht already gone); nothing when that is where the list is heading already. */
  const replaceWith = (target: string) => {
    const heading = splitAddress(intended.current);
    if (target === listHref(heading.pathname, heading.params, {})) return;
    intended.current = target;
    sent.current.push(target);
    router.replace(target, { scroll: false });
  };
  /** Replaces the address with `change` applied to where the list is heading (leht goes). */
  const go = (change: Record<string, string | null>) => {
    cancel();
    const from = splitAddress(intended.current);
    replaceWith(listHref(from.pathname, from.params, change));
  };
  /**
   * Goes to the page's own address `href` (an option's of select `from`), with the search typed so far on it (leht goes). The other selects'
   * parameters come from the address the list is heading for: a choice of theirs may be on its way, and `href` was built before it.
   */
  const goTo = (href: string, from: ListScope) => {
    cancel();
    const to = splitAddress(href);
    const heading = splitAddress(intended.current).params;
    const change: Record<string, string | null> = { otsi: parseSearch(text) };
    for (const other of selects) if (other !== from) for (const key of other.params ?? []) change[key] = heading.get(key);
    replaceWith(listHref(to.pathname, to.params, change));
  };
  const search = (value: string) => go({ otsi: parseSearch(value) });

  // The address on the screen changed. One of our own replaces arriving (or a later one, when Next dropped the earlier): the field already says
  // what it should. Anything else (Back, a pill, a row) is somebody else's: the list is what the address says now, so the field shows that, and
  // what was waiting or on its way is dropped.
  useEffect(() => {
    const own = sent.current.indexOf(committed);
    if (own !== -1) {
      sent.current.splice(0, own + 1);
      return;
    }
    if (committed === intended.current) return;
    cancel();
    sent.current = [];
    intended.current = committed;
    setText(urlQuery);
  }, [committed, urlQuery]);

  const onType = (value: string) => {
    setText(value);
    cancel();
    timer.current = setTimeout(() => search(value), SEARCH_DEBOUNCE_MS);
  };

  const rows = (pillRows ?? []).filter((row) => row.pills.length > 0);
  return (
    <div className={styles.toolbar} data-list-toolbar="">
      {(placeholder !== undefined || selects.length > 0) && (
        <div className={styles.row}>
          {placeholder !== undefined && (
            <form
              className={styles.search}
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                search(text);
              }}
            >
              <span className={styles.glass} aria-hidden="true">
                ⌕
              </span>
              <input
                ref={input}
                className={styles.field}
                type="search"
                name="otsi"
                value={text}
                onChange={(e) => onType(e.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
                maxLength={SEARCH_MAX}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
              />
              {text !== "" && (
                <button
                  type="button"
                  className={styles.clear}
                  aria-label={t.clearSearch}
                  data-search-clear=""
                  onClick={() => {
                    setText("");
                    search("");
                    input.current?.focus();
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              )}
            </form>
          )}
          {/* a search still waiting for its 300 ms goes with the choice */}
          {selects.map((s) => (
            <ScopeSelect key={s.label} scope={s} onChoose={(href) => goTo(href, s)} />
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className={styles.pillRows} data-list-pills="">
          {rows.map((row, i) => (
            <nav key={`${i}-${row.label}`} className={styles.pills} aria-label={row.label} data-list-pill-row="" data-tone={row.tone}>
              {row.pills.map((p) => (
                // a search still waiting is dropped at the click: sent after it, it would take the pill's navigation away
                <Link key={p.href} className={ui.pill} href={p.href} aria-current={p.current ? "true" : undefined} onClick={cancel}>
                  {p.label}
                  {p.count !== undefined && <span className={ui.pillCount}>{p.count}</span>}
                </Link>
              ))}
            </nav>
          ))}
        </div>
      )}

      {countLine && (
        <p className={`${ui.muted} ${ui.small}`} data-list-count="">
          {countLine}
        </p>
      )}
    </div>
  );
}

/**
 * A scope select. It shows the choice at once, while the address is still on its way, and follows the address when that changes. `onChoose` gets
 * the chosen option's own address. With a `short` word it is also a pill on a phone (see {@link ListScope}).
 */
function ScopeSelect({ scope, onChoose }: { scope: ListScope; onChoose: (href: string) => void }) {
  const [chosen, setChosen] = useState(scope.value);
  const [shown, setShown] = useState(scope.value);
  if (shown !== scope.value) {
    // the address changed (Back, a link): show it (state adjusted while rendering, as react.dev advises, not in an effect)
    setShown(scope.value);
    setChosen(scope.value);
  }
  const select = (
    <select
      className={styles.select}
      aria-label={scope.label}
      value={chosen}
      onChange={(e) => {
        const option = scope.options.find((o) => o.value === e.target.value);
        if (!option) return;
        setChosen(option.value);
        onChoose(option.href);
      }}
    >
      {scope.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (scope.short === undefined) return select;
  const picked = chosen === "" ? undefined : scope.options.find((o) => o.value === chosen);
  return (
    <span className={styles.selectBox}>
      {/* (the select is the control; the pill only draws it on a phone, and is not read a second time) */}
      <span className={styles.selectPill} data-scope-pill="" data-chosen={picked ? "" : undefined} aria-hidden="true">
        {picked ? picked.label : scope.short}
      </span>
      {select}
    </span>
  );
}
