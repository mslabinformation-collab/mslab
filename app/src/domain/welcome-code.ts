// The newsletter's welcome code (phase 2c, spec 5): Seaded "Tervituskood" (settings key "newsletter", field welcomeCode), sent after
// an address's first confirmation in the welcome mail and shown on the confirmed page. The same setting holds Hüpikaken's two numbers (admin
// UX pass piece 4b, ruling R-c): the discount the footer shows („Soodustus (%)“, discountPercent) and how many days the code is valid („Kood
// kehtib (päeva)“, codeDays: the welcome mail says it, S4-Q3 A), written by Hüpikaken's „Avalda muudatused“. Pure: no database, no React.

/** The longest welcome code. */
export const WELCOME_CODE_MAX = 30;

const SHAPE = /^[A-Z0-9-]{1,30}$/;

/** As the admin typed it → as stored: trimmed, in capitals. */
export const normalizeWelcomeCode = (typed: string): string => typed.trim().toUpperCase();

/** A code that may be stored: A–Z, 0–9 and "-", at most 30; "" (no code) too. */
export const isWelcomeCode = (code: string): boolean => code === "" || SHAPE.test(code);

/** The stored `newsletter` setting → its welcome code, or "" (none, or a value of another shape: never shown). */
export function welcomeCodeOf(setting: unknown): string {
  const value = setting && typeof setting === "object" && !Array.isArray(setting) ? (setting as Record<string, unknown>).welcomeCode : null;
  return typeof value === "string" && SHAPE.test(value) ? value : "";
}

/**
 * The fragment the confirmation link's redirect carries to the home page: `kood=<CODE>`. A fragment, never the query: the home page is
 * cached for every visitor, and no server or cache ever sees a fragment (FlashNotice reads it in the browser and removes it).
 */
export const welcomeFragment = (code: string): string => `kood=${code}`;

/** The welcome code in a page's fragment (without "#"), read back only in its own shape. */
export const WELCOME_FRAGMENT = /^kood=([A-Z0-9-]{1,30})$/;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Hüpikaken's discount, a whole percentage (R-c), and the one the footer shows while none is stored (the seed's „10%“). */
export const DISCOUNT_MIN = 1;
export const DISCOUNT_MAX = 99;
export const DEFAULT_DISCOUNT_PERCENT = 10;

/** How many days the welcome code is valid, at most (R-c): a whole 1–365. */
export const CODE_DAYS_MIN = 1;
export const CODE_DAYS_MAX = 365;

/**
 * The stored `newsletter` setting → Hüpikaken's discount (R-c): `discountPercent`, a whole 1–99; before the first publish writes it, the whole
 * number of the label Seaded stored until piece 4b (`discountLabel` „10%“, „-15%“); else 10.
 */
export function discountPercentOf(setting: unknown): number {
  const s = obj(setting);
  if (wholeIn(s.discountPercent, DISCOUNT_MIN, DISCOUNT_MAX)) return s.discountPercent;
  const old = typeof s.discountLabel === "string" ? /\d+/.exec(s.discountLabel) : null;
  const n = old ? Number(old[0]) : NaN;
  return wholeIn(n, DISCOUNT_MIN, DISCOUNT_MAX) ? n : DEFAULT_DISCOUNT_PERCENT;
}

/** The stored `newsletter` setting → how many days the welcome code is valid (R-c): a whole 1–365, or null (none set: the mail says nothing). */
export function codeDaysOf(setting: unknown): number | null {
  const days = obj(setting).codeDays;
  return wholeIn(days, CODE_DAYS_MIN, CODE_DAYS_MAX) ? days : null;
}
