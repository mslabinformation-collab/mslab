"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { PLACEHOLDERS } from "@/domain/contract";
import { SITE_LIMITS } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { saveContractTextsAction } from "@/server/actions/admin-contracts";
import type { ContractCard } from "@/server/contracts";
import { I18nInput } from "./I18nInput";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./ContractTexts.module.css";

/** The card's texts as typed: the Estonian one, and the Russian one (empty for none). */
type Draft = { title: I18n; body: I18n };
const draftOf = (card: ContractCard): Draft => ({ title: { ...card.title }, body: { ...card.body } });

/** The status line: empty, on its way, done or refused. */
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/**
 * Seaded → „Lepingud“ (contracts Task 5, spec D2, §4): „Kontaktkoolituse leping“, the contract a student confirms on the registration form of a group
 * course — its title and its text in Estonian and Russian, in the legal texts' editor (a blank line starts a new paragraph), with the placeholders the
 * text may use and what fills each, and „Näidisleping (PDF)“, a sample drawn from the texts on the screen without saving anything. A form of its
 * own after the invoice's card (a form cannot sit inside another), with its own „Salvesta lepingud“; a refused field is marked in words and the first
 * one takes the focus. The sample is a second form that posts the texts to a new tab: a contract text is far too long for an address. The card keeps its
 * own state; the page is not reloaded. The e-course's contract has its own card in the settings' form („E-koolituse leping (tingimused)“). This file runs on
 * old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).
 */
export function ContractTexts({ initial }: { initial: ContractCard }) {
  const t = adminEt.contracts.settings;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Line>(IDLE);
  const [pending, start] = useTransition();

  // a refused save: the first marked field takes the focus
  useEffect(() => {
    if (Object.keys(fields).length > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);

  /** The words under a refused field ("required", "tooLong"), or undefined when it is not refused. */
  const errorOf = (name: "title" | "body"): string | undefined => {
    const code = fields[name];
    if (code === undefined) return undefined;
    return (adminEt.courseEditor.errors as Record<string, string>)[code] ?? t.invalid;
  };

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setStatus({ tone: "busy", text: t.saving });
    start(async () => {
      const result = await saveContractTextsAction(draft);
      if (result.ok) {
        setDraft(draftOf(result.card));
        setFields({});
        setStatus({ tone: "done", text: t.saved });
      } else if ("fields" in result && result.fields) {
        setFields(result.fields);
        setStatus({ tone: "error", text: t.invalid });
      } else setStatus({ tone: "error", text: t.error });
    });
  };

  const hasRu = (draft.body.ru ?? "").trim() !== "";

  return (
    <section id="lepingud" className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-contract-texts="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <form ref={form} onSubmit={save} noValidate data-contract-form="">
        <div className={styles.group} data-contract-group="contact">
          <h3 className={ui.h3}>{t.contact}</h3>
          <I18nInput
            label={adminEt.settings.pageTitle}
            value={draft.title}
            onChange={(title) => setDraft((d) => ({ ...d, title }))}
            maxLength={SITE_LIMITS.legalTitle}
            error={errorOf("title")}
            name="contract.title"
          />
          <I18nInput
            label={adminEt.settings.pageBody}
            value={draft.body}
            onChange={(body) => setDraft((d) => ({ ...d, body }))}
            multiline
            rows={12}
            maxLength={SITE_LIMITS.legal}
            hint={t.paragraphHint}
            error={errorOf("body")}
            name="contract.body"
          />
          <div className={styles.placeholders} data-contract-placeholders="">
            <p className={ui.hint}>{t.placeholders}</p>
            <ul>
              {PLACEHOLDERS.map((name) => (
                <li key={name}>
                  <code>{`{${name}}`}</code> — {t.placeholderMeaning[name]}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className={styles.actions}>
          <p role="status" className={toneClass(status.tone)} data-contract-status="">
            {status.text}
          </p>
          <button type="submit" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} data-contract-save="">
            {pending ? t.saving : t.save}
          </button>
        </div>
      </form>

      {/* the sample: the texts as they stand on the screen, posted to a new tab; nothing is saved */}
      <form className={styles.sample} method="post" action="/api/admin/naidisleping" target="_blank" data-contract-sample-form="">
        <input type="hidden" name="titleEt" value={draft.title.et} />
        <input type="hidden" name="titleRu" value={draft.title.ru ?? ""} />
        <input type="hidden" name="bodyEt" value={draft.body.et} />
        <input type="hidden" name="bodyRu" value={draft.body.ru ?? ""} />
        <div className={styles.sampleButtons}>
          <button type="submit" name="lang" value="et" className={`${ui.btn} ${ui.secondary}`} data-contract-sample="et">
            {t.sample}
          </button>
          {hasRu && (
            <button type="submit" name="lang" value="ru" className={`${ui.btn} ${ui.secondary}`} data-contract-sample="ru">
              {t.sampleRu}
            </button>
          )}
        </div>
        <p className={ui.hint}>{t.sampleHint}</p>
      </form>
    </section>
  );
}
