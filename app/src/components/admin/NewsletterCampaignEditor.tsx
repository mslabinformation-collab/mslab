"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type FormEvent, type SyntheticEvent } from "react";
import { CAMPAIGN_LIMITS, checkCampaignDraft } from "@/domain/newsletter-campaign";
import { WELCOME_CODE_MAX } from "@/domain/welcome-code";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate, formatTime } from "@/i18n/format";
import { toStorable } from "@/lib/to-storable";
import { copyCampaignAction, prepareSendAction, saveCampaignAction, sendCampaignAction, sendTestAction } from "@/server/actions/admin-newsletter";
import type { SendPlan } from "@/server/newsletter-campaigns";
import { Choice } from "./Choice";
import { I18nInput, LangSwitch, type Lang } from "./I18nInput";
import { SaveBar } from "./SaveBar";
import { SingleImage } from "./SingleImage";
import { TextField } from "./TextField";
import type { SaveStatus } from "./useSiteDraft";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import ui from "./ui.module.css";
import styles from "./CampaignsPanel.module.css";

// Maria's campaign editor on the „Kampaaniad“ tab (newsletter campaigns, Task 4; spec D4–D6, §5; rulings R2, R4, R5, R7). A draft: the fields (the
// name, the subject, the preview line, the picture, the text in paragraphs, the code, the button), each with its limit and a counter, „Salvesta“,
// the live preview of the real mail in both languages, and the sends: „Saada proov“ (Maria's address or the signed-in admin's, either language)
// and „Saada kõigile“ (the sync first, then the spec's confirmation with the counts, then „Saada“). A sent campaign (or one whose send stopped
// half way) is read-only: „Saadetud {date} · {n} tellijale“, a link to each broadcast in Resend's dashboard, the preview, and „Kopeeri“. Without the
// newsletter's key the editor and the preview work as ever, and the two sends say that sending is not set up. The rules are domain/newsletter-
// campaign.ts checkCampaignDraft, run here before anything is sent (the server checks them again); text pasted from Word can carry control
// characters, which become spaces or line breaks first (`cleanPasted`). This file runs on old iPads: no regular expression with a lookbehind, here
// or in anything it imports (tests/unit/old-safari.test.ts).

type Both = { et: string; ru: string };
/** The editor's fields as the form holds them: every text a string ("" for none), the picture's key "" for none. */
export type CampaignValues = { name: string; subject: Both; preheader: Both; imageKey: string; body: Both; code: string; buttonLabel: Both; buttonHref: string };
/** A stored campaign as the editor shows it (components/admin/CampaignsPanel.tsx campaignEditorView builds it). */
export type CampaignEditorView = {
  id: number;
  status: "draft" | "sending" | "sent";
  values: CampaignValues;
  /** ISO time of the send; null until sent. */
  sentAt: string | null;
  /** The subscribers in Resend the send was for, per language; null while a draft. */
  recipients: { et: number; ru: number } | null;
  /** The broadcasts that went, per language. */
  broadcasts: { et?: string; ru?: string } | null;
};
/** An address „Saada proov“ may go to: MARIA_EMAIL's (`maria`) or the signed-in admin's (`me`); `subscriber`: a subscriber's address (ruling R7). */
export type TestTarget = { key: "maria" | "me"; address: string; subscriber: boolean };

export const EMPTY_CAMPAIGN: CampaignValues = {
  name: "",
  subject: { et: "", ru: "" },
  preheader: { et: "", ru: "" },
  imageKey: "",
  body: { et: "", ru: "" },
  code: "",
  buttonLabel: { et: "", ru: "" },
  buttonHref: "",
};

const PREVIEW_URL = "/api/admin/kampaania-eelvaade";
/** The pause after the last key before the preview is asked again (ms). */
const PREVIEW_PAUSE_MS = 300;
const RESEND_BROADCAST = "https://resend.com/broadcasts/";
const LOCALES: readonly Lang[] = ["et", "ru"];
const campaignHref = (id: number) => `/admin/uudiskiri?vaade=kampaaniad&kampaania=${id}`;

/**
 * A text as it is sent: a carriage return (alone or before a line feed) is a line break; every other control character but the line feed is a
 * space, except Word's line break (vertical tab) and page break (form feed), which are line breaks (lib/to-storable.ts). The rules trim.
 */
