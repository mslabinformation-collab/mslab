import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses } from "@/db/schema";
import { makeTestDb } from "./helpers";
import { sectionOf } from "./seaded-page";

// Seaded with its „Valdkonnad“ card (course areas, spec 2026-11-11-course-areas-filter-design.md §4.1; components/admin/AreasSettings.tsx), rendered
// from a real (PGlite) database to HTML: its own section after „Uudiskiri“, the migration's two areas in their order with both names, „Kustuta“
// for each, greyed for the one courses use, with the count („2 koolitust“, „Pole kasutusel“); the dashed „Lisa valdkond +“ row below.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/server/actions/admin-contracts", () => ({ requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));

import SettingsEditPage from "@/app/admin/(panel)/seaded/page";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  vi.stubEnv("ADMIN_EMAILS", "maria@example.test");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const page = async () => renderToStaticMarkup(await SettingsEditPage());

test("the card in its own section „Valdkonnad“ after „Uudiskiri“: both areas with both names, „Kustuta“ or how many courses use it, „Lisa valdkond“", async () => {
  for (const slug of ["a", "b"]) {
    await db.insert(courses).values({ slug, type: "contact", level: "basic", title: { et: slug }, summary: { et: "" }, body: { et: "" }, areaId: 1, sort: 1 });
  }
  const html = await page();
  expect(sectionOf(html, "data-areas-card")).toBe("valdkonnad");
  expect(html.indexOf('id="valdkonnad"')).toBeGreaterThan(html.indexOf('id="uudiskiri"'));
  expect(html.indexOf('id="valdkonnad"')).toBeLessThan(html.indexOf('id="maksmine"'));
  const card = html.slice(html.indexOf("data-areas-card"), html.indexOf("</section>", html.indexOf("data-areas-card")));
  for (const name of ["Kulmukoolitused", "Курсы по бровям", "Ripsmekoolitused", "Курсы по ресницам"]) expect(card).toContain(`value="${name}"`);
  expect(card.indexOf("Kulmukoolitused")).toBeLessThan(card.indexOf("Ripsmekoolitused"));
  expect(card).toContain("2 koolitust");
  expect(card).toContain("Pole kasutusel");
  // one „Kustuta“ per row; the used area's greyed (aria-disabled)
  expect(card.match(/data-area-delete/g)).toHaveLength(2);
  expect(card.match(/aria-disabled="true"[^>]*data-area-delete/g)).toHaveLength(1);
  expect(card).toContain("Lisa valdkond +");
  expect(card).not.toContain("Salvesta");
});
