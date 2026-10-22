// The search of the admin lists (admin UX pass, README §1.10; the A screens, Task 1). `?otsi=` is read by parseSearch and matched in text columns with
// containsPattern (domain/paging.ts: literal, escaped). A phone number is different: it is stored with whatever spaces, dashes and plus its owner typed,
// and searched with whatever the admin types, so the two are compared by their digits alone. The SQL side:
//
//   regexp_replace(<column>, '[^0-9]', '', 'g') like <phoneQuery(q)>
//
// (a number typed with +372 is searched without it, so it finds the same number stored without the country code)
//
// Pure and import-free: the browser runs it too (tests/unit/old-safari.test.ts: no regex lookbehind here).

/** The fewest digits in a search for it to be taken as part of a phone number. */
export const PHONE_MIN_DIGITS = 3;

/** Every ASCII digit of `q`, in order (the same characters the SQL side's `[^0-9]` leaves). */
export function digitsOf(q: string): string {
  return q.replace(/[^0-9]/g, "");
}

/** Estonia's country code, which a number is written with („+372 5123 4567“) or without („5123 4567“). */
const COUNTRY_CODE = "372";
/** An Estonian national number has 7 (a landline) or 8 digits; with fewer after the country code, the 372 is just digits typed so far. */
const NATIONAL_MIN_DIGITS = 7;

/**
 * The LIKE pattern that finds `q` among the digits of a phone column: `%<digits>%` when `q` holds at least PHONE_MIN_DIGITS digits, else null (a
 * name like "Kati 5" is not a phone). Digits hold nothing LIKE treats as a wildcard, so there is nothing to escape.
 *
 * A number typed with the country code, when at least NATIONAL_MIN_DIGITS digits follow the 372, is searched by the digits after it: „+372 5123
 * 4567“ finds a number stored „5123 4567“ as well as „+37251234567“ (a stored „+372 …“ holds the national digits, so it is found too), and
 * „+372 612 3456“ a landline stored „612 3456“. Fewer digits after the 372 are kept whole: „372 51“ is a number typed so far, not a country code.
 */
export function phoneQuery(q: string): string | null {
  const digits = digitsOf(q);
  if (digits.length < PHONE_MIN_DIGITS) return null;
  const national = digits.startsWith(COUNTRY_CODE) && digits.length - COUNTRY_CODE.length >= NATIONAL_MIN_DIGITS ? digits.slice(COUNTRY_CODE.length) : digits;
  return `%${national}%`;
}
