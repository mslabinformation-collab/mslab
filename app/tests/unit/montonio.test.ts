import { afterEach, describe, expect, test, vi } from "vitest";
import { signHs256, verifyHs256 } from "@/server/payments/jwt";
import {
  currentRuntime, LIVE_BASE, MontonioError, montonioClient, montonioConfig, montonioErrorText, paymentProvider, paymentsConfigured, REQUEST_TIMEOUT_MS, SANDBOX_BASE, mapMontonioStatus, toCents, toEuros, type MontonioConfig,
} from "@/server/payments/montonio";
import { stubFetch } from "../fakes";

// The Montonio client (phase 2b, spec 4, 7.1–7.3): which store and which address the settings give, the status map, euro↔cent, the order
// request exactly as spec 4 asks (and nothing it forbids), GET /orders/:uuid, and the order token. Montonio is a stubbed fetch here.

const KEYS = { MONTONIO_ACCESS_KEY: "test-access-key", MONTONIO_SECRET_KEY: "test-secret-key-0123456789abcdef" };
const LOCAL = { production: false, onVercel: false };
const CONFIG: MontonioConfig = { accessKey: KEYS.MONTONIO_ACCESS_KEY, secretKey: KEYS.MONTONIO_SECRET_KEY, baseUrl: SANDBOX_BASE, live: false, mock: false };
const ORDER = { reference: "MSLAB-M7", amountCents: 17550, locale: "ru" as const, returnUrl: "https://mslab.example/api/payments/return", notificationUrl: "https://mslab.example/api/payments/notify" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("montonioConfig: which store, which address", () => {
  test("both keys or nothing: payments are optional", () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // (one key alone is noted: the test below)
    expect(montonioConfig({}, LOCAL)).toBeNull();
    expect(montonioConfig({ MONTONIO_ACCESS_KEY: "a" }, LOCAL)).toBeNull();
    expect(montonioConfig({ MONTONIO_SECRET_KEY: "s" }, LOCAL)).toBeNull();
    expect(paymentsConfigured({}, LOCAL)).toBe(false);
    expect(paymentsConfigured(KEYS, LOCAL)).toBe(true);
  });

  test("only the exact 'live' is production; anything else is the sandbox", () => {
    expect(montonioConfig({ ...KEYS, MONTONIO_ENV: "live" }, LOCAL)).toEqual({ accessKey: "test-access-key", secretKey: KEYS.MONTONIO_SECRET_KEY, baseUrl: LIVE_BASE, live: true, mock: false });
    for (const env of [undefined, "sandbox", "Live", "LIVE", "production", "prod"])
      expect(montonioConfig({ ...KEYS, MONTONIO_ENV: env }, LOCAL), String(env)).toMatchObject({ baseUrl: SANDBOX_BASE, live: false, mock: false });
    expect(LIVE_BASE).toBe("https://stargate.montonio.com/api");
    expect(SANDBOX_BASE).toBe("https://sandbox-stargate.montonio.com/api");
    expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: "montonio" }, LOCAL)).toMatchObject({ baseUrl: SANDBOX_BASE, mock: false });
  });

  test("the mock: only PAYMENT_PROVIDER=mock with MONTONIO_FAKE_URL; never on Vercel; in production only with the explicit flag; never a fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = { ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997/" };
    expect(montonioConfig(mock, LOCAL)).toEqual({ accessKey: "test-access-key", secretKey: KEYS.MONTONIO_SECRET_KEY, baseUrl: "http://localhost:3997", live: false, mock: true });
    expect(montonioConfig(mock, { production: false, onVercel: true })).toBeNull();
    expect(montonioConfig({ ...mock, PAYMENT_MOCK_IN_PRODUCTION: "1" }, { production: true, onVercel: true })).toBeNull();
    expect(montonioConfig(mock, { production: true, onVercel: false })).toBeNull();
    expect(montonioConfig({ ...mock, PAYMENT_MOCK_IN_PRODUCTION: "yes" }, { production: true, onVercel: false })).toBeNull();
    expect(montonioConfig({ ...mock, PAYMENT_MOCK_IN_PRODUCTION: "1" }, { production: true, onVercel: false })).toMatchObject({ mock: true });
    expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: "mock" }, LOCAL)).toBeNull(); // no fake address: off, not the real store
    for (const other of ["Mock", "fake", "stripe"]) expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: other, MONTONIO_FAKE_URL: "http://localhost:3997" }, LOCAL), other).toBeNull();
  });

  test("a refused mock is never the real store either: no sandbox, no live, whatever else the settings say (Rempire's audit C1)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = [
      { ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997", MONTONIO_ENV: "live" },
      { ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_ENV: "live" },
      { ...KEYS, PAYMENT_PROVIDER: " mock", MONTONIO_ENV: "live" },
      { ...KEYS, PAYMENT_PROVIDER: "MONTONIO", MONTONIO_ENV: "live" },
    ];
    for (const env of refused) {
      expect(montonioConfig(env, { production: true, onVercel: true })).toBeNull();
      expect(montonioConfig(env, { production: true, onVercel: false })).toBeNull();
      expect(paymentProvider(env, { production: true, onVercel: true })).toBeNull();
    }
    // the fake's address is ignored on the real client: PAYMENT_PROVIDER unset or "montonio" never points anywhere but Montonio
    expect(montonioConfig({ ...KEYS, MONTONIO_FAKE_URL: "http://localhost:3997" }, LOCAL)).toMatchObject({ baseUrl: SANDBOX_BASE, mock: false });
    expect(montonioConfig({ ...KEYS, PAYMENT_PROVIDER: "montonio", MONTONIO_FAKE_URL: "http://localhost:3997", MONTONIO_ENV: "live" }, LOCAL)).toMatchObject({ baseUrl: LIVE_BASE, mock: false });
  });

  test("the fake's address: plain http on this machine only (localhost, 127.0.0.1, [::1]); a remote, https, credentialed or junk address turns payments off and is never used", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mock = (url: string) => ({ ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: url });
    const here: [string, string][] = [
      ["http://localhost:3997", "http://localhost:3997"],
      ["http://localhost:3997/", "http://localhost:3997"],
      ["http://LOCALHOST:4100", "http://localhost:4100"],
      ["http://127.0.0.1:3997", "http://127.0.0.1:3997"],
      ["http://[::1]:3997", "http://[::1]:3997"],
      ["  http://localhost:3997  ", "http://localhost:3997"],
    ];
    // in every runtime where the mock is allowed at all: a dev machine, and a production build that was flagged for it
    for (const [url, baseUrl] of here) {
      expect(montonioConfig(mock(url), LOCAL), url).toMatchObject({ mock: true, live: false, baseUrl });
      expect(montonioConfig({ ...mock(url), PAYMENT_MOCK_IN_PRODUCTION: "1" }, { production: true, onVercel: false }), url).toMatchObject({ mock: true, baseUrl });
    }
    const elsewhere = [
      "http://example.com:3997", "http://mslab.ee", "http://192.168.1.5:3997", "http://10.0.0.2", "http://0.0.0.0:3997", "http://localhost.example.com:3997",
      "http://localhost@evil.example", "http://evil.example#localhost", "http://evil.example/?h=localhost", "http://user:pw@localhost:3997", "http://localhost:3997@evil.example",
      "https://localhost:3997", "https://example.com", "ftp://localhost", "file:///localhost", "javascript:alert(1)", "localhost:3997", "//localhost:3997", "localhost", "not a url", "http://", "http://[::2]:3997",
    ];
    for (const url of elsewhere) {
      expect(montonioConfig(mock(url), LOCAL), url).toBeNull();
      expect(paymentProvider(mock(url), LOCAL), url).toBeNull();
      // the flag does not make a remote address fine
      expect(montonioConfig({ ...mock(url), PAYMENT_MOCK_IN_PRODUCTION: "1" }, { production: true, onVercel: false }), url).toBeNull();
    }
    // and the real client never takes the fake's address, whatever it is
    expect(montonioConfig({ ...KEYS, MONTONIO_FAKE_URL: "http://example.com:3997" }, LOCAL)).toMatchObject({ baseUrl: SANDBOX_BASE, mock: false });
  });

  test("a refused address is noted once with fixed text: not the address, not a key", async () => {
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules(); // a copy that has not noted anything yet
    const fresh = await import("@/server/payments/montonio");
    const env = { ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://evil-host.example:3997/secret-path" };
    for (let i = 0; i < 2; i++) expect(fresh.montonioConfig(env, LOCAL)).toBeNull();
    expect(note).toHaveBeenCalledTimes(1);
    const line = String(note.mock.calls[0][0]);
    expect(line).toContain("online payments are off");
    for (const secret of [KEYS.MONTONIO_ACCESS_KEY, KEYS.MONTONIO_SECRET_KEY, "evil-host", "secret-path", "3997"]) expect(line).not.toContain(secret);
  });

  test("a refusal is noted once per process, with fixed text: no key, no address", async () => {
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules(); // a copy that has not noted anything yet
    const fresh = await import("@/server/payments/montonio");
    const env = { ...KEYS, PAYMENT_PROVIDER: "mock", MONTONIO_FAKE_URL: "http://localhost:3997" };
    for (let i = 0; i < 3; i++) expect(fresh.montonioConfig(env, { production: true, onVercel: true })).toBeNull();
    expect(note).toHaveBeenCalledTimes(1);
    const line = String(note.mock.calls[0][0]);
    expect(line).toContain("online payments are off");
    for (const secret of [KEYS.MONTONIO_ACCESS_KEY, KEYS.MONTONIO_SECRET_KEY, "localhost"]) expect(line).not.toContain(secret);
  });

  test("only one of the two keys set: payments are off, and that is noted once, naming the settings, never a value; neither set: silent", async () => {
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [{ MONTONIO_ACCESS_KEY: KEYS.MONTONIO_ACCESS_KEY }, { MONTONIO_SECRET_KEY: KEYS.MONTONIO_SECRET_KEY }, { ...KEYS, MONTONIO_SECRET_KEY: "" }]) {
      vi.resetModules(); // a copy that has not noted anything yet
      const fresh = await import("@/server/payments/montonio");
      note.mockClear();
      for (let i = 0; i < 2; i++) expect(fresh.montonioConfig(env, LOCAL), JSON.stringify(Object.keys(env))).toBeNull();
      expect(note, JSON.stringify(Object.keys(env))).toHaveBeenCalledTimes(1);
      const line = String(note.mock.calls[0][0]);
      expect(line).toBe("[payments] only one of MONTONIO_ACCESS_KEY and MONTONIO_SECRET_KEY is set: online payments are off");
      for (const secret of [KEYS.MONTONIO_ACCESS_KEY, KEYS.MONTONIO_SECRET_KEY]) expect(line).not.toContain(secret);
    }
    vi.resetModules();
    const fresh = await import("@/server/payments/montonio");
    note.mockClear();
    for (const env of [{}, { MONTONIO_ACCESS_KEY: "", MONTONIO_SECRET_KEY: "" }]) expect(fresh.montonioConfig(env, LOCAL)).toBeNull();
    expect(note).not.toHaveBeenCalled(); // no keys at all is the normal "no payments", not a mistake
  });

  test("currentRuntime reads this process: NODE_ENV production, and VERCEL set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    expect(currentRuntime()).toEqual({ production: true, onVercel: false });
    vi.stubEnv("VERCEL", "1");
    expect(currentRuntime()).toEqual({ production: true, onVercel: true });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    expect(currentRuntime()).toEqual({ production: false, onVercel: false });
  });

  test("paymentProvider is the client of the config, or null", () => {
    expect(paymentProvider({}, LOCAL)).toBeNull();
    expect(paymentProvider(KEYS, LOCAL)?.accessKey).toBe("test-access-key");
  });
});

