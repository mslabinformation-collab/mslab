"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { PLACEHOLDERS } from "@/domain/contract";
import { LEGAL_KEYS, legalI18n, legalProblems, sameStoredI18n, sameStoredText, type LegalField, type LegalKey, type LegalState, type LegalText } from "@/domain/legal-text";
import { SITE_LIMITS } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { SAVE_TIMEOUT_MS } from "./autosave/constants";
import { ConfirmPanel } from "./ConfirmPanel";
import { Drawer } from "./Drawer";
import { LangSwitch } from "./EditLang";
import { I18nInput, type I18nInputHandle } from "./I18nInput";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./ContractTexts.module.css";

// Seaded → „Lepingud ja tingimused“ (admin UX pass piece 3b, Task 5; README B4, spec C6; rulings R-d, R-e; piece3-texts S3-P3-j, S3-P3-k, P-5, P-8,
// P-11; the Part 3 frame „B4 Seaded“ and the Part 4 phone frame): the four legal texts — Privaatsus, Õppetingimused, E-koolituse leping,
// Kontaktkoolituse leping — each a card of its title and its text in both languages (the page's ET | RU switch). What is typed autosaves into the
// text's draft (api/admin/oigustekst/<key>, server/legal-drafts.ts) under the page's one SaveStatus; nothing goes live by typing. While the text differs
// from live the card says „Avaldamata muudatus“ and offers „Avalda uus leping“ (the two contracts) or „Avalda uus tekst“ (the two pages), which opens
// its ConfirmPanel in its place; „Jah, avalda“ sends what is typed first and then publishes from the version the screen holds (…/avalda): a new
// contract version exactly as a save made one. There is no discard (R-d): typing the live text back removes the draft. The contracts' texts have the
// placeholder chips, which insert at the cursor; the contact contract has „Näidisleping (PDF)“. On a phone a card shows „Pikk tekst avaneb
// täisekraanil.“ and „Muuda teksti“, which opens the text in the shared drawer (its own address, ?tekst=<key>) with the chips under it. This file
// runs on old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

/** Below 641 px (the admin's phone width, the Part 4 frame) a long text opens in the drawer: the same width as the cards' CSS below. */
const PHONE = "(max-width: 640px)";
function onPhoneChange(tell: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const phone = window.matchMedia(PHONE);
  // (iOS before 14 has only the older addListener)
  if (typeof phone.addEventListener === "function") {
    phone.addEventListener("change", tell);
    return () => phone.removeEventListener("change", tell);
  }
  phone.addListener(tell);
  return () => phone.removeListener(tell);
}
const phoneNow = (): boolean => typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;
const usePhone = (): boolean => useSyncExternalStore(onPhoneChange, phoneNow, () => false);

/** What each card is: its title (as drawn: P-11), its lead, its title's hint, its public page, whether it is a contract (chips, „Avalda uus leping“), the sample. */
type CardDef = { title: string; lead?: string; titleHint?: string; href?: string; contract: boolean; sample: boolean };
function cardOf(key: LegalKey): CardDef {
  const t = adminEt.settings;
  const c = adminEt.contracts.settings;
  switch (key) {
    case "privacy":
      return { title: t.privacy, href: "/privaatsus", contract: false, sample: false };
    case "terms":
      return { title: t.terms, href: "/tingimused", contract: false, sample: false };
    case "course_terms":
      // the e-course contract: read in the cart and at the terms gate (account-only, so no public page); its title is the contract's (ruling R3)
      return { title: t.courseTerms, lead: t.courseTermsLead, titleHint: c.ecourseTitleHint, contract: true, sample: false };
    case "contract_contact":
      return { title: c.contact, lead: c.lead, contract: true, sample: true };
  }
}

/** The card's ConfirmPanel: README B4 (the e-course one, with P-8's n = 1 and n = 0), S3-P3-j (the contact one), S3-P3-k (the pages'). */
function panelOf(key: LegalKey, reaccept: number, contactEmpty: boolean): { question: string; lines: string[] } {
  const l = adminEt.settings.legal;
  switch (key) {
    case "course_terms": {
      const count = reaccept === 1 ? [l.ecourse.one] : reaccept > 1 ? [fill(l.ecourse.many, { n: reaccept })] : [];
      return { question: l.ecourse.question, lines: [...count, l.ecourse.kept] };
    }
    case "contract_contact":
      return { question: l.contact.question, lines: [l.contact.newOnly, l.contact.kept] };
    case "privacy":
      return { question: l.privacy.question, lines: [l.shownAtOnce] };
    case "terms":
      return { question: l.terms.question, lines: [l.shownAtOnce, ...(contactEmpty ? [l.terms.asContract] : [])] };
  }
}

