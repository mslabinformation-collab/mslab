import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, courseAccess, settings } from "@/db/schema";
import { createSession } from "@/server/auth";
import { formatCertificateNumber, tallinnYear } from "@/domain/certificate";
import { sampleCertificatePdf } from "@/server/certificate-sample";
import { certificatePdf } from "@/server/certificates";
import { at, ecourse, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";
import { readPdf } from "../pdf-read";

// GET /api/admin/tunnistus/<id> (phase 3d, spec §6): Maria's download of any certificate, a revoked access's too — signed-in admins only; the
// PDF rendered from the frozen row (server/certificates.ts certificatePdf, the real fonts of assets/fonts) with Seaded's trainer's name typed
// in the script font as the signature (no image), as a download named after its number, private and never kept. The database is PGlite and
// the session cookie (next/headers) is faked, as in tests/db/admin-photo-route.test.ts.

/** The PDF's only images are the logo (the site's, white, 1280 × 464: Dim 07.11.2026) and its alpha mask; there is no signature image. */
const onlyTheLogo = (pdf: Buffer) => {
  const text = pdf.toString("latin1");
  expect(text.match(/\/Subtype \/Image\b/g) ?? []).toHaveLength(2);
  expect(text.match(/\/Width 1280\b/g) ?? []).toHaveLength(2);
};

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
// the real PDF, wrapped so a test can make one render fail
vi.mock("@/server/certificates", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/certificates")>();
  return { ...real, certificatePdf: vi.fn(real.certificatePdf) };
});

// the sample certificate (Seaded → „Näidistunnistus (PDF)“), wrapped the same way
vi.mock("@/server/certificate-sample", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/certificate-sample")>();
  return { ...real, sampleCertificatePdf: vi.fn(real.sampleCertificatePdf) };
});

import { GET, maxDuration } from "@/app/api/admin/tunnistus/[id]/route";
import { GET as downloadSample, maxDuration as sampleMaxDuration } from "@/app/api/admin/naidistunnistus/route";

const ORIGIN = "https://mslab.example";

