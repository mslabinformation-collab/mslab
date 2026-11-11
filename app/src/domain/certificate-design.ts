// The certificate designs' pure rules (2026-11-11 certificate designs, spec §3–§5): Seaded → Tunnistus keeps a list of designs („Kujundused“: a
// name, a tone, an optional background photo), an e-course's „Tunnistus“ card picks one (none picked: the first), and each certificate keeps a copy
// of its design's look from its issue (certificates.design), so a design edited or deleted later never changes a certificate already issued. The
// light tone draws dark text and the black logo over the photo, the dark tone today's white on black. No database, no React: the server, Seaded and
// the course editor share them. It runs in the browser too: no lookbehind here nor in what it imports (tests/unit/old-safari.test.ts).

import { isMediaKey } from "@/lib/media";
import { toStorable } from "@/lib/to-storable";

/** The tones (certificate_designs.tone, its check): „Hele taust, tume tekst“ and „Tume taust, hele tekst“. */
export const DESIGN_TONES = ["light", "dark"] as const;
export type DesignTone = (typeof DESIGN_TONES)[number];

export const isDesignTone = (v: unknown): v is DesignTone => typeof v === "string" && (DESIGN_TONES as readonly string[]).includes(v);

/** „Nimi“: at most 40 characters (Estonian, Maria's own word for it; only the admin shows it). */
export const DESIGN_LIMITS = { name: 40 } as const;

/**
 * The background photo's upload: a JPEG of at most 1.5 MB (spec §4, my call: the app does no image processing, so the photo is embedded in the PDF
 * as it was uploaded, and this limit keeps the certificate small). Checked in the browser before it is sent and again by the upload route.
 */
export const BACKGROUND_MAX_BYTES = 1.5 * 1024 * 1024;
export const BACKGROUND_TYPE = "image/jpeg";

/** A design as Seaded keeps it (the table certificate_designs). */
export type CertificateDesign = { id: number; name: string; tone: DesignTone; backgroundKey: string; sort: number };

/** The look a certificate keeps from its issue (certificates.design): its design's tone and background, nothing else. */
export type FrozenDesign = { tone: DesignTone; backgroundKey: string };

/**
 * A background as a design may hold it: none (""), or a JPEG of the admin's upload (img/<uuid>.jpg, lib/media.ts isMediaKey): the PDF embeds it as a
 * JPEG (pdf-lib embedJpg) read from the media store, so never a PNG or a WebP, a picture of the site's own (/seed/…) or another site's address.
 */
export const isBackgroundKey = (key: string): boolean => key === "" || (isMediaKey(key) && key.endsWith(".jpg"));

/** The first design: the lowest `sort`, then the lowest id (what a course with no pick gets); null without designs. */
export function firstDesign<T extends { id: number; sort: number }>(designs: readonly T[]): T | null {
  let first: T | null = null;
  for (const d of designs) if (!first || d.sort < first.sort || (d.sort === first.sort && d.id < first.id)) first = d;
  return first;
}

/**
 * The design of a course's certificate: its pick (courses.certificate_design_id) when it is one of `designs`, else the first (a course that never
 * picked, a new one). A pick always names a design (the foreign key restricts the delete of one picked); this falls back all the same.
 */
export function designFor<T extends { id: number; sort: number }>(designs: readonly T[], pick: number | null): T | null {
  return (pick === null ? undefined : designs.find((d) => d.id === pick)) ?? firstDesign(designs);
}

/** The copy a certificate keeps of its design. */
export const frozenOf = (d: Pick<CertificateDesign, "tone" | "backgroundKey">): FrozenDesign => ({ tone: d.tone, backgroundKey: d.backgroundKey });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * certificates.design read defensively (jsonb: anything): the tone, and the background when it is one a design may hold (else none: nothing is read
 * from the store for it). Null — every certificate issued before the designs, or anything without a tone — draws today's dark page.
 */
export function readFrozenDesign(value: unknown): FrozenDesign | null {
  if (!isObject(value) || !isDesignTone(value.tone)) return null;
  const key = typeof value.backgroundKey === "string" && isBackgroundKey(value.backgroundKey) ? value.backgroundKey : "";
  return { tone: value.tone, backgroundKey: key };
}

/** „Nimi“'s refusal: empty, over 40 characters, or another design's name already. */
export type DesignNameError = "required" | "tooLong" | "taken";

/** A name compared with the others': its letters, whatever their case. */
const nameKey = (name: string): string => name.toLocaleLowerCase("et");

/**
 * „Nimi“ (spec §5.1): what Postgres can store (lib/to-storable.ts), on one line (each run of white space one space), trimmed; required, at most 40
 * characters (code points), and not the name of another design (`others`), whatever the case.
 */
export function checkDesignName(raw: string, others: readonly string[]): { ok: true; name: string } | { ok: false; error: DesignNameError } {
  const name = toStorable(raw).replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "required" };
  if (Array.from(name).length > DESIGN_LIMITS.name) return { ok: false, error: "tooLong" };
  if (others.some((o) => nameKey(o.trim()) === nameKey(name))) return { ok: false, error: "taken" };
  return { ok: true, name };
}