/** The line after „Jah, avalda“ (P-11). */
const publishedLine = (key: LegalKey): string => {
  const p = adminEt.settings.legal.published;
  return key === "course_terms" ? p.course_terms : key === "contract_contact" ? p.contract_contact : p.text;
};

/** A field's words for its code (the site editors' shared words, server/edit-check.ts FieldError). */
const errorText = (code: string | undefined): string | undefined => (code === undefined ? undefined : ((adminEt.courseEditor.errors as Record<string, string>)[code] ?? adminEt.editor.invalid));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const textOf = (v: unknown): LegalText => (isRecord(v) ? { title: legalI18n(v.title), body: legalI18n(v.body) } : { title: legalI18n(null), body: legalI18n(null) });
/** A publish's answer as the text stored now, or null when it is not one. */
function stateOf(body: unknown): LegalState | null {
  if (!isRecord(body) || typeof body.version !== "string" || !isRecord(body.value) || !isRecord(body.live)) return null;
  return { version: body.version, value: textOf(body.value), live: textOf(body.live), changed: body.changed === true };
}

/** POST a JSON body with the admin's cookie, given up after 10 s (the autosave's bound). Null when no answer came. */
async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: abort.signal });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The on-screen keyboard's height over the foot of the screen, as the CSS variable --keyboard-inset on `ref`'s element while `on` (Task 5 review I-1).
 * iOS Safari and Android Chrome (resizes-visual) keep the layout viewport, and the drawer's 100dvh, under the keyboard: what the visual viewport shows
 * ends `innerHeight − visualViewport.height − visualViewport.offsetTop` px above the layout viewport's foot (at least 0). It follows the visual
 * viewport's resize and scroll, and is gone with the element or when `on` ends. Without visualViewport (iOS before 13) nothing is set: no lift.
 */
function useKeyboardInset(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const el = ref.current;
    const view = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!on || !el || !view) return;
    const update = () => el.style.setProperty("--keyboard-inset", `${Math.max(0, Math.round(window.innerHeight - view.height - view.offsetTop))}px`);
    update();
    view.addEventListener("resize", update);
    view.addEventListener("scroll", update);
    return () => {
      view.removeEventListener("resize", update);
      view.removeEventListener("scroll", update);
      el.style.removeProperty("--keyboard-inset");
    };
  }, [ref, on]);
}

/**
 * The placeholders a contract's text may use (domain/contract.ts PLACEHOLDERS: the cart, the terms gate and the registration form fill them), as chips
 * „+ nimi“ … „+ ettemaks“ under the text (README B4, the Part 3 frame): a chip puts „{nimi}“ where the cursor is. Its title says what fills it. A press
 * keeps the cursor in the text (no focus moves to the chip). `sticky`: in the phone's drawer the row stays at the foot of what the screen shows, above
 * the on-screen keyboard (the Part 4 note; useKeyboardInset).
 */
