import { describe, expect, test, vi } from "vitest";
import { bunnyConfig } from "@/server/bunny";
import { paymentsEnv, serverEnv } from "@/server/env";
import { montonioConfig } from "@/server/payments/montonio";
import { E2E_BUNNY } from "../e2e/bunny-values";
import { E2E_MONTONIO } from "../e2e/montonio-values";
import { PROD_ENV } from "../e2e/prod-build";
import { FORBIDDEN_SETTINGS, forbiddenSettingError, LOCAL_ENV, parseEnvFile } from "../local-secrets";

// What an e2e run refuses to start with (tests/e2e/global-setup.ts reads these files and the environment): anything that
// would make the form tests reach real people, the upload tests write to the real R2 bucket, or the video tests create videos in
// the real Bunny library. The values here are made up.

const R2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

describe("forbiddenSettingError", () => {
  test("the forbidden settings are the two mail secrets, all four R2 variables and the Bunny API key", () => {
    expect(Object.keys(FORBIDDEN_SETTINGS).sort()).toEqual(["RESEND_API_KEY", "TELEGRAM_BOT_TOKEN", ...R2, "BUNNY_API_KEY"].sort());
  });

  test("a Bunny API key in an env file or in the run's environment stops it, without its value", () => {
    const message = forbiddenSettingError({ ".env.local": "BUNNY_API_KEY=fake-bunny-key-123\n" }, {})!;
    expect(message).toMatch(/\.env\.local sets BUNNY_API_KEY.*real Bunny library/);
    expect(message).not.toContain("fake-bunny-key-123");
    expect(forbiddenSettingError({}, { BUNNY_API_KEY: "fake-bunny-key-123" })).toMatch(/BUNNY_API_KEY is set in the environment/);
  });

  test("nothing set: the run may go on", () => {
    expect(forbiddenSettingError({}, {})).toBeUndefined();
    expect(forbiddenSettingError({ ".env.local": undefined, ".env": "DATABASE_URL=postgres://u:p@localhost:5432/x\nSITE_URL=https://x.example\n" }, { PATH: "/bin" })).toBeUndefined();
  });

  test("an R2 variable set in an env file stops the run, and the message names it, not its value", () => {
    for (const name of R2) {
      const message = forbiddenSettingError({ ".env.local": `ADMIN_EMAILS=a@example.test\n${name}=fake-value-123\n` }, {})!;
      expect(message, name).toContain(".env.local");
      expect(message, name).toContain(name);
      expect(message, name).toContain("real image bucket");
      expect(message, name).not.toContain("fake-value-123");
    }
  });

  test("so does a mail secret, as before", () => {
    expect(forbiddenSettingError({ ".env": "RESEND_API_KEY=re_fake_key" }, {})).toMatch(/RESEND_API_KEY.*real e-mails/);
    expect(forbiddenSettingError({ ".dev.vars": "TELEGRAM_BOT_TOKEN=1:fake" }, {})).toMatch(/TELEGRAM_BOT_TOKEN.*Telegram/);
  });

  test("an R2 variable in the environment of the run stops it, whatever the files say", () => {
    for (const name of R2) {
      const message = forbiddenSettingError({}, { [name]: "fake-value-123" })!;
      expect(message, name).toContain(name);
      expect(message, name).toContain("environment");
      expect(message, name).not.toContain("fake-value-123");
    }
  });

  test("a commented-out, empty or blank one does not count (.env.example lists them as comments)", () => {
    const text = ["# R2_ACCOUNT_ID=abc", "R2_ACCESS_KEY_ID=", 'R2_SECRET_ACCESS_KEY=""', "R2_BUCKET=''", "#RESEND_API_KEY=x"].join("\n");
    expect(forbiddenSettingError({ ".env.local": text }, { R2_BUCKET: "", R2_ACCOUNT_ID: "  " })).toBeUndefined();
  });

  test("`export NAME=value` and CRLF line ends are read like any other line", () => {
    expect(forbiddenSettingError({ ".env": "export R2_BUCKET=fake-bucket\r\n" }, {})).toContain("R2_BUCKET");
    expect(forbiddenSettingError({ ".env": "A=1\r\nR2_ACCOUNT_ID=abc\r\n" }, {})).toContain("R2_ACCOUNT_ID");
    expect(parseEnvFile("export A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });
});

describe("the dev server's environment (LOCAL_ENV)", () => {
  test("the four R2 variables are there and blank, so a .env.local cannot switch uploads to the real bucket", () => {
    for (const name of R2) expect(LOCAL_ENV, name).toHaveProperty(name, "");
  });

  test("and the server reads blank as not set: with them uploads use the local folder (media-store)", () => {
    const env = serverEnv(LOCAL_ENV, false);
    for (const name of R2) expect(env[name as keyof typeof env], name).toBeUndefined();
  });

  test("the Bunny settings point at the fake on this machine (never the real library)", () => {
    expect(LOCAL_ENV.BUNNY_FAKE_URL).toBe(`http://localhost:${E2E_BUNNY.port}`);
    expect(bunnyConfig(serverEnv(LOCAL_ENV, false), false)).toMatchObject({ apiBase: E2E_BUNNY.url, tusEndpoint: `${E2E_BUNNY.url}/tusupload`, embedBase: `${E2E_BUNNY.url}/embed` });
  });

  test("the fake's port is 3998 unless E2E_BUNNY_PORT names another", () => {
    if (!process.env.E2E_BUNNY_PORT) expect(LOCAL_ENV.BUNNY_FAKE_URL).toBe("http://localhost:3998");
    expect(E2E_BUNNY.port).toBe(process.env.E2E_BUNNY_PORT ? Number(process.env.E2E_BUNNY_PORT) : 3998);
  });

  test("the payments go to the fake Montonio on this machine, never the sandbox; the production build needs its explicit flag (phase 2b)", () => {
    expect(montonioConfig(paymentsEnv(LOCAL_ENV), { production: false, onVercel: false })).toEqual({
      accessKey: E2E_MONTONIO.accessKey, secretKey: E2E_MONTONIO.secretKey, baseUrl: E2E_MONTONIO.url, live: false, mock: true,
    });
    expect(montonioConfig(paymentsEnv(LOCAL_ENV), { production: true, onVercel: false })).toBeNull();
    expect(montonioConfig(paymentsEnv({ ...LOCAL_ENV, ...PROD_ENV }), { production: true, onVercel: false })).toMatchObject({ mock: true, baseUrl: E2E_MONTONIO.url });
    if (!process.env.E2E_MONTONIO_PORT) expect(LOCAL_ENV.MONTONIO_FAKE_URL).toBe("http://localhost:3997");
  });

  test("the run's Montonio settings win over a .env.local's real sandbox keys: all five are set, with the fake's made-up values (phase 2b)", () => {
    expect(LOCAL_ENV).toMatchObject({
      MONTONIO_ENV: "sandbox", MONTONIO_ACCESS_KEY: E2E_MONTONIO.accessKey, MONTONIO_SECRET_KEY: E2E_MONTONIO.secretKey, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: E2E_MONTONIO.url,
    });
    // the made-up keys say so, and are no real store's: the sandbox would answer 401 STORE_NOT_FOUND to them
    expect([E2E_MONTONIO.accessKey, E2E_MONTONIO.secretKey].every((k) => k.startsWith("e2e-"))).toBe(true);
    expect(PROD_ENV).toMatchObject({ PAYMENT_MOCK_IN_PRODUCTION: "1" });
    expect(LOCAL_ENV).not.toHaveProperty("PAYMENT_MOCK_IN_PRODUCTION"); // only the production build's switches carry it
  });

  test("the fake's port is 3997 unless E2E_MONTONIO_PORT names another, and a bad one stops the run", async () => {
    expect(E2E_MONTONIO.port).toBe(process.env.E2E_MONTONIO_PORT ? Number(process.env.E2E_MONTONIO_PORT) : 3997);
    const original = process.env.E2E_MONTONIO_PORT;
    try {
      for (const [value, port] of [[undefined, 3997], ["", 3997], ["  ", 3997], ["4100", 4100]] as const) {
        if (value === undefined) delete process.env.E2E_MONTONIO_PORT;
        else process.env.E2E_MONTONIO_PORT = value;
        vi.resetModules();
        expect((await import("../e2e/montonio-values")).E2E_MONTONIO.port, String(value)).toBe(port);
      }
      for (const bad of ["80", "1023", "65536", "3997.5", "abc", "-1"]) {
        process.env.E2E_MONTONIO_PORT = bad;
        vi.resetModules();
        await expect(import("../e2e/montonio-values"), bad).rejects.toThrow(/E2E_MONTONIO_PORT must be a port number from 1024 to 65535/);
      }
    } finally {
      if (original === undefined) delete process.env.E2E_MONTONIO_PORT;
      else process.env.E2E_MONTONIO_PORT = original;
      vi.resetModules();
    }
  });
});
