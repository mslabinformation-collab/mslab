"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type SyntheticEvent } from "react";
import { CAMPAIGN_DAILY_ROOM, CAMPAIGN_FIELDS, CAMPAIGN_LIMITS, campaignFieldCodes, campaignSaveCheck, checkCampaignDraft, type CampaignField } from "@/domain/newsletter-campaign";
import { WELCOME_CODE_MAX } from "@/domain/welcome-code";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { copyCampaignAction, createDraftAction, deleteDraftAction, prepareSendAction, sendTestAction, startSendAction, stopSendAction } from "@/server/actions/admin-newsletter";
import type { CampaignValues, Progress } from "@/server/newsletter-campaigns";
import { patchSender, type Fields, type SendPatch } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { ConfirmPanel } from "./ConfirmPanel";
import { useEditLang } from "./EditLang";
import { I18nInput, type Lang } from "./I18nInput";
import { SaveStatus } from "./SaveStatus";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import { usePhoneChip } from "./course/usePhoneChip";
import { useFootBar } from "./foot-bar";
import site from "./site-editor.module.css";
import ui from "./ui.module.css";
import styles from "./CampaignsPanel.module.css";

// Maria's letter editor on the „Kirjad“ tab (newsletter campaigns, Task 4; spec D4, D5; ruling R2; the 20.10 design §3:
// docs/superpowers/specs/2026-10-20-newsletter-simple-design.md; admin UX pass piece 3b, Task 6: README B5, B9, B17, spec C4, rulings R-g, R-h, the Part 3
// frame „B5 Uudiskiri“ and the Part 4 „B5 Kirjad“, piece3-texts S3-P3-f, S3-P3-h, S3-P3-l, P-12, P-13). Three states, decided by the letter's `status`:
// - a draft: the card of its fields (its name and the one SaveStatus at its head; the name, the subject, the preview line, the picture, the text in
//   paragraphs, the code, the button, each with its limit and a counter; „Kustuta mustand“ behind its ConfirmPanel), autosaved on api/admin/kiri/<id>
//   (autosave/useAutosave.ts: 1.5 s after the last key, at once when a field is left; the save's rules domain/newsletter-campaign.ts campaignSaveCheck,
//   shared with the server: an empty subject and text save, R-g); beside it the live preview of the real mail in the language of the page's ET | RU
//   switch, and the sends: the select „{address} · {eesti|vene keeles}“ with „Saada proov“, and „Saada kõigile ({n})“ (n: the page's read of the
//   confirmed subscribers, sample addresses left out, B9) with its ConfirmPanel. Both sends flush first, so what goes is what the screen shows; while the
//   text cannot be saved the two buttons give way to „Saatmiseks peab kiri olema salvestatud.“ and the reason (S3-P3-l); the sends' own rules (the
//   subject and the text required, the button whole) are said in the fields. On a phone (below 900 px, the stylesheet) the list is its own screen,
//   „← Kirjad“ goes back to it, „Muuda | Eelvaade“ switches between the fields and the preview, and the two buttons stand at the foot.
// - going out (`sending`): read-only, with the progress, the failed and unknown counts when they are not 0, the line of a batch Resend refused,
//   „Peata saatmine“ (its ConfirmPanel), the preview and „Kopeeri“;
// - sent: read-only, „Saadetud {date} · {n} tellijale“ (and the same counts), the preview and „Kopeeri“.
// What an action returns is only the line right after a press: the page is refreshed by the action and the state comes from the letter's row.
// This file runs on old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

export type { CampaignValues };
/** A stored letter as the editor shows it (components/admin/CampaignsPanel.tsx campaignEditorView builds it). */
export type CampaignEditorView = {
  id: number;
  status: "draft" | "sending" | "sent";
  values: CampaignValues;
  /** The autosave's version of the letter as the page read it (server/newsletter-campaigns.ts campaignVersion). */
  version: string;
  /** ISO time of the send; null until sent. */
  sentAt: string | null;
  /** ISO time of its last change. */
  updatedAt: string;
  /** The subscribers the send was for, per language; null while a draft. */
  recipients: { et: number; ru: number } | null;
  /** Where its deliveries stand (server/newsletter-campaigns.ts progressOf); null while a draft. */
  progress: Progress | null;
  /** While going out: the last batch stopped because Resend refused (server/newsletter-campaigns.ts sendRefused). */
  refused: boolean;
};
/** An address „Saada proov“ may go to: MARIA_EMAIL's (`maria`) or the signed-in admin's (`me`). */
export type TestTarget = { key: "maria" | "me"; address: string };
/** B9, R-h: who „Saada kõigile ({n})“ goes to as the page read it (server/newsletter-campaigns.ts sendCountsNow): by language, and the sample addresses left out. */
export type Audience = { et: number; ru: number; samples: number };

const LIST_HREF = "/admin/uudiskiri?vaade=kampaaniad";
const letterHref = (id: number) => `${LIST_HREF}&kampaania=${id}`;
const PREVIEW_URL = "/api/admin/kampaania-eelvaade";
/** The pause after the last key before the preview is asked again (ms). */
const PREVIEW_PAUSE_MS = 300;
const OWNER = "kiri";

