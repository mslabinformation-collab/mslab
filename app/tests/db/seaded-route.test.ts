import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { readSetting } from "@/db/queries/public";
import { certificates, clients, courseAccess, courses } from "@/db/schema";
import { tallinnYear } from "@/domain/certificate";
import { createSession } from "@/server/auth";
import { createInvoice, invoiceCard } from "@/server/invoices";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// Seaded's autosave (admin UX pass piece 3b, Task 4; README B4, B21; rulings R-f, R3): POST /api/admin/seaded/<part> for every card of the page —
// contact | newsletter | prepayment | invoice | certificate | financing — under server/autosave-route.ts' contract (200 the part's new version, 409
// what is stored, 400 by field, 404 for no such part). A contact, newsletter, prepayment or financing part's version is the hash of its stored
// setting; the invoice's and the certificate's (their stored JSON, which an issue also writes) is two hashes, of the texts and of the number series'
// counter, so an invoice issued while Maria types is no conflict of her texts, while a number another tab saved is. A number already issued is
// `taken` whatever version it was sent from (Review Focus 1: "a number field that another tab took shows `taken` in the field"). On PGlite, with the
// admin's session cookie faked (as tests/db/course-parts-routes.test.ts does).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST } from "@/app/api/admin/seaded/[part]/route";

