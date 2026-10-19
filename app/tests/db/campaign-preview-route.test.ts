import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { newsletterCampaigns, settings } from "@/db/schema";
import { INVOICE_KEY } from "@/domain/invoice";
import { createSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// The campaign editor's live preview (newsletter campaigns, Task 4; spec D4, D5): POST /api/admin/kampaania-eelvaade takes the editor's fields as they
// stand, saved or not, and answers the real mail (server/campaign-mail.ts campaignMail) in both languages, for the editor's two <iframe srcdoc
// sandbox>. Admins only, private and never kept, the body capped as /api/admin/naidisleping's; it stores nothing. The links hang on SITE_URL, never
// on the request's address. The database is PGlite and the admin's session cookie (next/headers) is faked, as in tests/db/admin-contract-routes.test.ts.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { MAX_PREVIEW_BODY, POST } from "@/app/api/admin/kampaania-eelvaade/route";

const ORIGIN = "https://admin-request.example";
const SITE = "https://mslab.example";
const PROOV = `${SITE}/api/newsletter/loobu?proov=1`;

let db: Db;

const DRAFT = {
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "−15% kõigile koolitustele", ru: "Скидка 15% на все курсы" },
  imageKey: "img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
  body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац.\n\nВторой абзац." },
  code: "sugis15",
  buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
  buttonHref: "/koolitused",
};

type Preview = { ok: true; et: { subject: string; preheader: string; html: string }; ru: { subject: string; preheader: string; html: string }; ruFallsBack: boolean };

