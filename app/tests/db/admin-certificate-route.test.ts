import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { certificates, courseAccess, settings } from "@/db/schema";
import { createSession } from "@/server/auth";
import { certificatePdf } from "@/server/certificates";
import { at, ecourse, student } from "./hindamine-fixtures";
import { makeTestDb } from "./helpers";

// GET /api/admin/tunnistus/<id> (phase 3d, spec §6): Maria's download of any certificate, a revoked access's too — signed-in admins only; the
// PDF rendered from the frozen row (server/certificates.ts certificatePdf, the real fonts of assets/fonts) with Seaded's trainer's name typed
// in the script font as the signature (no image), as a download named after its number, private and never kept. The database is PGlite and
// the session cookie (next/headers) is faked, as in tests/db/admin-photo-route.test.ts.

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

import { GET, maxDuration } from "@/app/api/admin/tunnistus/[id]/route";

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

  test("the PDF as a download named after its number, private and never kept, nosniff; no image in it (the signature is typed)", async () => {
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
    expect(pdf.includes("/Subtype /Image")).toBe(false);
  });

  test("Review Focus 4: the trainer's name is read from Seaded on every download — the same row and Seaded give the same bytes, another name another PDF; never an image", async () => {
    await signIn();
    const before = await bytesOf(await download(String(certId)));
    expect((await bytesOf(await download(String(certId)))).equals(before)).toBe(true); // the PDF is deterministic (Task 2)
    await db.insert(settings).values({ key: "certificate", value: { trainerName: "Maria S." } });
    try {
      const after = await bytesOf(await download(String(certId)));
      expect(after.equals(before)).toBe(false);
      expect(after.includes("/Subtype /Image")).toBe(false);
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