const ORIGIN = "https://mslab.example";
const HEX = "[0-9a-f]{32}";
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const save = async (part: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await POST(
    new Request(`${ORIGIN}/api/admin/seaded/${part}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ part }) },
  );
  return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
};
/** The part's version as the route holds it now: a save from no version is a conflict, which tells it. */
const versionOf = async (part: string) => {
  const a = await save(part, { version: "?", patch: {} });
  expect(a.status, part).toBe(409);
  return a.body.version as string;
};
const setting = (key: string) => readSetting(db, key);

const SELLER = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
const BANK = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const year = () => tallinnYear(new Date());

describe("the route", () => {
  test("without an admin's session: 401; from another site: 403; a part that is none: 404; a body that is not a save: 400 — nothing stored", async () => {
    expect((await save("contact", { version: "x", patch: { phone: "+372 5555 0101" } })).status).toBe(401);
    await signIn();
    expect((await save("contact", { version: "x", patch: { phone: "+372 5555 0101" } }, { origin: "https://evil.example" })).status).toBe(403);
    for (const part of ["kontakt", "privacy", "course_terms", ""]) expect((await save(part, { version: "x", patch: {} })).status, part).toBe(404);
    expect(await save("contact", { patch: {} })).toMatchObject({ status: 400, body: { ok: false, error: "body" } });
    expect(await setting("contact")).toBeNull();
  });
});

describe("contact, newsletter, prepayment: the settings parts", () => {
  test("contact: a field saved trimmed and the other keys kept, the version the stored setting's hash; the footer pages revalidated once", async () => {
    await signIn();
    await setSetting(db, "contact", { email: "info@example.test", phone: "", address: "Pärnu", instagram: "", facebook: "", extra: "kept" });
    const v1 = await versionOf("contact");
    expect(v1).toMatch(new RegExp(`^${HEX}$`));
    const ok = await save("contact", { version: v1, patch: { phone: " +372 5555  0101 " } });
    expect(ok).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(new RegExp(`^${HEX}$`)), savedAt: expect.any(String) } });
    expect(await setting("contact")).toEqual({ email: "info@example.test", phone: "+372 5555 0101", address: "Pärnu", instagram: "", facebook: "", extra: "kept" });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "settings", parts: ["contact"] });
    // the same text again: nothing written, the version stays, nothing revalidated
    const v2 = ok.body.version as string;
    expect(await save("contact", { version: v2, patch: { phone: "+372 5555 0101" } })).toMatchObject({ status: 200, body: { version: v2 } });
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
  });

  test("contact: two tabs — the second save from the old version is a conflict with the stored text, nothing written", async () => {
    await signIn();
    const v1 = await versionOf("contact");
    expect((await save("contact", { version: v1, patch: { address: "Rüütli 12, Pärnu" } })).status).toBe(200);
    const late = await save("contact", { version: v1, patch: { address: "Tartu" } });
    expect(late).toMatchObject({ status: 409, body: { ok: false, error: "conflict", version: expect.stringMatching(new RegExp(`^${HEX}$`)), value: { email: "", phone: "", address: "Rüütli 12, Pärnu", instagram: "", facebook: "" } } });
    expect(((await setting("contact")) as { address: string }).address).toBe("Rüütli 12, Pärnu");
  });

  test("contact: refused by field (the e-mail, the phone, an https link only), a field that is not the card's too; nothing written", async () => {
    await signIn();
    const v = await versionOf("contact");
    expect(await save("contact", { version: v, patch: { email: "info@", phone: "helista", instagram: "http://instagram.com/x", facebook: "javascript:alert(1)" } })).toMatchObject({
      status: 400,
      body: { ok: false, error: "invalid", fields: { email: "email", phone: "phone", instagram: "url", facebook: "url" } },
    });
    expect(await save("contact", { version: v, patch: { iban: "EE38" } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { iban: expect.any(String) } } });
    expect(await save("contact", { version: v, patch: { email: 7 } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { email: expect.any(String) } } });
    expect(await setting("contact")).toBeNull();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test("newsletter: the welcome code in capitals, the discount required; a code alone on a missing row is saved", async () => {
    await signIn();
    const v = await versionOf("newsletter");
    expect(await save("newsletter", { version: v, patch: { discountLabel: " " } })).toMatchObject({ status: 400, body: { fields: { discountLabel: "required" } } });
    expect(await save("newsletter", { version: v, patch: { welcomeCode: "tere 10" } })).toMatchObject({ status: 400, body: { fields: { welcomeCode: "codeFormat" } } });
    expect(await save("newsletter", { version: v, patch: { welcomeCode: " tere-10 " } })).toMatchObject({ status: 200 });
    expect(await setting("newsletter")).toEqual({ welcomeCode: "TERE-10" });
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "settings", parts: ["newsletter"] });
  });

  test("prepayment: the IBAN without spaces in capitals, a bad one refused with its own code; all four keys stored", async () => {
    await signIn();
    const v = await versionOf("prepayment");
    expect(await save("prepayment", { version: v, patch: { iban: "EE38 12" } })).toMatchObject({ status: 400, body: { fields: { iban: "iban" } } });
    const ok = await save("prepayment", { version: v, patch: { receiver: " MS LAB OÜ ", iban: "ee38 2200 2210 2014 5685" } });
    expect(ok.status).toBe(200);
    expect(await setting("prepayment")).toEqual({ receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "", referencePrefix: "" });
    expect(await save("prepayment", { version: v, patch: { bank: "Swedbank" } })).toMatchObject({ status: 409, body: { value: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "", referencePrefix: "" } } });
  });
});

describe("invoice (Maksmine's „Arve andmed“; R3, B21)", () => {
  /** Maria's request to pay on a new registration of `course`, issued now: its number. */
  const issue = async (email: string) => {
    const made = await createInvoice(db, (await registrationOn(db, course, { email })).id, { kind: "prepayment", mode: "request" }, new Date());
    if (!made.ok) throw new Error(made.error);
    return made.invoice.number;
  };
  let course: Awaited<ReturnType<typeof contactCourse>>;
  beforeEach(async () => {
    course = await contactCourse(db);
  });

  test("the first field on no stored row: the defaults with it; the version is two hashes, the texts' and the counter's", async () => {
    await signIn();
    const v1 = await versionOf("invoice");
    expect(v1).toMatch(new RegExp(`^i:${HEX}\\.${HEX}$`));
    const ok = await save("invoice", { version: v1, patch: { company: "  MS LAB   OÜ " } });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, version: expect.stringMatching(new RegExp(`^i:${HEX}\\.${HEX}$`)) } });
    expect(await setting("invoice")).toEqual({ company: "MS LAB OÜ", registryCode: "", address: "", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: year(), nextSeq: 1, termDays: 7, footer: "" });
  });

  test("refused by field: the prefix's letters, the VAT rate, the term, the number's range, a required seller field emptied, VAT on without a number (on the box)", async () => {
    await signIn();
    const v = await versionOf("invoice");
    const fields = async (patch: Record<string, unknown>) => {
      const a = await save("invoice", { version: v, patch });
      expect(a.status, JSON.stringify(patch)).toBe(400);
      return a.body.fields;
    };
    expect(await fields({ prefix: "MS-L" })).toEqual({ prefix: "invalid" });
    expect(await fields({ prefix: "" })).toEqual({ prefix: "required" });
    expect(await fields({ vatRate: "0", termDays: "91", nextSeq: "0" })).toEqual({ vatRate: "invalid", termDays: "invalid", nextSeq: "invalid" });
    expect(await fields({ company: " " })).toEqual({ company: "required" });
    expect(await fields({ footer: "F".repeat(301) })).toEqual({ footer: "tooLong" });
    expect(await fields({ vatOn: true })).toEqual({ vatOn: "required" });
    expect(await fields({ vatOn: true, vatNumber: " " })).toEqual({ vatNumber: "required" });
    expect(await fields({ nextYear: "2027" })).toEqual({ nextYear: expect.any(String) }); // (B21: the year is never typed)
    expect(await setting("invoice")).toBeNull();
  });

  test("two tabs: a text saved in one is a conflict of the other's text, with the card as stored (the numbers as the fields hold them)", async () => {
    await signIn();
    await setSetting(db, "invoice", { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: year(), nextSeq: 5, termDays: 7, footer: "" });
    const v1 = await versionOf("invoice");
    expect((await save("invoice", { version: v1, patch: { footer: "Täname!" } })).status).toBe(200);
    expect(await save("invoice", { version: v1, patch: { address: "Tartu" } })).toMatchObject({
      status: 409,
      body: { ok: false, error: "conflict", value: { ...SELLER, vatNumber: "", vatOn: false, vatRate: "24", prefix: "MSL", nextSeq: "5", termDays: "7", footer: "Täname!" } },
    });
    expect(((await setting("invoice")) as { address: string }).address).toBe(SELLER.address);
  });

  test("an invoice issued while she types is no conflict of her text: the counter it moved stays", async () => {
    await signIn();
    await setSetting(db, "invoice", { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: year(), nextSeq: 1, termDays: 7, footer: "" });
    await setSetting(db, "prepayment", BANK);
    const v1 = await versionOf("invoice");
    expect(await issue("a@example.test")).toBe(`MSL${year()}-001`);
    expect(await save("invoice", { version: v1, patch: { footer: "Täname!" } })).toMatchObject({ status: 200 });
    expect(await setting("invoice")).toMatchObject({ footer: "Täname!", nextSeq: 2 });
  });

  test("„Järgmine number“: one already issued is `taken`, whatever version it was sent from (another tab took it); from the old counter a free one is a conflict, from the new one it is stored", async () => {
    await signIn();
    await setSetting(db, "invoice", { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: year(), nextSeq: 1, termDays: 7, footer: "" });
    await setSetting(db, "prepayment", BANK);
    const before = await versionOf("invoice");
    await issue("a@example.test");
    await issue("b@example.test");
    for (const version of [before, await versionOf("invoice")]) {
      expect(await save("invoice", { version, patch: { nextSeq: "2" } }), version).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { nextSeq: "taken" } } });
    }
    // the counter moved under the old version (the issues): a free number from it is not stored over what moved it
    expect(await save("invoice", { version: before, patch: { nextSeq: "9" } })).toMatchObject({ status: 409, body: { value: { nextSeq: "3" } } });
    expect(await setting("invoice")).toMatchObject({ nextSeq: 3 });
    const now = await versionOf("invoice");
    expect(await save("invoice", { version: now, patch: { nextSeq: "9" } })).toMatchObject({ status: 200 });
    expect(await setting("invoice")).toMatchObject({ nextYear: year(), nextSeq: 9 });
    expect((await invoiceCard(db, new Date())).nextSeq).toBe(9);
  });

  test("R3: a new prefix (in capitals) starts its series at 1; back to the old one, its own series goes on from its highest", async () => {
    await signIn();
    await setSetting(db, "invoice", { ...SELLER, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: year(), nextSeq: 1, termDays: 7, footer: "" });
    await setSetting(db, "prepayment", BANK);
    await issue("a@example.test");
    await issue("b@example.test");
    expect(await save("invoice", { version: await versionOf("invoice"), patch: { prefix: "abc" } })).toMatchObject({ status: 200 });
    expect(await setting("invoice")).toMatchObject({ prefix: "ABC", nextSeq: 1 });
    expect((await invoiceCard(db, new Date())).nextSeq).toBe(1);
    expect(await save("invoice", { version: await versionOf("invoice"), patch: { prefix: "MSL" } })).toMatchObject({ status: 200 });
    expect((await invoiceCard(db, new Date())).nextSeq).toBe(3);
    expect(await issue("c@example.test")).toBe(`MSL${year()}-003`);
  });
});

describe("certificate (Tunnistus; D6: the year field stays)", () => {
  const SETTING = { place: "Pärnu linn", registryCode: "16346048", practicalLine: "Praktiline töö", trainerName: "Maria Sosnina" };
  /** A certificate row of `year`-`seq` (an e-course access of its own). */
  const certificate = async (seq: number, y = year()) => {
    const [course] = await db
      .insert(courses)
      .values({ slug: `e-${seq}-${y}`, type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true })
      .returning();
    const [client] = await db.insert(clients).values({ email: `c${seq}-${y}@example.test`, name: "Kati Kask" }).returning();
    const [access] = await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    await db.insert(certificates).values({
      accessId: access.id, number: `MS LAB ${y}-${String(seq).padStart(2, "0")}`, year: y, seq, name: "Kati Kask", courseTitle: "E", skills: [], volume: "", practicalLine: "", place: "", registryCode: "", issuedAt: new Date(),
    });
  };

  test("a text saved; the trainer's name by the name rules; the year this one or the next; a number already issued in that year `taken` even from an older version", async () => {
    await signIn();
    await setSetting(db, "certificate", { ...SETTING, nextYear: year(), nextSeq: 1 });
    const before = await versionOf("certificate");
    expect(before).toMatch(new RegExp(`^c:${HEX}\\.${HEX}$`));
    expect(await save("certificate", { version: before, patch: { place: " Tartu linn " } })).toMatchObject({ status: 200 });
    expect(await setting("certificate")).toMatchObject({ place: "Tartu linn", nextYear: year(), nextSeq: 1 });
    const v = await versionOf("certificate");
    expect(await save("certificate", { version: v, patch: { trainerName: "Мария Соснина" } })).toMatchObject({ status: 400, body: { fields: { trainerName: "letters" } } });
    expect(await save("certificate", { version: v, patch: { nextYear: String(year() - 1) } })).toMatchObject({ status: 400, body: { fields: { nextYear: "invalid" } } });
    await certificate(1);
    await certificate(2);
    for (const version of [before, v]) expect(await save("certificate", { version, patch: { nextSeq: "2" } }), version).toMatchObject({ status: 400, body: { fields: { nextSeq: "taken" } } });
    expect(await save("certificate", { version: v, patch: { nextSeq: "93" } })).toMatchObject({ status: 200 });
    expect(await setting("certificate")).toMatchObject({ nextYear: year(), nextSeq: 93 });
    // next year from 1 (December's preset): nothing issued there yet
    expect(await save("certificate", { version: await versionOf("certificate"), patch: { nextYear: String(year() + 1), nextSeq: "1" } })).toMatchObject({ status: 200 });
    expect(await setting("certificate")).toMatchObject({ nextYear: year() + 1, nextSeq: 1 });
  });

  test("two tabs: a text saved in one is a conflict of the other's, with the card as stored", async () => {
    await signIn();
    await setSetting(db, "certificate", { ...SETTING, nextYear: year(), nextSeq: 4 });
    const v1 = await versionOf("certificate");
    expect((await save("certificate", { version: v1, patch: { registryCode: "12345678" } })).status).toBe(200);
    expect(await save("certificate", { version: v1, patch: { place: "Tartu linn" } })).toMatchObject({
      status: 409,
      body: { value: { ...SETTING, registryCode: "12345678", nextYear: String(year()), nextSeq: "4" } },
    });
  });
});

describe("financing (Järelmaks (Inbank): the switch, instant)", () => {
  test("a boolean only, stored as { enabled } and nothing else; the course pages and the carts revalidated; two tabs a conflict", async () => {
    await signIn();
    const v1 = await versionOf("financing");
    expect(await save("financing", { version: v1, patch: { enabled: "true" } })).toMatchObject({ status: 400, body: { fields: { enabled: expect.any(String) } } });
    expect(await save("financing", { version: v1, patch: { enabled: true, extra: 1 } })).toMatchObject({ status: 400 });
    expect(await setting("financing")).toBeNull();
    const on = await save("financing", { version: v1, patch: { enabled: true } });
    expect(on).toMatchObject({ status: 200 });
    expect(await setting("financing")).toEqual({ enabled: true });
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "settings", parts: ["financing"] });
    expect(await save("financing", { version: v1, patch: { enabled: false } })).toMatchObject({ status: 409, body: { value: { enabled: true } } });
    expect(await save("financing", { version: on.body.version, patch: { enabled: false } })).toMatchObject({ status: 200 });
    expect(await setting("financing")).toEqual({ enabled: false });
  });
});
