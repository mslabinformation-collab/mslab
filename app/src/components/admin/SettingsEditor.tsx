"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { AutosaveStatus } from "@/domain/autosave";
import type { LegalKey, LegalState } from "@/domain/legal-text";
import { SITE_LIMITS, type ContactDraft, type NewsletterDraft } from "@/domain/site-editor";
import { WELCOME_CODE_MAX } from "@/domain/welcome-code";
import { adminEt } from "@/i18n/dict/admin";
import type { SettingsValues } from "@/server/admin-site";
import { CertificateSettings, type CertificateSettingsInitial } from "./CertificateSettings";
import { LegalTexts } from "./ContractTexts";
import { combineStatus } from "./course/course-view";
import { usePhoneChip } from "./course/usePhoneChip";
import { LangSwitch } from "./EditLang";
import { FinancingSettings, type FinancingInitial } from "./FinancingSettings";
import { InvoiceSettings, type InvoiceSettingsInitial } from "./InvoiceSettings";
import { SaveStatus } from "./SaveStatus";
import { SectionMap, sectionCard, type SectionEntry } from "./SectionMap";
import { TextField } from "./TextField";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import type { Loaded } from "./useSiteDraft";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import styles from "./SettingsEditor.module.css";

/**
 * The page's sections in the map's order (README B4): the id of each, its card(s) below. The old anchors are aliases at the start of the section
 * that now holds their card („Cards that move“): #arve, #ettemaks and #jarelmaks go to „Maksmine“; #tunnistus and #lepingud are their sections' own.
 */
type SectionId = "kontakt" | "uudiskiri" | "maksmine" | "tunnistus" | "lepingud" | "ligipaas";
const SECTIONS: { id: SectionId; label: keyof typeof adminEt.settings.sections; aliases?: readonly string[] }[] = [
  { id: "kontakt", label: "contact" },
  { id: "uudiskiri", label: "newsletter" },
  { id: "maksmine", label: "payment", aliases: ["arve", "ettemaks", "jarelmaks"] },
  { id: "tunnistus", label: "certificate" },
  { id: "lepingud", label: "legal" },
  { id: "ligipaas", label: "admins" },
];

/** One section: its id (the map's link goes there and the focus with it), the aliases at its start, its cards. */
function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const aliases = SECTIONS.find((s) => s.id === id)?.aliases ?? [];
  return (
    <div id={id} className={`${sectionCard} ${styles.section}`} tabIndex={-1} data-seaded-section="">
      {aliases.map((alias) => (
        <span key={alias} id={alias} className={`${sectionCard} ${styles.alias}`} aria-hidden="true" />
      ))}
      {children}
    </div>
  );
}

/** The same status, as the chip would say it (each change of a field makes a new object of the same state): the page is not drawn again for it. */
const sameStatus = (a: AutosaveStatus | undefined, b: AutosaveStatus): boolean =>
  a !== undefined &&
  a.kind === b.kind &&
  (a.kind !== "saved" || b.kind !== "saved" || (a.at?.getTime() ?? null) === (b.at?.getTime() ?? null)) &&
  (a.kind !== "invalid" || b.kind !== "invalid" || (a.fields.length === b.fields.length && a.fields.every((f, i) => f === b.fields[i])));

/** A field's words for the route's code (server/edit-check.ts FieldError: the site editors' shared words). */
const errorText = (code: string | undefined): string | undefined => (code === undefined ? undefined : ((adminEt.courseEditor.errors as Record<string, string>)[code] ?? adminEt.editor.invalid));

/** Puts the focus on the field of a part (TextField's `data-field`, "<part>.<field>"). */
const focusOf = (part: string) => (name: string) => document.querySelector<HTMLElement>(`[data-field="${part}.${name}"]`)?.focus();

