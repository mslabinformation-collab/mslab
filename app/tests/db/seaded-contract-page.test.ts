import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { pages } from "@/db/schema";
import { saveContractTexts } from "@/server/contracts";
import { makeTestDb } from "./helpers";

// Seaded with its „Lepingud“ card (contracts Task 5, spec D2, §4), rendered from a real (PGlite) database to HTML: the card is the last, a form of its own
// (and the sample's second form) after the settings', the certificate's and the invoice's; it shows Maria's own contact text as stored (empty before her first
// save, never the public „Õppetingimused“ text that stands in for it); the e-course's contract keeps its card in the settings' form, retitled
// „E-koolituse leping (tingimused)“, with the stored page title in its own field; the anchor „#lepingud“ is on the page. The shell and the server actions are
// stand-ins.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/server/actions/admin-site", () => ({ saveSettings: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ saveInvoiceSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => ({ saveContractTextsAction: vi.fn(), requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));

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
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The value of the field with `data-i18n="<name>"`: an input's value or a textarea's text. */
const fieldValue = (html: string, name: string): string | null => {
  const input = new RegExp(`<input[^>]*data-i18n="${name}"[^>]*>`).exec(html)?.[0];
  if (input) return decode(/\svalue="([^"]*)"/.exec(input)?.[1] ?? "");
  const area = new RegExp(`<textarea[^>]*data-i18n="${name}"[^>]*>([^<]*)</textarea>`).exec(html);
  return area ? decode(area[1]) : null;
};

test("before Maria writes anything: the card is the last on the page, a form of its own after the invoice's, its fields empty; the anchor and the sample are there", async () => {
  const html = await page();
  expect(html).toContain('data-shell-active="settings"');
  const invoice = html.indexOf("data-invoice-settings");
  const card = html.indexOf("data-contract-texts");
  expect(invoice).toBeGreaterThan(-1);
  expect(card).toBeGreaterThan(invoice);
  expect(html.slice(html.lastIndexOf("<section", card))).toMatch(/^<section id="lepingud"/);
  expect(html.slice(card)).not.toContain("<section"); // the last card
  expect(html.slice(card)).toContain("Kontaktkoolituse leping");
  expect([fieldValue(html, "contract.title"), fieldValue(html, "contract.body")]).toEqual(["", ""]);
  expect(html.slice(card)).toContain('action="/api/admin/naidisleping"');
  // the public „Õppetingimused“ text stands in for hers for the student, not in the card
  await db.insert(pages).values({ key: "terms", title: { et: "Õppetingimused" }, body: { et: "Avalik tingimuste tekst." } });
  const again = await page();
  expect(again.slice(again.indexOf("data-contract-texts"))).not.toContain("Avalik tingimuste tekst."); // (the „Õppetingimused“ card above it holds it, as it should)
  expect([fieldValue(again, "contract.title"), fieldValue(again, "contract.body")]).toEqual(["", ""]);
});

test("after her first save: her title and text in the fields, as stored", async () => {
  expect(await saveContractTexts(db, { title: { et: "Kontaktkoolituse leping", ru: "Договор" }, body: { et: "Õpilane {nimi}.\n\nTeine lõik.", ru: "Ученик {nimi}." } }, new Date("2026-10-17T09:00:00Z"))).toEqual({ ok: true });
  const html = await page();
  expect(fieldValue(html, "contract.title")).toBe("Kontaktkoolituse leping");
  expect(fieldValue(html, "contract.body")).toBe("Õpilane {nimi}.\n\nTeine lõik.");
  // (the Russian text is behind the switch, so the Russian sample is offered)
  expect(html.slice(html.indexOf("data-contract-texts"))).toContain("Näidisleping vene keeles (PDF)");
});

test("the e-course's contract keeps its card in the settings' form, retitled, with its stored page title in a field of its own (ruling R3)", async () => {
  await db.insert(pages).values({ key: "course_terms", title: { et: "E-koolituse leping", ru: "Договор онлайн-обучения" }, body: { et: "Tere {nimi}." } });
  const html = await page();
  const editor = html.slice(html.indexOf('data-legal-editor="course_terms"'));
  expect(editor.slice(0, editor.indexOf("</section>"))).toContain("E-koolituse leping (tingimused)");
  expect(fieldValue(html, "course_terms.title")).toBe("E-koolituse leping");
  expect(fieldValue(html, "course_terms.body")).toBe("Tere {nimi}.");
  expect(html).toContain("Soovitus: „E-koolituse leping“.");
  // the settings' form ends before the contracts' card begins, and the e-course card is inside it
  expect(html.indexOf("</form>")).toBeGreaterThan(html.indexOf('data-legal-editor="course_terms"'));
  expect(html.indexOf("</form>")).toBeLessThan(html.indexOf("data-contract-texts"));
});
