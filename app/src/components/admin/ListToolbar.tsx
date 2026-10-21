"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { parseSearch, SEARCH_MAX } from "@/domain/paging";
import { adminEt } from "@/i18n/dict/admin";
import { listHref } from "./list-params";
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
 *   field. The field is never remounted by a replace, so it keeps its focus and its text; what the address says later is shown only when it did
 *   not come from this field (Back, „Tühjenda otsing ja filtrid“): a replace that was sent and has not arrived yet, or arrives after the person
 *   has typed on, never takes the text back.
 * - The scope select applies on change, by the same rules (its empty option takes the parameter away).
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
  const urlQuery = parseSearch(params.get("otsi") ?? undefined);

  const [text, setText] = useState(urlQuery);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the search the address has, or is on its way to have; and the replaces sent and not yet seen in the address, oldest first
  const last = useRef(urlQuery);
  const sent = useRef<string[]>([]);
  // the address the delayed send reads when it runs, not the one it was started from
  const at = useRef({ pathname, params });
  useEffect(() => {
    at.current = { pathname, params };
  });

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const send = (value: string) => {
    cancel();
    const query = parseSearch(value);
    if (query === last.current) return;
    last.current = query;
    sent.current.push(query);
    router.replace(listHref(at.current.pathname, at.current.params, { otsi: query }), { scroll: false });
  };

  // The address changed. If it is one of our own replaces arriving, the field already says what it should; else (Back, a link) show it.
  useEffect(() => {
    const own = sent.current.indexOf(urlQuery);
    if (own !== -1) {
      sent.current.splice(0, own + 1);
      return;
    }
    if (urlQuery === last.current) return;
    cancel();
    sent.current = [];
    last.current = urlQuery;
    setText(urlQuery);
  }, [urlQuery]);

  const onType = (value: string) => {
    setText(value);
    cancel();
    timer.current = setTimeout(() => send(value), SEARCH_DEBOUNCE_MS);
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
            send(text);
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
                send("");
                input.current?.focus();
              }}
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </form>
        {scope && <ScopeSelect scope={scope} onChoose={(value) => router.replace(listHref(pathname, params, { [scope.name]: value }), { scroll: false })} />}
      </div>

      {pills && pills.length > 0 && (
        <Pills className={styles.pills} aria-label={pillsLabel} data-list-pills="">
          {pills.map((p) => (
            <Link key={p.href} className={ui.pill} href={p.href} aria-current={p.current ? "true" : undefined}>
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
