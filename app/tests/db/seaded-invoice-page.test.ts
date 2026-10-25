import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { tallinnYear } from "@/domain/certificate";
import { createInvoice } from "@/server/invoices";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";
import { sectionOf } from "./seaded-page";

// Seaded with its „Maksmine“ card (invoices Task 5, spec D2, D7; admin UX pass piece 3b, Task 4: README B4, B21, ruling R-f, P-9, P-10), rendered from
// a real (PGlite) database to HTML: one card in the section „Maksmine“ — the bank fields of the prepayment instructions (editable: one source for both)
// and the invoice settings, no form and no save button (it autosaves) — showing the stored setting (or the defaults), „Arve järgmine number“ as the
// next issue will take it with its preview and the last number issued beside it; the old anchors #arve, #ettemaks and #jarelmaks lead to the section.
// The legal texts' actions are stand-ins.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/server/actions/admin-contracts", () => ({ requestContractAction: vi.fn(), sendContractCopyAction: vi.fn() }));
// (the card reads the page again once a new prefix is stored: the router is a stand-in here)
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));

import SettingsEditPage from "@/app/admin/(panel)/seaded/page";

const CARD = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "EE100200300", vatOn: true, vatRate: 22, prefix: "ABC", nextYear: 2026, nextSeq: 1, termDays: 14, footer: "Täname!" };
const BANK = { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };

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
/** The value of the input marked `<attribute>="<field>"`. */
const valueIn = (attribute: string) => (html: string, field: string) => {
  const tag = new RegExp(`<input[^>]*${attribute}="${field}"[^>]*>`).exec(html)?.[0] ?? "";
  return /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
};
const valueOf = valueIn("data-invoice-field");
const bankOf = valueIn("data-bank-field");
/** The card's HTML: from its section to the section's end. */
const cardOf = (html: string) => {
  const at = html.indexOf("data-invoice-settings");
  return html.slice(html.lastIndexOf("<section", at), html.indexOf("data-financing-settings"));
};
const THIS = () => tallinnYear(new Date());

test("without a setting: the defaults (MSL, VAT off at 24, a week), nothing issued, the preview of 001; one card in „Maksmine“, no form, the bank fields empty and the bank missing", async () => {
  const html = await page();
  expect(sectionOf(html, "data-invoice-settings")).toBe("maksmine");
  const card = cardOf(html);
  expect(card).not.toMatch(/<form|type="submit"/);
  expect(card).toContain(">Maksmine</h2>");
  expect(["company", "registryCode", "address", "vatNumber", "vatRate", "prefix", "nextSeq", "termDays", "footer"].map((f) => valueOf(html, f))).toEqual(["", "", "", "", "24", "MSL", "1", "7", ""]);
  expect(["receiver", "iban", "bank", "referencePrefix"].map((f) => bankOf(html, f))).toEqual(["", "", "", ""]);
  expect(card).toContain(`Järgmine arve: MSL${THIS()}-001`);
  expect(card).toContain("pole veel arveid väljastatud");
  expect(card).toContain("data-invoice-bank-missing");
  expect(card).toContain("Saaja ja IBAN on täitmata: pangaülekande arvet ei saa koostada.");
});

test("the old anchors lead to „Maksmine“: #arve, #ettemaks and #jarelmaks at the section's start, before its first card", async () => {
  const html = await page();
  for (const alias of ["arve", "ettemaks", "jarelmaks"]) {
    const at = html.indexOf(`id="${alias}"`);
    expect(at, alias).toBeGreaterThan(-1);
    expect(sectionOf(html, `id="${alias}"`), alias).toBe("maksmine");
    expect(at, alias).toBeLessThan(html.indexOf("data-invoice-settings"));
  }
  expect(sectionOf(html, "data-certificate-settings")).toBe("tunnistus");
});

test("a stored setting and the bank details: the values in the fields, the bank's in its own fields (one source), VAT ticked, no year; the sample holds the card's values", async () => {
  await setSetting(db, "invoice", CARD);
  await setSetting(db, "prepayment", BANK);
  const html = await page();
  const card = cardOf(html);
  expect(["company", "registryCode", "address", "vatNumber", "vatRate", "prefix", "nextSeq", "termDays", "footer"].map((f) => valueOf(html, f))).toEqual([
    "MS LAB OÜ", "16346048", "Rüütli 1, 80010 Pärnu", "EE100200300", "22", "ABC", "1", "14", "Täname!",
  ]);
  expect(["receiver", "iban", "bank", "referencePrefix"].map((f) => bankOf(html, f))).toEqual(["MS LAB Koolituskeskus OÜ", "EE382200221020145685", "Swedbank", "MSLAB-"]);
  expect(valueOf(html, "nextYear")).toBeNull(); // (B21: the year is never typed)
  expect(card).toMatch(/data-invoice-field="vatOn"[^>]*checked|checked=""[^>]*data-invoice-field="vatOn"/);
  expect(card).not.toContain("data-invoice-bank-missing");
  expect(card).toContain('href="/api/admin/naidisarve?');
  expect(card).not.toContain('href="/admin/seaded'); // (no link to another card: the bank is here)
});

test("the next number is the one the next issue takes, with the last issued beside it", async () => {
  await setSetting(db, "invoice", { ...CARD, vatOn: false, prefix: "MSL" });
  await setSetting(db, "prepayment", BANK);
  const c = await contactCourse(db);
  const now = new Date();
  for (const email of ["a@example.com", "b@example.com"]) {
    const made = await createInvoice(db, (await registrationOn(db, c, { email })).id, { kind: "prepayment", mode: "request" }, now);
    expect(made.ok).toBe(true);
  }
  // (the setting itself was moved on by the issues; pushed back, the card still shows what an issue would take)
  await setSetting(db, "invoice", { ...CARD, vatOn: false, prefix: "MSL", nextYear: tallinnYear(now), nextSeq: 1 });
  const html = await page();
  expect(valueOf(html, "nextSeq")).toBe("3");
  expect(html).toContain(`Järgmine arve: MSL${tallinnYear(now)}-003`);
  expect(html).toMatch(/Viimati väljastatud: MSL\d{4}-002/);
});