/** „Kontaktandmed“: autosaved on api/admin/seaded/contact (the footer and the contact page; an empty field is not shown). */
function ContactCard({ version, value, onStatus }: { version: string; value: ContactDraft; onStatus: StatusReport }) {
  const t = adminEt.settings;
  const uid = useId();
  const labels: Record<keyof ContactDraft, string> = { email: t.email, phone: t.phone, address: t.address, instagram: t.instagram, facebook: t.facebook };
  const fields = useMemo(() => ({ ...value }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const part = useSeadedPart({ part: "contact", version, fields, label: (f) => labels[f as keyof ContactDraft] ?? f, focusField: focusOf("contact"), onStatus });
  const field = (name: keyof ContactDraft) => ({
    label: labels[name],
    value: String(part.text(name) ?? ""),
    onChange: (v: string) => part.type(name, v),
    error: errorText(part.codeOf(name)),
    name: `contact.${name}`,
  });
  return (
    <section className={ui.card} aria-labelledby={`${uid}-title`} onBlur={() => void part.flush()} data-contact-card="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.contact}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.contactLead}</p>
      <div className={ed.grid}>
        <TextField {...field("email")} type="email" inputMode="email" maxLength={SITE_LIMITS.email} />
        <TextField {...field("phone")} type="tel" inputMode="tel" maxLength={SITE_LIMITS.phone} />
        <TextField {...field("address")} className={ed.wide} maxLength={SITE_LIMITS.address} hint={t.addressHint} />
        <TextField {...field("instagram")} type="url" inputMode="url" maxLength={SITE_LIMITS.url} hint={t.socialHint} placeholder="https://" />
        <TextField {...field("facebook")} type="url" inputMode="url" maxLength={SITE_LIMITS.url} hint={t.socialHint} placeholder="https://" />
      </div>
      <Restore conflict={part.conflict !== null} onRestore={() => void part.restore()} />
    </section>
  );
}

/**
 * „Uudiskiri“: the welcome code, autosaved on api/admin/seaded/newsletter. The welcome discount is Hüpikaken's „Soodustus (%)“ since piece 4b (S4-Q2 A),
 * published with the popup.
 */
function NewsletterCard({ version, value, onStatus }: { version: string; value: NewsletterDraft; onStatus: StatusReport }) {
  const t = adminEt.settings;
  const uid = useId();
  const labels: Record<keyof NewsletterDraft, string> = { welcomeCode: t.welcomeCode };
  const fields = useMemo(() => ({ ...value }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const part = useSeadedPart({ part: "newsletter", version, fields, label: (f) => labels[f as keyof NewsletterDraft] ?? f, focusField: focusOf("newsletter"), onStatus });
  const field = (name: keyof NewsletterDraft) => ({
    label: labels[name],
    value: String(part.text(name) ?? ""),
    onChange: (v: string) => part.type(name, v),
    error: errorText(part.codeOf(name)),
    name: `newsletter.${name}`,
  });
  return (
    <section className={ui.card} aria-labelledby={`${uid}-title`} onBlur={() => void part.flush()} data-newsletter-card="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.newsletter}
      </h2>
      <div className={ed.grid}>
        <TextField {...field("welcomeCode")} maxLength={WELCOME_CODE_MAX} hint={t.welcomeCodeHint} />
      </div>
      <Restore conflict={part.conflict !== null} onRestore={() => void part.restore()} />
    </section>
  );
}

/** After a conflict (README §1.3, B13): „Taasta minu tekst“ saves the card's text over the other tab's. */
function Restore({ conflict, onRestore }: { conflict: boolean; onRestore: () => void }) {
  if (!conflict) return null;
  return (
    <p className={styles.restore}>
      <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={onRestore} data-seaded-restore="">
        {adminEt.courseEditor.restore}
      </button>
    </p>
  );
}

/**
 * Seaded (admin UX pass piece 3b, Task 4; README B4, B21; rulings R-f, „Cards that move“; the Part 3 frame „B4 Seaded“ and the Part 4 phone frame):
 * one page with the section map — Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja tingimused, Halduse ligipääs (SectionMap: from 1180 px the list
 * at the left, below it the „Jaotised ▾“ select under the header) — and the header's ET | RU switch and ONE SaveStatus for every card (compact below
 * 900 px). Every card autosaves its part on api/admin/seaded/<part> (useSeadedPart) and tells its status here: „Kontaktandmed“, „Uudiskiri“, „Maksmine“
 * (the prepayment instructions' bank fields and the invoice settings in one card, InvoiceSettings) with „Järelmaks (Inbank)“'s instant switch, and
 * „Tunnistus“. The four legal texts (Task 5: ContractTexts.tsx LegalTexts) type into their drafts under the same chip and are published by their own
 * „Avalda uus leping“ / „Avalda uus tekst“; the map says „{n} avaldamata“ beside „Lepingud ja tingimused“ while some wait. The admin addresses are
 * shown, never edited (the environment variable ADMIN_EMAILS). „Näita“ of the chip goes to the first field a route refused. The page lead is gone
 * (none is drawn).
 */
export function SettingsEditor(p: {
  initial: Loaded<SettingsValues>;
  admins: string[];
  invoice: InvoiceSettingsInitial;
  certificate: CertificateSettingsInitial;
  financing: FinancingInitial;
  /** The four legal texts with their drafts (server/legal-drafts.ts readLegalTexts). */
  legal: Record<LegalKey, LegalState>;
  /** The students the e-course contract's panel says will be asked again (ruling R-e). */
  reaccept: number;
  now: Date;
}) {
  const t = adminEt.settings;
  const uid = useId();
  const phone = usePhoneChip();
  const [board, setBoard] = useState<Record<string, AutosaveStatus>>({});
  const report = useCallback<StatusReport>((part, status) => setBoard((b) => (sameStatus(b[part], status) ? b : { ...b, [part]: status })), []);
  const status = combineStatus(Object.values(board));
  const showInvalid = () => document.querySelector<HTMLElement>('[data-settings-editor] [data-seaded-section] [aria-invalid="true"]')?.focus();
  // the legal texts that wait for their publish (the map's „{n} avaldamata“, piece3-texts P-11)
  const [waiting, setWaiting] = useState<Partial<Record<LegalKey, boolean>>>(() => Object.fromEntries(Object.entries(p.legal).map(([k, s]) => [k, s.changed])));
  const onChanged = useCallback((key: LegalKey, changed: boolean) => setWaiting((w) => (w[key] === changed ? w : { ...w, [key]: changed })), []);
  const unpublished = Object.values(waiting).filter(Boolean).length;
  const sections: SectionEntry[] = SECTIONS.map((s) => ({ id: s.id, label: t.sections[s.label], ...(s.id === "lepingud" && unpublished > 0 ? { unpublished } : {}) }));
  // A load with an anchor (a bookmark, a link from outside, #arve of an old one): the browser looks for it before the page has streamed in, so it is
  // gone to once the page is here (a link within the admin is the router's own jump; this one lands in the same place).
  useEffect(() => {
    let id = "";
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    const target = id ? document.getElementById(id) : null;
    if (target?.closest("[data-settings-editor]")) target.scrollIntoView({ block: "start" });
  }, []);
  const { initial } = p;

  return (
    <div className={ui.page} data-settings-editor="">
      <div className={ui.heading} data-seaded-head="">
        <div>
          <p className={ui.eyebrow}>{t.eyebrow}</p>
          <h1 className={ui.h1}>{t.title}</h1>
        </div>
        <div className={ui.headAside}>
          <LangSwitch />
          <SaveStatus status={status} compact={phone} onShowInvalid={showInvalid} />
        </div>
      </div>

      <div className={styles.layout}>
        <SectionMap sections={sections} />
        <div className={styles.main}>
          <Section id="kontakt">
            <ContactCard version={initial.versions.contact} value={initial.values.contact} onStatus={report} />
          </Section>
          <Section id="uudiskiri">
            <NewsletterCard version={initial.versions.newsletter} value={initial.values.newsletter} onStatus={report} />
          </Section>
          <Section id="maksmine">
            <InvoiceSettings initial={p.invoice} bank={{ version: initial.versions.prepayment, value: initial.values.prepayment }} now={p.now} onStatus={report} />
            <FinancingSettings initial={p.financing} onStatus={report} />
          </Section>
          <Section id="tunnistus">
            <CertificateSettings initial={p.certificate} onStatus={report} />
          </Section>
          <Section id="lepingud">
            <LegalTexts texts={p.legal} reaccept={p.reaccept} onStatus={report} onChanged={onChanged} />
          </Section>
          <Section id="ligipaas">
            <section className={ui.card} aria-labelledby={`${uid}-admins`} data-admin-emails="">
              <h2 id={`${uid}-admins`} className={`${ui.h2} ${site.cardTitle}`}>
                {t.admins}
              </h2>
              <p className={ui.muted}>{t.adminsLead}</p>
              <ul className={site.admins}>
                {p.admins.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </section>
          </Section>
        </div>
      </div>
    </div>
  );
}