export function PlaceholderChips({ onInsert, disabled, sticky }: { onInsert: (text: string) => void; disabled?: boolean; sticky?: boolean }) {
  const t = adminEt.contracts.settings;
  const uid = useId();
  const row = useRef<HTMLDivElement>(null);
  useKeyboardInset(row, sticky === true);
  return (
    <div ref={row} className={`${styles.chips} ${sticky ? styles.stickyChips : ""}`.trim()} data-placeholder-chips="" data-fab-avoid={sticky ? "" : undefined}>
      <p id={`${uid}-lead`} className={ui.hint}>
        {t.placeholders}
      </p>
      <div className={styles.chipRow} role="group" aria-labelledby={`${uid}-lead`}>
        {PLACEHOLDERS.map((name) => (
          <button
            key={name}
            type="button"
            className={styles.chip}
            title={t.placeholderMeaning[name]}
            aria-disabled={disabled || undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!disabled) onInsert(`{${name}}`);
            }}
            data-placeholder-chip={name}
          >
            + {name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A line under the card's button: what „Jah, avalda“ did or why it did not. `focus`: the line takes the focus when the card starts over with it. */
type Said = { tone: "done" | "error"; text: string; focus?: boolean } | null;

type CardProps = { k: LegalKey; contactEmpty: boolean; reaccept: number; onStatus?: StatusReport; onChanged?: (key: LegalKey, changed: boolean) => void };

/**
 * The section's four cards. `texts`: each as the page read it (server/legal-drafts.ts readLegalTexts); `reaccept`: the students the e-course panel says
 * will be asked again (R-e, read with the page). Each card tells the page its autosave status (`onStatus`, part "legal-<key>") and whether its text
 * waits to be published (`onChanged`: the section map's „{n} avaldamata“).
 */
export function LegalTexts({ texts, reaccept, onStatus, onChanged }: { texts: Record<LegalKey, LegalState>; reaccept: number; onStatus?: StatusReport; onChanged?: (key: LegalKey, changed: boolean) => void }) {
  // the public „Õppetingimused“ text is the contact contract while hers is empty (server/contracts.ts storedTemplate): its panel says so
  const contactEmpty = !texts.contract_contact.live.body.et.trim();
  return (
    <div className={styles.cards} data-legal-texts="">
      {LEGAL_KEYS.map((key) => (
        <LegalCard key={key} k={key} initial={texts[key]} contactEmpty={contactEmpty} reaccept={reaccept} onStatus={onStatus} onChanged={onChanged} />
      ))}
    </div>
  );
}

/**
 * One text's card. It starts its editor from the page's read once, and over again from a publish's answer (the text as stored then: a new version,
 * no draft; or, refused, what another window stored), so its autosave goes on from the published version; the line under the button stays.
 */
function LegalCard({ initial, ...rest }: CardProps & { initial: LegalState }) {
  const [seed, setSeed] = useState({ state: initial, n: 0 });
  const [said, setSaid] = useState<Said>(null);
  const reseed = useCallback((state: LegalState, line: Said) => {
    setSeed((s) => ({ state, n: s.n + 1 }));
    setSaid(line);
  }, []);
  return <LegalEditor key={seed.n} {...rest} state={seed.state} said={said} onSaid={setSaid} onReseed={reseed} />;
}

function LegalEditor({ k, state, said, onSaid, onReseed, contactEmpty, reaccept, onStatus, onChanged }: CardProps & { state: LegalState; said: Said; onSaid: (s: Said) => void; onReseed: (state: LegalState, line: Said) => void }) {
  const t = adminEt.settings;
  const l = t.legal;
  const card = cardOf(k);
  const uid = useId();
  const router = useRouter();
  const params = useSearchParams();
  const phone = usePhone();
  const drawerOpen = phone && params?.get("tekst") === k;
  const openHref = `/admin/seaded?tekst=${k}`;
  const openId = `${uid}-open`;

  const fields = useMemo(() => ({ title: state.value.title, body: state.value.body }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from its seed
  const focusField = useCallback((name: string) => document.querySelector<HTMLElement>(`[data-i18n="${k}.${name}"]`)?.focus(), [k]);
  const label = useCallback((name: string) => (name === "title" ? t.pageTitle : name === "body" ? t.pageBody : name), [t.pageTitle, t.pageBody]);
  const part = useSeadedPart({ part: `legal-${k}`, url: `/api/admin/oigustekst/${k}`, version: state.version, fields, label, focusField, onStatus });
  const title = legalI18n(part.text("title"));
  const body = legalI18n(part.text("body"));
  const current: LegalText = { title, body };
  // (spaces at either end are no change: the writers trim them, review M1)
  const changed = !sameStoredText(current, state.live);
  useEffect(() => onChanged?.(k, changed), [k, changed, onChanged]);
  const now = useRef(current);
  useEffect(() => {
    now.current = current;
  });

  // a field the press found empty or too long (the writers' rule): said in the field until it is typed in again
  const [press, setPress] = useState<Partial<Record<LegalField, string>>>({});
  const type = (name: LegalField, value: I18n) => {
    setPress((p) => {
      if (!(name in p)) return p;
      const rest = { ...p };
      delete rest[name];
      return rest;
    });
    part.type(name, value);
  };
  const errorOf = (name: LegalField) => errorText(press[name] ?? part.codeOf(name));

  // the chips go to the field the cursor was last in (the text unless it was the title)
  const inputs = { title: useRef<I18nInputHandle>(null), body: useRef<I18nInputHandle>(null) };
  const lastField = useRef<LegalField>("body");

  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [asking]);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // the card started over from a publish's answer: its line takes the focus (the panel that had it is gone)
    if (said?.focus && (document.activeElement === null || document.activeElement === document.body)) line.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as the card starts

  /** „Avalda …“: the writers' rule first (a field that would be refused is said there and takes the focus), then the panel in the button's place. */
  const ask = () => {
    const problems = legalProblems(current);
    if (problems.title || problems.body) {
      setPress(problems);
      // on a phone the fields are in the drawer
      if (phone && !drawerOpen) router.push(openHref, { scroll: false });
      else focusField(problems.title ? "title" : "body");
      return;
    }
    onSaid(null);
    setAsking(true);
  };

  /** „Jah, avalda“: what is typed is sent first; then the publish, from the version the screen holds. The panel is busy until the answer. */
  const yes = async () => {
    if (busy) return;
    setBusy(true);
    const close = (next: Said) => {
      setBusy(false);
      refocus.current = true;
      setAsking(false);
      onSaid(next);
    };
    if (!(await part.flush())) {
      const why = part.unconfirmed();
      return close({ tone: "error", text: part.conflictNow() ? l.changed : why?.reason === "signedOut" ? adminEt.leave.reasons.signedOut : adminEt.publish.publishFailed });
    }
    // typed back to live while the panel was open: there is nothing to publish
    if (sameStoredText(now.current, state.live)) return close(null);
    const answer = await postJson(`/api/admin/oigustekst/${k}/avalda`, { version: part.versionNow() });
    const stored = answer && (answer.status === 200 || answer.status === 409) ? stateOf(answer.body) : null;
    if (answer && stored) {
      router.refresh(); // (the other cards' panels read the page: the contact text's emptiness, the e-course count)
      // a 409 that finds the screen's text live and no other draft is her own publish whose answer the 10 s bound cut off (review M5): published
      const mine = answer.status === 409 && !stored.changed && sameStoredText(stored.live, now.current);
      onReseed(stored, answer.status === 200 || mine ? { tone: "done", text: publishedLine(k), focus: true } : { tone: "error", text: l.changed, focus: true });
      return;
    }
    const reply = answer?.body;
    if (answer?.status === 400 && isRecord(reply) && reply.error === "invalid" && isRecord(reply.fields)) {
      const refused = reply.fields;
      setPress(Object.fromEntries((["title", "body"] as const).filter((f) => typeof refused[f] === "string").map((f) => [f, refused[f] as string])));
    }
    close({ tone: "error", text: answer?.status === 401 || answer?.status === 403 ? adminEt.leave.reasons.signedOut : adminEt.publish.publishFailed });
  };

  const insert = (piece: string) => {
    if (!busy) inputs[lastField.current].current?.insert(piece);
  };
  const fieldsOf = (sticky: boolean) => (
    <div className={site.fields}>
      <div className={styles.field} onFocus={() => void (lastField.current = "title")}>
        <I18nInput
          ref={inputs.title}
          label={t.pageTitle}
          value={title}
          onChange={(v) => type("title", v)}
          maxLength={SITE_LIMITS.legalTitle}
          hint={card.titleHint}
          error={errorOf("title")}
          name={`${k}.title`}
          unpublished={!sameStoredI18n(title, state.live.title)}
          readOnly={busy}
        />
      </div>
      <div className={styles.field} onFocus={() => void (lastField.current = "body")}>
        <I18nInput
          ref={inputs.body}
          label={t.pageBody}
          value={body}
          onChange={(v) => type("body", v)}
          multiline
          rows={k === "contract_contact" ? 12 : 10}
          maxLength={SITE_LIMITS.legal}
          hint={t.pageHint}
          error={errorOf("body")}
          name={`${k}.body`}
          unpublished={!sameStoredI18n(body, state.live.body)}
          readOnly={busy}
        />
      </div>
      {card.contract && <PlaceholderChips onInsert={insert} disabled={busy} sticky={sticky} />}
    </div>
  );
  const panel = panelOf(k, reaccept, contactEmpty);

  return (
    // (a field left saves at once, as the other cards of Seaded do)
    <section className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} onBlur={() => void part.flush()} data-legal-editor={k}>
      <div className={styles.head}>
        <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
          {card.title}
        </h2>
        {changed && (
          <span className={`${ui.tag} ${ui.warn} ${styles.tag}`} data-legal-tag="">
            <span className={styles.long} data-tag-long="">
              {l.tag}
            </span>
            <span className={styles.short} data-tag-short="">
              {l.tagShort}
            </span>
          </span>
        )}
        {card.href && (
          <a className={`${ui.link} ${styles.view}`} href={card.href} target="_blank" rel="noopener">
            {adminEt.editor.viewSite} ↗<span className={ui.sr}> ({adminEt.editor.newWindow})</span>
          </a>
        )}
      </div>
      {card.lead && <p className={`${ui.muted} ${site.cardLead}`}>{card.lead}</p>}

      {/* the fields on the card; on a phone the card says the text opens full screen (the fields are hidden there, CSS), and in the drawer once it is open */}
      <div className={styles.inline}>{!drawerOpen && fieldsOf(false)}</div>
      <div className={styles.phone}>
        <p className={styles.phoneHint}>{l.phoneHint}</p>
        <Link href={openHref} scroll={false} id={openId} className={`${ui.btn} ${ui.secondary} ${styles.open}`} data-legal-open="">
          {l.phoneOpen}
        </Link>
      </div>

      {part.conflict !== null && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void part.restore()} data-seaded-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}

      <div className={styles.publish}>
        {asking ? (
          <ConfirmPanel
            question={panel.question}
            lines={panel.lines}
            yesLabel={l.yes}
            tone="send"
            busy={busy}
            onYes={() => void yes()}
            onCancel={() => {
              refocus.current = true;
              setAsking(false);
            }}
          />
        ) : (
          changed && (
            <button ref={trigger} type="button" className={ui.btn} onClick={ask} data-legal-publish="">
              {card.contract ? l.publishContract : l.publishText}
            </button>
          )
        )}
        <p ref={line} role="status" tabIndex={-1} className={`${styles.said} ${said?.tone === "error" ? ui.error : said ? ui.success : ui.hint}`} data-legal-said="">
          {said?.text ?? ""}
        </p>
      </div>

      {card.sample && <SampleForm title={title} body={body} />}

      {drawerOpen && (
        <Drawer label={card.title} closeHref="/admin/seaded" closeLabel={adminEt.common.close} returnFocus={openId}>
          <div className={styles.drawer}>
            <h2 className={`${ui.h2} ${styles.drawerTitle}`}>{card.title}</h2>
            <LangSwitch />
            {fieldsOf(true)}
          </div>
        </Drawer>
      )}
    </section>
  );
}

/**
 * „Näidisleping (PDF)“ (contracts Task 5, spec §4; ruling R-d): a form of its own that posts the card's texts as they stand on the screen — the draft
 * as typed, published or not — to a new tab (a contract text is far too long for an address). Nothing is stored or published by it.
 */
function SampleForm({ title, body }: { title: I18n; body: I18n }) {
  const c = adminEt.contracts.settings;
  const hasRu = (body.ru ?? "").trim() !== "";
  return (
    <form className={styles.sample} method="post" action="/api/admin/naidisleping" target="_blank" data-contract-sample-form="">
      <input type="hidden" name="titleEt" value={title.et} />
      <input type="hidden" name="titleRu" value={title.ru ?? ""} />
      <input type="hidden" name="bodyEt" value={body.et} />
      <input type="hidden" name="bodyRu" value={body.ru ?? ""} />
      <div className={styles.sampleButtons}>
        <button type="submit" name="lang" value="et" className={`${ui.btn} ${ui.secondary}`} data-contract-sample="et">
          {c.sample}
        </button>
        {hasRu && (
          <button type="submit" name="lang" value="ru" className={`${ui.btn} ${ui.secondary}`} data-contract-sample="ru">
            {c.sampleRu}
          </button>
        )}
      </div>
      <p className={ui.hint}>{c.sampleHint}</p>
    </form>
  );
}
