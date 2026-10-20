import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BAD_DATABASE_URL, gateEnv, LOCAL_DATABASE_URL, paymentsEnv, serverEnv } from "@/server/env";
import { parseEnvFile } from "../local-secrets";

// serverEnv() is the one place the server reads its configuration (process.env on Vercel and under `next dev`). In
// production a missing required variable is an error that names the variable and never shows a value.

// Placeholder values only (the address guard rejects real addresses); the secrets are made-up strings the tests look for in messages.
const SECRET_URL = "postgres://app:s3cret-pw@db.example.com:5432/mslab";
const SECRET_KEY = "re_s3cret_resend_key";
const FULL = {
  DATABASE_URL: SECRET_URL,
  SITE_URL: "https://mslab.example.com",
  ADMIN_EMAILS: "admin@example.test,second.admin@example.test",
  ADMIN_NAMES: "admin@example.test=Dim,second.admin@example.test=Maria",
  MARIA_EMAIL: "maria@example.test",
  MAIL_FROM: "MS LAB <info@example.test>",
};
const without = (...names: (keyof typeof FULL)[]) => Object.fromEntries(Object.entries(FULL).filter(([k]) => !names.includes(k as keyof typeof FULL)));
const failure = (source: Record<string, string | undefined>, production = true): string => {
  try {
    serverEnv(source, production);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("serverEnv did not throw");
};

afterEach(() => vi.unstubAllEnvs());

describe("serverEnv in production", () => {
  test("returns the six required values as given; every optional one is undefined when not set", () => {
    const env = serverEnv(FULL, true);
    expect(env).toMatchObject(FULL);
    for (const name of ["RESEND_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ADMIN_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "MEDIA_LOCAL", "CRON_SECRET", "BUNNY_LIBRARY_ID", "BUNNY_API_KEY", "BUNNY_TOKEN_KEY", "BUNNY_WEBHOOK_SECRET", "BUNNY_FAKE_URL", "SITE_GATE", "PREVIEW_SECRET", "MONTONIO_ENV", "MONTONIO_ACCESS_KEY", "MONTONIO_SECRET_KEY", "PAYMENT_PROVIDER", "MONTONIO_FAKE_URL", "PAYMENT_MOCK_IN_PRODUCTION", "E2E_MAIL_OUTBOX", "E2E_MAIL_IN_PRODUCTION", "MONTONIO_REFERENCE_PREFIX"] as const)
      expect(env[name], name).toBeUndefined();
  });

  test("optional values are passed through; blank ones count as not set", () => {
    const env = serverEnv(
      { ...FULL, RESEND_API_KEY: SECRET_KEY, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42", ADMIN_KEY: "k", R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "mslab-media", MEDIA_LOCAL: "1", CRON_SECRET: "c", BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "bunny-api-key", BUNNY_TOKEN_KEY: "bunny-token-key", BUNNY_WEBHOOK_SECRET: "bunny-hook", BUNNY_FAKE_URL: "http://localhost:3998", SITE_GATE: "1", PREVIEW_SECRET: "preview-secret", MONTONIO_ENV: "sandbox", MONTONIO_ACCESS_KEY: "access", MONTONIO_SECRET_KEY: "secret", PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997", PAYMENT_MOCK_IN_PRODUCTION: "1", E2E_MAIL_OUTBOX: "/work/e2e-outbox.jsonl", E2E_MAIL_IN_PRODUCTION: "1", MONTONIO_REFERENCE_PREFIX: "MSLAB-X" },
      true,
    );
    expect(env).toMatchObject({ RESEND_API_KEY: SECRET_KEY, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42", ADMIN_KEY: "k", R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "mslab-media", MEDIA_LOCAL: "1", CRON_SECRET: "c", BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "bunny-api-key", BUNNY_TOKEN_KEY: "bunny-token-key", BUNNY_WEBHOOK_SECRET: "bunny-hook", BUNNY_FAKE_URL: "http://localhost:3998", SITE_GATE: "1", PREVIEW_SECRET: "preview-secret", MONTONIO_ENV: "sandbox", MONTONIO_ACCESS_KEY: "access", MONTONIO_SECRET_KEY: "secret", PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997", PAYMENT_MOCK_IN_PRODUCTION: "1", E2E_MAIL_OUTBOX: "/work/e2e-outbox.jsonl", E2E_MAIL_IN_PRODUCTION: "1", MONTONIO_REFERENCE_PREFIX: "MSLAB-X" });
    expect(serverEnv({ ...FULL, RESEND_API_KEY: "  ", ADMIN_KEY: "", CRON_SECRET: " " }, true)).toMatchObject({ RESEND_API_KEY: undefined, ADMIN_KEY: undefined, CRON_SECRET: undefined });
  });

  test("a missing required variable is an error that names it", () => {
    for (const name of Object.keys(FULL) as (keyof typeof FULL)[]) expect(failure(without(name)), name).toContain(name);
  });

  test("blank or whitespace-only counts as missing", () => {
    expect(failure({ ...FULL, DATABASE_URL: "" })).toContain("DATABASE_URL");
    expect(failure({ ...FULL, SITE_URL: "   " })).toContain("SITE_URL");
  });

  test("every missing variable is named at once, and only the missing ones", () => {
    const message = failure(without("DATABASE_URL", "MARIA_EMAIL"));
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("MARIA_EMAIL");
    for (const present of ["SITE_URL", "ADMIN_EMAILS", "ADMIN_NAMES", "MAIL_FROM"]) expect(message, present).not.toContain(present);
  });

  test("the message never holds a value: not the ones that are set, not the secrets", () => {
    const message = failure({ ...without("ADMIN_EMAILS"), RESEND_API_KEY: SECRET_KEY });
    expect(message).toContain("ADMIN_EMAILS");
    for (const value of [...Object.values(FULL), SECRET_KEY, "s3cret-pw"]) expect(message).not.toContain(value);
    expect(failure({})).not.toMatch(/postgres:|localhost|@/); // and with nothing set, no default value shows either
  });

  test("production has no defaults: an empty environment names all six", () => {
    const message = failure({});
    for (const name of Object.keys(FULL)) expect(message, name).toContain(name);
  });
});

describe("a DATABASE_URL that is not a postgres URL", () => {
  // `#` ends the address early, so "…:s3cret-pw" would be read as a port: postgres.js's own error would quote the whole
  // string, password included. serverEnv() refuses it first, with an error that never shows the value.
  const BAD = ["postgres://app:s3cret-pw#oops@db.example.com:5432/mslab", "not a url at all, s3cret-pw", "postgres://app:s3cret-pw@db.example.com:port/mslab"];
  // a well-formed URL of another scheme is not a database address either
  const OTHER_SCHEME = ["https://app:s3cret-pw@db.example.com/mslab", "http://db.example.com:5432/s3cret-pw", "mysql://app:s3cret-pw@db.example.com:3306/mslab", "redis://:s3cret-pw@cache.example.com:6379", "file:///s3cret-pw", "javascript:alert('s3cret-pw')", "//app:s3cret-pw@db.example.com/mslab"];

  for (const production of [true, false]) {
    test(`is an error that names the variable and shows none of the value (production ${production})`, () => {
      for (const url of [...BAD, ...OTHER_SCHEME]) {
        let error: unknown;
        try {
          serverEnv({ ...FULL, DATABASE_URL: url }, production);
        } catch (e) {
          error = e;
        }
        expect(error, url).toBeInstanceOf(Error);
        const { message, cause } = error as Error;
        expect(message).toBe(BAD_DATABASE_URL);
        expect(message).toContain("DATABASE_URL");
        expect(cause).toBeUndefined(); // the URL error is not chained: it carries the input
        expect(String((error as Error).stack)).not.toContain("s3cret-pw");
      }
    });
  }

  test("a postgres:// or postgresql:// one passes, with its parameters (?sslmode=require) and an escaped password", () => {
    for (const url of [SECRET_URL, LOCAL_DATABASE_URL, "postgresql://postgres:pa%23ss@host.proxy.example:12345/railway?sslmode=require"])
      expect(serverEnv({ ...FULL, DATABASE_URL: url }, true).DATABASE_URL, url).toBe(url);
  });
});

describe("serverEnv outside production (next dev, the tests)", () => {
  test("DATABASE_URL defaults to the local development database; a value that is set wins", () => {
    const local = new URL(serverEnv({}, false).DATABASE_URL);
    expect(local.hostname).toBe("localhost");
    expect(serverEnv({}, false).DATABASE_URL).toBe(LOCAL_DATABASE_URL);
    expect(serverEnv({ DATABASE_URL: "postgres://u:p@127.0.0.1:5433/other" }, false).DATABASE_URL).toBe("postgres://u:p@127.0.0.1:5433/other");
  });

  test("the other required values may be missing: nobody is an admin and nothing is sent until they are set", () => {
    const env = serverEnv({}, false);
    expect(env.ADMIN_EMAILS).toBe("");
    expect(env.ADMIN_NAMES).toBe("");
    expect(env.MARIA_EMAIL).toBe("");
    expect(env.SITE_URL).toBe("https://mslab.ee"); // public
    expect(env.MAIL_FROM).toBe("MS LAB <info@send.mslab.ee>");
    expect(serverEnv(FULL, false)).toMatchObject(FULL);
  });
});

describe("serverEnv() with no arguments", () => {
  test("reads process.env, and NODE_ENV decides whether there are defaults", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, v);
    expect(serverEnv()).toMatchObject(FULL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => serverEnv()).toThrow("DATABASE_URL");
    vi.stubEnv("NODE_ENV", "development");
    expect(serverEnv().DATABASE_URL).toBe(LOCAL_DATABASE_URL);
  });
});

describe("gateEnv (the middleware: the coming-soon gate's two settings only)", () => {
  test("reads SITE_GATE and PREVIEW_SECRET trimmed, blank as not set, and needs none of the required ones, even in production", () => {
    const key = "k".repeat(32);
    expect(gateEnv({})).toEqual({ SITE_GATE: undefined, PREVIEW_SECRET: undefined });
    expect(gateEnv({ SITE_GATE: " 1 ", PREVIEW_SECRET: ` ${key} \n` })).toEqual({ SITE_GATE: "1", PREVIEW_SECRET: key });
    expect(gateEnv({ SITE_GATE: "  ", PREVIEW_SECRET: "" })).toEqual({ SITE_GATE: undefined, PREVIEW_SECRET: undefined });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITE_GATE", "1");
    vi.stubEnv("PREVIEW_SECRET", key);
    expect(gateEnv()).toEqual({ SITE_GATE: "1", PREVIEW_SECRET: key });
  });

  test("a PREVIEW_SECRET shorter than 32 characters counts as unset (the gate then fails closed)", () => {
    for (const secret of ["1", "k", "k".repeat(31), ` ${"k".repeat(31)} `]) expect(gateEnv({ SITE_GATE: "1", PREVIEW_SECRET: secret }).PREVIEW_SECRET, secret).toBeUndefined();
    expect(gateEnv({ SITE_GATE: "1", PREVIEW_SECRET: "k".repeat(32) }).PREVIEW_SECRET).toBe("k".repeat(32));
  });
});

describe("paymentsEnv (phase 2b)", () => {
  test("the seven payment settings, trimmed, blank as not set, without the required ones even in production", () => {
    expect(paymentsEnv({})).toEqual({ MONTONIO_ENV: undefined, MONTONIO_ACCESS_KEY: undefined, MONTONIO_SECRET_KEY: undefined, PAYMENT_PROVIDER: undefined, MONTONIO_FAKE_URL: undefined, PAYMENT_MOCK_IN_PRODUCTION: undefined, MONTONIO_REFERENCE_PREFIX: undefined });
    expect(paymentsEnv({ MONTONIO_ENV: " live ", MONTONIO_ACCESS_KEY: "a\n", MONTONIO_SECRET_KEY: "  ", PAYMENT_PROVIDER: "" })).toMatchObject({ MONTONIO_ENV: "live", MONTONIO_ACCESS_KEY: "a", MONTONIO_SECRET_KEY: undefined, PAYMENT_PROVIDER: undefined });
  });

  test("with no argument it reads process.env, in production too, and only its seven names", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MONTONIO_ACCESS_KEY", " access ");
    vi.stubEnv("DATABASE_URL", "");
    expect(paymentsEnv().MONTONIO_ACCESS_KEY).toBe("access");
    expect(Object.keys(paymentsEnv({ DATABASE_URL: "postgres://x", RESEND_API_KEY: "k" })).sort()).toEqual(
      ["MONTONIO_ACCESS_KEY", "MONTONIO_ENV", "MONTONIO_FAKE_URL", "MONTONIO_REFERENCE_PREFIX", "MONTONIO_SECRET_KEY", "PAYMENT_MOCK_IN_PRODUCTION", "PAYMENT_PROVIDER"],
    );
  });
});

describe(".env.example", () => {
  const text = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const values = parseEnvFile(text);

  test("documents every variable serverEnv() reads, the optional ones as comments", () => {
    for (const name of Object.keys(serverEnv({}, false))) expect(text, name).toMatch(new RegExp(`^(# )?${name}=`, "m"));
  });

  test("is a complete production configuration, and its database is the local one", () => {
    expect(() => serverEnv(values, true)).not.toThrow();
    expect(values.DATABASE_URL).toBe(LOCAL_DATABASE_URL);
    for (const name of ["RESEND_API_KEY", "TELEGRAM_BOT_TOKEN"]) expect(values[name], `${name} is never set in the example`).toBeUndefined();
  });
});
