import type { Dict } from "@/i18n/locales";

// The dictionary parts the account's client components get, picked on the server (the static /konto… shells, and the
// admin's read-only "view as client"), so a page sends only these strings to the browser, not the whole dictionary.

export type ShellTexts = Dict["account"]["shell"];

/** AccountLoader's: another device signed in, loading, the data could not be loaded. */
export type LoaderTexts = Dict["account"]["loader"];

export type CoursesTexts = Dict["account"]["dashboard"] & {
  /** The card sentences (account.next, filled with domain/account-cards.ts nextStep's vars). */
  next: Dict["account"]["next"];
  loader: LoaderTexts;
  /** The pay button's texts (phase 2b). */
  online: PayTexts;
};

/** "Lemmikud": the account.favourites strings and AccountLoader's. */
export type FavouritesTexts = Dict["account"]["favourites"] & { loader: LoaderTexts };

/** "Minu andmed": the account.details strings and AccountLoader's. */
export type DetailsTexts = Dict["account"]["details"] & { loader: LoaderTexts };

/** The e-course page's: the account.ecourse strings, the modules' lock label (course.locked), AccountLoader's. */
export type EcourseTexts = Dict["account"]["ecourse"] & { locked: string; loader: LoaderTexts };

/** One lesson's page: the account.lesson strings, "Jätka" and the lock sentence (account.ecourse), AccountLoader's. */
export type LessonTexts = Dict["account"]["lesson"] & { resume: string; lockedHint: string; loader: LoaderTexts };

/** The cards' pay button (phase 2b): "Maksa {amount}", "Maksa ülejäänud {amount}", the transfer line, the button while it opens, and why a start was refused. */
export type PayTexts = { pay: string; payRest: string; transfer: string; starting: string; full: string; nothing: string; rate: string; failed: string };

export const payTexts = (d: Dict): PayTexts => ({
  pay: d.payment.pay,
  payRest: d.payment.payRest,
  transfer: d.payment.transfer,
  starting: d.payment.starting,
  full: d.payment.page.full,
  nothing: d.payment.page.nothing,
  rate: d.forms.errorTooMany,
  failed: d.forms.errorGeneric,
});

export const shellTexts = (d: Dict): ShellTexts => d.account.shell;

export const loaderTexts = (d: Dict): LoaderTexts => d.account.loader;

export const ecourseTexts = (d: Dict): EcourseTexts => ({ ...d.account.ecourse, locked: d.course.locked, loader: loaderTexts(d) });

export const coursesTexts = (d: Dict): CoursesTexts => ({ ...d.account.dashboard, next: d.account.next, loader: loaderTexts(d), online: payTexts(d) });

export const favouritesTexts = (d: Dict): FavouritesTexts => ({ ...d.account.favourites, loader: loaderTexts(d) });

export const detailsTexts = (d: Dict): DetailsTexts => ({ ...d.account.details, loader: loaderTexts(d) });

export const lessonTexts = (d: Dict): LessonTexts => ({ ...d.account.lesson, resume: d.account.ecourse.resume, lockedHint: d.account.ecourse.lockedHint, loader: loaderTexts(d) });

/** The student's protocol page (phase protocols): account.protocol, the way back (Minu koolitused) and AccountLoader's. */
export type ProtocolTexts = Dict["account"]["protocol"] & { back: string; loader: LoaderTexts };

export const protocolTexts = (d: Dict): ProtocolTexts => ({ ...d.account.protocol, back: d.account.shell.courses, loader: loaderTexts(d) });
