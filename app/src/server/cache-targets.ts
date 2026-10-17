// Which public pages show what (pure: no Next.js, so it is tested on its own; server/public-cache.ts hands each target to
// revalidatePath()). Pages are named by their route (app/[locale]/(site)/…), which covers both languages: a "page" target
// is that page, a "layout" target every page at or below it. A path without brackets is one address (as the middleware
// rewrote it, so with its locale: "/et/koolitused/x").

/** What changed. `parts`: the editor parts that were saved (an editor page sends only the changed ones). */
export type PublicChange =
  /** a course saved, created or moved in the list */
  | { kind: "courses" }
  /** a calendar session saved or deleted */
  | { kind: "sessions" }
  /** seat counts: a registration or waitlist entry for `course` (its slug), or an admin's status / payment change */
  | { kind: "seats"; course?: string }
  /** Avaleht: hero slides, statement, FAQ */
  | { kind: "home" }
  /** Praktika: the packages */
  | { kind: "practice" }
  /** Koolitaja: trainer (name in the footer, portrait, stats), bio, works, center_story, trainer_journey */
  | { kind: "trainer"; parts: string[] }
  /** a post saved or deleted */
  | { kind: "posts" }
  /** Hüpikaken (the home page's popup: the campaign or the newsletter sign-up) */
  | { kind: "campaign" }
  /** Seaded: contact and newsletter (footer, every page), privacy, terms and `contract_contact` (the course pages' contract); `course_terms` (the carts' contract); `prepayment` shows on no public page */
  | { kind: "settings"; parts: string[] };

export type CacheTarget = { path: string; type?: "page" | "layout" };

const SITE = "/[locale]/(site)";
const page = (route: string): CacheTarget => ({ path: SITE + route, type: "page" });
const below = (route: string): CacheTarget => ({ path: SITE + route, type: "layout" });

const HOME = page("");
const EVERY_PAGE = below("");
const CALENDAR = page("/koolituskalender");
/** the catalogue and every course page */
const COURSES = below("/koolitused");
const COURSE_PAGES = page("/koolitused/[slug]");
/** the empty cart and every course's cart */
const CARTS = below("/ostukorv");

/** A course's own page in both languages (its slug as stored: lowercase letters, digits and dashes). */
const coursePages = (slug: string): CacheTarget[] => ["et", "ru"].map((l) => ({ path: `/${l}/koolitused/${slug}` }));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The pages that show what `change` changed. */
export function revalidationTargets(change: PublicChange): CacheTarget[] {
  switch (change.kind) {
    case "courses":
      // cards (home, catalogue, recommendations on every course page), the course page, calendar rows, the cart
      return [COURSES, HOME, CALENDAR, CARTS];
    case "sessions":
      // calendar rows, the course page's dates, the next date on cards, the home page's upcoming strip
      return [COURSES, HOME, CALENDAR];
    case "seats":
      // seat states are shown in the calendar and on the course page
      return [...(change.course && SLUG.test(change.course) ? coursePages(change.course) : [COURSE_PAGES]), CALENDAR];
    case "home":
    case "campaign":
      return [HOME];
    case "practice":
      return [HOME, page("/praktika")];
    case "posts":
      return [below("/uudised"), HOME];
    case "trainer": {
      const parts = new Set(change.parts);
      // the trainer's name is in the footer; portrait, role and stats also on the home page, /kontakt, course pages
      if (parts.has("trainer")) return [EVERY_PAGE];
      const out: CacheTarget[] = [];
      if (parts.size > 0) out.push(page("/koolitaja"));
      if (parts.has("bio")) out.push(HOME, COURSE_PAGES); // the teaser and the course page's trainer card
      return out;
    }
    case "settings": {
      const parts = new Set(change.parts);
      // contact details and the newsletter discount are in the footer
      if (parts.has("contact") || parts.has("newsletter")) return [EVERY_PAGE];
      // the contracts (contracts, D1): "contract_contact" (Seaded → Lepingud, Maria's contact contract) is the text the course pages' registration
      // form shows inline, and "terms" (the public „Õppetingimused“) is that text until she writes her own, so each revalidates the course pages:
      // the form refuses a stale contract version and refreshes, and a page kept for minutes would show the student the same refusal again.
      // "course_terms" (the e-course terms) is the e-course contract, which every cart shows inline. "prepayment" (where to pay) is read through
      // the account's JSON only (GET /api/konto, never cached), so it has no target
      return [
        ...(parts.has("privacy") ? [page("/privaatsus")] : []),
        ...(parts.has("terms") ? [page("/tingimused")] : []),
        ...(parts.has("terms") || parts.has("contract_contact") ? [COURSE_PAGES] : []),
        ...(parts.has("course_terms") ? [CARTS] : []),
      ];
    }
  }
}

