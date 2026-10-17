import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeTestDb, shownContractVersion } from "./helpers";
import type { Db } from "@/db/client";
import { courses, courseSessions, practicePackages, registrations, requests, subscribers } from "@/db/schema";
import { clientDetail } from "@/server/admin-clients";
import { issueClientLogin, redeemClientCode } from "@/server/client-auth";
import { loadDashboard, updateProfile } from "@/server/client-data";
import type { Env } from "@/server/notify";
import {
  createRegistration,
  handleContact,
  handleIndividual,
  handlePractice,
  handlePurchaseInterest,
  handleRegistration,
  handleSubscribe,
  handleWaitlist,
  type Deps,
} from "@/server/submit";
import { fakeKv } from "../fakes";

// Spec §2 "New ones link at creation time" (final review C1): a registration, waitlist entry, request or newsletter row made
// for an address that already has an account carries the account's client_id from its INSERT on, so a student who is signed
// in (sessions last 180 days) sees what she just booked at once, and so does the admin's Õpilased drawer. Every address is
// `@example.test`; no mail goes out (no Resend key, and sample addresses are never mailed).

const NOW = new Date("2026-10-04T09:00:00Z");
const base = { level: "basic" as const, summary: { et: "" }, body: { et: "" } };

let db: Db;
let session: { id: number };
/** The contact contract's version the course page shows (contracts R6: the group form sends it with the box). */
let contractVersion = "";

