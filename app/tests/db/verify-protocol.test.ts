import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { verifyLink } from "@/server/account-mail";
import { issueClientLogin } from "@/server/client-auth";
import { fakeKv } from "../fakes";
import { makeTestDb } from "./helpers";

// The protocol mail's button (phase protocols): the login link with `p=<registration>` signs her in and opens that protocol, in her account's
// language, the id after the login mark in the fragment. Without one (or with a p that is no id) the login opens Minu koolitused as before.

const SITE = "https://mslab.example";
const NOW = new Date("2026-10-12T16:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const deps = (): AccountDeps => ({
  db,
  env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
});
const open = async (link: string) => (await handleAccountApi(new Request(link), deps()))!;
const login = async () => (await issueClientLogin(db, "kati@example.test", NOW))!.token;

test("the link with the protocol signs her in and opens it; a Russian account opens the Russian page", async () => {
  const res = await open(verifyLink(SITE, await login(), "et", 42));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${SITE}/konto/protokoll#sisse&id=42`);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-mslab_client=") && !c.includes("Max-Age=0"))).toBe(true);
  await db.update(clients).set({ locale: "ru" });
  expect((await open(verifyLink(SITE, await login(), "ru", 42))).headers.get("location")).toBe(`${SITE}/ru/konto/protokoll#sisse&id=42`);
});

test("without a protocol, or with a p that is no id, it opens Minu koolitused; a used link opens the login page, never the protocol", async () => {
  const token = await login();
  expect((await open(`${verifyLink(SITE, token)}&p=abc`)).headers.get("location")).toBe(`${SITE}/konto#sisse`);
  expect((await open(verifyLink(SITE, token, "et", 42))).headers.get("location")).toBe(`${SITE}/konto/sisene#viga=link`);
  expect((await open(verifyLink(SITE, await login(), "et", 0))).headers.get("location")).toBe(`${SITE}/konto#sisse`);
});
