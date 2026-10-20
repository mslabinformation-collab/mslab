import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { campaignMailSend, outboxFile, outboxSend, type OutboxMail } from "@/server/mail-outbox";
import { sendMailResult, type Env, type Mail } from "@/server/notify";

// The e2e run's mail outbox (the simple newsletter, Task 5; src/server/mail-outbox.ts). A newsletter campaign's mails are written to a file instead of being
// sent, and only on the e2e run's own servers: the gate is what keeps it from ever swallowing the real site's newsletter, so it is pinned from every side.
// Nothing here calls Resend.

const state = vi.hoisted(() => ({ db: {} as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/kv", () => ({ serverKv: () => ({ get: async () => null, put: async () => {} }) }));

import { campaignSendDeps } from "@/server/send-deps";

const FILE = join(tmpdir(), "mslab-outbox-test", "outbox.jsonl");
const DEV = { production: false, onVercel: false };
const PROD = { production: true, onVercel: false };
const env: Env = { KV: { get: async () => null, put: async () => {} }, MAIL_FROM: "MS LAB <info@send.example.com>", MARIA_EMAIL: "maria@example.com", SITE_URL: "https://mslab.example" };
const mail: Mail = {
  to: "kati@example.com",
  subject: "Sügispakkumine",
  text: "Tere! Loobu: https://mslab.example/api/newsletter/loobu?t=abc",
  html: "<p>Tere!</p>",
  headers: { "List-Unsubscribe": "<https://mslab.example/api/newsletter/loobu?t=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
};

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(join(tmpdir(), "mslab-outbox-test"), { recursive: true, force: true });
});

/** Everything logged, joined. */
const logged = () => [warn, info, error].flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");

describe("the gate (outboxFile)", () => {
  test("no setting, a blank one: no outbox, and nothing said", () => {
    expect(outboxFile({}, DEV)).toBeNull();
    expect(outboxFile({ E2E_MAIL_OUTBOX: "" }, DEV)).toBeNull();
    expect(outboxFile({ E2E_MAIL_OUTBOX: "   " }, PROD)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("`next dev` on this machine: the file", () => {
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE }, DEV)).toBe(FILE);
  });

  test("Vercel never: not with the setting alone, not with the production flag, not under `next dev` there", () => {
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE }, { production: true, onVercel: true })).toBeNull();
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE, E2E_MAIL_IN_PRODUCTION: "1" }, { production: true, onVercel: true })).toBeNull();
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE, E2E_MAIL_IN_PRODUCTION: "1" }, { production: false, onVercel: true })).toBeNull();
  });

  test("a production build needs the explicit flag, and only the exact \"1\"", () => {
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE }, PROD)).toBeNull();
    for (const flag of ["0", "true", "yes", "", "1 "]) expect(outboxFile({ E2E_MAIL_OUTBOX: FILE, E2E_MAIL_IN_PRODUCTION: flag }, PROD), flag).toBeNull();
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE, E2E_MAIL_IN_PRODUCTION: "1" }, PROD)).toBe(FILE);
  });

  test("a path that is not absolute is no outbox (a relative one would depend on where the server was started)", () => {
    expect(outboxFile({ E2E_MAIL_OUTBOX: "outbox.jsonl" }, DEV)).toBeNull();
    expect(outboxFile({ E2E_MAIL_OUTBOX: "../outbox.jsonl" }, DEV)).toBeNull();
  });

  test("a refusal is said once by the setting's name, never its value", async () => {
    vi.resetModules();
    const fresh = await import("@/server/mail-outbox"); // (a fresh module: what it has said is forgotten)
    fresh.outboxFile({ E2E_MAIL_OUTBOX: FILE }, PROD);
    fresh.outboxFile({ E2E_MAIL_OUTBOX: FILE }, PROD);
    fresh.outboxFile({ E2E_MAIL_OUTBOX: FILE }, { production: true, onVercel: true });
    fresh.outboxFile({ E2E_MAIL_OUTBOX: FILE }, { production: true, onVercel: true });
    const said: string[] = warn.mock.calls.map((call: unknown) => String(call));
    expect(said.filter((m) => m.includes("production build"))).toHaveLength(1);
    expect(said.filter((m) => m.includes("Vercel"))).toHaveLength(1);
    expect(logged()).toContain("E2E_MAIL_OUTBOX");
    expect(logged()).not.toContain("mslab-outbox-test");
  });

  test("without a runtime given it reads NODE_ENV and VERCEL (the vitest run is neither)", () => {
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE })).toBe(FILE);
    vi.stubEnv("VERCEL", "1");
    expect(outboxFile({ E2E_MAIL_OUTBOX: FILE })).toBeNull();
  });

  test("campaignMailSend: the outbox's send when the gate opens, none (the real sender) when it does not", () => {
    expect(campaignMailSend({}, DEV)).toBeUndefined();
    expect(campaignMailSend({ E2E_MAIL_OUTBOX: FILE }, PROD)).toBeUndefined();
    expect(campaignMailSend({ E2E_MAIL_OUTBOX: FILE }, { production: true, onVercel: true })).toBeUndefined();
    const send = campaignMailSend({ E2E_MAIL_OUTBOX: FILE }, DEV);
    expect(send).toBeTypeOf("function");
    expect(send).not.toBe(sendMailResult);
  });
});