const t = adminEt.newsletter.campaigns;
const LOCALES: readonly Lang[] = ["et", "ru"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const without = <T extends Record<string, unknown>>(codes: T, names: readonly string[]): T => {
  if (!names.some((n) => n in codes)) return codes;
  const out = { ...codes };
  for (const n of names) delete out[n];
  return out;
};
const both = (v: I18n): { et: string; ru: string } => ({ et: v.et, ru: v.ru ?? "" });
const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${formatDate(d, "et")} ${formatTime(d, "et")}`;
};

type PreviewMail = { subject: string; preheader: string; html: string };
type Preview = { et: PreviewMail; ru: PreviewMail; ruFallsBack: boolean };
type Tone = "idle" | "busy" | "done" | "error";
type Line = { tone: Tone; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Tone) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/** An action's refusal in words (an unknown code: the general one). */
const refusal = (code: string): string => (t.errorsOf as Record<string, string>)[code] ?? t.errorsOf.server;
/** What a lost connection or a thrown action is to the editor: the general refusal. */
const LOST = { ok: false as const, error: "server" as const };
/** „Saadetud {sent} / {n} — ülejäänud {left} lähevad järgmisel päeval.“ for the deliveries as they stand. */
const progressText = (p: Progress): string => fill(t.progress, { sent: p.sent, n: p.total, left: p.waiting });
/** A field's refusal in words (domain/newsletter-campaign.ts's codes). */
const fieldError = (code: string | undefined): string | undefined =>
  code === undefined ? undefined : code === "ruLabel" ? adminEt.newsletter.campaignErrors.ruLabel : ((t.errors as Record<string, string>)[code] ?? t.errors.invalid);
/** The visible name of each field (the leave guard's notice, the chip's „Näita“). */
const LABELS: Record<CampaignField, string> = {
  name: t.name,
  subject: t.subject,
  preheader: t.preheader,
  imageKey: t.image,
  body: t.body,
  code: t.code,
  buttonLabel: t.buttonLabel,
  buttonHref: t.buttonHref,
};
const ONE_LANGUAGE: readonly string[] = ["name", "code", "buttonHref"];
/** The element of a field (its input in the language shown; the picture's own control). */
const fieldElement = (name: string): HTMLElement | null =>
  name === "imageKey"
    ? document.querySelector<HTMLElement>('[data-campaign-form] [data-single-image="campaign-image"] input, [data-campaign-form] [data-single-image="campaign-image"] button')
    : document.querySelector<HTMLElement>(ONE_LANGUAGE.includes(name) ? `[data-campaign-form] [data-field="${name}"]` : `[data-campaign-form] [data-i18n="${name}"]`);

// ---------- what outlives a letter's editor: the new draft's cursor, the list's „Mustand kustutatud.“ ----------

/** „Uus kiri +“ made this draft: when its editor opens, the cursor goes to „Nimi“ (S3-P3-h). Once. */
let focusNameOf: number | null = null;

/** The draft just deleted (S3-P3-f): the list says „Mustand kustutatud.“ until another letter is opened. */
const deleted = {
  id: null as number | null,
  listeners: new Set<() => void>(),
  subscribe(fn: () => void) {
    deleted.listeners.add(fn);
    return () => void deleted.listeners.delete(fn);
  },
  get: () => deleted.id,
  set(id: number | null) {
    deleted.id = id;
    for (const fn of deleted.listeners) fn();
  },
};
const nobody = (): number | null => null;

/**
 * The list's line after „Kustuta mustand“: „Mustand kustutatud.“ (S3-P3-f) while no letter is open (`selected` null: the list, or the phone's list
 * screen); opening another letter ends it. It takes the focus when the focus fell to the page (the panel that had it is gone with the editor).
 */
export function DeletedNotice({ selected }: { selected: number | null }) {
  const id = useSyncExternalStore(deleted.subscribe, deleted.get, nobody);
  const line = useRef<HTMLParagraphElement>(null);
  const shown = id !== null && selected === null;
  useEffect(() => {
    // (while the deleted letter's own address is still open the page is moving away from it: the line waits for the list)
    if (id !== null && selected !== null && selected !== id) deleted.set(null);
  }, [id, selected]);
  useEffect(() => {
    if (shown && (document.activeElement === null || document.activeElement === document.body)) line.current?.focus();
  }, [shown]);
  if (!shown) return null;
  return (
    <p ref={line} tabIndex={-1} role="status" className={`${ui.notice} ${styles.listNotice}`} data-campaign-deleted="">
      {t.remove.done}
    </p>
  );
}

/** „Uus kiri +“ (S3-P3-h): the draft „Uus kiri“ at once (createDraftAction), then its editor, the cursor in „Nimi“. */
export function NewLetterButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setLine("");
    const r = await createDraftAction().catch(() => LOST);
    setBusy(false);
    if (!r.ok) return setLine(refusal(r.error));
    focusNameOf = r.id;
    router.push(letterHref(r.id));
  };
  return (
    <div className={styles.newPart}>
      <button type="button" className={`${ui.btn} ${ui.smallBtn} ${styles.new}`} aria-disabled={busy || undefined} onClick={() => void create()} data-campaign-new="">
        {`${t.new} +`}
      </button>
      <p role="status" className={`${styles.status} ${ui.error}`} data-campaign-new-status="">
        {line}
      </p>
    </div>
  );
}

export function NewsletterCampaignEditor({
  campaign,
  links,
  testTargets,
  gated,
  audience,
}: {
  campaign: CampaignEditorView;
  /** The site's pages for the button's address (server/site-links.ts). */
  links: string[];
  /** The addresses „Saada proov“ offers. */
  testTargets: TestTarget[];
  /** The coming-soon gate is on (the page reads SITE_GATE, lib/site-gate.ts gateOn; this component never reads the environment): the mail's links open „Tulekul“. */
  gated: boolean;
  /** Who „Saada kõigile ({n})“ goes to, as the page read it (B9). */
  audience: Audience;
}) {
  // a line that stays when the letter's state changes under it (a delete refused because it was sent meanwhile: the page then shows it read-only)
  const [notice, setNotice] = useState<string | null>(null);
  const readOnly = campaign.status !== "draft";
  return (
    <>
      {notice && (
        <p role="status" className={`${ui.notice} ${styles.notice}`} data-campaign-notice="">
          {notice}
        </p>
      )}
      {readOnly ? (
        <SentCampaign campaign={campaign} />
      ) : (
        <DraftEditor campaign={campaign} links={links} testTargets={testTargets} gated={gated} audience={audience} onNotice={setNotice} />
      )}
    </>
  );
}

// ---------- the preview ----------

/** The real mail of `values` in both languages, from the preview route, asked again PREVIEW_PAUSE_MS after the last change. */
function usePreview(values: CampaignValues): { preview: Preview | null; failed: boolean } {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const body = JSON.stringify({ draft: values });
  useEffect(() => {
    const ask = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(PREVIEW_URL, { method: "POST", headers: { "content-type": "application/json" }, body, credentials: "same-origin", signal: ask.signal });
        const answer = (await res.json().catch(() => null)) as ({ ok?: boolean } & Partial<Preview>) | null;
        if (!res.ok || !answer?.ok || !answer.et || !answer.ru) throw new Error("no preview");
        setPreview({ et: answer.et, ru: answer.ru, ruFallsBack: answer.ruFallsBack === true });
        setFailed(false);
      } catch {
        if (!ask.signal.aborted) setFailed(true);
      }
    }, PREVIEW_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      ask.abort();
    };
  }, [body]);
  return { preview, failed };
}

/**
 * The preview card: the subject and the mail in a sandboxed frame (no script runs in it, nothing in it can be pressed), in the language of the page's
 * ET | RU switch (README B5: the preview follows LangSwitch; its own pills are gone, ledger L152).
 */
function PreviewCard({ values }: { values: CampaignValues }) {
  const uid = useId();
  const { lang } = useEditLang();
  const [height, setHeight] = useState<number | null>(null);
  const { preview, failed } = usePreview(values);
  const mail = preview?.[lang];
  // the frame takes the mail's own height (its document is this page's origin, without scripts: sandbox="allow-same-origin")
  const fit = (e: SyntheticEvent<HTMLIFrameElement>) => {
    const doc = e.currentTarget.contentDocument;
    if (doc?.documentElement) setHeight(doc.documentElement.scrollHeight);
  };
  return (
    <section className={ui.card} aria-labelledby={`${uid}-preview`} data-campaign-preview="">
      <h2 id={`${uid}-preview`} className={`${ui.h3} ${styles.cardTitle}`}>
        {t.preview}
      </h2>
      {mail && (
        <p className={`${ui.small} ${styles.previewSubject}`}>
          <span className={ui.muted}>{t.previewSubject}: </span>
          <strong data-campaign-preview-subject="">{mail.subject}</strong>
        </p>
      )}
      {lang === "ru" && preview?.ruFallsBack && (
        <p className={`${ui.notice} ${styles.previewNote}`} data-campaign-preview-fallback="">
          {t.previewFallback}
        </p>
      )}
      {failed && (
        <p className={ui.error} data-campaign-preview-error="">
          {t.previewError}
        </p>
      )}
      {mail ? (
        <div className={styles.frameBox} inert>
          <iframe
            key={lang}
            className={styles.frame}
            title={fill(t.previewFrame, { lang: adminEt.i18n.langName[lang] })}
            sandbox="allow-same-origin"
            srcDoc={mail.html}
            onLoad={fit}
            style={height ? { height } : undefined}
            tabIndex={-1}
            data-campaign-preview-frame={lang}
          />
        </div>
      ) : (
        !failed && <p className={ui.hint}>{t.previewWorking}</p>
      )}
    </section>
  );
}

// ---------- a draft ----------

type Codes = Partial<Record<CampaignField, string>>;

/** The engine's states in which the letter's text cannot be saved now: the sends give way to S3-P3-l. */
const CANNOT_SAVE: ReadonlySet<string> = new Set(["retry", "invalid", "signedOut", "conflict", "gone"]);

function DraftEditor({
  campaign,
  links,
  testTargets,
  gated,
  audience,
  onNotice,
}: {
  campaign: CampaignEditorView;
  links: string[];
  testTargets: TestTarget[];
  gated: boolean;
  audience: Audience;
  onNotice: (text: string | null) => void;
}) {
  const router = useRouter();
  const uid = useId();
  const L = CAMPAIGN_LIMITS;
  const id = campaign.id;
  const phone = usePhoneChip();
  const nav = useRef(router);
  useEffect(() => {
    nav.current = router;
  });
  /** The route's refusals (400) by field, until the field is typed in again or saved. */
  const [refused, setRefused] = useState<Codes>({});
  /** The sends' refusals (R-g: the subject and the text required, the button whole) by field, until the field is typed in again. */
  const [press, setPress] = useState<Codes>({});

  const save = useMemo<SendPatch>(() => {
    const base = patchSender(`/api/admin/kiri/${id}`);
    return async (body, opts) => {
      const answer = await base(body, opts);
      const reply = answer && isRecord(answer.body) ? answer.body : null;
      if (answer?.status === 200 && reply?.ok === true) {
        setRefused((r) => without(r, Object.keys(body.patch)));
        // stored (its version moved): the list's row (its name, its time) and the count are the page's to say
        if (reply.version !== body.version) startTransition(() => nav.current.refresh());
      } else if (answer?.status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
        const fields = reply.fields;
        const codes: Codes = {};
        for (const f of CAMPAIGN_FIELDS) if (typeof fields[f] === "string" && f in body.patch) codes[f] = fields[f] as string;
        setRefused((r) => ({ ...r, ...codes }));
      } else if (answer?.status === 409) {
        // another tab's save, or a send that began: the page's read says which (a sent letter is shown read-only)
        startTransition(() => nav.current.refresh());
      }
      return answer;
    };
  }, [id]);
  const validate = useCallback((f: Fields): Record<string, string> => campaignSaveCheck(f).codes as Record<string, string>, []);
  const label = useCallback((f: string) => LABELS[f as CampaignField] ?? f, []);
  const focusField = useCallback((name: string) => fieldElement(name)?.focus(), []);
  const auto = useAutosave({ owner: OWNER, key: String(id), version: campaign.version, fields: { ...campaign.values }, save, validate, label, focusField });
  const { flush, unconfirmed, discardCopy } = auto;
  const values = auto.fields as CampaignValues;

  // „Uus kiri +“ made this draft: the cursor in „Nimi“ (S3-P3-h), its text chosen so that typing replaces „Uus kiri“
  useEffect(() => {
    if (focusNameOf !== id) return;
    focusNameOf = null;
    const name = fieldElement("name");
    if (name instanceof HTMLInputElement) {
      name.focus();
      name.select();
    }
  }, [id]);
  // another letter opened, or the list (the same page: the leave guard lets it go): what waits is saved now, not left to the copy
  useEffect(() => () => void flush(), [flush]);

  const set = (name: CampaignField, value: unknown) => {
    setPress((p) => without(p, [name]));
    setRefused((r) => without(r, [name]));
    auto.setField(name, value);
  };
  const held = auto.status.kind === "invalid";
  const local = campaignSaveCheck(values).codes;
  const codeOf = (f: CampaignField): string | undefined => press[f] ?? (held ? (local[f] ?? refused[f]) : undefined);
  const err = (f: CampaignField) => fieldError(codeOf(f));
  const showInvalid = () => {
    const first = CAMPAIGN_FIELDS.find((f) => codeOf(f) !== undefined);
    if (first) fieldElement(first)?.focus();
  };

  /** The sends' rules over the fields as they stand (the same pure rule as the server's): the refused fields marked, the first one focused. */
  const sendable = (): boolean => {
    const checked = checkCampaignDraft(values);
    if (checked.ok) return true;
    mark(checked.fields);
    return false;
  };
  const mark = (fields: Record<string, string>) => {
    const codes = campaignFieldCodes(fields);
    setPress(codes);
    const first = CAMPAIGN_FIELDS.find((f) => codes[f] !== undefined);
    // (after the render that marks it)
    if (first) setTimeout(() => fieldElement(first)?.focus(), 0);
  };

  const cannot = CANNOT_SAVE.has(auto.status.kind);
  const reason = cannot ? adminEt.leave.reasons[unconfirmed()?.reason ?? "error"] : "";

  const [pane, setPane] = useState<"edit" | "preview">("edit");

  const counter = (key: string, value: string, max: number) => (
    <p className={`${ui.hint} ${styles.count}`} data-campaign-count={key}>
      {fill(t.count, { n: value.length, max })}
    </p>
  );
  const counterBoth = (key: string, value: { et: string; ru: string }, max: number) => (
    <p className={`${ui.hint} ${styles.count}`} data-campaign-count={key}>
      {fill(t.countI18n, { et: value.et.length, ru: value.ru.length, max })}
    </p>
  );

  return (
    <div className={styles.editor} data-campaign-form={id} data-pane={pane}>
      <Link className={styles.back} href={LIST_HREF} data-campaign-back="">
        {t.back}
      </Link>
      {/* (a field left saves at once, README §1.3) */}
      <section className={`${ui.card} ${styles.formCard}`} aria-labelledby={`${uid}-form`} onBlur={() => void flush()}>
        <div className={styles.formHead}>
          <h2 id={`${uid}-form`} className={styles.formTitle} data-campaign-title="">
            {values.name.trim() || t.newTitle}
          </h2>
          <SaveStatus status={auto.status} compact={phone} thing={t.thing} onShowInvalid={showInvalid} />
        </div>
        <div className={styles.panes} role="group" aria-labelledby={`${uid}-form`} data-campaign-panes="">
          {(["edit", "preview"] as const).map((p) => (
            <button key={p} type="button" className={styles.pane} aria-pressed={pane === p} onClick={() => setPane(p)} data-pane={p}>
              {t.panes[p]}
            </button>
          ))}
        </div>
        <div className={site.fields} data-pane-part="edit">
          <div>
            <TextField label={t.name} value={values.name} onChange={(name) => set("name", name)} maxLength={L.name} hint={t.nameHint} error={err("name")} name="name" />
            {counter("name", values.name, L.name)}
          </div>
          <div>
            <I18nInput label={t.subject} value={values.subject} onChange={(v) => set("subject", both(v))} maxLength={L.subject} error={err("subject")} name="subject" />
            {counterBoth("subject", values.subject, L.subject)}
          </div>
          <div>
            <I18nInput label={t.preheader} value={values.preheader} onChange={(v) => set("preheader", both(v))} maxLength={L.preheader} hint={t.preheaderHint} error={err("preheader")} name="preheader" />
            {counterBoth("preheader", values.preheader, L.preheader)}
          </div>
          <div className={styles.picture}>
            <SingleImage label={t.image} value={values.imageKey} onChange={(imageKey) => set("imageKey", imageKey)} hint={t.imageHint} error={err("imageKey")} removable ratio="4 / 5" name="campaign-image" />
          </div>
          <div>
            <I18nInput label={t.body} value={values.body} onChange={(v) => set("body", both(v))} multiline rows={8} maxLength={L.body} hint={t.bodyHint} error={err("body")} name="body" />
            {counterBoth("body", values.body, L.body)}
          </div>
          <div className={styles.trio}>
            <TextField label={t.code} value={values.code} onChange={(code) => set("code", code)} maxLength={WELCOME_CODE_MAX} hint={t.codeHint} error={err("code")} name="code" />
            <div>
              <I18nInput label={t.buttonLabel} value={values.buttonLabel} onChange={(v) => set("buttonLabel", both(v))} maxLength={L.buttonLabel} error={err("buttonLabel")} name="buttonLabel" />
              {counterBoth("buttonLabel", values.buttonLabel, L.buttonLabel)}
            </div>
            <TextField
              label={t.buttonHref}
              value={values.buttonHref}
              onChange={(buttonHref) => set("buttonHref", buttonHref)}
              maxLength={L.href}
              hint={t.buttonHrefHint}
              error={err("buttonHref")}
              inputMode="url"
              suggestions={links}
              name="buttonHref"
            />
          </div>
          {auto.conflict && (
            <p className={styles.restore}>
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void auto.restore()} data-campaign-restore="">
                {adminEt.courseEditor.restore}
              </button>
            </p>
          )}
          <DeleteDraft
            id={id}
            name={values.name.trim() || t.newTitle}
            onGone={(line) => {
              discardCopy();
              // (gone already, or sent meanwhile: the action has read the page again — it shows the letter's state, or that it is not there)
              if (line === null) {
                deleted.set(id);
                router.replace(LIST_HREF);
              } else onNotice(line);
            }}
            onSent={() => onNotice(t.errorsOf.sent)}
          />
        </div>
      </section>

      <div className={styles.aside}>
        <div data-pane-part="preview">
          <PreviewCard values={values} />
        </div>
        <Sends
          id={id}
          name={values.name.trim() || t.newTitle}
          revision={JSON.stringify(values)}
          flush={flush}
          sendable={sendable}
          mark={mark}
          blocked={cannot ? reason : null}
          testTargets={testTargets}
          gated={gated}
          audience={audience}
        />
      </div>
    </div>
  );
}

/**
 * „Kustuta mustand“ (B17, S3-P3-f): a danger button under the fields; its ConfirmPanel in its place („Kas kustutan mustandi „{nimi}“?“ · „Seda ei saa
 * tagasi võtta.“ · „Jah, kustuta“ / „Katkesta“). Deleted: `onGone(null)` (the list says „Mustand kustutatud.“); sent meanwhile in another tab: `onSent`
 * („See kiri on juba saadetud.“); gone already: `onGone` with its line. Any other refusal is said under the button, which takes the focus back.
 */
function DeleteDraft({ id, name, onGone, onSent }: { id: number; name: string; onGone: (line: string | null) => void; onSent: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [asking]);
  const close = () => {
    refocus.current = true;
    setAsking(false);
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    const r = await deleteDraftAction({ id }).catch(() => LOST);
    if (r.ok) return onGone(null); // (the panel stays busy until the page has moved to the list)
    setBusy(false);
    close();
    if (r.error === "sent") return onSent();
    if (r.error === "notFound") return onGone(t.errorsOf.notFound);
    setLine(refusal(r.error));
  };
  return (
    <div className={styles.deletePart} data-campaign-delete-part="">
      {asking ? (
        <ConfirmPanel question={fill(t.remove.question, { name })} lines={[t.remove.line]} yesLabel={t.remove.yes} tone="danger" busy={busy} onYes={() => void remove()} onCancel={close} />
      ) : (
        <button
          ref={trigger}
          type="button"
          className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`}
          onClick={() => {
            setLine("");
            setAsking(true);
          }}
          data-campaign-delete=""
        >
          {t.remove.button}
        </button>
      )}
      <p role="status" className={`${styles.status} ${ui.error}`} data-campaign-delete-status="">
        {line}
      </p>
    </div>
  );
}