describe("the status map (spec 7.3) and euro↔cent", () => {
  test("PAID is paid; PENDING, AUTHORIZED and anything unknown change nothing; ABANDONED, VOIDED, CANCELLED, FAILED fail; the refunds are refunded", () => {
    expect(mapMontonioStatus("PAID")).toBe("paid");
    expect(mapMontonioStatus("paid")).toBe("paid");
    for (const s of ["PENDING", "AUTHORIZED", "", "SOMETHING_NEW", undefined, null, 42]) expect(mapMontonioStatus(s), String(s)).toBe("pending");
    for (const s of ["ABANDONED", "VOIDED", "CANCELLED", "FAILED"]) expect(mapMontonioStatus(s), s).toBe("failed");
    for (const s of ["REFUNDED", "PARTIALLY_REFUNDED"]) expect(mapMontonioStatus(s), s).toBe("refunded");
  });

  test("only a string is a status: an array, an object or a boxed string that would print as PAID is pending, never paid", () => {
    // String(["PAID"]) is "PAID", String({ toString }) is whatever it says: neither is Montonio's paymentStatus
    const sayingPaid = { toString: () => "PAID" };
    for (const s of [["PAID"], [["PAID"]], sayingPaid, new String("PAID"), { status: "PAID" }, ["ABANDONED"], ["REFUNDED"], true, BigInt(1)])
      expect(mapMontonioStatus(s), String(typeof s)).toBe("pending");
    expect(["PAID", " paid ", "abandoned", "Refunded"].map((s) => mapMontonioStatus(s))).toEqual(["paid", "paid", "failed", "refunded"]);
  });

  test("cents ↔ euros: a number or GET /orders' string; anything else is no amount, a third decimal included (exact in cents, spec 7.4)", () => {
    expect([toCents(175), toCents(175.5), toCents(99.99), toCents(175.01), toCents("100.00"), toCents("0.10"), toCents(0)]).toEqual([17500, 17550, 9999, 17501, 10000, 10, 0]);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "", "1,50", "abc", "1.234", 175.504, 174.999, 0.001, null, undefined, {}]) expect(toCents(bad), String(bad)).toBeNull();
    expect([toEuros(17500), toEuros(17550), toEuros(9999), toEuros(1)]).toEqual([175, 175.5, 99.99, 0.01]);
  });

  test("an amount too big to be counted exactly in cents is no amount: it could not be compared with what was asked", () => {
    for (const big of ["99999999999999999999", "1000000000000000.00", 1e20, 1e15, 9_007_199_254_740_993, Number.MAX_VALUE, "9".repeat(400)])
      expect(toCents(big), String(big)).toBeNull();
    // a large price that is still exact stays an amount
    expect(toCents("1000000000000.00")).toBe(100_000_000_000_000);
    expect(toCents(1e12)).toBe(100_000_000_000_000);
  });

  test("every whole number of cents survives the trip to euros and back (no float drift in a price)", () => {
    for (let cents = 0; cents <= 50_000; cents++) if (toCents(toEuros(cents)) !== cents) throw new Error(`${cents} came back as ${toCents(toEuros(cents))}`);
    for (const euros of ["1.5", "175.50", " 100.00 ", "007"]) expect(toCents(euros), euros).not.toBeNull();
  });
});

