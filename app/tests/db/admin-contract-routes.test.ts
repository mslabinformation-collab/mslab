import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { contracts, pages, registrations, settings } from "@/db/schema";
import { CONTRACT_CONTACT_KEY, CONTRACT_CONTACT_VERSION_KEY } from "@/domain/contract";
import { INVOICE_KEY } from "@/domain/invoice";
import { createSession } from "@/server/auth";
import { sampleContractPdf } from "@/server/contract-sample";
import { contractForRegistration, contractPdf, registrationContractFields, saveContractTexts } from "@/server/contracts";
import { readPdf } from "../pdf-read";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// Maria's contract downloads (contracts Task 5, spec §4): GET /api/admin/leping/<id> (any contract as a PDF) and POST /api/admin/naidisleping (Seaded's
// sample from the card's texts). Signed-in admins only; every answer is private, never kept, nosniff. The database is PGlite, the real renderer and fonts
// are used (wrapped, so a test can make a render fail), and the session cookie (next/headers) is faked, as in tests/db/admin-invoice-routes.test.ts.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/contracts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/contracts")>();
  return { ...real, contractPdf: vi.fn(real.contractPdf) };
});
vi.mock("@/server/contract-sample", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/contract-sample")>();
  return { ...real, sampleContractPdf: vi.fn(real.sampleContractPdf) };
});

import { GET as downloadContract, maxDuration } from "@/app/api/admin/leping/[id]/route";
import { POST as downloadSample, maxDuration as sampleMaxDuration } from "@/app/api/admin/naidisleping/route";

const ORIGIN = "https://mslab.example";
const NBSP = " ";
const NOW = new Date("2026-10-17T09:00:00Z");
const LATER = new Date("2026-10-18T09:00:00Z");
const SCHOOL = { company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu" };
const CARD = { ...SCHOOL, vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" };
const CONTACT = {
  title: { et: "Kontaktkoolituse leping", ru: "Договор очного обучения" },
  body: { et: "Õpilane {nimi} ({e-post}) registreerub koolitusele {koolitus}.\n\nHind {hind}.", ru: "Ученик {nimi} записывается на курс {koolitus}." },
};

let db: Db;
let fixture: Awaited<ReturnType<typeof contactCourse>>;
/** Kati's first contract (superseded by the second), the second, and the contract of a registration that is cancelled since. */
let first: number;
let second: number;
let cancelled: number;
let cancelledRegistration: number;

/** What the student's tick on the form does: the fields and the template of the registration, then the contract, in one transaction. */
async function accept(registrationId: number, via: "form" | "account", now: Date) {
  return db.transaction(async (tx) => {
    const f = (await registrationContractFields(tx, registrationId))!;
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, registrationId));
    return contractForRegistration(tx, { registrationId, clientId: r.clientId, courseId: r.courseId, template: f.template, fields: f.fields, prepaymentText: f.prepaymentText, via, now });
  });
}

beforeAll(async () => {
  db = await makeTestDb();
  await setSetting(db, INVOICE_KEY, CARD);
  expect(await saveContractTexts(db, CONTACT, NOW)).toEqual({ ok: true });
  fixture = await contactCourse(db, { capacity: 20 });
  const kati = await registrationOn(db, fixture, { email: "kati@example.test", name: "Kati Tamm" });
  first = (await accept(kati.id, "form", NOW)).id;
  second = (await accept(kati.id, "account", LATER)).id;
  const mari = await registrationOn(db, fixture, { email: "mari@example.test", name: "Mari Maasikas" });
  cancelled = (await accept(mari.id, "form", NOW)).id;
  cancelledRegistration = mari.id;
  await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, mari.id));
});
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.mocked(contractPdf).mockClear();
  vi.mocked(sampleContractPdf).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const pdf = (id: string) => downloadContract(new Request(`${ORIGIN}/api/admin/leping/${id}`), { params: Promise.resolve({ id }) });