// ---------- the sends of a draft ----------

/** What the ConfirmPanel was given (prepareSendAction): the counts by language, the samples left out, the Russian fall-back, the letter's version. */
type Plan = { et: number; ru: number; samples: number; ruFallsBack: boolean; updatedAt: string };

/** The ConfirmPanel's lines (P-13): the counts (one language: its part only), the sample line, the day's room above CAMPAIGN_DAILY_ROOM, what cannot be undone. */
function panelLines(plan: Plan): string[] {
  const n = plan.et + plan.ru;
  const a = t.all;
  const counts = plan.et > 0 && plan.ru > 0 ? fill(a.counts, { n, a: plan.et, b: plan.ru }) : plan.ru === 0 ? fill(a.countsEt, { n, a: plan.et }) : fill(a.countsRu, { n, b: plan.ru });
  return [counts, ...(plan.samples > 0 ? [a.samples] : []), ...(n > CAMPAIGN_DAILY_ROOM ? [a.room] : []), a.final];
}

/** The hint under the buttons (drawn): „3 eesti, 1 vene keeles · näidisaadressidele ei saadeta“, a zero part and the sample part left out when empty. */
function hintOf(a: Audience): string {
  const h = t.all.hint;
  const counts = a.et > 0 && a.ru > 0 ? fill(h.both, { a: a.et, b: a.ru }) : a.ru === 0 ? fill(h.et, { a: a.et }) : fill(h.ru, { b: a.ru });
  return [counts, ...(a.samples > 0 ? [h.samples] : [])].join(" · ");
}