const cleanPasted = (raw: string): string => toStorable(raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u0009\u000e-\u001f\u007f]/g, " "));
const cleanBoth = (v: Both): Both => ({ et: cleanPasted(v.et), ru: cleanPasted(v.ru) });
const cleanValues = (v: CampaignValues): CampaignValues => ({
  name: cleanPasted(v.name),
  subject: cleanBoth(v.subject),
  preheader: cleanBoth(v.preheader),
  imageKey: v.imageKey,
  body: cleanBoth(v.body),
  code: cleanPasted(v.code),
  buttonLabel: cleanBoth(v.buttonLabel),
  buttonHref: cleanPasted(v.buttonHref),
});
const both = (v: I18n): Both => ({ et: v.et, ru: v.ru ?? "" });
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

const t = adminEt.newsletter.campaigns;
/** An action's refusal in words (an unknown code: the general one). */
const refusal = (code: string): string => (t.errorsOf as Record<string, string>)[code] ?? t.errorsOf.server;
/** A field's refusal in words (domain/newsletter-campaign.ts checkCampaignDraft's codes). */
const fieldError = (code: string | undefined): string | undefined =>
  code === undefined ? undefined : code === "ruLabel" ? adminEt.newsletter.campaignErrors.ruLabel : ((t.errors as Record<string, string>)[code] ?? t.errors.invalid);

