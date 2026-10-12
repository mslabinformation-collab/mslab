import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { loadDashboard } from "@/server/client-data";
import { saveProtocol, sendProtocol } from "@/server/protocols";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { HEADINGS, protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The student's protocol (spec §5, §10): GET /api/konto/protokoll?id= answers her own registration's protocol as Maria last sent it — never a
// draft, never another's — and her dashboard card says it is there.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE };
const deps = (): AccountDeps => ({ db, env, now: NOW, siteUrl: SITE, later: () => {}, dev: false });

/** A session cookie of `clientId`. */
async function cookieOf(clientId: number): Promise<string> {
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return `__Host-mslab_client=${raw}`;
}
const get = async (cookie: string | null, query: string) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto/protokoll${query}`, { headers: cookie ? { cookie } : {} }), deps()))!;
const write = (registrationId: number, version: number, notes: string[], generalNote: string) =>
  saveProtocol(db, { registrationId, version, titles: HEADINGS, notes, generalNote }, NOW);
const send = (registrationId: number, version: number) => sendProtocol({ db, env, siteUrl: SITE, now: NOW, later: () => {} }, { registrationId, version });

/** Mari's registration with a sent protocol (the send made her account and linked the registration), and her session. */
async function sent() {
  const { course, session } = await protocolCourse(db);
  const mari = await student(db, course, session, "Mari Maasikas");
  await write(mari.id, 0, ["Kulmud said ühtlased", "", "", "Värv sobis"], "Tubli töö!\nJätka harjutamist.");
  await send(mari.id, 1);
  const [account] = await db.select().from(clients).where(eq(clients.email, "marimaasikas@example.com"));
  return { course, session, mari, account, cookie: await cookieOf(account.id) };
}

test("her own sent protocol: the course, its day and place, the stages and the general notes as sent; private and never cached", async () => {
  const { session, mari, cookie } = await sent();
  const res = await get(cookie, `?id=${mari.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.json()).toEqual({
    ok: true,
    course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
    session: { startsAt: session.startsAt.toISOString(), city: "Pärnu", venue: "MS LAB stuudio" },
    sentAt: NOW.toISOString(),
    stages: [
      { title: "Ettevalmistus", note: "Kulmud said ühtlased" },
      { title: "Kulmude analüüs", note: "" },
      { title: "Vormi määramine", note: "" },
      { title: "Värvimine", note: "Värv sobis" },
    ],
    generalNote: "Tubli töö!\nJätka harjutamist.",
  });
});

test("only the sent copy: an edit after the send is not shown until it is sent again", async () => {
  const { mari, cookie } = await sent();
  await write(mari.id, 1, ["Uus tekst", "", "", ""], "Mustand");
  const body = await (await get(cookie, `?id=${mari.id}`)).json();
  expect([body.stages[0].note, body.generalNote]).toEqual(["Kulmud said ühtlased", "Tubli töö!\nJätka harjutamist."]);
  await send(mari.id, 2);
  expect((await (await get(cookie, `?id=${mari.id}`)).json()).generalNote).toBe("Mustand");
});

test("another's protocol, a draft, a registration under another address, an id that is no id: 404, and nothing of it in the answer", async () => {
  const { course, session, mari, cookie } = await sent();
  const anu = await student(db, course, session, "Anu Aas");
  await write(anu.id, 0, ["Anu", "", "", ""], "");
  await send(anu.id, 1); // sent: Anu's account, not Mari's
  const kati = await student(db, course, session, "Kati Kask");
  await write(kati.id, 0, ["mustand", "", "", ""], ""); // a draft
  for (const query of [`?id=${anu.id}`, `?id=${kati.id}`, "?id=abc", "?id=0", "", "?id=999999"]) {
    const res = await get(cookie, query);
    expect(res.status, query).toBe(404);
    expect(await res.json(), query).toEqual({ ok: false });
  }
  // Mari signed in under another address: her registration is not linked to that account (spec §9), so not hers there
  const [other] = await db.insert(clients).values({ email: "mari.teine@example.com" }).returning();
  expect((await get(await cookieOf(other.id), `?id=${mari.id}`)).status).toBe(404);
});

test("without a session: 401", async () => {
  const { mari } = await sent();
  expect((await get(null, `?id=${mari.id}`)).status).toBe(401);
});

test("the dashboard's card says the protocol is sent, and says nothing before", async () => {
  const { course, session, mari, account } = await sent();
  const later = await student(db, course, session, "Mari Maasikas", { clientId: account.id, email: "marimaasikas@example.com" });
  await write(later.id, 0, ["x", "", "", ""], ""); // a draft only
  const cards = (await loadDashboard(db, account.id, NOW))!.cards;
  const byId = new Map(cards.flatMap((c) => (c.kind === "contact" ? [[c.registrationId, c] as const] : [])));
  expect(byId.get(mari.id)?.protocolSent).toBe(true);
  expect(byId.get(later.id)).not.toHaveProperty("protocolSent");
});