describe("the outbox's send", () => {
  test("writes each mail as one JSON line (to, subject, headers, text, html) and answers accepted", async () => {
    const send = outboxSend(FILE);
    expect(await send(env, mail)).toEqual({ ok: true });
    expect(await send(env, { to: "juhan@example.com", subject: "Teine", text: "Tekst" })).toEqual({ ok: true });
    const lines = readFileSync(FILE, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((l) => JSON.parse(l) as OutboxMail);
    expect(first).toMatchObject({ to: "kati@example.com", subject: "Sügispakkumine", text: mail.text, html: "<p>Tere!</p>", headers: mail.headers });
    expect(new Date(first.at).getTime()).toBeGreaterThan(0);
    expect(second).toMatchObject({ to: "juhan@example.com", subject: "Teine", html: null, headers: {} });
  });

  test("the folder is made when it is not there", async () => {
    await outboxSend(join(tmpdir(), "mslab-outbox-test", "a", "b", "outbox.jsonl"))(env, mail);
    expect(readFileSync(join(tmpdir(), "mslab-outbox-test", "a", "b", "outbox.jsonl"), "utf8")).toContain("kati@example.com");
  });

  test("the log carries no address, subject or text", async () => {
    await outboxSend(FILE)(env, mail);
    expect(logged()).toContain("[mail-outbox]");
    for (const secret of ["kati@example.com", "Sügispakkumine", "Tere!", "loobu"]) expect(logged()).not.toContain(secret);
  });

  test("a file that cannot be written is `refused` (the batch stops and Maria's page says so), logged by class only", async () => {
    mkdirSync(join(tmpdir(), "mslab-outbox-test"), { recursive: true });
    const blocker = join(tmpdir(), "mslab-outbox-test", "not-a-folder");
    writeFileSync(blocker, "x");
    expect(await outboxSend(join(blocker, "outbox.jsonl"))(env, mail)).toEqual({ ok: false, kind: "refused" });
    expect(error).toHaveBeenCalled();
    expect(logged()).not.toContain("kati@example.com");
  });
});

describe("campaignSendDeps (the press, „Saada proov“ and the daily job get their send here)", () => {
  test("no setting: no `send`, so the engine uses the real sendMailResult", () => {
    expect(campaignSendDeps(1000)).not.toHaveProperty("send");
  });

  test("with the setting under `next dev`: the outbox's send", () => {
    vi.stubEnv("E2E_MAIL_OUTBOX", FILE);
    const deps = campaignSendDeps(1000);
    expect(deps.send).toBeTypeOf("function");
    expect(deps.send).not.toBe(sendMailResult);
  });

  test("with the setting on Vercel, or in a production build without the flag: no `send` again", () => {
    vi.stubEnv("E2E_MAIL_OUTBOX", FILE);
    vi.stubEnv("VERCEL", "1");
    expect(campaignSendDeps(1000)).not.toHaveProperty("send");
    vi.unstubAllEnvs();
    vi.stubEnv("E2E_MAIL_OUTBOX", FILE);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/x");
    for (const name of ["SITE_URL", "ADMIN_EMAILS", "ADMIN_NAMES", "MARIA_EMAIL", "MAIL_FROM"]) vi.stubEnv(name, "x@example.com");
    expect(campaignSendDeps(1000)).not.toHaveProperty("send");
    vi.stubEnv("E2E_MAIL_IN_PRODUCTION", "1");
    expect(campaignSendDeps(1000).send).toBeTypeOf("function");
  });
});
