// The search of the admin lists (admin UX pass, README §1.10; the A screens, Task 1). `?otsi=` is read by parseSearch and matched in text columns with
// containsPattern (domain/paging.ts: literal, escaped). A phone number is different: it is stored with whatever spaces, dashes and plus its owner typed,
// and searched with whatever the admin types, so the two are compared by their digits alone. The SQL side:
//
//   regexp_replace(<column>, '[^0-9]', '', 'g') like <phoneQuery(q)>
//
// Pure and import-free: the browser runs it too (tests/unit/old-safari.test.ts: no regex lookbehind here).

/** The fewest digits in a search for it to be taken as part of a phone number. */
export const PHONE_MIN_DIGITS = 3;

/** Every ASCII digit of `q`, in order (the same characters the SQL side's `[^0-9]` leaves). */
export function digitsOf(q: string): string {
  return q.replace(/[^0-9]/g, "");
}

/**
 * The LIKE pattern that finds `q` among the digits of a phone column: `%<digits>%` when `q` holds at least PHONE_MIN_DIGITS digits, else null (a
 * name like "Kati 5" is not a phone). Digits hold nothing LIKE treats as a wildcard, so there is nothing to escape.
 */
export function phoneQuery(q: string): string | null {
  const digits = digitsOf(q);
  return digits.length >= PHONE_MIN_DIGITS ? `%${digits}%` : null;
}