export function NewsletterCampaignEditor({
  campaign,
  configured,
  testTargets,
  links,
}: {
  /** The campaign, or null for „Uus kampaania“ (saved, it opens at its own address). */
  campaign: CampaignEditorView | null;
  /** Is the newsletter's Resend side set up (a marketing key)? Without it the sends say so and send nothing. */
  configured: boolean;
  testTargets: TestTarget[];
  /** The site's pages for the button's address (server/site-links.ts). */
  links: string[];
}) {
  const readOnly = campaign !== null && campaign.status !== "draft";
  return readOnly ? <SentCampaign campaign={campaign} /> : <DraftEditor campaign={campaign} configured={configured} testTargets={testTargets} links={links} />;
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

/** The preview card: the language switch, the subject, and the mail in a sandboxed frame (no script runs in it, nothing in it can be pressed). */
function PreviewCard({ values }: { values: CampaignValues }) {
  const uid = useId();
  const [lang, setLang] = useState<Lang>("et");
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
      <div className={site.previewHead}>
        <h2 id={`${uid}-preview`} className={ui.h3}>
          {t.preview}
        </h2>
        <LangSwitch lang={lang} onChange={setLang} label={t.preview} missingRu={false} />
      </div>
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

function DraftEditor({ campaign, configured, testTargets, links }: { campaign: CampaignEditorView | null; configured: boolean; testTargets: TestTarget[]; links: string[] }) {
  const router = useRouter();
  const uid = useId();
  const L = CAMPAIGN_LIMITS;
  const [id, setId] = useState<number | null>(campaign?.id ?? null);
  const [values, setValues] = useState<CampaignValues>(campaign?.values ?? EMPTY_CAMPAIGN);
  const [saved, setSaved] = useState<CampaignValues>(campaign?.values ?? EMPTY_CAMPAIGN);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saveLine, setSaveLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  // Another campaign chosen (the list's links, „Uus kampaania“): its fields (adjusting state while rendering). Not when the page comes back with the
  // new campaign this editor has just saved: its fields and its „Salvestatud.“ stay.
  const shownId = campaign?.id ?? null;
  const [seenId, setSeenId] = useState(shownId);
  if (shownId !== seenId) {
    setSeenId(shownId);
    if (shownId !== id) {
      setId(shownId);
      setValues(campaign?.values ?? EMPTY_CAMPAIGN);
      setSaved(campaign?.values ?? EMPTY_CAMPAIGN);
      setFields({});
      setSaveLine(IDLE);
    }
  }

  // unsaved changes: leaving the page asks first (as the site editors do, useSiteDraft)
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = (patch: Partial<CampaignValues>) => {
    setValues((v) => ({ ...v, ...patch }));
    setSaveLine(IDLE);
    // typing in a refused field takes its mark away
    const keys = Object.keys(patch);
    setFields((f) => {
      const left = Object.entries(f).filter(([k]) => !keys.some((key) => k === key || k.startsWith(`${key}.`)));
      return left.length === Object.keys(f).length ? f : Object.fromEntries(left);
    });
  };
  const err = (key: string) => fieldError(fields[key] ?? fields[`${key}.et`] ?? fields[`${key}.ru`]);

  // a refused field: the first marked one takes the focus
  useEffect(() => {
    if (Object.keys(fields).length > 0) document.querySelector<HTMLElement>('[data-campaign-form] [aria-invalid="true"], [data-campaign-form] [data-invalid]')?.focus();
  }, [fields]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const cleaned = cleanValues(values);
    setValues(cleaned);
    const checked = checkCampaignDraft(cleaned);
    if (!checked.ok) {
      setFields(checked.fields);
      setSaveLine({ tone: "error", text: adminEt.editor.invalid });
      return;
    }
    setFields({});
    start(async () => {
      // (a lost connection rejects the call: words, not an error page)
      const r = await saveCampaignAction({ id, draft: checked.value }).catch(() => ({ ok: false as const, error: "server" as const }));
      if (r.ok) {
        setSaved(cleaned);
        setSaveLine({ tone: "done", text: adminEt.editor.saved });
        if (id === null) {
          setId(r.id);
          router.replace(campaignHref(r.id));
        }
      } else if ("fields" in r) {
        setFields(r.fields);
        setSaveLine({ tone: "error", text: adminEt.editor.invalid });
      } else setSaveLine({ tone: "error", text: refusal(r.error) });
    });
  };

  const status: SaveStatus = pending
    ? { text: adminEt.editor.saving, tone: "hint", stale: false }
    : saveLine.tone === "error"
      ? { text: saveLine.text, tone: "error", stale: false }
      : dirty
        ? { text: adminEt.editor.dirty, tone: "hint", stale: false }
        : saveLine.tone === "done"
          ? { text: saveLine.text, tone: "success", stale: false }
          : { text: "", tone: "hint", stale: false };

  const counter = (key: string, value: string, max: number) => (
    <p className={`${ui.hint} ${styles.count}`} data-campaign-count={key}>
      {fill(t.count, { n: value.length, max })}
    </p>
  );
  const counterBoth = (key: string, value: Both, max: number) => (
    <p className={`${ui.hint} ${styles.count}`} data-campaign-count={key}>
      {fill(t.countI18n, { et: value.et.length, ru: value.ru.length, max })}
    </p>
  );

  return (
    <form className={styles.editor} onSubmit={submit} noValidate data-campaign-form={id ?? "new"}>
      <div className={site.cols}>
        <section className={ui.card} aria-labelledby={`${uid}-form`}>
          <h2 id={`${uid}-form`} className={`${ui.h3} ${styles.formTitle}`}>
            {id === null ? t.newTitle : t.form}
          </h2>
          <div className={site.fields}>
            <div>
              <TextField label={t.name} value={values.name} onChange={(name) => set({ name })} maxLength={L.name} hint={t.nameHint} error={err("name")} name="name" />
              {counter("name", values.name, L.name)}
            </div>
            <div>
              <I18nInput label={t.subject} value={values.subject} onChange={(v) => set({ subject: both(v) })} maxLength={L.subject} error={err("subject")} name="subject" />
              {counterBoth("subject", values.subject, L.subject)}
            </div>
            <div>
              <I18nInput label={t.preheader} value={values.preheader} onChange={(v) => set({ preheader: both(v) })} maxLength={L.preheader} hint={t.preheaderHint} error={err("preheader")} name="preheader" />
              {counterBoth("preheader", values.preheader, L.preheader)}
            </div>
            <div className={styles.picture}>
              <SingleImage label={t.image} value={values.imageKey} onChange={(imageKey) => set({ imageKey })} hint={t.imageHint} error={err("imageKey")} removable ratio="4 / 5" name="campaign-image" />
            </div>
            <div>
              <I18nInput label={t.body} value={values.body} onChange={(v) => set({ body: both(v) })} multiline rows={8} maxLength={L.body} hint={t.bodyHint} error={err("body")} name="body" />
              {counterBoth("body", values.body, L.body)}
            </div>
            <TextField label={t.code} value={values.code} onChange={(code) => set({ code })} maxLength={WELCOME_CODE_MAX} hint={t.codeHint} error={err("code")} name="code" />
            <div className={site.pair}>
              <div>
                <I18nInput label={t.buttonLabel} value={values.buttonLabel} onChange={(v) => set({ buttonLabel: both(v) })} maxLength={L.buttonLabel} error={err("buttonLabel")} name="buttonLabel" />
                {counterBoth("buttonLabel", values.buttonLabel, L.buttonLabel)}
              </div>
              <TextField
                label={t.buttonHref}
                value={values.buttonHref}
                onChange={(buttonHref) => set({ buttonHref })}
                maxLength={L.href}
                hint={t.buttonHrefHint}
                error={err("buttonHref")}
                inputMode="url"
                suggestions={links}
                name="buttonHref"
              />
            </div>
          </div>
        </section>

        <div className={site.aside}>
          <PreviewCard values={values} />
          <Sends key={id ?? "new"} id={id} configured={configured} saved={id !== null && !dirty} testTargets={testTargets} />
        </div>
      </div>
      <SaveBar status={status} pending={pending} reloadHref={id === null ? "/admin/uudiskiri?vaade=kampaaniad" : campaignHref(id)} />
    </form>
  );
}

// ---------- the sends ----------

function Sends({ id, configured, saved, testTargets }: { id: number | null; configured: boolean; saved: boolean; testTargets: TestTarget[] }) {
  const uid = useId();
  const [to, setTo] = useState<TestTarget["key"]>(testTargets[0]?.key ?? "me");
  const [locale, setLocale] = useState<Lang>("et");
  const [testLine, setTestLine] = useState<Line>(IDLE);
  const [sendLine, setSendLine] = useState<Line>(IDLE);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [testing, startTest] = useTransition();
  const [sending, startSend] = useTransition();
  const target = testTargets.find((x) => x.key === to) ?? testTargets[0];
  const open = configured && saved && id !== null;

  const test = () => {
    if (id === null || !open || testing || !target) return;
    setTestLine({ tone: "busy", text: t.test.working });
    startTest(async () => {
      const r = await sendTestAction({ id, to: target.key, locale }).catch(() => ({ ok: false as const, error: "server" as const }));
      if (r.ok) setTestLine({ tone: "done", text: [fill(t.test.sent, { email: target.address }), r.realLink ? t.test.realLink : ""].filter(Boolean).join(" ") });
      else setTestLine({ tone: "error", text: refusal(r.error) });
    });
  };

  const prepare = () => {
    if (id === null || !open || sending) return;
    setPlan(null);
    setSendLine({ tone: "busy", text: t.all.checking });
    startSend(async () => {
      const r = await prepareSendAction({ id }).catch(() => ({ ok: false as const, error: "server" as const }));
      if (r.ok) {
        setPlan(r.plan);
        setSendLine(IDLE);
      } else setSendLine({ tone: "error", text: refusal(r.error) });
    });
  };

  const send = () => {
    if (id === null || !open || sending || !plan) return;
    setSendLine({ tone: "busy", text: t.all.working });
    startSend(async () => {
      const r = await sendCampaignAction({ id }).catch(() => ({ ok: false as const, error: "server" as const }));
      setPlan(null);
      if (!r.ok) return setSendLine({ tone: "error", text: refusal(r.error) });
      const lines = r.missing.length > 0 ? r.missing.map((l) => t.missing[l]) : [t.all.done];
      if (r.left > 0) lines.push(fill(t.all.left, { n: r.left }));
      setSendLine({ tone: r.missing.length > 0 ? "error" : "done", text: lines.join(" ") });
    });
  };

  return (
    <section className={ui.card} aria-labelledby={`${uid}-send`} data-campaign-send="">
      <h2 id={`${uid}-send`} className={ui.h3}>
        {t.send}
      </h2>
      {!configured && (
        <p className={ui.notice} data-campaign-send-off="">
          {t.off}
        </p>
      )}
      {configured && !(saved && id !== null) && (
        <p className={ui.hint} data-campaign-save-first="">
          {t.saveFirst}
        </p>
      )}

      <div className={styles.sendPart} data-campaign-test="">
        <h3 className={styles.sendTitle}>{t.test.title}</h3>
        <p className={`${ui.muted} ${ui.small}`}>{t.test.lead}</p>
        {configured && testTargets.length > 0 && (
          <fieldset className={ed.fieldset}>
            <legend className={ui.legend}>{t.test.to}</legend>
            <div className={ed.choices}>
              {testTargets.map((x) => (
                <Choice
                  key={x.key}
                  className={ed.choice}
                  type="radio"
                  name={`${uid}-to`}
                  value={x.key}
                  checked={to === x.key}
                  onChange={() => setTo(x.key)}
                  label={fill(x.key === "maria" ? t.test.toMaria : t.test.toMe, { email: x.address })}
                  data-test-to={x.key}
                />
              ))}
            </div>
          </fieldset>
        )}
        {configured && (
          <fieldset className={ed.fieldset}>
            <legend className={ui.legend}>{t.test.language}</legend>
            <div className={ed.choices}>
              {LOCALES.map((l) => (
                <Choice key={l} className={ed.choice} type="radio" name={`${uid}-locale`} value={l} checked={locale === l} onChange={() => setLocale(l)} label={t.test.languages[l]} data-test-locale={l} />
              ))}
            </div>
          </fieldset>
        )}
        {configured && target?.subscriber && (
          <p className={ui.notice} data-test-real-link="">
            {t.test.realLink}
          </p>
        )}
        <div className={styles.sendRow}>
          <button type="button" className={`${ui.btn} ${ui.secondary}`} aria-disabled={!open || testing || !target || undefined} onClick={test} data-test-send="">
            {testing ? t.test.working : t.test.button}
          </button>
        </div>
        <p role="status" className={`${styles.status} ${toneClass(testLine.tone)}`} data-test-status="">
          {testLine.text}
        </p>
      </div>

      <div className={styles.sendPart} data-campaign-all="">
        <h3 className={styles.sendTitle}>{t.all.title}</h3>
        <p className={`${ui.muted} ${ui.small}`}>{t.all.lead}</p>
        {plan ? (
          <div className={styles.confirm} data-send-confirm="">
            <p data-send-confirm-text="">{fill(t.all.confirm, { n: plan.et + plan.ru, a: plan.et, b: plan.ru })}</p>
            {plan.ruFallsBack && plan.ru > 0 && (
              <p className={ui.notice} data-send-fallback="">
                {t.all.fallback}
              </p>
            )}
            {plan.left > 0 && (
              <p className={ui.notice} data-send-left="">
                {fill(t.all.left, { n: plan.left })}
              </p>
            )}
            <div className={styles.sendRow}>
              <button type="button" className={ui.btn} aria-disabled={sending || undefined} onClick={send} data-send-yes="">
                {sending ? t.all.working : t.all.yes}
              </button>
              <button type="button" className={`${ui.btn} ${ui.secondary}`} onClick={() => !sending && setPlan(null)} data-send-no="">
                {t.all.no}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.sendRow}>
            <button type="button" className={ui.btn} aria-disabled={!open || sending || undefined} onClick={prepare} data-send-all="">
              {t.all.button}
            </button>
          </div>
        )}
        <p role="status" className={`${styles.status} ${toneClass(sendLine.tone)}`} data-send-status="">
          {sendLine.text}
        </p>
      </div>
    </section>
  );
}

// ---------- a sent campaign ----------

function SentCampaign({ campaign }: { campaign: CampaignEditorView }) {
  const router = useRouter();
  const uid = useId();
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const went = campaign.broadcasts ?? {};
  const planned = campaign.recipients ?? { et: 0, ru: 0 };
  const reached = LOCALES.reduce((n, l) => n + (went[l] ? planned[l] : 0), 0);
  const missing = LOCALES.filter((l) => planned[l] > 0 && !went[l]);

  const copy = () => {
    if (pending) return;
    setLine({ tone: "busy", text: t.copying });
    start(async () => {
      const r = await copyCampaignAction({ id: campaign.id }).catch(() => ({ ok: false as const, error: "server" as const }));
      if (r.ok) {
        setLine(IDLE);
        router.push(campaignHref(r.id));
      } else setLine({ tone: "error", text: refusal(r.error) });
    });
  };

  return (
    <div className={site.cols}>
      <section className={ui.card} aria-labelledby={`${uid}-sent`} data-campaign-sent={campaign.status}>
        <h2 id={`${uid}-sent`} className={ui.h3}>
          {campaign.values.name}
        </h2>
        {campaign.status === "sent" && campaign.sentAt && (
          <p className={ui.success} data-campaign-sent-line="">
            {fill(t.sentLine, { date: stamp(campaign.sentAt), n: reached })}
          </p>
        )}
        {campaign.status === "sending" && (
          <p className={ui.notice} data-campaign-sending="">
            {t.sending}
          </p>
        )}
        {campaign.status === "sent" &&
          missing.map((l) => (
            <p key={l} className={ui.error} data-campaign-missing={l}>
              {t.missing[l]}
            </p>
          ))}
        {LOCALES.some((l) => went[l]) && (
          <ul className={styles.broadcasts}>
            {LOCALES.filter((l) => went[l]).map((l) => (
              <li key={l}>
                <a className={ui.link} href={`${RESEND_BROADCAST}${encodeURIComponent(went[l]!)}`} target="_blank" rel="noopener noreferrer" data-campaign-broadcast={l}>
                  {fill(t.openInResend, { lang: t.langNames[l] })}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className={`${ui.hint} ${styles.readOnly}`}>{t.readOnly}</p>
        <div className={styles.sendRow}>
          <button type="button" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} onClick={copy} data-campaign-copy="">
            {pending ? t.copying : t.copy}
          </button>
        </div>
        <p role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-campaign-copy-status="">
          {line.text}
        </p>
      </section>
      <div className={site.aside}>
        <PreviewCard values={campaign.values} />
      </div>
    </div>
  );
}
