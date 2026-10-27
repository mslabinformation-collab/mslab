"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import { NewsletterForm } from "@/components/site/NewsletterForm";
import { NewsletterPopupCard, POPUP_FORM_CLASS, popupFormTexts } from "@/components/site/NewsletterPopupCard";
import { SITE_LIMITS } from "@/domain/site-editor";
import type { PopupOfferValue, SitePartState } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { pick } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { getDict } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";
import { PlainField } from "./course/PlainField";
import { useEditLang } from "./EditLang";
import { I18nInput } from "./I18nInput";
import { SingleImage } from "./SingleImage";
import { SiteCard } from "./site/SiteCard";
import { SiteEditorPage, type SitePage } from "./site/SiteEditorPage";
import type { SitePartApi } from "./site/useSitePart";
import { Switch } from "./Switch";
import { useUndo } from "./UndoBar";
import { stampOf } from "./useEditorRestarts";
import ui from "./ui.module.css";
import styles from "./CampaignEditor.module.css";

// C4 Hüpikaken (admin UX pass piece 4b, Task 4; README §4 C4 "the „Lehel näidatakse“ choice is instant with UndoBar; one preview that follows LangSwitch;
// the „Reeglid“ text stays", the Part 4 C4 frame; piece4-texts S4-25…S4-30, S4-Q2…Q4; spec D3; rulings R-c, R-d, builder notes §5). One popup, the
// newsletter sign-up: page.tsx (requireAdmin, readSiteEditor of the entity "popup", readPopupSwitch, Seaded's code) → this wrapper → SiteEditorPage
// (the header „Turundus“ / „Hüpikaken“ with ET | RU, the chip and „Vaata lehel ↗“ to the home page; the PublishBar with S4-30's labels; the part
// `offer` on the draft layer) → the cards, in the screen's marker `data-campaign-editor` (admin-inbox.spec.ts opens the section by it):
// - „Lehel näidatakse“ with S4-25's line, a card of its own on top: an instant switch on the live row (server/site-drafts.ts switchPopup), pressed as the
//   page's instant press with `flush: false` (SitePage.instant: the cards wait from the press to the read from its answer's stamp; what is typed is not
//   saved first — the switch never reads or publishes a draft, and the drafts' versions do not move, so nothing typed is lost over the read). Off: the
//   UndoBar „Hüpikaken peidetud.“, whose „Võta tagasi“ switches it on again from the version the hide left; on: no bar (its own reverse), and a hide's
//   bar still up goes (S4-26). Refused on, the live popup lacks a field a shown one needs: `Puudub: pilt` under it, never on the bar (S4-30: the
//   switch is never on the bar), until the next press or the page's next read (a publish that brings the picture). Refused because another tab changed
//   the popup: „Hüpikakent muudeti vahepeal. Vaata see üle.“ under it, and the page is read so the switch shows the row as it is; the line stays over
//   that read. A failure says its line there.
// - Below, `minmax(0,1fr) 440px` from 1180 px (one column under it, the preview under the card): „Pakkumine“ — „Silt“ and „Pilt“ (kept, builder notes
//   §5), „Pealkiri“, „Tekst“, then „Soodustus (%)“ and „Kood kehtib (päeva)“ side by side (R-c, S4-Q2 A, S4-Q3 A) with S4-28 under them — and the
//   preview: the home page's card (components/site/NewsletterPopupCard.tsx) of the fields as typed, in the language of the page's ET | RU, its button
//   following Seaded's code (S4-Q4), a picture of it (inert), with S4-29 („Reeglid: …“) and the kept note under it.
// What the switch's presses need lives here, above the cards: SiteEditorPage starts its cards over after every press's read (a new `generation`), and
// the UndoBar's undo comes after that.

const SWITCH_URL = "/api/admin/hupikaken/naita";

/** Hüpikaken's parts by name (SiteEditorPage's values): the one part `offer` (domain/site-entities.ts POPUP_PART). */
type Popup = { offer: PopupOfferValue };

/** „Lehel näidatakse“ as the page read it (server/site-drafts.ts readPopupSwitch): shown or not, and the version its press sends. */
export type PopupSwitchState = { on: boolean; version: string };

/** What the switch keeps above the cards' restarts (the wrapper's; the card tells it). */
type SwitchMemory = {
  /** The page's instant press as the newest render has it, kept for the UndoBar's undo (which comes after the cards started over). */
  keep: (page: SitePage) => void;
  /** A press went through: off puts up „Hüpikaken peidetud.“ with its undo from `version` (the one the hide left); on takes a hide's bar away. */
  switched: (on: boolean, version: string) => void;
  /** What the last press said under the switch, while it still holds. */
  said: string | null;
  /** Says `line` under the switch (null: nothing) until the page's next read, or the read after it (`overRead`: the read the press asked for). */
  say: (line: string | null, overRead?: boolean) => void;
};

/** A press of the switch, as its answer is read (S4-26). */
type SwitchPress =
  | { kind: "done"; version: string }
  | { kind: "missing"; fields: string[] }
  | { kind: "changed" }
  | { kind: "failed"; line: string }
  | { kind: "late" | "busy" };

