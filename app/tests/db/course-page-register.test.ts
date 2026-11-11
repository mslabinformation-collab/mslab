import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { makeTestDb } from "./helpers";
import { protocolCourse } from "./protocols-fixtures";

// The course page's registration on a phone (UX pass 11.11 P5, Dim's call 2; the Telefon-kursus board): a contact course's page holds the facts, then
// „Registreeru ↓“ (a jump to the form) with „Kuupäeva ja makseviisi valid lehe lõpus.“, and the form is its own block after the course's texts in
// the page under its own title „Registreeru“, the order a phone shows (one column below 980 px); on a computer the grid places the form in the right column beside the gallery, as
// before (the texts between hold nothing to tab to, so the keyboard goes from the facts to the form there too). An e-course's short buy box stays
// under the facts, with no jump. The real page, from a real (PGlite) database, rendered to HTML.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
// (the registration form reads the router, which a page rendered to HTML here has not got)
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/headers", async (original) => ({ ...(await original<typeof import("next/headers")>()), draftMode: async () => ({ isEnabled: false }) }));

import CoursePage from "@/app/[locale]/(site)/koolitused/[slug]/page";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
});
afterEach(() => vi.restoreAllMocks());

const page = (locale: "et" | "ru", slug: string) => CoursePage({ params: Promise.resolve({ locale, slug }) }).then((tree) => renderToStaticMarkup(tree));
/** Where a marker first stands in the page (-1: not there). */
const at = (html: string, marker: string) => html.indexOf(marker);

describe("the course page's registration (UX pass 11.11 P5)", () => {
  test("a contact course: the jump under the facts, then the course's texts, the form after them in its own block", async () => {
    await protocolCourse(db, { body: { et: "Kahe päeva koolitus." }, outcomes: [{ et: "Kulmude kuju" }] });
    const html = await page("et", "kulmude-lami");
    const jump = /<a [^>]*href="#registreeru"[^>]*data-register-jump=""[^>]*>(.*?)<\/a>/.exec(html);
    expect(jump).not.toBeNull();
    expect(jump![1].replace(/<[^>]+>/g, "")).toBe("Registreeru ↓");
    expect(html).toContain("Kuupäeva ja makseviisi valid lehe lõpus.");
    // the order in the page: the facts, the jump, the texts („Koolitusest“), the form's block (#registreeru) with the form
    expect(at(html, "data-course-summary")).toBeLessThan(at(html, "data-register-jump"));
    expect(at(html, "data-register-jump")).toBeLessThan(at(html, "Kahe päeva koolitus."));
    expect(at(html, "Kahe päeva koolitus.")).toBeLessThan(at(html, 'id="registreeru"'));
    expect(html).toMatch(/<section [^>]*id="registreeru"[^>]*aria-labelledby="registreeru-title"[^>]*data-course-register=""/);
    expect(html).toMatch(/<h2 id="registreeru-title"[^>]*>Registreeru<\/h2>/);
    expect(at(html, 'id="registreeru"')).toBeLessThan(at(html, "data-register-form"));
    const ru = await page("ru", "kulmude-lami");
    const ruJump = /<a [^>]*data-register-jump=""[^>]*>(.*?)<\/a>/.exec(ru);
    expect(ruJump![1].replace(/<[^>]+>/g, "")).toBe("Записаться ↓");
    expect(ru).toMatch(/<h2 id="registreeru-title"[^>]*>Записаться<\/h2>/);
  });

  test("an e-course: its buy box stays under the facts, before the texts; no jump", async () => {
    await protocolCourse(db, { slug: "e-kulm", type: "e_learning", price: 19900, body: { et: "Kahe päeva koolitus." } });
    const html = await page("et", "e-kulm");
    expect(html).not.toContain("data-register-jump");
    expect(html).not.toContain('id="registreeru"');
    expect(at(html, "data-course-summary")).toBeLessThan(at(html, "data-buy"));
    expect(at(html, "data-buy")).toBeLessThan(at(html, "Kahe päeva koolitus."));
  });
});
