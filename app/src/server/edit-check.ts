import type { FieldError } from "@/domain/field-check";
import { isStorableImageKey } from "@/lib/media";

// What every content editor's form handling shares (courses and calendar in admin-content.ts, the site content in
// admin-site.ts): the result type, the field error codes the editors show, and Check, which collects field errors while
// it normalises the values (both pure: domain/field-check.ts since admin UX pass piece 4a, re-exported here, so the site editors' loose checks of a
// draft save are made of the same rules). Nothing the browser sends is trusted: every field is checked again here.

export { Check, type FieldError } from "@/domain/field-check";

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