const sampleRequest = (fields: Record<string, string> | null, headers: Record<string, string> = {}) => {
  if (fields === null) return new Request(`${ORIGIN}/api/admin/naidisleping`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request(`${ORIGIN}/api/admin/naidisleping`, { method: "POST", headers, body: form });
};
const sample = (fields: Record<string, string> | null = {}, headers: Record<string, string> = {}) => downloadSample(sampleRequest(fields, headers), undefined);
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
/** The text a PDF draws, all its pages, one run a line. */
const textOf = async (bytes: Buffer) => {
  const out: string[] = [];
  const pageCount = (await import("pdf-lib").then((m) => m.PDFDocument.load(new Uint8Array(bytes)))).getPageCount();
  for (let i = 0; i < pageCount; i++) out.push(...(await readPdf(new Uint8Array(bytes), i)).runs.map((r) => r.text));
  return out.join("\n");
};

describe("without an admin's session", () => {
  test("every route answers 401 { ok: false, error: 'unauthorized' } and renders nothing", async () => {
    for (const res of [await pdf(String(second)), await sample({ titleEt: "X", bodyEt: "Y" })]) {
      expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(contractPdf).not.toHaveBeenCalled();
    expect(sampleContractPdf).not.toHaveBeenCalled();
  });

  test("a session of an address that is not an admin's is no session", async () => {
    state.cookie = await createSession(db, "admin@example.test");
    vi.stubEnv("ADMIN_EMAILS", "someone-else@example.test");
    expect((await pdf(String(second))).status).toBe(401);
    expect((await sample()).status).toBe(401);
  });
});

describe("GET /api/admin/leping/<id>: a contract as a PDF", () => {
  test("the PDF as a download named after the contract's id, private and never kept, nosniff", async () => {
    await signIn();
    const res = await pdf(String(second));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="MS-LAB-leping-${second}.pdf"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = await bytesOf(res);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(100 * 1024);
    const text = await textOf(bytes);
    // the frozen copy: the school, the student, the filled text (Maria's own, not the public terms) and the closing line
    for (const part of ["Kontaktkoolituse leping", "MS LAB OÜ", "Kati Tamm", "kati@example.test", "Kulmumeistri baaskoolitus", `350,00${NBSP}€`, "Kinnitatud elektrooniliselt"]) expect(text, part).toContain(part);
  });

  test("a superseded contract is Maria's to download too, under its own id, marked „Asendatud“; the current one is not", async () => {
    await signIn();
    const old = await pdf(String(first));
    expect([old.status, old.headers.get("content-disposition")]).toEqual([200, `attachment; filename="MS-LAB-leping-${first}.pdf"`]);
    expect(await textOf(await bytesOf(old))).toContain("Asendatud");
    expect(await textOf(await bytesOf(await pdf(String(second))))).not.toContain("Asendatud");
  });

  test("the contract of a registration that was cancelled since is still hers to download (set-null links keep the frozen copy)", async () => {
    await signIn();
    const res = await pdf(String(cancelled));
    expect([res.status, res.headers.get("content-disposition")]).toEqual([200, `attachment; filename="MS-LAB-leping-${cancelled}.pdf"`]);
    expect(await textOf(await bytesOf(res))).toContain("Mari Maasikas");
    // ...and after the registration itself is gone
    await db.delete(registrations).where(eq(registrations.id, cancelledRegistration));
    const gone = await pdf(String(cancelled));
    expect(gone.status).toBe(200);
    expect(await textOf(await bytesOf(gone))).toContain("Mari Maasikas");
    expect((await db.select().from(contracts).where(eq(contracts.id, cancelled)))[0].registrationId).toBeNull();
  });

  test("a render that fails answers 500 { ok: false, error: 'server' } and no PDF, and logs the contract's id and the error's class only", async () => {
    await signIn();
    vi.mocked(contractPdf).mockRejectedValueOnce(new TypeError("boom: Kati Tamm, kati@example.test"));
    const res = await pdf(String(second));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(vi.mocked(console.error).mock.calls.map((call) => call.join(" "))).toEqual([`[contracts] contract ${second}: the admin's download failed: TypeError`]);
    expect((await pdf(String(second))).status).toBe(200);
  });

  test("404 { ok: false, error: 'notFound' }: an id that is no contract, or no id at all; nothing is rendered", async () => {
    await signIn();
    for (const id of ["999999", "abc", "0", "007", "2147483648", "-1", "1.5", ""]) {
      const res = await pdf(id);
      expect([res.status, await res.json()], id).toEqual([404, { ok: false, error: "notFound" }]);
    }
    expect(contractPdf).not.toHaveBeenCalled();
  });

  test("a hung call does not hold the function: maxDuration 30, the sample's too", () => {
    expect(maxDuration).toBe(30);
    expect(sampleMaxDuration).toBe(30);
  });
});

describe("POST /api/admin/naidisleping: the sample from the card's texts", () => {
  const countContracts = async () => (await db.select().from(contracts)).length;
  const stored = async () => ({
    page: await db.select().from(pages).where(eq(pages.key, CONTRACT_CONTACT_KEY)),
    version: await db.select().from(settings).where(eq(settings.key, CONTRACT_CONTACT_VERSION_KEY)),
    card: await db.select().from(settings).where(eq(settings.key, INVOICE_KEY)),
  });

  test("an inline PDF, private, never kept, nosniff, that reads the card's texts from the form — saved or not — and fills them with a sample student, course and session", async () => {
    await signIn();
    const res = await sample({
      titleEt: "Proovileping",
      titleRu: "Пробный договор",
      bodyEt: "Õpilane {nimi} ({e-post}) tuleb koolitusele {koolitus}.\n\nToimumine {toimumine}. Hind {hind}, ettemaks {ettemaks}. {tundmatu}",
      bodyRu: "Ученик {nimi}.",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="MS-LAB-naidisleping.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = await bytesOf(res);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(100 * 1024);
    const text = await textOf(bytes);
    // the card's texts (not the stored ones), the placeholders filled, an unknown one as typed, Seaded's school
    for (const part of ["Proovileping", "Proov (näidis)", "naidis@example.test", "Näidiskoolitus", "14.11.2026, Pärnu", `350,00${NBSP}€`, `175,00${NBSP}€`, "{tundmatu}", "MS LAB OÜ", "16346048"]) expect(text, part).toContain(part);
    expect(text).not.toContain("Kontaktkoolituse leping");
    expect(text).not.toContain("{nimi}");
    expect(text).not.toContain("Пробный договор"); // Estonian unless the Russian sample is asked for
  });

  test("lang=ru: the Russian title and text, the Russian labels and the Russian sample course; without a Russian text it is the Estonian one", async () => {
    await signIn();
    const ru = await textOf(await bytesOf(await sample({ titleEt: "Proovileping", titleRu: "Пробный договор", bodyEt: "Eesti tekst.", bodyRu: "Ученик {nimi} на курсе {koolitus}.", lang: "ru" })));
    for (const part of ["Пробный договор", "Ученик Proov (näidis) на курсе Пример курса.", "Стороны"]) expect(ru.replace(/\s+/g, " "), part).toContain(part);
    expect(ru).not.toContain("Eesti tekst.");
    const fallback = await textOf(await bytesOf(await sample({ titleEt: "Proovileping", titleRu: "Пробный договор", bodyEt: "Eesti tekst.", bodyRu: "  ", lang: "ru" })));
    expect(fallback).toContain("Eesti tekst.");
    expect(fallback).toContain("Proovileping");
    expect(fallback).toContain("Pooled");
    // (a Russian title alone, with an Estonian title: it is the Russian one in a Russian contract; an empty Russian title falls back to the Estonian one)
    const mixed = await textOf(await bytesOf(await sample({ titleEt: "Proovileping", titleRu: "", bodyEt: "Eesti tekst.", bodyRu: "Русский текст.", lang: "ru" })));
    expect(mixed).toContain("Proovileping");
    expect(mixed).toContain("Русский текст.");
  });

  test("nothing is stored: the contracts, the contact text's page and its version, and Arve andmed are as they were", async () => {
    await signIn();
    const before = { contracts: await countContracts(), stored: await stored() };
    expect((await sample({ titleEt: "Muu", bodyEt: "Muu tekst, {nimi}.", lang: "et" })).status).toBe(200);
    expect((await sample({ titleEt: "Muu", bodyRu: "Текст", bodyEt: "x", lang: "ru" })).status).toBe(200);
    expect({ contracts: await countContracts(), stored: await stored() }).toEqual(before);
  });

  test("the card empty or the fields wild: a sample all the same, with brackets for the text that is missing, and the school as Seaded has it", async () => {
    await signIn();
    // (the card posts its four texts, empty ones too)
    const empty = await sample({ titleEt: "", titleRu: "", bodyEt: "", bodyRu: "" });
    expect(empty.status).toBe(200);
    const text = await textOf(await bytesOf(empty));
    for (const part of ["(lepingu pealkiri)", "(lepingu tekst)", "MS LAB OÜ"]) expect(text, part).toContain(part);
    // a field that is no text (a file), an unknown field and a language that is neither are ignored
    const form = new FormData();
    form.set("titleEt", new Blob(["x"]), "x.txt");
    form.set("bodyEt", "Tekst.");
    form.set("ignored", "x");
    form.set("lang", "de");
    const wild = await downloadSample(new Request(`${ORIGIN}/api/admin/naidisleping`, { method: "POST", body: form }), undefined);
    expect(wild.status).toBe(200);
    const wildText = await textOf(await bytesOf(wild));
    expect(wildText).toContain("(lepingu pealkiri)");
    expect(wildText).toContain("Tekst.");
  });

  test("before Maria names the company in Arve andmed the school is „MS LAB“ and says nothing false", async () => {
    await signIn();
    await db.delete(settings).where(eq(settings.key, INVOICE_KEY));
    try {
      const text = await textOf(await bytesOf(await sample({ titleEt: "Proovileping", bodyEt: "Tekst." })));
      expect(text).toContain("MS LAB");
      expect(text).not.toContain("MS LAB OÜ");
      expect(text).not.toContain("16346048");
    } finally {
      await setSetting(db, INVOICE_KEY, CARD);
    }
  });

  test("a field longer than the legal texts' limit is cut before it is drawn (40 000 characters)", async () => {
    await signIn();
    vi.mocked(sampleContractPdf).mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect((await sample({ titleEt: "T".repeat(50_000), bodyEt: "B".repeat(50_000), bodyRu: "Р".repeat(50_000), titleRu: "Р", lang: "ru" })).status).toBe(200);
    const values = vi.mocked(sampleContractPdf).mock.calls[0][1];
    expect([values.titleEt!.length, values.bodyEt!.length, values.bodyRu!.length, values.titleRu, values.lang]).toEqual([40_000, 40_000, 40_000, "Р", "ru"]);
  });

  describe("a body is read up to about 1 MB (review M-2)", () => {
    const CYRILLIC = "Р".repeat(40_000);
    const urlencoded = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    const post = (body: BodyInit, headers: Record<string, string> = {}, init: Record<string, unknown> = {}) =>
      downloadSample(new Request(`${ORIGIN}/api/admin/naidisleping`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body, ...init }), undefined);

    test("the largest sample the card can post — four fields of 40 000 Cyrillic characters, six bytes each form-encoded — is read whole; the fields are cut after", async () => {
      await signIn();
      const body = urlencoded({ titleEt: CYRILLIC, titleRu: CYRILLIC, bodyEt: CYRILLIC, bodyRu: CYRILLIC, lang: "ru" });
      expect(body.length).toBeGreaterThan(960_000);
      expect(body.length).toBeLessThan(1_000_000);
      vi.mocked(sampleContractPdf).mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      expect((await post(body)).status).toBe(200);
      const values = vi.mocked(sampleContractPdf).mock.calls[0][1];
      expect([values.titleEt!.length, values.titleRu!.length, values.bodyEt!.length, values.bodyRu!.length]).toEqual([40_000, 40_000, 40_000, 40_000]);
    });

    test("a content-length above the cap is 413 { ok: false, error: 'tooLarge' } before a byte of the body is read, nothing drawn", async () => {
      await signIn();
      const request = new Request(`${ORIGIN}/api/admin/naidisleping`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "1000001" },
        body: urlencoded({ titleEt: "x", bodyEt: "y" }),
      });
      const res = await downloadSample(request, undefined);
      expect([res.status, await res.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
      expect(request.bodyUsed).toBe(false);
      expect(sampleContractPdf).not.toHaveBeenCalled();
      // (and a length at the cap is not refused by it)
      vi.mocked(sampleContractPdf).mockResolvedValueOnce(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      expect((await post(urlencoded({ titleEt: "x", bodyEt: "y" }), { "content-length": "1000000" })).status).toBe(200);
    });

    test("a body that does not say its length (or lies) is read chunk by chunk and dropped at the first byte past the cap: 413, and the rest is never pulled", async () => {
      await signIn();
      const chunk = new TextEncoder().encode("bodyEt=" + "a".repeat(99_993)); // 100 000 bytes
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= 50) return controller.close(); // 5 MB on offer
          pulled += 1;
          controller.enqueue(chunk);
        },
      });
      const res = await post(stream, {}, { duplex: "half" });
      expect([res.status, await res.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
      expect(pulled).toBeLessThan(15); // about eleven chunks fill the cap; the other 39 were never asked for
      expect(sampleContractPdf).not.toHaveBeenCalled();
    });

    test("a small body that arrives as a stream is read and drawn as ever", async () => {
      await signIn();
      const bytes = new TextEncoder().encode(urlencoded({ titleEt: "Proovileping", bodyEt: "Tekst." }));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 10));
          controller.enqueue(bytes.subarray(10));
          controller.close();
        },
      });
      const res = await post(stream, {}, { duplex: "half" });
      expect(res.status).toBe(200);
      expect(await textOf(await bytesOf(res))).toContain("Proovileping");
    });

    test("an empty body is not a form with fields: a post with no text is the stored contact text (its draft when there is one: admin UX pass piece 3b, R-d)", async () => {
      await signIn();
      const res = await post("");
      expect(res.status).toBe(200);
      expect(await textOf(await bytesOf(res))).toContain(CONTACT.title.et);
    });

    test("without a session nothing of the body is read (401 first)", async () => {
      const request = new Request(`${ORIGIN}/api/admin/naidisleping`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: urlencoded({ titleEt: "x" }) });
      expect((await downloadSample(request, undefined)).status).toBe(401);
      expect(request.bodyUsed).toBe(false);
    });
  });

  test("a body that is no form is 400 { ok: false, error: 'invalid' }, nothing drawn", async () => {
    await signIn();
    const res = await sample(null);
    expect([res.status, await res.json()]).toEqual([400, { ok: false, error: "invalid" }]);
    expect(sampleContractPdf).not.toHaveBeenCalled();
  });

  test("a post from another site is refused (403), nothing drawn; the page's own post (its Origin) is fine", async () => {
    await signIn();
    const foreign = await sample({ titleEt: "X", bodyEt: "Y" }, { origin: "https://evil.example" });
    expect([foreign.status, await foreign.json()]).toEqual([403, { ok: false, error: "forbidden" }]);
    expect(sampleContractPdf).not.toHaveBeenCalled();
    expect((await sample({ titleEt: "X", bodyEt: "Y" }, { origin: ORIGIN })).status).toBe(200);
  });

  test("only a post: a GET to the sample is not an answer of the route", async () => {
    const route = await import("@/app/api/admin/naidisleping/route");
    expect(Object.keys(route).filter((k) => /^(GET|HEAD|PUT|PATCH|DELETE|POST)$/.test(k))).toEqual(["POST"]);
  });

  test("a render that fails answers 500 and logs nothing of the texts", async () => {
    await signIn();
    vi.mocked(sampleContractPdf).mockRejectedValueOnce(new TypeError("boom: Proovileping"));
    const res = await sample({ titleEt: "Proovileping", bodyEt: "Tekst." });
    expect([res.status, await res.json()]).toEqual([500, { ok: false, error: "server" }]);
    expect(vi.mocked(console.error).mock.calls.map((call) => call.join(" "))).toEqual(["[contracts] the sample contract failed: TypeError"]);
  });
});