let db: Db;
let certId: number;
let accessId: number;
beforeAll(async () => {
  db = await makeTestDb();
  const course = await ecourse(db, { test: null });
  const kati = await student(db, course.id, "Kati", { completedAt: at(8) });
  accessId = kati.access.id;
  const [c] = await db
    .insert(certificates)
    .values({
      accessId,
      number: "MS LAB 2026-03",
      year: 2026,
      seq: 3,
      name: "Kätlin Kask-Žukova",
      courseTitle: "Kulmumeistri e-koolitus",
      skills: ["Kulmude kuju ja proportsioonid", "Värvi valik"],
      volume: "10 akadeemilist tundi",
      practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
      place: "Pärnu linn",
      registryCode: "16346048",
      issuedAt: at(10),
    })
    .returning();
  certId = c.id;
});
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const download = (id: string) => GET(new Request(`${ORIGIN}/api/admin/tunnistus/${id}`), { params: Promise.resolve({ id }) });
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("GET /api/admin/tunnistus/<id>", () => {
  test("without an admin's session: 401, nothing rendered", async () => {
    const res = await download(String(certId));
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
  });

  test("the PDF as a download named after its number, private and never kept, nosniff; no signature image in it (the signature is typed; the logo is the one image)", async () => {
    await signIn();
    const res = await download(String(certId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="MS-LAB-tunnistus-2026-03.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const pdf = await bytesOf(res);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeLessThan(300 * 1024);
    onlyTheLogo(pdf);
  });

  test("Review Focus 4: the trainer's name is read from Seaded on every download — the same row and Seaded give the same bytes, another name another PDF; never a signature image", async () => {
    await signIn();
    const before = await bytesOf(await download(String(certId)));
    expect((await bytesOf(await download(String(certId)))).equals(before)).toBe(true); // the PDF is deterministic (Task 2)
    await db.insert(settings).values({ key: "certificate", value: { trainerName: "Maria S." } });
    try {
      const after = await bytesOf(await download(String(certId)));
      expect(after.equals(before)).toBe(false);
      onlyTheLogo(after);
    } finally {
      await db.delete(settings).where(eq(settings.key, "certificate"));
    }
  });

  test("Review Focus 5: a revoked access's certificate is still Maria's to download", async () => {
    await signIn();
    await db.update(courseAccess).set({ revokedAt: at(12) }).where(eq(courseAccess.id, accessId));
    try {
      expect((await download(String(certId))).status).toBe(200);
    } finally {
      await db.update(courseAccess).set({ revokedAt: null }).where(eq(courseAccess.id, accessId));
    }
  });

  test("a render that fails answers 500 { ok: false, error: 'server' } and no PDF, and logs the certificate's id and the error's class only, never a name or the message", async () => {
    await signIn();
    vi.mocked(certificatePdf).mockRejectedValueOnce(new TypeError("boom: Kätlin Kask-Žukova, Kulmumeistri e-koolitus"));
    const res = await download(String(certId));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(vi.mocked(console.error).mock.calls.map((call) => call.join(" "))).toEqual([`[certificate] ${certId}: the admin's download failed: TypeError`]);
    // and the next download is a PDF again
    expect((await download(String(certId))).status).toBe(200);
  });

  test("404: an id that is no certificate, or no id at all", async () => {
    await signIn();
    for (const id of ["999999", "abc", "0", "007", "2147483648"]) {
      const res = await download(id);
      expect([res.status, await res.json()], id).toEqual([404, { ok: false, error: "notFound" }]);
    }
  });

  test("a hung call does not hold the function: maxDuration 30", () => {
    expect(maxDuration).toBe(30);
  });
});

// GET /api/admin/naidistunnistus (Dim 07.11.2026): Seaded → „Näidistunnistus (PDF)“, a sample from the card's values as they stand on the screen,
// saved or not, with a made-up student and course (adminEt.certificates.sample). Nothing is stored and no number is used.
describe("GET /api/admin/naidistunnistus: the sample from the card's values", () => {
  const sample = (query = "") => downloadSample(new Request(`${ORIGIN}/api/admin/naidistunnistus${query}`), undefined);
  const textOf = async (res: Response) => (await readPdf(new Uint8Array(await res.arrayBuffer()))).runs.map((r) => r.text).join("\n");
  const stored = async () => ({ certificates: await db.select().from(certificates), setting: await db.select().from(settings).where(eq(settings.key, "certificate")) });
  /** The Tallinn year the sample is drawn in (it reads the clock): the suite does not depend on the year it runs in. */
  const YEAR = tallinnYear(new Date());

  test("without an admin's session: 401, nothing rendered", async () => {
    const res = await sample("?place=X");
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    expect(sampleCertificatePdf).not.toHaveBeenCalled();
  });

  test("an inline PDF, private, never kept, nosniff, no signature image (the logo is the one image), that reads the card's values from the query — saved or not — with the made-up student and course", async () => {
    await signIn();
    const query = new URLSearchParams({ place: "Tartu linn", registryCode: "99887766", practicalLine: "Praktiline töö modellil", trainerName: "Maria S.", nextYear: String(YEAR), nextSeq: "93" });
    const res = await sample(`?${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="MS-LAB-naidistunnistus.pdf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await res.clone().arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(300 * 1024);
    onlyTheLogo(bytes);
    const text = await textOf(res);
    for (const part of ["Tartu linn", "99887766", "PRAKTILINE TÖÖ MODELLIL", "Maria S.", formatCertificateNumber(YEAR, 93), "Mari Maasikas", "NÄIDISKOOLITUS", "Kulmude kuju analüüs", "10 AKADEEMILIST TUNDI"]) expect(text, part).toContain(part);
    expect(text).not.toContain("Pärnu linn");
  });

  test("nothing is stored and no number is used: the certificates and the stored card are as they were", async () => {
    await signIn();
    const before = await stored();
    expect((await sample(`?place=Muu&nextYear=${YEAR}&nextSeq=500`)).status).toBe(200);
    expect(await stored()).toEqual(before);
  });

  test("the card empty or the values wild: a sample all the same, read as the stored setting is — the defaults, this year's number 1, Maria Sosnina for a name the rules refuse", async () => {
    await signIn();
    const empty = await textOf(await sample());
    for (const part of ["Pärnu linn", "16346048", "PRAKTILINE TÖÖ FOTODEL", "Maria Sosnina", formatCertificateNumber(YEAR, 1)]) expect(empty, part).toContain(part);
    const wild = await sample(`?place=${"X".repeat(5000)}&trainerName=${encodeURIComponent("Мария")}&nextYear=abc&nextSeq=-4&registryCode=%3Cscript%3E`);
    expect(wild.status).toBe(200);
    const wildText = await textOf(wild);
    for (const part of ["Pärnu linn", "Maria Sosnina", formatCertificateNumber(YEAR, 1)]) expect(wildText, part).toContain(part);
    expect(wildText).not.toContain("XXXX");
  });

  test("a render that fails answers 500 and logs nothing of the values", async () => {
    await signIn();
    vi.mocked(sampleCertificatePdf).mockRejectedValueOnce(new TypeError("boom: Tartu linn"));
    const res = await sample("?place=Tartu%20linn");
    expect([res.status, await res.json()]).toEqual([500, { ok: false, error: "server" }]);
    expect(vi.mocked(console.error).mock.calls.map((call) => call.join(" "))).toEqual(["[certificate] the sample certificate failed: TypeError"]);
  });

  test("a hung call does not hold the function: maxDuration 30", () => {
    expect(sampleMaxDuration).toBe(30);
  });
});