/**
 * The sends (README B5, the Part 3 frame): the select „{address} · {eesti|vene keeles}“ (Maria's address or the signed-in admin's, each in both languages),
 * „Saada proov“, „Saada kõigile ({n})“ (n: `audience`, the page's read, B9; at 0 the existing „Kinnitatud tellijaid pole …“ in its place), and the hint.
 * Both sends flush the editor first (`flush`): what goes out is the stored letter, so it must be the screen's; then the sends' rules (`sendable`, the
 * server's too). While the text cannot be saved (`blocked`: the reason) the two buttons give way to S3-P3-l. `gated`: the gate is on (the notice under
 * the panel and the test's result); the section says so in `data-gated`. On a phone the two buttons stand at the foot of the screen (the stylesheet).
 */
function Sends({
  id,
  name,
  revision,
  flush,
  sendable,
  mark,
  blocked,
  testTargets,
  gated,
  audience,
}: {
  id: number;
  name: string;
  revision: string;
  flush: () => Promise<boolean>;
  sendable: () => boolean;
  mark: (fields: Record<string, string>) => void;
  blocked: string | null;
  testTargets: TestTarget[];
  gated: boolean;
  audience: Audience;
}) {
  const uid = useId();
  const router = useRouter();
  const foot = useFootBar();
  const n = audience.et + audience.ru;
  const [choice, setChoice] = useState(`${testTargets[0]?.key ?? "me"}:et`);
  const [toKey, localeKey] = choice.split(":") as [TestTarget["key"], Lang];
  const target = testTargets.find((x) => x.key === toKey) ?? testTargets[0];
  const locale: Lang = localeKey === "ru" ? "ru" : "et";
  const [testLine, setTestLine] = useState<Line>(IDLE);
  const [testing, setTesting] = useState(false);
  const [line, setLine] = useState<Line>(IDLE);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<{ plan: Plan; revision: string } | null>(null);
  // the text the screen shows now: a press decides on it, and an open panel belongs to it (any change of a field closes it, even if the field comes back)
  const now = useRef(revision);
  useEffect(() => {
    now.current = revision;
  });
  // (and a letter that cannot be saved any more closes it: the buttons give way to S3-P3-l, and the panel must not come back by itself later)
  if (confirm && (confirm.revision !== revision || blocked !== null)) setConfirm(null);
  const shown = confirm && confirm.revision === revision ? confirm : null;
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const asking = shown !== null;
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [asking]);

  const test = async () => {
    if (testing || !target || blocked) return;
    const pressed = now.current;
    setTesting(true);
    setTestLine({ tone: "busy", text: t.test.working });
    try {
      // the letter as the screen shows it is stored first; one that cannot be saved is S3-P3-l (the buttons give way)
      if (!(await flush()) || now.current !== pressed) return setTestLine(IDLE);
      if (!sendable()) return setTestLine({ tone: "error", text: adminEt.editor.invalid });
      const r = await sendTestAction({ id, to: target.key, locale }).catch(() => LOST);
      if (r.ok) setTestLine({ tone: "done", text: fill(t.test.sent, { email: target.address }) });
      else if ("fields" in r) {
        mark(r.fields);
        setTestLine({ tone: "error", text: adminEt.editor.invalid });
      } else setTestLine({ tone: "error", text: refusal(r.error) });
    } finally {
      setTesting(false);
    }
  };

  const prepare = async () => {
    if (sending || blocked || n === 0) return;
    const pressed = now.current;
    setConfirm(null);
    setSending(true);
    setLine({ tone: "busy", text: t.all.checking });
    try {
      if (!(await flush()) || now.current !== pressed) return setLine(IDLE);
      if (!sendable()) return setLine({ tone: "error", text: adminEt.editor.invalid });
      const r = await prepareSendAction({ id }).catch(() => LOST);
      if (!r.ok) {
        if ("fields" in r) {
          mark(r.fields);
          return setLine({ tone: "error", text: adminEt.editor.invalid });
        }
        return setLine({ tone: "error", text: refusal(r.error) });
      }
      // R-h: the panel's count is read under the press's lock; one that moved since the button's is the existing `changed` answer
      if (r.et + r.ru !== n) {
        setLine({ tone: "error", text: t.errorsOf.changed });
        startTransition(() => router.refresh());
        return;
      }
      // typed while the count was read: the panel would be for a text the server does not hold yet
      if (now.current !== pressed) return setLine(IDLE);
      setConfirm({ plan: { et: r.et, ru: r.ru, samples: r.samples, ruFallsBack: r.ruFallsBack, updatedAt: r.updatedAt }, revision: pressed });
      setLine(IDLE);
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (!shown || sending) return;
    const { plan } = shown;
    setSending(true);
    setLine({ tone: "busy", text: t.all.working });
    const r = (await flush()) ? await startSendAction({ id, et: plan.et, ru: plan.ru, updatedAt: plan.updatedAt }).catch(() => LOST) : null;
    setSending(false);
    refocus.current = true;
    setConfirm(null);
    if (r === null) return setLine(IDLE);
    if (!r.ok) {
      if ("fields" in r) {
        mark(r.fields);
        return setLine({ tone: "error", text: adminEt.editor.invalid });
      }
      return setLine({ tone: "error", text: refusal(r.error) });
    }
    if (r.stopped === "refused") return setLine({ tone: "error", text: t.errorsOf.refused });
    setLine({ tone: "done", text: r.progress.waiting > 0 ? progressText(r.progress) : t.all.done });
  };

  const emailName = (target?.address ?? "").split("@")[0];
  return (
    <section className={`${ui.card} ${styles.sends}`} aria-labelledby={`${uid}-send`} data-campaign-send="" data-gated={gated ? "" : undefined}>
      <h2 id={`${uid}-send`} className={`${ui.h3} ${styles.cardTitle}`}>
        {t.send}
      </h2>
      {testTargets.length > 0 && (
        <div className={styles.target}>
          <label className={ui.sr} htmlFor={`${uid}-target`}>
            {t.test.to}
          </label>
          <select id={`${uid}-target`} className={styles.select} value={choice} onChange={(e) => setChoice(e.target.value)} data-test-target="">
            {testTargets.flatMap((x) =>
              LOCALES.map((l) => (
                <option key={`${x.key}:${l}`} value={`${x.key}:${l}`}>
                  {fill(t.test.option, { email: x.address, lang: t.test.optionLang[l] })}
                </option>
              )),
            )}
          </select>
        </div>
      )}
      <div ref={foot} className={styles.sendButtons} data-send-buttons="" data-fab-avoid="">
        {blocked !== null ? (
          <p className={`${ui.notice} ${styles.blocked}`} data-send-blocked="">
            {t.blocked} {blocked}
          </p>
        ) : (
          <>
            {target && (
              <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.sendButton}`} aria-disabled={testing || undefined} onClick={() => void test()} data-test-send="">
                <span className={styles.wide} data-label-wide="">
                  {testing ? t.test.working : t.test.button}
                </span>
                <span className={styles.phone} data-label-phone="">
                  {fill(t.test.phoneButton, { email: fill(t.test.phoneEmail, { name: emailName }), lang: adminEt.common.locale[locale] })}
                </span>
              </button>
            )}
            {shown ? (
              <div className={styles.confirm} data-send-confirm="">
                <ConfirmPanel
                  question={fill(t.all.question, { name })}
                  lines={panelLines(shown.plan)}
                  yesLabel={sending ? t.all.working : fill(t.all.yes, { n: shown.plan.et + shown.plan.ru })}
                  tone="send"
                  busy={sending}
                  onYes={() => void send()}
                  onCancel={() => {
                    refocus.current = true;
                    setConfirm(null);
                  }}
                />
                {shown.plan.ruFallsBack && shown.plan.ru > 0 && (
                  <p className={ui.notice} data-send-fallback="">
                    {t.all.fallback}
                  </p>
                )}
                {gated && <GateNotice />}
              </div>
            ) : n > 0 ? (
              <button ref={trigger} type="button" className={`${ui.btn} ${styles.sendButton}`} aria-disabled={sending || undefined} onClick={() => void prepare()} data-send-all="">
                {fill(t.all.button, { n })}
              </button>
            ) : (
              <p className={ui.hint} data-send-empty="">
                {t.errorsOf.empty}
              </p>
            )}
          </>
        )}
      </div>
      {n > 0 && (
        <p className={`${ui.small} ${ui.muted} ${styles.hint}`} data-send-hint="">
          {hintOf(audience)}
        </p>
      )}
      <p role="status" className={`${styles.status} ${toneClass(testLine.tone)}`} data-test-status="">
        {testLine.text}
      </p>
      {gated && testLine.tone === "done" && <GateNotice />}
      <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-send-status="">
        {line.text}
      </p>
    </section>
  );
}

/**
 * While the coming-soon gate is on, the links and the button of the mail open the „Tulekul“ page (final review I1, ruling R9): one line under the
 * panel of „Saada kõigile“ and under the result of „Saada proov“. A notice, not a block: a „we open soon“ letter is a legitimate one.
 */
function GateNotice() {
  return (
    <p className={ui.notice} data-gate-notice="">
      {t.gateNotice}
    </p>
  );
}

// ---------- a letter that is no draft ----------

/** The lines of a letter's counts that are worth a line only when they are not 0: the addresses that failed, the mails with no answer. */
function CountLines({ progress }: { progress: Progress | null }) {
  if (!progress || (progress.failed === 0 && progress.unknown === 0)) return null;
  return (
    <div className={styles.lines}>
      {progress.failed > 0 && (
        <p className={ui.notice} data-campaign-failed="">
          {fill(t.failedLine, { n: progress.failed })}
        </p>
      )}
      {progress.unknown > 0 && (
        <p className={ui.notice} data-campaign-unknown="">
          {fill(t.unknownLine, { n: progress.unknown })}
        </p>
      )}
    </div>
  );
}

/**
 * „Peata saatmine“ (spec §3; P-13): its ConfirmPanel in the button's place („Kas peatan saatmise?“ · „Veel saatmata {n} kirja ei lähe välja.“ · „Seda ei
 * saa tagasi võtta.“ · „Jah, peata“ / „Katkesta“), then the stop: what waits is skipped and the letter is sent with its counts (stopSendAction, which
 * refreshes the page: the card then shows the sent letter).
 */
function StopSend({ id, waiting }: { id: number; waiting: number }) {
  const [confirming, setConfirming] = useState(false);
  const [line, setLine] = useState<Line>(IDLE);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [confirming]);
  const close = () => {
    refocus.current = true;
    setConfirming(false);
  };

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    setLine({ tone: "busy", text: t.stop.working });
    const r = await stopSendAction({ id }).catch(() => LOST);
    setBusy(false);
    close();
    if (r.ok) setLine({ tone: "done", text: t.stop.done });
    else setLine({ tone: "error", text: refusal(r.error) });
  };

  return (
    <div className={styles.sendPart} data-campaign-stop-part="">
      <div data-stop-confirm="">
        {confirming ? (
          <ConfirmPanel
            question={t.stop.question}
            lines={[fill(t.stop.left, { n: waiting }), t.stop.final]}
            yesLabel={busy ? t.stop.working : t.stop.yes}
            tone="danger"
            busy={busy}
            onYes={() => void stop()}
            onCancel={close}
          />
        ) : (
          <div className={styles.sendRow}>
            <button ref={trigger} type="button" className={`${ui.btn} ${ui.danger}`} onClick={() => setConfirming(true)} data-campaign-stop="">
              {t.stop.button}
            </button>
          </div>
        )}
      </div>
      <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-stop-status="">
        {line.text}
      </p>
    </div>
  );
}

/**
 * A letter sent or going out: read-only (a sent letter never changes). Going out (`sending`): the progress line, the failed and unknown counts when
 * they are not 0, the line of a batch Resend refused, and „Peata saatmine“. Sent: the sent line and the same counts. Both: the preview (in the page's
 * language) and „Kopeeri“, which makes a new draft of it.
 */
function SentCampaign({ campaign }: { campaign: CampaignEditorView }) {
  const router = useRouter();
  const uid = useId();
  const [line, setLine] = useState<Line>(IDLE);
  const [busy, setBusy] = useState(false);
  const going = campaign.status === "sending";

  const copy = async () => {
    if (busy) return;
    setBusy(true);
    setLine({ tone: "busy", text: t.copying });
    const r = await copyCampaignAction({ id: campaign.id }).catch(() => LOST);
    setBusy(false);
    if (r.ok) {
      setLine(IDLE);
      router.push(letterHref(r.id));
    } else setLine({ tone: "error", text: refusal(r.error) });
  };

  return (
    <div className={styles.editor} data-campaign-letter={campaign.id}>
      <Link className={styles.back} href={LIST_HREF} data-campaign-back="">
        {t.back}
      </Link>
      <section className={`${ui.card} ${styles.formCard}`} aria-labelledby={`${uid}-sent`} data-campaign-sent={campaign.status}>
        <h2 id={`${uid}-sent`} className={styles.formTitle}>
          {campaign.values.name}
        </h2>
        {going && campaign.progress && (
          <p className={`${ui.hint} ${styles.progress}`} data-campaign-progress="">
            {progressText(campaign.progress)}
          </p>
        )}
        {going && campaign.refused && (
          <p className={ui.error} data-campaign-refused="">
            {t.errorsOf.refused}
          </p>
        )}
        {campaign.status === "sent" && campaign.sentAt && campaign.recipients && (
          <p className={ui.success} data-campaign-sent-line="">
            {fill(t.sentLine, { date: stamp(campaign.sentAt), n: campaign.recipients.et + campaign.recipients.ru })}
          </p>
        )}
        <CountLines progress={campaign.progress} />
        <p className={`${ui.hint} ${styles.readOnly}`} data-campaign-read-only="">
          {going ? t.readOnlySending : t.readOnly}
        </p>
        {going && <StopSend key={campaign.id} id={campaign.id} waiting={campaign.progress?.waiting ?? 0} />}
        <div className={styles.sendRow}>
          <button type="button" className={`${ui.btn} ${ui.secondary}`} aria-disabled={busy || undefined} onClick={() => void copy()} data-campaign-copy="">
            {busy ? t.copying : t.copy}
          </button>
        </div>
        <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-campaign-copy-status="">
          {line.text}
        </p>
      </section>
      <div className={styles.aside}>
        <PreviewCard values={campaign.values} />
      </div>
    </div>
  );
}