/**
 * POST /api/admin/hupikaken/naita `{ on, version }` as the page's instant press, with no save first: done (the row's new version; the page is read from
 * the answer's stamp), refused on with the fields the live popup lacks (the cards take typing again, nothing is read), refused as changed meanwhile
 * (the page is read, so the switch shows the row as it is), failed with its line, past the bound (the page is read), or not pressed at all because the
 * cards wait for another press.
 */
async function pressSwitch(page: SitePage, on: boolean, version: string): Promise<SwitchPress> {
  let answer: Record<string, unknown> = {};
  const result = await page.instant(
    SWITCH_URL,
    { on, version },
    (a) => {
      answer = a;
      if ((a.ok === true && typeof a.version === "string") || a.error === "changed") return { done: true, stamp: stampOf(a) };
      // (said under the switch, not on the bar: no part is held)
      if (Array.isArray(a.missing)) return { held: [] };
      return null;
    },
    { flush: false },
  );
  if (result.kind === "done") return answer.ok === true ? { kind: "done", version: answer.version as string } : { kind: "changed" };
  if (result.kind === "held") return { kind: "missing", fields: (answer.missing as unknown[]).filter((f): f is string => typeof f === "string") };
  if (result.kind === "failed") return result;
  if (result.kind === "late" || result.kind === "busy") return { kind: result.kind };
  return { kind: "failed", line: adminEt.common.saveError }; // ("unsaved" cannot be: nothing is saved first)
}

const missingLine = (fields: string[]) => fill(adminEt.publish.missing, { fields: fields.join(", ") });

/**
 * The page as soon as its cards take typing again — the read the last press asked for has come, or its bound has passed (useEditorRestarts: the wait
 * ends by SAVE_TIMEOUT_MS) — or null when there is none by then. „Võta tagasi“ comes while the hide's own read may still be on its way.
 */
