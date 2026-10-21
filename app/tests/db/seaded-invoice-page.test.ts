import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { tallinnYear } from "@/domain/certificate";
import { createInvoice } from "@/server/invoices";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// Seaded with its „Arve andmed“ card (invoices Task 5, spec D2, D7), rendered from a real (PGlite) database to HTML: the card is a form of its own
// after the settings' and the certificate's, it shows the stored setting (or the defaults), the next number as the next issue will take it with the
// last number issued beside it, and the bank details of „Ettemaksu juhised“ read-only; the anchors „#arve“ (the drawer's link) and „#ettemaks“ (the
// card's link) are on the page. The shell and the server actions are stand-ins.

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
/** The value of the card's input `data-invoice-field="<field>"`. */
const valueOf = (html: string, field: string) => {
  const tag = new RegExp(`<input[^>]*data-invoice-field="${field}"[^>]*>`).exec(html)?.[0] ?? "";
  return /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
};

test("without a setting: the defaults (MSL, VAT off at 24, a week), nothing issued; the card is a form of its own after the certificate's; the bank is missing", async () => {
  const html = await page();
  expect(html).toContain('data-shell-active="settings"');
  const certificate = html.indexOf("data-certificate-settings");
  const card = html.indexOf("data-invoice-settings");
  expect(card).toBeGreaterThan(certificate);
  expect(html.match(/<form/g)).toHaveLength(5); // (the settings', the certificate's, this card's and the contracts' two after it: the save and the sample, contracts Task 5)
  expect(html.slice(html.lastIndexOf("<section", card))).toMatch(/^<section id="arve"/);
  expect(["company", "registryCode", "address", "vatNumber", "vatRate", "prefix", "nextSeq", "termDays", "footer"].map((f) => valueOf(html, f))).toEqual(["", "", "", "", "24", "MSL", "1", "7", ""]);
  expect(html.slice(card)).toContain("pole veel arveid väljastatud");
  expect(html.slice(card)).toContain("data-invoice-bank-missing");
});

test("a stored setting and the bank details: the values in the fields, the bank read-only with the IBAN in groups; the prepayment card carries the anchor the link goes to", async () => {
  await setSetting(db, "invoice", CARD);
  await setSetting(db, "prepayment", BANK);
  const html = await page();
  expect(html).toMatch(/<section id="ettemaks"[^>]*data-prepayment-editor/);
  const card = html.slice(html.indexOf("data-invoice-settings"));
  expect(["company", "registryCode", "address", "vatNumber", "vatRate", "prefix", "nextSeq", "termDays", "footer"].map((f) => valueOf(html, f))).toEqual([
    "MS LAB OÜ", "16346048", "Rüütli 1, 80010 Pärnu", "EE100200300", "22", "ABC", "1", "14", "Täname!",
  ]);
  expect(valueOf(html, "nextYear")).toBeNull(); // (B21: the year is never typed)
  expect(card).toMatch(/data-invoice-field="vatOn"[^>]*checked|checked=""[^>]*data-invoice-field="vatOn"/);
  const bank = card.slice(card.indexOf("data-invoice-bank"));
  for (const part of ["MS LAB Koolituskeskus OÜ", "EE38 2200 2210 2014 5685", "Swedbank", 'href="/admin/seaded#ettemaks"']) expect(bank, part).toContain(part);
  expect(card).not.toContain("data-invoice-bank-missing");
  expect(card).toContain('href="/api/admin/naidisarve?');
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
  expect(html).toMatch(/Viimati väljastatud: MSL\d{4}-002/);
});