describe("createOrder", () => {
  test("POST /orders { data: <jwt> }: the order of spec 4 (paymentInitiation, no preferredProvider, no paymentReference), signed for 10 minutes", async () => {
    const f = stubFetch(() => Response.json({ uuid: "uuid-1", paymentStatus: "PENDING", merchantReference: "MSLAB-M7", paymentUrl: "https://sandbox-stargate.montonio.com/uuid-1" }));
    expect(await montonioClient(CONFIG).createOrder(ORDER)).toEqual({ uuid: "uuid-1", paymentUrl: "https://sandbox-stargate.montonio.com/uuid-1" });
    expect(f.calls).toHaveLength(1);
    expect([f.calls[0].url, f.calls[0].method]).toEqual([`${SANDBOX_BASE}/orders`, "POST"]);
    const { data } = f.calls[0].body as { data: string };
    const { claims } = verifyHs256(data, CONFIG.secretKey);
    expect(claims).toEqual({
      accessKey: "test-access-key",
      merchantReference: "MSLAB-M7",
      returnUrl: ORDER.returnUrl,
      notificationUrl: ORDER.notificationUrl,
      currency: "EUR",
      grandTotal: 175.5,
      locale: "ru",
      payment: { method: "paymentInitiation", amount: 175.5, currency: "EUR", methodOptions: { paymentDescription: "MS LAB MSLAB-M7" } },
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
  });

  test("the request is signed at the client's clock, not the machine's", async () => {
    const f = stubFetch(() => Response.json({ uuid: "u", paymentUrl: "https://x.example/1" }));
    await montonioClient(CONFIG, undefined, () => 1_791_500_000_999).createOrder(ORDER);
    const { claims } = verifyHs256((f.calls[0].body as { data: string }).data, CONFIG.secretKey, { nowSec: 1_791_500_000 });
    expect([claims.iat, claims.exp]).toEqual([1_791_500_000, 1_791_500_600]);
  });

  test("every call has the 15 s signal, refuses redirects and is never cached; the secret key is never sent", async () => {
    const f = stubFetch(() => Response.json({ uuid: "uuid-1", paymentUrl: "https://x.example/1", paymentStatus: "PAID" }));
    await montonioClient(CONFIG).createOrder(ORDER);
    await montonioClient(CONFIG).fetchOrder("uuid-1");
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(f.fn.mock.calls).toHaveLength(2);
    for (const [, init] of f.fn.mock.calls) {
      expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    }
    expect(JSON.stringify([f.calls[0].body, [...f.calls[0].headers], [...f.calls[1].headers], f.calls.map((c) => c.url)])).not.toContain(CONFIG.secretKey);
  });

  test("Montonio's refusal keeps its own text; no answer is 'unreachable'; a body without uuid or an https paymentUrl is 'bad_response'", async () => {
    const fail = async (respond: () => Response | Promise<Response>, config = CONFIG) => {
      stubFetch(respond);
      try {
        await montonioClient(config).createOrder(ORDER);
      } catch (e) {
        return e instanceof MontonioError ? [e.op, e.code, e.detail] : ["other"];
      }
      return ["none"];
    };
    expect(await fail(() => Response.json({ message: "STORE_NOT_FOUND - double check your access key" }, { status: 401 }))).toEqual(["create", "rejected", "HTTP 401 · STORE_NOT_FOUND - double check your access key"]);
    expect(await fail(() => new Response("Bad gateway", { status: 502 }))).toEqual(["create", "rejected", "HTTP 502 · Bad gateway"]);
    expect(await fail(() => Promise.reject(new TypeError("fetch failed")))).toEqual(["create", "unreachable", ""]);
    expect(await fail(() => new Response("not json"))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json({ paymentUrl: "https://x.example/1" }))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json({ uuid: "u", paymentUrl: "http://x.example/1" }))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json({ uuid: "u", paymentUrl: "javascript:alert(1)" }))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json({ uuid: "u" }))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json("a string"))).toEqual(["create", "bad_response", ""]);
    expect(await fail(() => Response.json(null))).toEqual(["create", "bad_response", ""]);
    // a redirect that the platform refuses (redirect: "error") rejects the fetch: not Montonio's answer
    expect(await fail(() => Promise.reject(new TypeError("redirect mode is set to error")))).toEqual(["create", "unreachable", ""]);
    // the e2e run's fake answers on plain http: only a mock config takes that
    expect(await fail(() => Response.json({ uuid: "u", paymentUrl: "http://localhost:3997/pay/u" }), { ...CONFIG, mock: true, baseUrl: "http://localhost:3997" })).toEqual(["none"]);
    expect(await fail(() => Response.json({ uuid: "u", paymentUrl: "javascript:alert(1)" }), { ...CONFIG, mock: true, baseUrl: "http://localhost:3997" })).toEqual(["create", "bad_response", ""]);
  });

  test("the payer is sent to https, or in a mock config to plain http on this machine only: never to a remote http address", async () => {
    const mock: MontonioConfig = { ...CONFIG, mock: true, baseUrl: "http://localhost:3997" };
    const reply = async (paymentUrl: string, config: MontonioConfig) => {
      stubFetch(() => Response.json({ uuid: "u", paymentUrl }));
      try {
        return (await montonioClient(config).createOrder(ORDER)).paymentUrl;
      } catch (e) {
        return e instanceof MontonioError ? `${e.code}` : "other";
      }
    };
    for (const url of ["http://localhost:3997/pay/u", "http://127.0.0.1:3997/pay/u", "http://[::1]:3997/pay/u", "https://pay.example/u"]) expect(await reply(url, mock), url).toBe(url);
    for (const url of [
      "http://x.example/1", "http://example.com:3997/pay/u", "http://localhost.evil.example/pay/u", "http://localhost@evil.example/pay/u", "http://evil.example/?h=localhost",
      "http://user:pw@localhost:3997/pay/u", "http://192.168.1.5/pay/u", "http://", "javascript:alert(1)", "//localhost/pay/u", "localhost:3997/pay/u",
    ])
      expect(await reply(url, mock), url).toBe("bad_response");
    // and a config that is not a mock takes https only, localhost or not
    for (const url of ["http://localhost:3997/pay/u", "http://127.0.0.1/pay/u"]) expect(await reply(url, CONFIG), url).toBe("bad_response");
  });

  test("an amount that is no positive whole number of cents is a programming error, not an order", async () => {
    const f = stubFetch(() => Response.json({}));
    for (const amountCents of [0, -1, 1.5, Number.NaN]) await expect(montonioClient(CONFIG).createOrder({ ...ORDER, amountCents })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });
});

