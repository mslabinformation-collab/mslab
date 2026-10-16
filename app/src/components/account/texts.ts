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
  /** An e-course card's "Lõpetatud {date}" (e-course completion: account.completion.completedOn). */
  completed: string;
  /**
   * An ended e-course card's certificate (phase 3d): its link "Laadi tunnistus alla" (`cardLink`), and the name form of an access completed
   * without one yet, in the e-course page's own words.
   */
  certificate: CertificateTexts;
  /** The invoices on the card (invoices Task 6): the account.invoices words. */
  invoices: Dict["account"]["invoices"];
};

/** "Lemmikud": the account.favourites strings and AccountLoader's. */
export type FavouritesTexts = Dict["account"]["favourites"] & { loader: LoaderTexts };

/** "Minu andmed": the account.details strings and AccountLoader's. */
export type DetailsTexts = Dict["account"]["details"] & { loader: LoaderTexts };

/** The certificate's texts (phase 3d): account.certificate, with the two failure lines of the issue (too many tries, anything else). */
export type CertificateTexts = Dict["account"]["certificate"] & { rate: string; failed: string };

/**
 * The e-course page's: the account.ecourse strings, the modules' lock label (course.locked), AccountLoader's, "Lõpetamine" (account.completion)
 * and its "Tunnistus" row (CertificateTexts), and "Minu konto" (nav.account), the no-access notice's way to the dashboard.
 */
export type EcourseTexts = Dict["account"]["ecourse"] & {
  locked: string;
  toAccount: string;
  loader: LoaderTexts;
  completion: Dict["account"]["completion"];
  certificate: CertificateTexts;
};

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

const certificateTexts = (d: Dict): CertificateTexts => ({ ...d.account.certificate, rate: d.forms.errorTooMany, failed: d.forms.errorGeneric });

export const ecourseTexts = (d: Dict): EcourseTexts => ({
  ...d.account.ecourse,
  locked: d.course.locked,
  toAccount: d.nav.account,
  loader: loaderTexts(d),
  completion: d.account.completion,
  certificate: certificateTexts(d),
});

export const coursesTexts = (d: Dict): CoursesTexts => ({
  ...d.account.dashboard,
  next: d.account.next,
  loader: loaderTexts(d),
  online: payTexts(d),
  completed: d.account.completion.completedOn,
  certificate: certificateTexts(d),
  invoices: d.account.invoices,
});

export const favouritesTexts = (d: Dict): FavouritesTexts => ({ ...d.account.favourites, loader: loaderTexts(d) });

export const detailsTexts = (d: Dict): DetailsTexts => ({ ...d.account.details, loader: loaderTexts(d) });

export const lessonTexts = (d: Dict): LessonTexts => ({ ...d.account.lesson, resume: d.account.ecourse.resume, lockedHint: d.account.ecourse.lockedHint, loader: loaderTexts(d) });

/** The student's protocol page (phase protocols): account.protocol, the way back (Minu koolitused) and AccountLoader's. */
export type ProtocolTexts = Dict["account"]["protocol"] & { back: string; loader: LoaderTexts };

export const protocolTexts = (d: Dict): ProtocolTexts => ({ ...d.account.protocol, back: d.account.shell.courses, loader: loaderTexts(d) });

/** The feedback form (phase protocols): account.feedback, the way back, the two failure lines and AccountLoader's. */
export type FeedbackTexts = Dict["account"]["feedback"] & { back: string; rate: string; failed: string; loader: LoaderTexts };

export const feedbackTexts = (d: Dict): FeedbackTexts => ({
  ...d.account.feedback,
  back: d.account.shell.courses,
  rate: d.forms.errorTooMany,
  failed: d.forms.errorGeneric,
  loader: loaderTexts(d),
});

/** The knowledge test's page (e-course completion): account.test, the way back to the course (account.lesson.back), the two failure lines and AccountLoader's. */
export type TestTexts = Dict["account"]["test"] & { back: string; loader: LoaderTexts; rate: string; failed: string };

export const testTexts = (d: Dict): TestTexts => ({
  ...d.account.test,
  back: d.account.lesson.back,
  rate: d.forms.errorTooMany,
  failed: d.forms.errorGeneric,
  loader: loaderTexts(d),
});

/** The practical work's page (e-course completion): account.practical, the way back to the course, the two failure lines and AccountLoader's. */
export type PracticalTexts = Dict["account"]["practical"] & { back: string; loader: LoaderTexts; rate: string; failed: string };

export const practicalTexts = (d: Dict): PracticalTexts => ({
  ...d.account.practical,
  back: d.account.lesson.back,
  loader: loaderTexts(d),
  rate: d.forms.errorTooMany,
  failed: d.forms.errorGeneric,
});