const request = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/admin/kampaania-eelvaade`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const preview = (draft: unknown, headers: Record<string, string> = {}) => POST(request(JSON.stringify({ draft }), headers), undefined);
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};

beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  state.db = db;
  state.cookie = undefined;
  await db.delete(settings);
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.stubEnv("SITE_URL", SITE);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("without an admin's session", () => {
  test("401 { ok: false, error: 'unauthorized' }, never kept, nothing rendered", async () => {
    const res = await preview(DRAFT);
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a POST from another site is refused (403) before the session is asked", async () => {
    await signIn();
    const res = await preview(DRAFT, { origin: "https://elsewhere.example" });
    expect(res.status).toBe(403);
  });
});

describe("the preview of the fields as they stand", () => {
  test("both languages' mail: the subject, the preview line and the HTML; private, never kept, nosniff", async () => {
    await signIn();
    const res = await preview(DRAFT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await res.json()) as Preview;
    expect(body.ok).toBe(true);
    expect(body.ruFallsBack).toBe(false);
    expect(body.et).toMatchObject({ subject: "Sügispakkumine", preheader: "−15% kõigile koolitustele" });
    expect(body.ru).toMatchObject({ subject: "Осеннее предложение", preheader: "Скидка 15% на все курсы" });
    expect(body.et.html).toMatch(/^<!doctype html>/);
    expect(body.et.html).toContain("Esimene lõik.");
    expect(body.et.html).toContain("SUGIS15");
    expect(body.et.html).toContain("Loobu uudiskirjast");
    expect(body.ru.html).toContain("Первый абзац.");
    expect(body.ru.html).toContain("Отписаться от рассылки");
  });

  test("the picture, the logo, the button and the unsubscribe link hang on SITE_URL, never on the request's address; the link is the test page's", async () => {
    await signIn();
    const body = (await (await preview(DRAFT)).json()) as Preview;
    expect(body.et.html).toContain(`src="${SITE}/media/img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg"`);
    expect(body.et.html).toContain(`src="${SITE}/brand/logo.png"`);
    expect(body.et.html).toContain(`href="${SITE}/koolitused"`);
    expect(body.ru.html).toContain(`href="${SITE}/ru/koolitused"`);
    expect(body.et.html).toContain(`href="${PROOV}"`);
    expect(body.et.html).not.toContain("admin-request.example");
    expect(body.et.html).not.toContain("{{{");
  });

  test("the school's name and address from Seaded → „Arve andmed“, else „MS LAB“", async () => {
    await signIn();
    expect(((await (await preview(DRAFT)).json()) as Preview).et.html).toContain(">MS LAB<");
    await setSetting(db, INVOICE_KEY, { company: "MS LAB Koolituskeskus OÜ", registryCode: "1", address: "Rüütli 1, Pärnu", vatNumber: "", vatOn: false, vatRate: 24, prefix: "MSL", nextYear: 2026, nextSeq: 1, termDays: 7, footer: "" });
    const html = ((await (await preview(DRAFT)).json()) as Preview).et.html;
    expect(html).toContain("MS LAB Koolituskeskus OÜ");
    expect(html).toContain("Rüütli 1, Pärnu");
  });

  test("without the Russian text the Russian preview is the Estonian text under the Russian footer, and says so (Review Focus 5)", async () => {
    await signIn();
    const body = (await (await preview({ ...DRAFT, subject: { et: "Sügispakkumine", ru: "" }, body: { et: "Esimene lõik.", ru: "" } })).json()) as Preview;
    expect(body.ruFallsBack).toBe(true);
    expect(body.ru.subject).toBe("Sügispakkumine");
    expect(body.ru.html).toContain("Esimene lõik.");
    expect(body.ru.html).toContain("Отписаться от рассылки");
  });

  test("half-written fields still preview: what is not valid yet is left out (a code of another shape, a button without its address, a picture of another site)", async () => {
    await signIn();
    const res = await preview({ name: "", subject: { et: "" }, body: { et: "Ainult tekst." }, code: "ä ö", buttonLabel: { et: "Vaata" }, buttonHref: "", imageKey: "https://elsewhere.example/x.jpg" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Preview;
    expect(body.et.html).toContain("Ainult tekst.");
    expect(body.et.html).not.toContain("Vaata");
    expect(body.et.html).not.toContain("elsewhere.example");
    expect(body.et.html).not.toContain("Ä Ö");
    expect(body.et.subject).toBe("");
  });

  test("Maria's texts are escaped, pasted control characters are gone, and a text over its limit is cut", async () => {
    await signIn();
    const body = (await (await preview({ ...DRAFT, body: { et: `<script>alert(1)</script>\u0007Lõik.${"x".repeat(20_000)}`, ru: "" } })).json()) as Preview;
    expect(body.et.html).not.toContain("<script>");
    expect(body.et.html).toContain("&lt;script&gt;");
    expect(body.et.html).not.toContain("\u0007");
    expect(body.et.html).not.toContain("x".repeat(10_001));
  });

  test("it stores nothing", async () => {
    await signIn();
    await preview(DRAFT);
    expect(await db.select().from(newsletterCampaigns)).toEqual([]);
  });
});

describe("the body", () => {
  test("not JSON, or no object: 400 `invalid`", async () => {
    await signIn();
    for (const body of ["no json", "[]", "null"]) {
      const res = await POST(request(body), undefined);
      expect([res.status, await res.json()], body).toEqual([400, { ok: false, error: "invalid" }]);
    }
  });

  test(`over ${MAX_PREVIEW_BODY} bytes: 413 \`tooLarge\`, by its content-length before a byte is read, or at the first byte past the cap`, async () => {
    await signIn();
    expect(MAX_PREVIEW_BODY).toBeGreaterThanOrEqual(200_000);
    const declared = await POST(request("{}", { "content-length": String(MAX_PREVIEW_BODY + 1) }), undefined);
    expect([declared.status, await declared.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
    const big = new TextEncoder().encode(JSON.stringify({ draft: { ...DRAFT, body: { et: "x".repeat(4 * MAX_PREVIEW_BODY) } } }));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= big.byteLength) return controller.close();
        controller.enqueue(big.slice(pulled, pulled + 65_536));
        pulled += 65_536;
      },
    });
    const streamed = await POST(new Request(`${ORIGIN}/api/admin/kampaania-eelvaade`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit), undefined);
    expect([streamed.status, await streamed.json()]).toEqual([413, { ok: false, error: "tooLarge" }]);
    expect(pulled).toBeLessThan(big.byteLength);
  });

  test("the largest draft the editor can send fits under the cap (every text at its limit, the Russian ones in Cyrillic)", async () => {
    await signIn();
    const L = { name: 80, subject: 150, preheader: 150, body: 10_000, buttonLabel: 40 };
    const full = {
      name: "N".repeat(L.name),
      subject: { et: "S".repeat(L.subject), ru: "Ж".repeat(L.subject) },
      preheader: { et: "P".repeat(L.preheader), ru: "Ж".repeat(L.preheader) },
      imageKey: DRAFT.imageKey,
      body: { et: "õ".repeat(L.body), ru: "Ж".repeat(L.body) },
      code: "X".repeat(30),
      buttonLabel: { et: "B".repeat(L.buttonLabel), ru: "Ж".repeat(L.buttonLabel) },
      buttonHref: `https://example.com/${"a".repeat(470)}`,
    };
    expect(new TextEncoder().encode(JSON.stringify({ draft: full })).byteLength).toBeLessThan(MAX_PREVIEW_BODY);
    expect((await preview(full)).status).toBe(200);
  });
});