beforeEach(async () => {
  db = await makeTestDb();
  contractVersion = await shownContractVersion(db);
  const [contact] = await db
    .insert(courses)
    .values({ ...base, slug: "kulm", type: "contact", title: { et: "Kulmude lamineerimine" }, priceGroup: 35000, priceIndividual: 45000, published: true })
    .returning();
  await db.insert(courses).values({ ...base, slug: "e-kulm", type: "e_learning", title: { et: "Kulmude e-koolitus" }, price: 9500, published: true });
  [session] = await db.insert(courseSessions).values({ courseId: contact.id, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio" }).returning();
  await db.insert(practicePackages).values({ code: "MINI", name: { et: "MINI" }, tagline: { et: "" }, models: 2, durationLabel: { et: "4 ak" }, price: 15000 });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

/** A student who has signed in with a code: the account exists, its session is live. */
async function signedIn(email: string): Promise<number> {
  const { code } = (await issueClientLogin(db, email, NOW))!;
  const login = await redeemClientCode(db, email, code, NOW);
  if (!login || login === "wrong") throw new Error("no login");
  return login.clientId;
}

/** The forms' dependencies: no Resend key (nothing is mailed), work after the response is collected and dropped. */
function deps(): Deps {
  const env: Env = { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example.test>", MARIA_EMAIL: "maria@example.test", SITE_URL: "https://mslab.example.test" };
  return { db, env, ip: "203.0.113.9", siteUrl: "https://mslab.example.test", now: NOW, later: () => {} };
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const register = (email: string, extra: Record<string, string> = {}) =>
  handleRegistration(deps(), form({ course: "kulm", session: String(session.id), name: "Kati Kask", email, phone: "+372 5555 1234", payment: "half", terms: "on", contractVersion, ...extra }));
const waitlist = (email: string, extra: Record<string, string> = {}) =>
  handleWaitlist(deps(), form({ session: String(session.id), name: "Kati Kask", email, ...extra }));
const individual = (email: string, extra: Record<string, string> = {}) =>
  handleIndividual(deps(), form({ course: "kulm", name: "Kati Kask", email, phone: "+372 5555 1234", period: "Detsembri algus", terms: "on", ...extra }));

describe("records made for an address with an account link to it at once", () => {
  test("a signed-in student's registration, waitlist entry and individual request are on Minu koolitused and in her drawer right away", async () => {
    const id = await signedIn("kati@example.test");
    expect((await loadDashboard(db, id, NOW))!.cards).toEqual([]);

    expect(await register("kati@example.test")).toEqual({ ok: true });
    expect(await waitlist("kati@example.test")).toEqual({ ok: true });
    expect(await individual("kati@example.test")).toEqual({ ok: true });

    const cards = (await loadDashboard(db, id, NOW))!.cards;
    expect(cards.map((c) => c.kind).sort()).toEqual(["contact", "request", "waitlist"]);
    expect(cards.find((c) => c.kind === "request")).toMatchObject({ requestKind: "individual", detail: "Detsembri algus" });
    expect(cards.find((c) => c.kind === "contact")).toMatchObject({ course: { slug: "kulm" }, status: "awaiting_prepayment" });

    const detail = (await clientDetail(db, id, NOW))!;
    expect(detail.registrations).toHaveLength(1);
    expect(detail.requests.map((r) => r.kind).sort()).toEqual(["individual", "waitlist"]);
  });

  test("a practice request, the cart's purchase request, a contact message and a newsletter sign-up link too", async () => {
    const id = await signedIn("kati@example.test");
    expect(await handlePractice(deps(), form({ package: "MINI", name: "Kati Kask", email: "kati@example.test", phone: "+372 5555 1234", times: "õhtuti" }))).toEqual({ ok: true });
    expect(await handlePurchaseInterest(deps(), form({ course: "e-kulm", email: "kati@example.test" }))).toEqual({ ok: true });
    expect(await handleContact(deps(), form({ name: "Kati Kask", email: "kati@example.test", message: "Tere!" }))).toEqual({ ok: true });
    expect(await handleSubscribe(deps(), form({ email: "kati@example.test" }))).toEqual({ ok: true });

    expect((await db.select().from(requests)).map((r) => [r.kind, r.clientId])).toEqual([["practice", id], ["contact", id], ["contact", id]]);
    expect((await db.select().from(subscribers)).map((s) => s.clientId)).toEqual([id]);
    expect((await loadDashboard(db, id, NOW))!.cards).toEqual([expect.objectContaining({ kind: "request", requestKind: "practice" })]);
  });

  test("the address is compared normalised: another case and spaces still link (the stored address is normalised)", async () => {
    const id = await signedIn("kati@example.test");
    const row = await createRegistration(db, {
      courseId: (await db.select().from(courses).where(eq(courses.slug, "kulm")))[0].id,
      courseSessionId: session.id,
      kind: "group",
      name: "Kati Kask",
      email: "  KATI@Example.TEST ",
      phone: "",
      paymentChoice: "full",
      wantsModelHelp: false,
      wantsAccount: false,
      preferredPeriod: "",
      message: "",
      locale: "et",
    });
    expect(row).toMatchObject({ email: "kati@example.test", clientId: id });
    expect(await waitlist(" Kati@EXAMPLE.test ")).toEqual({ ok: true });
    expect((await db.select().from(requests))[0].clientId).toBe(id);
    expect((await loadDashboard(db, id, NOW))!.cards.map((c) => c.kind).sort()).toEqual(["contact", "waitlist"]);
  });

  test("the record linked at once fills the account's empty name and phone (spec 2.1 rule 4), never ones she has saved", async () => {
    const id = await signedIn("kati@example.test");
    const profile = async () => (await loadDashboard(db, id, NOW))!.client;
    expect(await profile()).toMatchObject({ name: "", phone: "" });
    // a waitlist entry has a name but no phone
    expect(await waitlist("kati@example.test", { name: "Kati Kask" })).toEqual({ ok: true });
    expect(await profile()).toMatchObject({ name: "Kati Kask", phone: "" });
    // the registration brings the phone; the name she has stays
    expect(await register("kati@example.test", { name: "Katrin Kask", phone: "+372 5555 1234" })).toEqual({ ok: true });
    expect(await profile()).toMatchObject({ name: "Kati Kask", phone: "+372 5555 1234" });
    // saved in Minu andmed: a later request changes neither
    await updateProfile(db, id, { name: "Kati K.", phone: "+372 5000 0000", locale: "et" });
    expect(await individual("kati@example.test", { name: "Katrin", phone: "+372 5555 9999" })).toEqual({ ok: true });
    expect(await profile()).toMatchObject({ name: "Kati K.", phone: "+372 5000 0000" });
  });

  test("an address without an account stays unlinked, and nobody else's account gets it", async () => {
    const kati = await signedIn("kati@example.test");
    expect(await register("mari@example.test", { name: "Mari Maasikas" })).toEqual({ ok: true });
    expect(await waitlist("mari@example.test")).toEqual({ ok: true });
    expect(await handleSubscribe(deps(), form({ email: "mari@example.test" }))).toEqual({ ok: true });
    expect((await db.select().from(registrations)).map((r) => r.clientId)).toEqual([null]);
    expect((await db.select().from(requests)).map((r) => r.clientId)).toEqual([null]);
    expect((await db.select().from(subscribers)).map((s) => s.clientId)).toEqual([null]);
    expect((await loadDashboard(db, kati, NOW))!.cards).toEqual([]);
  });
});
