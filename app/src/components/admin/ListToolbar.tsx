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
export type ListScope = { label: string; name: string; options: { value: string; label: string }[]; value: string };

/**
 * The top of an admin list (admin UX pass, README §1.10): a search field, filter pills with their counts, one optional scope select and the
 * count line. All of it lives in the URL, so a drawer's close link and a back link return to the same view (withListParams, list-params.ts).
 *
 * - Search: typing waits {@link SEARCH_DEBOUNCE_MS} ms after the last keystroke, then `router.replace`s `?otsi=` (taken away when the text is
 *   empty) with `leht` dropped: a new search starts at page 1. Enter sends it at once, and so does the ✕, which also puts the focus back in the
 *   field. The field is never remounted by a replace, so it keeps its focus and its text.
 * - The scope select applies on change, by the same rules (its empty option takes the parameter away); text still waiting for its 300 ms goes
 *   with it.
 * - One address for every replace: Next keeps one navigation at a time and drops a pending one when a newer starts, so each replace is built
 *   from the address the list is heading for (the last replace sent), not from the one on the screen; a search and a scope chosen within the
 *   time a page takes to load both arrive. An address that did not come from the toolbar (Back, a row, „Tühjenda otsing ja filtrid“) is the
 *   list now: the field shows its search and what was waiting is dropped. A pill is such a navigation, and a click on one drops a search that
 *   is still waiting (sent after it, the search would take the pill's navigation away); a search already sent loses to the pill the same way.
 * - `pills` are plain links, built by the page (they carry the search and the other filters themselves); the current one has aria-current.
 * - `placeholder` is the page's own („Otsi nime, e-posti või telefoni järgi“, …) and is the field's accessible name.
 */
export function ListToolbar({
  placeholder,
  pills,
  pillsLabel,
  scope,
  countLine,
}: {
  placeholder: string;
  pills?: ListPill[];
  /** The accessible name of the pill row ("Staatus"); without it the row is not a landmark. */
  pillsLabel?: string;
  scope?: ListScope;
  countLine?: string;
}) {
  const t = adminEt.lists;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const committed = addressOf(pathname, params);
  const urlQuery = parseSearch(params.get("otsi") ?? undefined);

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

  /** Replaces the address with `change` applied to where the list is heading (leht goes); nothing when that is where it is heading already. */
  const go = (change: Record<string, string | null>) => {
    cancel();
    const from = splitAddress(intended.current);
    const href = listHref(from.pathname, from.params, change);
    if (href === listHref(from.pathname, from.params, {})) return;
    intended.current = href;
    sent.current.push(href);
    router.replace(href, { scroll: false });
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

  const Pills = pillsLabel ? "nav" : "div";
  return (
    <div className={styles.toolbar} data-list-toolbar="">
      <div className={styles.row}>
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
        {/* a search still waiting for its 300 ms goes with the choice */}
        {scope && <ScopeSelect scope={scope} onChoose={(value) => go({ otsi: parseSearch(text), [scope.name]: value })} />}
      </div>

      {pills && pills.length > 0 && (
        <Pills className={styles.pills} aria-label={pillsLabel} data-list-pills="">
          {pills.map((p) => (
            // a search still waiting is dropped at the click: sent after it, it would take the pill's navigation away
            <Link key={p.href} className={ui.pill} href={p.href} aria-current={p.current ? "true" : undefined} onClick={cancel}>
              {p.label}
              {p.count !== undefined && <span className={ui.pillCount}>{p.count}</span>}
            </Link>
          ))}
        </Pills>
      )}

      {countLine && (
        <p className={`${ui.muted} ${ui.small}`} data-list-count="">
          {countLine}
        </p>
      )}
    </div>
  );
}

/** The scope select. It shows the choice at once, while the address is still on its way, and follows the address when that changes. */
function ScopeSelect({ scope, onChoose }: { scope: ListScope; onChoose: (value: string) => void }) {
  const [chosen, setChosen] = useState(scope.value);
  const [shown, setShown] = useState(scope.value);
  if (shown !== scope.value) {
    // the address changed (Back, a link): show it (state adjusted while rendering, as react.dev advises, not in an effect)
    setShown(scope.value);
    setChosen(scope.value);
  }
  return (
    <select
      className={styles.select}
      name={scope.name}
      aria-label={scope.label}
      value={chosen}
      onChange={(e) => {
        setChosen(e.target.value);
        onChoose(e.target.value);
      }}
    >
      {scope.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
