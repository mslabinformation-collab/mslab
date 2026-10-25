import type { I18n } from "@/i18n/field";
import { textProblem, type TextProblem } from "./lesson-limits";
import { SITE_LIMITS } from "./site-editor";

// The legal texts of Seaded → „Lepingud ja tingimused“ on the draft layer (admin UX pass piece 3b, Task 5; README B4, spec C6; ruling R-d): what the
// cards (components/admin/ContractTexts.tsx) and the server (server/legal-drafts.ts) share. Pure: no database, no React. It runs in the browser, on
// iOS Safari before 16.4 as well (tests/unit/old-safari.test.ts): no lookbehind.

/** The four texts, in the section's order: Privaatsus, Õppetingimused, E-koolituse leping, Kontaktkoolituse leping (each a `pages` row of that key). */
export const LEGAL_KEYS = ["privacy", "terms", "course_terms", "contract_contact"] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];
export const isLegalKey = (key: string): key is LegalKey => (LEGAL_KEYS as readonly string[]).includes(key);

/** A text's two fields in both languages, as its card holds them: a language not written is "" (never left out). */
export type LegalText = { title: { et: string; ru: string }; body: { et: string; ru: string } };
export type LegalField = keyof LegalText;

/**
 * A text as its card reads it: `version` the one its autosave goes from ("l:<hash>" while it has no draft, "d:<row>.<n>" with one: server/legal-drafts.ts),
 * `value` what the card shows (the draft, else live), `live` what is published, `changed` whether a draft differs from live (the tag „Avaldamata muudatus“).
 */
export type LegalState = { version: string; value: LegalText; live: LegalText; changed: boolean };

/** A stored or sent `{ et, ru? }` as the card holds it; anything else is an empty text. */
export function legalI18n(value: unknown): { et: string; ru: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { et: "", ru: "" };
  const { et, ru } = value as { et?: unknown; ru?: unknown };
  return { et: typeof et === "string" ? et : "", ru: typeof ru === "string" ? ru : "" };
}

/** The same text: a Russian one left out is an empty one. */
export const sameI18n = (a: I18n, b: I18n): boolean => a.et === b.et && (a.ru ?? "") === (b.ru ?? "");
export const sameLegalText = (a: LegalText, b: LegalText): boolean => sameI18n(a.title, b.title) && sameI18n(a.body, b.body);

/**
 * The same text as the writers store it (Task 5 review M1): each language trimmed — they trim it and leave a blank Russian one out — so spaces added or
 * taken at either end are no change to publish (no „Avaldamata muudatus“, no new version, nobody asked again).
 */
export const sameStoredI18n = (a: I18n, b: I18n): boolean => a.et.trim() === b.et.trim() && (a.ru ?? "").trim() === (b.ru ?? "").trim();
export const sameStoredText = (a: LegalText, b: LegalText): boolean => sameStoredI18n(a.title, b.title) && sameStoredI18n(a.body, b.body);

/** A field's limit: the legal titles' and the legal texts' (SITE_LIMITS, as every writer of these pages checks them). */
const LIMIT: Record<LegalField, number> = { title: SITE_LIMITS.legalTitle, body: SITE_LIMITS.legal };

/**
 * The writers' rule for one field (admin-site.ts pagePart with `required`, the e-course part, contracts.ts saveContractTexts): the Estonian text
 * required — a Russian one alone is no text —, each language at most 120 (the title) or 30 000 (the text) characters once trimmed. Null: it passes.
 */
export const legalFieldProblem = (field: LegalField, value: I18n): TextProblem | null => textProblem(value, LIMIT[field], { required: true });

/** The problems of the fields given, by field name (empty: they pass). */
export function legalProblems(value: Partial<Record<LegalField, I18n>>): Partial<Record<LegalField, TextProblem>> {
  const out: Partial<Record<LegalField, TextProblem>> = {};
  for (const field of ["title", "body"] as const) {
    const f = value[field];
    const problem = f === undefined ? null : legalFieldProblem(field, f);
    if (problem) out[field] = problem;
  }
  return out;
}
