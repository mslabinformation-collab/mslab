import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { makeTestDb } from "./helpers";

// Seaded with its „Järelmaks (Inbank)“ card (instalments Task 5, spec D4), rendered from a real (PGlite) database to HTML: the card is a form of its
// own after „Arve andmed“ and before „Lepingud“; the box is ticked only by a stored `{ enabled: true }` (no row, a wrong shape or anything else is off).
// The server actions are stand-ins.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/server/actions/admin-site", () => ({ saveSettings: vi.fn() }));
vi.mock("@/server/actions/admin-certificates", () => ({ saveCertificateSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => ({ saveInvoiceSettingsAction: vi.fn() }));
vi.mock("@/server/actions/admin-financing", () => ({ saveFinancingSettingsAction: vi.fn() }));
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
/** The card's checkbox tag. */
const boxOf = (html: string) => /<input[^>]*data-financing-enabled[^>]*>/.exec(html)?.[0] ?? "";

test("without a stored setting: the card is there, after „Arve andmed“ and before „Lepingud“, and the box is not ticked", async () => {
  const html = await page();
  const invoice = html.indexOf("data-invoice-settings");
  const card = html.indexOf("data-financing-settings");
  const contracts = html.indexOf("data-contract-texts");
  expect(invoice).toBeGreaterThan(-1);
  expect(card).toBeGreaterThan(invoice);
  expect(contracts).toBeGreaterThan(card);
  expect(html.slice(html.lastIndexOf("<section", card))).toMatch(/^<section id="jarelmaks"/);
  const section = html.slice(card, contracts);
  expect(section).toContain("Järelmaks (Inbank)");
  expect(section).toContain("Paku järelmaksu (Inbank)");
  expect(section).toContain("Lülita sisse, kui Montonio on järelmaksu sinu poele avanud. Hind peab olema 100–5000 €.");
  expect(section).toContain("Salvesta");
  expect(boxOf(html)).toContain('type="checkbox"');
  expect(boxOf(html)).not.toMatch(/\schecked/);
});

test("a stored { enabled: true } ticks the box; { enabled: false } does not", async () => {
  await setSetting(db, "financing", { enabled: true });
  expect(boxOf(await page())).toMatch(/\schecked/);
  await setSetting(db, "financing", { enabled: false });
  expect(boxOf(await page())).not.toMatch(/\schecked/);
});

test("anything but exactly { enabled: true } is off: the string \"true\", 1, a bare true, an array, an empty object", async () => {
  for (const value of [{ enabled: "true" }, { enabled: 1 }, true, [{ enabled: true }], {}]) {
    await setSetting(db, "financing", value);
    expect(boxOf(await page()), JSON.stringify(value)).not.toMatch(/\schecked/);
  }
});
