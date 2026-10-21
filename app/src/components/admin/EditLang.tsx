"use client";

import { createContext, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import styles from "./EditLang.module.css";

export type Lang = "et" | "ru";

/** The content language Maria edits in, kept in this browser: ET or RU, for every page of the admin. */
const STORAGE_KEY = "mslab-edit-lang";

/** Reads inside try/catch: a browser that refuses storage (private mode, blocked site data) throws here. Anything but "et" / "ru" is no choice. */
function readLang(): Lang | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "et" || stored === "ru" ? stored : null;
  } catch {
    return null;
  }
}

/** Writes inside try/catch; false when the browser refused. */
function writeLang(lang: Lang): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
    return true;
  } catch {
    return false;
  }
}

/**
 * The content language, kept in this browser. It is an external store that each field and the switch read for themselves (useEditLang),
 * not a value passed down through React's context: the page below the layout streams in and hydrates after the layout, and a context that
 * changes before that has finished makes React throw the page's server HTML away and render it again in the browser. A store read by the
 * components that are already hydrated changes only those.
 */
class LangStore {
  private readonly listeners = new Set<() => void>();
  /** The choice of a browser that refused the write: it holds until the page is closed. */
  private unsaved: Lang | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    window.addEventListener("storage", listener); // another tab's choice
    return () => {
      this.listeners.delete(listener);
      window.removeEventListener("storage", listener);
    };
  };

  get = (): Lang => this.unsaved ?? readLang() ?? "et";

  set = (lang: Lang) => {
    this.unsaved = writeLang(lang) ? null : lang;
    this.listeners.forEach((listener) => listener());
  };
}

/** What a field reads the language from, and where the switch writes it. */
type LangSource = { subscribe: (listener: () => void) => () => void; get: () => Lang; set: (lang: Lang) => void };

type Entry = { missing: boolean; focus: () => void };

/**
 * The bilingual fields on the page, as they tell it: which of them have Estonian text and no Russian, and how to put the cursor in one.
 * The switch counts the first and walks the second („Järgmine →“). Outside React's state on purpose: a field registers from its effect, and
 * only the count is something a component renders.
 */
class Registry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private missing = 0;
  /** The field the cursor was last in: „Järgmine →“ goes to the next missing one after it. */
  private anchor: Element | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  count = () => this.missing;

  /** `id` is the id of the field's box in the document (its place on the page is its order); `focus` puts the cursor in it. Returns the way out. */
  register = (id: string, missingRu: boolean, focus: () => void) => {
    const entry: Entry = { missing: missingRu, focus };
    this.entries.set(id, entry);
    this.tally();
    return () => {
      // (a field that registered again meanwhile is another entry under the same id)
      if (this.entries.get(id) === entry) this.entries.delete(id);
      this.tally();
    };
  };

  setAnchor = (el: Element | null) => {
    this.anchor = el;
  };

  /** Puts the cursor in the next field without its Russian text: the first after the one she was in, in page order, and the first of all after the last. */
  next = () => {
    const open = [...this.entries].filter(([, e]) => e.missing).map(([id, e]) => ({ el: document.getElementById(id), focus: e.focus }));
    if (open.length === 0) return;
    // in the order of the page, whatever order the fields registered in (one that became empty later registered later)
    open.sort((a, b) => (a.el && b.el ? (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : a.el ? -1 : b.el ? 1 : 0));
    const from = this.anchor?.isConnected ? this.anchor : null;
    const target = (from && open.find((x) => x.el && from.compareDocumentPosition(x.el) & Node.DOCUMENT_POSITION_FOLLOWING)) || open[0];
    target.focus();
    const now = document.activeElement;
    if (now && target.el?.contains(now)) this.anchor = now;
  };

  private tally() {
    let n = 0;
    for (const e of this.entries.values()) if (e.missing) n++;
    if (n === this.missing) return;
    this.missing = n;
    this.listeners.forEach((listener) => listener());
  }
}

type Page = {
  lang: LangSource;
  /** A field tells the page whether its Russian text is missing, and how to focus it; the return value takes it off the page again. */
  register: Registry["register"];
  registry: Registry;
};

// Without a provider (a field rendered alone, in a test or a story) there is Estonian and nobody to count.
const NO_PAGE: Page = { lang: { subscribe: () => () => {}, get: () => "et", set: () => {} }, register: () => () => {}, registry: new Registry() };
// (what this holds never changes while the page is open: the language changes in the store, not in the context)
const Context = createContext<Page>(NO_PAGE);

/** The page's content language (it re-renders the reader when the choice changes), how to change it, and where the fields report what they lack. */
export function useEditLang(): { lang: Lang; setLang: (lang: Lang) => void; register: Registry["register"] } {
  const { lang: source, register } = useContext(Context);
  const lang = useSyncExternalStore(source.subscribe, source.get, (): Lang => "et");
  return { lang, setLang: source.set, register };
}

/**
 * The content language of the admin's editors (README §1.9): ET or RU, one for every bilingual field on the page, chosen with the page's
 * `LangSwitch`. The choice is kept per device (localStorage `mslab-edit-lang`). The server and the first client render know nothing of the
 * browser's storage and show ET (useSyncExternalStore's server snapshot); the stored choice follows when the page has taken over. A browser
 * that refused the write keeps the choice until the page is closed.
 *
 * Mounted once, in the (panel) layout, so a move from one page to the next keeps the language.
 */
export function EditLangProvider({ children }: { children: ReactNode }) {
  const [lang] = useState(() => new LangStore());
  const [registry] = useState(() => new Registry());

  // where the cursor is in the page's fields, for „Järgmine →“
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.hasAttribute("data-lang-field")) registry.setAnchor(e.target);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [registry]);

  const page = useMemo<Page>(() => ({ lang, register: registry.register, registry }), [lang, registry]);
  return <Context.Provider value={page}>{children}</Context.Provider>;
}

/**
 * „Sisu keel“ ET | RU, at the right of the page heading (README §1.9): a segmented control, 38 px segments in a 44 px track. In RU mode, while some
 * field has Estonian text and no Russian, „RU puudub {n} väljal“ and „Järgmine →“ beside it. No props: it is the page's.
 */
export function LangSwitch() {
  const t = adminEt.i18n;
  const { lang, setLang } = useEditLang();
  const { registry } = useContext(Context);
  const missing = useSyncExternalStore(registry.subscribe, registry.count, () => 0);
  const labelId = useId();
  return (
    <div className={styles.bar} data-edit-lang-bar="">
      <div className={styles.pick}>
        <span id={labelId} className={styles.label}>
          {t.contentLang}
        </span>
        <span className={styles.track} role="group" aria-labelledby={labelId} data-edit-lang-switch="">
          {(["et", "ru"] as const).map((l) => (
            <button key={l} type="button" className={styles.segment} aria-pressed={lang === l} onClick={() => setLang(l)} data-edit-lang={l}>
              {t.lang[l]}
            </button>
          ))}
        </span>
      </div>
      {lang === "ru" && missing > 0 && (
        <span className={styles.missing} data-ru-missing="">
          {fill(t.ruMissing, { n: missing })}
          <button type="button" className={styles.next} onClick={registry.next} data-ru-next="">
            {t.next}
          </button>
        </span>
      )}
    </div>
  );
}
