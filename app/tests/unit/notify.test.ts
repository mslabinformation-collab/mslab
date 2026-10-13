import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultReplyTo, notifyMaria, RATE_LIMIT_RETRY_MS, sendMail, sendTelegram, type Env } from "@/server/notify";
import { fakeKv, stubFetch } from "../fakes";

const env = (extra: Partial<Env> = {}, kv = fakeKv()): Env => ({
  KV: kv,
  MAIL_FROM: "MS LAB <info@send.diipsolutions.eu>",
  MARIA_EMAIL: "maria@example.com",
  SITE_URL: "https://mslab.example",
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("without secrets (local dev)", () => {
  test("nothing is sent, a console note says so, nothing throws", async () => {
    const f = stubFetch();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await notifyMaria(env(), "Teema", "Tekst")).toEqual({ mail: false, telegram: false });
    expect(f.calls).toHaveLength(0);
    expect(info).toHaveBeenCalledWith("[notify] RESEND_API_KEY is not set: e-mail skipped");
    expect(info).toHaveBeenCalledWith("[notify] TELEGRAM_BOT_TOKEN is not set: Telegram skipped");
  });
});

describe("e-mail (Resend)", () => {
  test("sends a plain-text e-mail from MAIL_FROM; reply goes to the visitor", async () => {
    const f = stubFetch(() => Response.json({ id: "email_123" }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const ok = await sendMail(env({ RESEND_API_KEY: "re_test" }), { to: "maria@example.com", subject: "S", text: "T", replyTo: "visitor@example.com" });
    expect(ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe("Bearer re_test");
    expect(call.body).toMatchObject({ from: "MS LAB <info@send.diipsolutions.eu>", to: "maria@example.com", subject: "S", text: "T", reply_to: "visitor@example.com" });
  });

  test("sends the HTML body next to the text when the mail has one; a text-only mail carries no html", async () => {
    const f = stubFetch(() => Response.json({ id: "email_123" }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const key = env({ RESEND_API_KEY: "re_test" });
    expect(await sendMail(key, { to: "x@example.com", subject: "S", text: "T", html: "<p>H</p>" })).toBe(true);
    expect(f.calls[0].body).toMatchObject({ subject: "S", text: "T", html: "<p>H</p>" });
    expect(await sendMail(key, { to: "x@example.com", subject: "S", text: "T", html: "" })).toBe(true); // an empty html is left out
    expect(await sendMail(key, { to: "x@example.com", subject: "S", text: "T" })).toBe(true);
    for (const call of f.calls.slice(1)) expect(Object.keys(call.body as object)).not.toContain("html");
    expect(f.calls[1].body).toMatchObject({ text: "T" });
  });

  test("a rejected or failed send is reported as false; the log has the error name and status, not the message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() =>
      Response.json({ name: "validation_error", message: "You can only send to your own address (private@example.com).", statusCode: 422 }, { status: 422 }),
    );
    expect(await sendMail(env({ RESEND_API_KEY: "re_test" }), { to: "private@example.com", subject: "S", text: "T" })).toBe(false);
    stubFetch(() => {
      throw new Error("network down");
    });
    expect(await sendMail(env({ RESEND_API_KEY: "re_test" }), { to: "x", subject: "S", text: "T" })).toBe(false);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("validation_error (status 422)");
    expect(logged).not.toContain("private@example.com");
  });

  describe("Resend's rate limit (429)", () => {
    const limited = () => Response.json({ name: "rate_limit_exceeded", message: "Too many requests to private@example.com.", statusCode: 429 }, { status: 429 });
    const key = () => env({ RESEND_API_KEY: "re_test" });
    const mail = { to: "private@example.com", subject: "S", text: "T" };

    afterEach(() => vi.useRealTimers());

    test("a 429 is tried once more after about a second, and a 200 then sends it", async () => {
      vi.useFakeTimers();
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let n = 0;
      const f = stubFetch(() => (++n === 1 ? limited() : Response.json({ id: "email_2" })));
      const sent = sendMail(key(), mail);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
      expect(f.calls).toHaveLength(1); // not before the pause
      await vi.advanceTimersByTimeAsync(1);
      expect(await sent).toBe(true);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1].body).toEqual(f.calls[0].body); // the same mail
      const logged = [...info.mock.calls, ...error.mock.calls].flat().join(" ");
      expect(logged).not.toContain("private@example.com"); // the provider's message can quote the recipient
    });

    test("only once: a second 429 is a failure, and its log has the error name and status only", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const f = stubFetch(() => limited());
      const sent = sendMail(key(), mail);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
      expect(await sent).toBe(false);
      expect(f.calls).toHaveLength(2);
      expect(error.mock.calls.flat().join(" ")).toContain("rate_limit_exceeded (status 429)");
      expect(error.mock.calls.flat().join(" ")).not.toContain("private@example.com");
    });

    test("nothing else is tried again: another rejection, a daily quota, a failed request", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const f = stubFetch(() => Response.json({ name: "validation_error", message: "no", statusCode: 422 }, { status: 422 }));
      expect(await sendMail(key(), mail)).toBe(false);
      const quota = stubFetch(() => Response.json({ name: "daily_quota_exceeded", message: "no", statusCode: 429 }, { status: 429 }));
      expect(await sendMail(key(), mail)).toBe(false);
      const down = stubFetch(() => {
        throw new Error("network down");
      });
      expect(await sendMail(key(), mail)).toBe(false);
      expect([f.calls.length, quota.calls.length, down.calls.length]).toEqual([1, 1, 1]);
    });
  });

  test("a hung Resend call gives up after 8 s", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      stubFetch(() => new Promise<Response>(() => {}));
      const sent = sendMail(env({ RESEND_API_KEY: "re_test" }), { to: "x@example.com", subject: "S", text: "T" });
      await vi.advanceTimersByTimeAsync(8000);
      expect(await sent).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Telegram", () => {
  test("uses the chat id stored in KV (tg:chat) and links the admin (SITE_URL, or the given site address)", async () => {
    const f = stubFetch(() => Response.json({ ok: true }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await notifyMaria(env({ TELEGRAM_BOT_TOKEN: "123:abc" }, fakeKv({ "tg:chat": "42" })), "Teema", "Pikk tekst", { short: "Lühike" });
    expect(r).toEqual({ mail: false, telegram: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(f.calls[0].body).toEqual({ chat_id: "42", text: "Lühike\n\nhttps://mslab.example/admin", disable_web_page_preview: true });
    await notifyMaria(env({ TELEGRAM_BOT_TOKEN: "123:abc" }, fakeKv({ "tg:chat": "42" })), "Teema", "Tekst", { siteUrl: "https://mslab.diipsolutions.eu" });
    expect((f.calls[1].body as { text: string }).text).toBe("Teema\n\nhttps://mslab.diipsolutions.eu/admin");
  });

  test("TELEGRAM_CHAT_ID overrides KV", async () => {
    const f = stubFetch(() => Response.json({ ok: true }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await sendTelegram(env({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "7" }, fakeKv({ "tg:chat": "42" })), "x");
    expect(f.calls[0].body).toMatchObject({ chat_id: "7" });
  });

  test("without TELEGRAM_CHAT_ID or a stored chat it is skipped: no getUpdates, nothing written to KV", async () => {
    const kv = fakeKv();
    const put = vi.spyOn(kv, "put");
    const f = stubFetch(() => Response.json({ ok: true, result: [{ message: { chat: { id: 555, type: "private" } } }] }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await sendTelegram(env({ TELEGRAM_BOT_TOKEN: "t" }, kv), "x")).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("[notify] no Telegram chat (TELEGRAM_CHAT_ID / KV tg:chat): Telegram skipped");
  });

  test("the Telegram request carries a timeout signal", async () => {
    const f = stubFetch(() => Response.json({ ok: true }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await sendTelegram(env({ TELEGRAM_BOT_TOKEN: "t" }, fakeKv({ "tg:chat": "1" })), "x");
    expect(f.fn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("an error answer or a network failure is false, never an exception; the log has no token or URL", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => new Response("Bad Request: chat not found", { status: 400 }));
    expect(await sendTelegram(env({ TELEGRAM_BOT_TOKEN: "123:secret" }, fakeKv({ "tg:chat": "1" })), "x")).toBe(false);
    stubFetch(() => {
      throw new TypeError("fetch failed: https://api.telegram.org/bot123:secret/sendMessage");
    });
    expect(await sendTelegram(env({ TELEGRAM_BOT_TOKEN: "123:secret" }, fakeKv({ "tg:chat": "1" })), "x")).toBe(false);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("status 400");
    expect(logged).toContain("TypeError");
    expect(logged).not.toMatch(/secret|api\.telegram\.org|chat not found/);
  });

  test("long messages are cut to Telegram's limit", async () => {
    const f = stubFetch(() => Response.json({ ok: true }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await sendTelegram(env({ TELEGRAM_BOT_TOKEN: "t" }, fakeKv({ "tg:chat": "1" })), "x".repeat(5000));
    expect((f.calls[0].body as { text: string }).text).toHaveLength(3900);
  });
});

describe("Reply-To (spec D8): Maria's inbox for every mail without one of its own", () => {
  test("defaultReplyTo: MARIA_EMAIL, unless the mail goes to her (trimmed, any case) or it is not set", () => {
    expect(defaultReplyTo({ MARIA_EMAIL: "maria@example.com" }, "kati@example.com")).toBe("maria@example.com");
    expect(defaultReplyTo({ MARIA_EMAIL: " maria@example.com " }, "kati@example.com")).toBe("maria@example.com");
    expect(defaultReplyTo({ MARIA_EMAIL: "maria@example.com" }, "maria@example.com")).toBeUndefined();
    expect(defaultReplyTo({ MARIA_EMAIL: "Maria@Example.com" }, " maria@example.COM ")).toBeUndefined();
    expect(defaultReplyTo({ MARIA_EMAIL: "" }, "kati@example.com")).toBeUndefined();
    expect(defaultReplyTo({ MARIA_EMAIL: "   " }, "kati@example.com")).toBeUndefined();
  });

  test("sendMail: a student's mail replies to Maria; a mail's own Reply-To wins; a mail to Maria gets none of hers", async () => {
    const f = stubFetch(() => Response.json({ id: "email_1" }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const key = env({ RESEND_API_KEY: "re_test" });
    await sendMail(key, { to: "kati@example.com", subject: "S", text: "T" });
    await sendMail(key, { to: "kati@example.com", subject: "S", text: "T", replyTo: "other@example.com" });
    await sendMail(key, { to: "maria@example.com", subject: "S", text: "T" });
    const bodies = f.calls.map((c) => c.body as Record<string, unknown>);
    expect(bodies.map((b) => b.reply_to)).toEqual(["maria@example.com", "other@example.com", undefined]);
    expect(Object.keys(bodies[2])).not.toContain("reply_to");
  });

  test("notifyMaria: the student's address when the notice names her, none of its own otherwise", async () => {
    const f = stubFetch(() => Response.json({ id: "email_1" }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const key = env({ RESEND_API_KEY: "re_test" });
    await notifyMaria(key, "Teema", "Tekst", { replyTo: "kati@example.com" });
    await notifyMaria(key, "Teema", "Tekst");
    const bodies = f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as Record<string, unknown>);
    expect(bodies.map((b) => [b.to, b.reply_to])).toEqual([["maria@example.com", "kati@example.com"], ["maria@example.com", undefined]]);
  });

  test("without MARIA_EMAIL no Reply-To is added", async () => {
    const f = stubFetch(() => Response.json({ id: "email_1" }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await sendMail(env({ RESEND_API_KEY: "re_test", MARIA_EMAIL: "" }), { to: "kati@example.com", subject: "S", text: "T" });
    expect(Object.keys(f.calls[0].body as object)).not.toContain("reply_to");
  });
});