describe("montonioErrorText", () => {
  test("the status and Montonio's own words, one short line, cut at 300 characters", () => {
    expect(montonioErrorText(400, JSON.stringify({ message: "Refund amount [1000] exceeds" }))).toBe("HTTP 400 · Refund amount [1000] exceeds");
    expect(montonioErrorText(403, JSON.stringify({ error: "INVALID_TOKEN - double check your secret key" }))).toBe("HTTP 403 · INVALID_TOKEN - double check your secret key");
    expect(montonioErrorText(422, JSON.stringify({ message: ["a is wrong", "b is wrong"] }))).toBe("HTTP 422 · a is wrong; b is wrong");
    expect(montonioErrorText(500, "")).toBe("HTTP 500");
    expect(montonioErrorText(502, "<html>Bad gateway</html>")).toBe("HTTP 502 · <html>Bad gateway</html>");
    expect(montonioErrorText(400, "{broken")).toBe("HTTP 400 · {broken");
    expect(montonioErrorText(400, JSON.stringify({ other: 1 }))).toBe(`HTTP 400 · {"other":1}`);
    expect(montonioErrorText(400, JSON.stringify({ message: "x".repeat(400) })).length).toBe("HTTP 400 · ".length + 300);
  });

  test("a token Montonio echoes back is cut out of its text before the text is cut to length", () => {
    const token = signHs256({ accessKey: "echoed-access-key", paymentStatus: "PAID" }, CONFIG.secretKey, { expiresInSeconds: 600 });
    expect(token).toMatch(/^eyJ/);
    const [head, body, signature] = token.split(".");
    const kept = (text: string) => {
      for (const part of [token, head, body, signature]) expect(text).not.toContain(part);
    };
    const inMessage = montonioErrorText(401, JSON.stringify({ message: `Invalid token ${token} for this store` }));
    expect(inMessage).toBe("HTTP 401 · Invalid token [jwt] for this store");
    kept(inMessage);
    expect(montonioErrorText(401, JSON.stringify({ error: `Bearer ${token}` }))).toBe("HTTP 401 · Bearer [jwt]");
    expect(montonioErrorText(422, JSON.stringify({ message: ["first is fine", `second ${token}`] }))).toBe("HTTP 422 · first is fine; second [jwt]");
    expect(montonioErrorText(400, `Bad request: ${token}`)).toBe("HTTP 400 · Bad request: [jwt]");
    expect(montonioErrorText(400, `<html>${token}</html> and again ${token}`)).toBe("HTTP 400 · <html>[jwt]</html> and again [jwt]");
    // a token that begins just inside the cut would leave a readable piece of itself if it were cut first
    const long = montonioErrorText(400, JSON.stringify({ message: `${"x".repeat(270)}${token}` }));
    expect(long).toBe(`HTTP 400 · ${"x".repeat(270)}[jwt]`);
    kept(long);
    // a token with no signature (alg none) or with dashes and underscores in it is one too
    expect(montonioErrorText(400, "eyJhbGciOiJub25lIn0.eyJhIjoxfQ.")).toBe("HTTP 400 · [jwt]");
    expect(montonioErrorText(400, "eyJh-bG_ci.eyJh-I_oxfQ.c-i_g")).toBe("HTTP 400 · [jwt]");
    // text that only looks a little like one is kept as it is
    expect(montonioErrorText(400, "STORE_NOT_FOUND eyJ only one part. here")).toBe("HTTP 400 · STORE_NOT_FOUND eyJ only one part. here");
  });

  test("and it never reaches the log or a MontonioError: Montonio echoes the request's own tokens back", async () => {
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    // a gateway that answers with everything it was sent: the Bearer header, and the body of the POST
    const f = stubFetch((_url, init) => Response.json({ message: `Rejected ${new Headers(init?.headers).get("authorization") ?? ""} ${String(init?.body ?? "")}` }, { status: 401 }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    const detail = await montonioClient(CONFIG).createOrder(ORDER).then(
      () => "",
      (e: unknown) => (e instanceof MontonioError ? e.detail : "other"),
    );
    const bearer = /^Bearer (.+)$/.exec(f.calls[0].headers.get("authorization") ?? "")![1];
    const data = (f.calls[1].body as { data: string }).data;
    const logged = note.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("HTTP 401 · Rejected Bearer [jwt]");
    expect(detail).toContain("[jwt]");
    for (const token of [bearer, data]) {
      const [head, body, signature] = token.split(".");
      for (const part of [token, head, body, signature]) {
        expect(logged).not.toContain(part);
        expect(detail).not.toContain(part);
      }
    }
  });
});

describe("fetchOrder (GET /orders/:uuid)", () => {
  test("a Bearer token of { accessKey } for an hour; the status, the amount from a string, the reference", async () => {
    const f = stubFetch(() => Response.json({ uuid: "uuid-1", paymentStatus: "PAID", merchantReference: "MSLAB-M7", grandTotal: "175.50", currency: "EUR", paymentMethodType: "paymentInitiation" }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toEqual({ uuid: "uuid-1", reference: "MSLAB-M7", status: "paid", rawStatus: "PAID", amountCents: 17550, currency: "EUR", method: "paymentInitiation" });
    expect([f.calls[0].url, f.calls[0].method]).toEqual([`${SANDBOX_BASE}/orders/uuid-1`, "GET"]);
    const bearer = /^Bearer (.+)$/.exec(f.calls[0].headers.get("authorization") ?? "")![1];
    const { claims } = verifyHs256(bearer, CONFIG.secretKey);
    expect(claims.accessKey).toBe("test-access-key");
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
  });

  test("no answer, a refusal, a body that is no order, or an id that cannot be one: null (never a throw)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    stubFetch(() => Response.json({ message: "Order not found" }, { status: 404 }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    stubFetch(() => new Response("[]"));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    stubFetch(() => new Response("not json"));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toBeNull();
    const f = stubFetch(() => Response.json({}));
    for (const id of ["../stores", "a/b", "a b", "", "   ", "x".repeat(101), "id?x=1", "id#frag"]) expect(await montonioClient(CONFIG).fetchOrder(id), id).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("a body without a status stays pending and unpaid: nothing is read into a missing field", async () => {
    stubFetch(() => Response.json({ uuid: "uuid-1" }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-1")).toEqual({ uuid: "uuid-1", reference: "", status: "pending", rawStatus: "", amountCents: null, currency: null, method: "" });
  });

  test("a refusal is noted with Montonio's own text and nothing of the request: no key, no token, no uuid", async () => {
    const note = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => Response.json({ message: "INVALID_TOKEN - double check your secret key" }, { status: 403 }));
    expect(await montonioClient(CONFIG).fetchOrder("uuid-secret-id")).toBeNull();
    const lines = note.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).toContain("HTTP 403 · INVALID_TOKEN - double check your secret key");
    for (const secret of [CONFIG.secretKey, CONFIG.accessKey, "uuid-secret-id", "Bearer"]) expect(lines).not.toContain(secret);
  });
});

describe("verifyOrderToken", () => {
  const token = (claims: Record<string, unknown>, secret = CONFIG.secretKey, nowSec?: number) =>
    signHs256({ uuid: "uuid-1", accessKey: "test-access-key", merchantReference: "MSLAB-M7", paymentStatus: "PAID", paymentMethod: "paymentInitiation", grandTotal: 175.5, currency: "EUR", paymentProviderName: "Swedbank", ...claims }, secret, { expiresInSeconds: 600, nowSec });

  test("what the token says, read; the access key is reported, not judged (settle.ts asks Montonio on a mismatch)", () => {
    const client = montonioClient(CONFIG);
    expect(client.verifyOrderToken(token({}))).toEqual({ uuid: "uuid-1", accessKey: "test-access-key", reference: "MSLAB-M7", status: "paid", rawStatus: "PAID", amountCents: 17550, currency: "EUR", method: "paymentInitiation", bank: "Swedbank", expired: false });
    expect(client.verifyOrderToken(token({ accessKey: "someone-else", paymentStatus: "ABANDONED", grandTotal: "x" }))).toMatchObject({ accessKey: "someone-else", status: "failed", rawStatus: "ABANDONED", amountCents: null });
    expect(client.verifyOrderToken(token({ accessKey: undefined, paymentProviderName: null }))).toMatchObject({ accessKey: null, bank: "" });
    expect(client.accessKey).toBe("test-access-key");
  });

  test("another secret throws (unverifiable); no merchantReference throws; an old token is read, and says expired", () => {
    const client = montonioClient(CONFIG);
    expect(() => client.verifyOrderToken(token({}, "another-secret-0123456789abcdef"))).toThrow(/jwt signature/);
    expect(() => client.verifyOrderToken(token({ merchantReference: "" }))).toThrow(/jwt payload/);
    const old = token({}, CONFIG.secretKey, Math.floor(Date.now() / 1000) - 3600);
    expect(client.verifyOrderToken(old)).toMatchObject({ status: "paid", expired: true });
  });

  test("a token that is not Montonio's own is never read as a payment: other algorithm, tampered amount, garbage", () => {
    const client = montonioClient(CONFIG);
    const good = token({});
    const [h, , s] = good.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ uuid: "uuid-1", merchantReference: "MSLAB-M7", paymentStatus: "PAID", grandTotal: 1, currency: "EUR" })).toString("base64url")}.${s}`;
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${good.split(".")[1]}.`;
    for (const bad of [forged, none, "", "garbage", "a.b.c"]) expect(() => client.verifyOrderToken(bad), bad).toThrow(/jwt/);
  });

  test("the token's age is judged by the client's clock, with the 60 s tolerance", () => {
    const issued = 1_791_500_000;
    const old = token({}, CONFIG.secretKey, issued); // exp = issued + 600
    const at = (sec: number) => montonioClient(CONFIG, undefined, () => sec * 1000).verifyOrderToken(old).expired;
    expect([at(issued + 600 + 60), at(issued + 600 + 61)]).toEqual([false, true]);
  });
});

describe("verifyRefundToken (Montonio's refund webhook, { refundToken }: docs.montonio.com, Stargate refunds guide)", () => {
  const token = (claims: Record<string, unknown>, secret = CONFIG.secretKey, nowSec?: number) =>
    signHs256({ refundUuid: "refund-1", refundStatus: "SUCCESSFUL", refundStatusDescription: null, accessKey: "test-access-key", refundAmount: 33.09, orderUuid: "uuid-1", ...claims }, secret, { expiresInSeconds: 7 * 86_400, nowSec });

  test("what the token says, read: the order it is about, the refund's own id and status; the amount is not read (Montonio's GET /orders is the source)", () => {
    const client = montonioClient(CONFIG);
    expect(client.verifyRefundToken(token({}))).toEqual({ orderUuid: "uuid-1", refundUuid: "refund-1", accessKey: "test-access-key", rawStatus: "SUCCESSFUL", expired: false });
    expect(client.verifyRefundToken(token({ accessKey: undefined, refundStatus: "rejected", refundUuid: 7 }))).toMatchObject({ accessKey: null, rawStatus: "REJECTED", refundUuid: "" });
    const old = token({}, CONFIG.secretKey, Math.floor(Date.now() / 1000) - 8 * 86_400);
    expect(client.verifyRefundToken(old)).toMatchObject({ orderUuid: "uuid-1", expired: true });
  });

  test("verified as an order token is: HS256 only, the signature with the store's secret; no orderUuid is no refund notice", () => {
    const client = montonioClient(CONFIG);
    expect(() => client.verifyRefundToken(token({}, "another-secret-0123456789abcdef"))).toThrow(/jwt signature/);
    expect(() => client.verifyRefundToken(token({ orderUuid: "" }))).toThrow(/jwt payload/);
    expect(() => client.verifyRefundToken(token({ orderUuid: 42 }))).toThrow(/jwt payload/);
    const good = token({});
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${good.split(".")[1]}.`;
    const rs = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${good.split(".")[1]}.${good.split(".")[2]}`;
    const [h, , s] = good.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ orderUuid: "uuid-2", refundStatus: "SUCCESSFUL" })).toString("base64url")}.${s}`;
    for (const bad of [none, rs, forged, "", "garbage", "a.b.c"]) expect(() => client.verifyRefundToken(bad), bad).toThrow(/jwt/);
  });
});
