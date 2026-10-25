import { LIMITS } from "@/domain/course-editor";
import { textProblem } from "@/domain/lesson-limits";
import { parseEuroCents } from "@/domain/money";
import { hasLocalePrefix, isFocal, isHttpsUrl, isSiteHref } from "@/domain/site-editor";
import type { I18n } from "@/i18n/field";
import { isStorableImageKey } from "@/lib/media";

// What every content editor's form handling shares (courses and calendar in admin-content.ts, the site content in
// admin-site.ts): the result type, the field error codes the editors show, and Check, which collects field errors while
// it normalises the values. Nothing the browser sends is trusted: every field is checked again here.

/** Why one field was refused (the editor shows the matching text under it). */
export type FieldError =
  | "required"
  | "tooLong"
  | "slugFormat"
  | "slugTaken"
  | "amount"
  | "whole"
  | "priceRequired"
  | "listEt"
  | "tooMany"
  | "image"
  | "badge"
  | "typeLocked"
  | "course"
  | "date"
  | "time"
  | "capacity"
  // a calendar session's rules (piece 3b, rulings R-b, R-c; domain/session-fields.ts): „Kohti“ below the confirmed, „Koolitus“ once anyone is booked
  | "capacityBelow"
  | "courseLocked"
  | "href"
  | "url"
  | "email"
  | "phone"
  | "focal"
  | "codeFormat"
  | "imageRequired"
  | "localeHref"
  | "iban"
  // "Teadmiste test" (e-course completion): the question list's problems (domain/completion.ts checkQuestions), on the field `test`
  | "testTooMany"
  | "testEmpty"
  | "testTooLong"
  | "testOptions"
  | "testNoCorrect";

/** Where in a list a field's error is: the course editor's "Teadmiste test" names the question (0-based; -1: the list as a whole) and the option in it. */
export type FieldPlace = { index: number; option?: number };

/** The parts of a site editor as stored after a save: their drafts and versions (the editor continues from these). */
export type SavedParts = { values: Record<string, unknown>; versions: Record<string, string> };

/**
 * What a content form gets back. `fields`: the refused fields (with error "invalid"); `at`: where the error of a list field is (the course
 * editor's questions, FieldPlace). stale: the content was saved elsewhere since the editor loaded it (nothing saved). inUse: a session with
 * registrations cannot be deleted.
 */
export type EditResult =
  | { ok: true; id: number; created?: boolean; deleted?: boolean; saved?: SavedParts }
  | { ok: false; error: "invalid" | "notFound" | "stale" | "inUse" | "server"; fields?: Record<string, FieldError>; at?: FieldPlace };

export const invalid = (errors: Record<string, FieldError>, at?: FieldPlace): EditResult => ({ ok: false, error: "invalid", fields: errors, ...(at ? { at } : {}) });

/** A text field of a FormData, or null. */
export const field = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v : null;
};

// The key rule (an upload or a picture shipped with the site) is lib/media.ts's, shared with the pure rules of the newsletter campaign; it stays importable from here.
export { isStorableImageKey };

const EMAIL = /^[^\s@<>"'`,;]+@[^\s@<>"'`,;]+\.[^\s@<>"'`,;]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{3,38}$/;

/** Collects field errors while values are normalised. */
export class Check {
  readonly errors: Record<string, FieldError> = {};
  fail(name: string, error: FieldError): null {
    this.errors[name] ??= error;
    return null;
  }
  get ok() {
    return Object.keys(this.errors).length === 0;
  }

  /**
   * A text in both languages: trimmed, the Russian one left out when blank. Null when `optional` and empty. The rule is domain/lesson-limits.ts
   * textProblem's, which the browser's lesson and module fields check by too.
   */
  text(name: string, f: I18n, max: number, opts: { required?: boolean } = {}): I18n | null {
    const problem = textProblem(f, max, opts);
    if (problem) return this.fail(name, problem);
    const et = f.et.trim();
    const ru = (f.ru ?? "").trim();
    if (!et) return null;
    return ru ? { et, ru } : { et };
  }

  /** A list of texts: blank rows dropped; a row needs its Estonian text. */
  list(name: string, items: I18n[], max = LIMITS.item, most = LIMITS.items): I18n[] {
    const out: I18n[] = [];
    for (const item of items) {
      const et = item.et.trim();
      const ru = (item.ru ?? "").trim();
      if (!et && !ru) continue;
      if (!et) return this.fail(name, "listEt") ?? [];
      if (et.length > max || ru.length > max) return this.fail(name, "tooLong") ?? [];
      out.push(ru ? { et, ru } : { et });
    }
    if (out.length > most) return this.fail(name, "tooMany") ?? [];
    return out;
  }

  /** A one-language text, trimmed ("" when blank and not required). */
  plain(name: string, value: string, max: number, opts: { required?: boolean } = {}): string {
    const v = value.trim();
    if (v.length > max) return this.fail(name, "tooLong") ?? "";
    if (!v && opts.required) return this.fail(name, "required") ?? "";
    return v;
  }

  /** Euros as typed → cents; null when blank. */
  amount(name: string, value: string): number | null {
    if (!value.trim()) return null;
    return parseEuroCents(value) ?? this.fail(name, "amount");
  }

  /** A whole number in min…max; null when blank. */
  whole(name: string, value: string, min: number, max: number): number | null {
    const v = value.trim();
    if (!v) return null;
    if (!/^\d{1,4}$/.test(v) || Number(v) < min || Number(v) > max) return this.fail(name, "whole");
    return Number(v);
  }

  /**
   * A button link: a path on this site or an https:// address ("" when blank and not required). A path is written
   * without the locale ("/praktika", not "/ru/praktika"): the site adds /ru on the Russian pages itself.
   */
  href(name: string, value: string, opts: { required?: boolean } = {}): string {
    const v = value.trim();
    if (!v) return opts.required ? (this.fail(name, "required") ?? "") : "";
    if (!isSiteHref(v)) return this.fail(name, "href") ?? "";
    return hasLocalePrefix(v) ? (this.fail(name, "localeHref") ?? "") : v;
  }

  /** An https:// address, or "" when blank. */
  httpsUrl(name: string, value: string): string {
    const v = value.trim();
    if (!v) return "";
    return isHttpsUrl(v) ? v : (this.fail(name, "url") ?? "");
  }

  /** An e-mail address, or "" when blank. */
  email(name: string, value: string, max: number): string {
    const v = value.trim();
    if (!v) return "";
    if (v.length > max) return this.fail(name, "tooLong") ?? "";
    return EMAIL.test(v) ? v : (this.fail(name, "email") ?? "");
  }

  /** A phone number as people write it (+372 5555 0101), or "" when blank. */
  phone(name: string, value: string): string {
    const v = value.trim().replace(/\s+/g, " ");
    if (!v) return "";
    return PHONE.test(v) ? v : (this.fail(name, "phone") ?? "");
  }

  /** An uploaded image (img/<uuid>.<ext>) or a seed photo, or "" when blank and not required. */
  image(name: string, key: string, opts: { required?: boolean } = {}): string {
    const v = key.trim();
    if (!v) return opts.required ? (this.fail(name, "imageRequired") ?? "") : "";
    return isStorableImageKey(v) ? v : (this.fail(name, "image") ?? "");
  }

  /** A focal point "x% y%" (whole percentages). */
  focal(name: string, value: string): string {
    const v = value.trim();
    return isFocal(v) ? v : (this.fail(name, "focal") ?? "");
  }
}