async function whenFree(latest: () => SitePage | null): Promise<SitePage | null> {
  const until = Date.now() + SAVE_TIMEOUT_MS + 1000;
  for (;;) {
    const page = latest();
    if (page && !page.waitingNow()) return page;
    if (Date.now() > until) return null;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** The editor of the home page's popup, from the page's read (readSiteEditor's `parts` and `stamp`, as they came), the switch's and Seaded's code. */
export function CampaignEditor({ parts, stamp, shown, code }: { parts: Record<string, SitePartState>; stamp: number; shown: PopupSwitchState; code: boolean }) {
  const t = adminEt.campaign;
  const undo = useUndo();
  const latest = useRef<SitePage | null>(null);
  /** Takes away the hide's UndoBar (UndoBar's show answers it). */
  const withdraw = useRef<(() => void) | null>(null);
  // an editor that goes takes its offer with it (UndoBar.tsx)
  useEffect(() => () => withdraw.current?.(), []);
  // the page's reads, counted (a new `parts` object is a new read), and the line under the switch with the last read it holds for
  const [reads, setReads] = useState({ parts, n: 0 });
  if (reads.parts !== parts) setReads({ parts, n: reads.n + 1 });
  const [line, setLine] = useState<{ text: string; until: number } | null>(null);
  /** „Võta tagasi“ of a hide: on again, from the version the hide left, once the hide's read is in; a refusal is said in the bar. */
  const undoHide = async (version: string): Promise<boolean | string> => {
    const page = await whenFree(() => latest.current);
    if (!page) return false;
    setLine(null);
    const press = await pressSwitch(page, true, version);
    if (press.kind === "done") return true;
    if (press.kind === "changed") return t.changed;
    if (press.kind === "missing") return missingLine(press.fields);
    if (press.kind === "failed") return press.line;
    return false;
  };
  const memory: SwitchMemory = {
    keep: (page) => {
      latest.current = page;
    },
    switched: (on, version) => {
      withdraw.current?.();
      withdraw.current = on ? null : undo.show({ text: t.hidden, undo: () => undoHide(version) });
    },
    said: line && reads.n <= line.until ? line.text : null,
    say: (text, overRead = false) => setLine(text === null ? null : { text, until: reads.n + (overRead ? 1 : 0) }),
  };
  return (
    <SiteEditorPage<Popup>
      entity="popup"
      eyebrow={t.eyebrow}
      title={t.title}
      viewHref="/"
      previewPath="/"
      parts={parts}
      stamp={stamp}
      render={(apis, now) => <PopupCards api={apis.offer} page={now} shown={shown} code={code} memory={memory} />}
    />
  );
}

/** The screen's cards: „Lehel näidatakse“ on top, then „Pakkumine“ beside its preview. */
function PopupCards({ api, page, shown, code, memory }: { api: SitePartApi<PopupOfferValue>; page: SitePage; shown: PopupSwitchState; code: boolean; memory: SwitchMemory }) {
  return (
    <div className={styles.screen} data-campaign-editor="">
      <ShownCard page={page} shown={shown} memory={memory} />
      <div className={styles.cols}>
        <OfferCard api={api} />
        <OfferPreview api={api} code={code} />
      </div>
    </div>
  );
}

/** „Lehel näidatakse“ (S4-25, S4-26): the switch shows what was asked until the cards start over from the page's read, or the press ends otherwise. */
function ShownCard({ page, shown, memory }: { page: SitePage; shown: PopupSwitchState; memory: SwitchMemory }) {
  const t = adminEt.campaign;
  const uid = useId();
  const [asked, setAsked] = useState<boolean | null>(null);
  const { keep, said } = memory;
  useLayoutEffect(() => keep(page));

  const switchTo = async (on: boolean) => {
    if (asked !== null || page.waitingNow()) return;
    setAsked(on);
    memory.say(null);
    const press = await pressSwitch(page, on, shown.version);
    if (press.kind === "done") {
      // the bar (off) or none (on); the cards start over from the page's read, this card with them
      memory.switched(on, press.version);
      return;
    }
    // (past the bound the page is read, the outcome unknown: the cards start over from it)
    if (press.kind === "late") return;
    setAsked(null);
    if (press.kind === "changed") memory.say(t.changed, true);
    else if (press.kind === "missing") memory.say(missingLine(press.fields));
    else if (press.kind === "failed") memory.say(press.line);
  };

  return (
    <div className={`${ui.card} ${styles.shown}`} data-popup-shown="">
      <Switch label={t.shown} checked={asked ?? shown.on} onChange={(on) => void switchTo(on)} describedBy={said ? `${uid}-hint ${uid}-said` : `${uid}-hint`} data-popup-switch="" />
      <p id={`${uid}-hint`} className={ui.hint}>
        {t.shownHint}
      </p>
      {said && (
        <p id={`${uid}-said`} role="alert" className={ui.error} data-switch-error="">
          {said}
        </p>
      )}
    </div>
  );
}

/** „Pakkumine“ (S4-27, S4-28), saved when the focus leaves it; every field waits for „Avalda muudatused“ („· avaldamata“ where it differs from live). */
function OfferCard({ api }: { api: SitePartApi<PopupOfferValue> }) {
  const t = adminEt.campaign;
  const v = api.fields;
  return (
    <SiteCard id="pakkumine" title={adminEt.siteChanges.popup.offer} parts={[api]} className={styles.offer} titleClassName={styles.offerTitle}>
      <I18nInput label={t.kicker} value={v.kicker} onChange={(x) => api.set("kicker", x)} maxLength={SITE_LIMITS.campaignKicker} error={api.error("kicker")} name="offer.kicker" unpublished={api.unpublished("kicker")} />
      <I18nInput label={t.titleField} value={v.title} onChange={(x) => api.set("title", x)} maxLength={SITE_LIMITS.campaignTitle} error={api.error("title")} name="offer.title" unpublished={api.unpublished("title")} />
      <I18nInput
        label={t.text}
        value={v.text}
        onChange={(x) => api.set("text", x)}
        multiline
        rows={3}
        maxLength={SITE_LIMITS.campaignText}
        error={api.error("text")}
        name="offer.text"
        unpublished={api.unpublished("text")}
      />
      <SingleImage label={t.image} value={v.imageKey} onChange={(key) => api.commit("imageKey", key)} error={api.error("imageKey")} ratio="16 / 9" name="popup" field="offer.imageKey" />
      <div className={styles.numbers} data-offer-numbers="">
        <PlainField
          name="offer.discountPercent"
          label={t.discount}
          value={v.discountPercent}
          onChange={(x) => api.set("discountPercent", x)}
          inputMode="numeric"
          maxLength={2}
          error={api.error("discountPercent")}
          unpublished={api.unpublished("discountPercent")}
        />
        <PlainField
          name="offer.codeDays"
          label={t.codeDays}
          value={v.codeDays}
          onChange={(x) => api.set("codeDays", x)}
          inputMode="numeric"
          maxLength={3}
          error={api.error("codeDays")}
          unpublished={api.unpublished("codeDays")}
        />
      </div>
      <p className={ui.hint}>{t.codeWhere}</p>
    </SiteCard>
  );
}

/** The live preview: the home page's popup card of the offer as typed, in the page's content language, a picture of it (inert: nothing is sent). */
function OfferPreview({ api, code }: { api: SitePartApi<PopupOfferValue>; code: boolean }) {
  const t = adminEt.campaign;
  const { lang } = useEditLang();
  const v = api.fields;
  const view = { image: v.imageKey ? mediaUrl(v.imageKey) : "", kicker: pick(v.kicker, lang), title: pick(v.title, lang), text: pick(v.text, lang) };
  return (
    <div className={styles.aside} data-popup-preview="">
      {/* (`preview`: the form's fields in a plain block, no <form> inside the page, no link out of it) */}
      <section className={styles.stage} aria-label={t.preview} inert lang={lang} data-newsletter-preview="">
        <NewsletterPopupCard n={view} form={<NewsletterForm locale={lang} preview className={POPUP_FORM_CLASS} t={popupFormTexts(getDict(lang), code)} />} />
      </section>
      <p className={`${ui.muted} ${ui.small}`} data-popup-rules="">
        {t.rulesLine}
      </p>
      <p className={`${ui.muted} ${ui.small}`}>{t.previewNote}</p>
    </div>
  );
}
