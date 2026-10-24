import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bunnyApi, BunnyError, bunnyConfig, embedToken, lessonVideoStatus, signedEmbedUrl, tusSignature } from "@/server/bunny";

const VIDEO = "11111111-2222-3333-4444-555555555555";
const ENV = { BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "test-api-key", BUNNY_TOKEN_KEY: "test-token-key" };
const CONFIG = bunnyConfig(ENV, false)!;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("signing", () => {
  test("tus (reference/tus-resumable-uploads): sha256 of library id + API key + expiry + video id, lowercase hex", async () => {
    expect(await tusSignature("12345", "test-api-key", 1767225600, VIDEO)).toBe("a6abfdd5d725736f86b8233000c5ba454075e9f9d222198aad1bf74e01fc62ee");
    expect(await tusSignature("12345", "test-api-key", 1767225600, VIDEO)).toBe(sha(`12345test-api-key1767225600${VIDEO}`));
  });
  test("embed token (stream/token-authentication): sha256 of token key + video id + expiry", async () => {
    expect(await embedToken("test-token-key", VIDEO, 1767225600)).toBe("adebd867cd8a745b86fb42b2337b4488d397ad9134efbb4a7da8ed5869a55e48");
  });
  test("the embed URL: player.mediadelivery.net, token, expiry, autoplay off; t only for a resume point (whole seconds)", async () => {
    const url = new URL(await signedEmbedUrl(CONFIG, VIDEO, 1767225600));
    expect(`${url.origin}${url.pathname}`).toBe(`https://player.mediadelivery.net/embed/12345/${VIDEO}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ token: "adebd867cd8a745b86fb42b2337b4488d397ad9134efbb4a7da8ed5869a55e48", expires: "1767225600", autoplay: "false" });
    expect(new URL(await signedEmbedUrl(CONFIG, VIDEO, 1767225600, 95.7)).searchParams.get("t")).toBe("95");
  });
  test("startSec: below 1 s, negative or not finite gives no t; 1 s gives t=1", async () => {
    const t = async (startSec?: number) => new URL(await signedEmbedUrl(CONFIG, VIDEO, 1767225600, startSec)).searchParams.get("t");
    for (const none of [undefined, 0, 0.9, 0.999, -0, -1, -95, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(await t(none), String(none)).toBeNull();
    expect(await t(1)).toBe("1");
    expect(await t(1.9)).toBe("1");
    expect(await t(3600)).toBe("3600");
  });
  test("expires is whole unix seconds: a fraction, NaN, Infinity or an unsafe integer is a TypeError, never a signature", async () => {
    const bad = [1767225600.5, 1767225600.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, Number.MAX_VALUE];
    for (const expires of bad) {
      await expect(tusSignature("12345", "test-api-key", expires, VIDEO), String(expires)).rejects.toThrow(TypeError);
      await expect(embedToken("test-token-key", VIDEO, expires), String(expires)).rejects.toThrow(TypeError);
      await expect(signedEmbedUrl(CONFIG, VIDEO, expires), String(expires)).rejects.toThrow(TypeError);
    }
    // the refusal names neither key, and a valid expiry (even 0) still signs
    const err = await tusSignature("12345", "test-api-key", Number.NaN, VIDEO).catch((e) => e);
    expect(String(err.message)).not.toContain("test-api-key");
    expect(await tusSignature("12345", "test-api-key", 0, VIDEO)).toBe(sha(`12345test-api-key0${VIDEO}`));
  });
  test("expires in milliseconds (1e11 and up, Date.now()) is a TypeError; seconds, such as now + one hour, sign", async () => {
    const inSeconds = Math.floor(Date.now() / 1000) + 3600;
    expect(inSeconds).toBeLessThan(1e11);
    for (const expires of [Date.now(), Date.now() + 3600_000, 1e11, 1767225600000]) {
      await expect(tusSignature("12345", "test-api-key", expires, VIDEO), String(expires)).rejects.toThrow(TypeError);
      await expect(embedToken("test-token-key", VIDEO, expires), String(expires)).rejects.toThrow(TypeError);
      await expect(signedEmbedUrl(CONFIG, VIDEO, expires), String(expires)).rejects.toThrow(TypeError);
    }
    // seconds are fine, up to the last one below the limit
    for (const expires of [inSeconds, 1767225600, 1e11 - 1]) {
      expect(await tusSignature("12345", "test-api-key", expires, VIDEO), String(expires)).toBe(sha(`12345test-api-key${expires}${VIDEO}`));
      expect(await embedToken("test-token-key", VIDEO, expires), String(expires)).toBe(sha(`test-token-key${VIDEO}${expires}`));
      expect(new URL(await signedEmbedUrl(CONFIG, VIDEO, expires)).searchParams.get("expires"), String(expires)).toBe(String(expires));
    }
  });
});

describe("bunnyConfig", () => {
  test("all three settings, or no video ('Video seadistamata')", () => {
    expect(bunnyConfig({}, false)).toBeNull();
    expect(bunnyConfig({ ...ENV, BUNNY_TOKEN_KEY: undefined }, false)).toBeNull();
    expect(CONFIG).toEqual({
      libraryId: "12345", apiKey: "test-api-key", tokenKey: "test-token-key", webhookSecret: null,
      apiBase: "https://video.bunnycdn.com", tusEndpoint: "https://video.bunnycdn.com/tusupload", embedBase: "https://player.mediadelivery.net/embed",
    });
    expect(bunnyConfig({ ...ENV, BUNNY_WEBHOOK_SECRET: "s" }, false)?.webhookSecret).toBe("s");
  });
  test("BUNNY_FAKE_URL (the e2e run's fake) replaces the three addresses, and is ignored on Vercel", () => {
    const fake = { ...ENV, BUNNY_FAKE_URL: "http://localhost:3998/" };
    expect(bunnyConfig(fake, false)).toMatchObject({ apiBase: "http://localhost:3998", tusEndpoint: "http://localhost:3998/tusupload", embedBase: "http://localhost:3998/embed" });
    expect(bunnyConfig(fake, true)).toMatchObject({ apiBase: "https://video.bunnycdn.com", embedBase: "https://player.mediadelivery.net/embed" });
  });
});

/** A fetch that records the calls and answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; method: string; headers: Headers; body: unknown; signal: AbortSignal | null | undefined; redirect: RequestRedirect | undefined }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal, redirect: init.redirect });
    return respond(url, init);
  });
  return { calls, fetch: fn as unknown as typeof fetch };
}

describe("the API client", () => {
  test("createVideo: POST …/library/<id>/videos with the AccessKey and the title; answers the guid", async () => {
    const f = fakeFetch(() => Response.json({ guid: VIDEO, status: 0 }));
    expect(await bunnyApi(CONFIG, f.fetch).createVideo("Kulmud · Sissejuhatus")).toBe(VIDEO);
    expect(f.calls[0]).toMatchObject({ url: "https://video.bunnycdn.com/library/12345/videos", method: "POST", body: { title: "Kulmud · Sissejuhatus" } });
    expect(f.calls[0].headers.get("accesskey")).toBe("test-api-key");
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal); // a timeout, and Next.js's fetch does not deduplicate a call with a signal (server/r2.ts)
  });
  test("createVideo without a guid in the answer, or with an error status, is a BunnyError", async () => {
    await expect(bunnyApi(CONFIG, fakeFetch(() => Response.json({})).fetch).createVideo("x")).rejects.toThrow(new BunnyError("create", 200));
    await expect(bunnyApi(CONFIG, fakeFetch(() => new Response("no", { status: 401 })).fetch).createVideo("x")).rejects.toThrow(new BunnyError("create", 401));
  });
  test("getVideo: status, length and picture size; null for an unknown video (404)", async () => {
    const f = fakeFetch((url) => (url.endsWith(VIDEO) ? Response.json({ guid: VIDEO, status: 4, length: 754, width: 1920, height: 1080, title: "x" }) : new Response("", { status: 404 })));
    const api = bunnyApi(CONFIG, f.fetch);
    expect(await api.getVideo(VIDEO)).toEqual({ status: 4, length: 754, width: 1920, height: 1080, encodeProgress: null });
    expect(await api.getVideo("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(f.calls[0]).toMatchObject({ url: `https://video.bunnycdn.com/library/12345/videos/${VIDEO}`, method: "GET" });
  });
  test("deleteVideo: DELETE; 404 counts as gone; another status is an error that names the operation and status only", async () => {
    const ok = fakeFetch(() => Response.json({ success: true }));
    await bunnyApi(CONFIG, ok.fetch).deleteVideo(VIDEO);
    expect(ok.calls[0]).toMatchObject({ url: `https://video.bunnycdn.com/library/12345/videos/${VIDEO}`, method: "DELETE" });
    await bunnyApi(CONFIG, fakeFetch(() => new Response("", { status: 404 })).fetch).deleteVideo(VIDEO);
    const err = await bunnyApi(CONFIG, fakeFetch(() => new Response("key test-api-key", { status: 401 })).fetch).deleteVideo(VIDEO).catch((e) => e);
    expect(err).toEqual(new BunnyError("delete", 401));
    expect(String(err.message)).not.toContain("test-api-key");
  });
  test("getVideo: only 404 is null; any other error status rejects with BunnyError('get', status), never null", async () => {
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      const err = await bunnyApi(CONFIG, fakeFetch(() => new Response("key test-api-key", { status })).fetch)
        .getVideo(VIDEO)
        .then(
          (v) => `resolved ${JSON.stringify(v)}`,
          (e) => e,
        );
      expect(err, String(status)).toBeInstanceOf(BunnyError);
      expect(err).toMatchObject({ op: "get", status });
      expect(err.message).toBe(`Bunny get answered ${status}`);
    }
  });
  test("getVideo: a 200 whose body has no numeric status is a BunnyError, not 'still processing'", async () => {
    const answers = [() => Response.json({}), () => Response.json({ length: 10 }), () => Response.json({ status: "4", length: 10 }), () => Response.json({ status: null }), () => Response.json(null), () => Response.json([]), () => new Response("<html>not json</html>")];
    for (const answer of answers) {
      const err = await bunnyApi(CONFIG, fakeFetch(answer).fetch)
        .getVideo(VIDEO)
        .then(
          (v) => `resolved ${JSON.stringify(v)}`,
          (e) => e,
        );
      expect(err).toBeInstanceOf(BunnyError);
      expect(err).toMatchObject({ op: "get", status: 200 });
    }
    // a missing length is not an error (a video still uploading has none yet): 0
    expect(await bunnyApi(CONFIG, fakeFetch(() => Response.json({ guid: VIDEO, status: 0 })).fetch).getVideo(VIDEO)).toEqual({ status: 0, length: 0, width: 0, height: 0, encodeProgress: null });
  });
  test("getVideo: the picture size is read as numbers; a missing or unusable one is 0 and never an error (older or still processing videos)", async () => {
    const read = (body: Record<string, unknown>) => bunnyApi(CONFIG, fakeFetch(() => Response.json({ guid: VIDEO, status: 4, length: 60, ...body })).fetch).getVideo(VIDEO);
    expect(await read({ width: 1080, height: 1920 })).toEqual({ status: 4, length: 60, width: 1080, height: 1920, encodeProgress: null });
    expect(await read({})).toEqual({ status: 4, length: 60, width: 0, height: 0, encodeProgress: null }); // no size in the answer
    expect(await read({ width: 1080 })).toEqual({ status: 4, length: 60, width: 1080, height: 0, encodeProgress: null }); // one side only
    expect(await read({ width: 0, height: 0 })).toEqual({ status: 4, length: 60, width: 0, height: 0, encodeProgress: null }); // not known yet
    // not numbers (strings, null, objects, a list): 0 for that side
    expect(await read({ width: "1080", height: null })).toEqual({ status: 4, length: 60, width: 0, height: 0, encodeProgress: null });
    expect(await read({ width: {}, height: [1920] })).toEqual({ status: 4, length: 60, width: 0, height: 0, encodeProgress: null });
    // JSON cannot carry NaN or Infinity (they travel as null); a huge number is still a number: the domain decides what is a shape
    expect(await read({ width: 1e999, height: 1080 })).toEqual({ status: 4, length: 60, width: 0, height: 1080, encodeProgress: null });
    expect(await read({ width: 1e9, height: 1080 })).toEqual({ status: 4, length: 60, width: 1e9, height: 1080, encodeProgress: null });
  });
  test("getVideo: a quarter turn in the file's metadata (a phone held upright: 1920 × 1080, rotation 90) is the picture the student sees, upright", async () => {
    const read = (body: Record<string, unknown>) => bunnyApi(CONFIG, fakeFetch(() => Response.json({ guid: VIDEO, status: 4, length: 60, ...body })).fetch).getVideo(VIDEO);
    for (const rotation of [90, -90, 270, -270])
      expect(await read({ width: 1920, height: 1080, rotation }), String(rotation)).toEqual({ status: 4, length: 60, width: 1080, height: 1920, encodeProgress: null });
    // no turn, a half turn, no metadata (null) or a value that is no angle: the sides as they are
    for (const rotation of [0, 180, -180, 45, null, "90", undefined])
      expect(await read({ width: 1920, height: 1080, rotation }), String(rotation)).toEqual({ status: 4, length: 60, width: 1920, height: 1080, encodeProgress: null });
    expect(await read({ width: 1080, height: 1920, rotation: 90 })).toEqual({ status: 4, length: 60, width: 1920, height: 1080, encodeProgress: null }); // a quarter turn swaps whatever the file stored
  });
  test("getVideo: encodeProgress (Bunny's encode percent, 0–100; video_getvideo checked 24.10.2026) is read as a whole number; a missing or unusable one is null", async () => {
    const read = (body: Record<string, unknown>) => bunnyApi(CONFIG, fakeFetch(() => Response.json({ guid: VIDEO, status: 3, length: 0, ...body })).fetch).getVideo(VIDEO);
    expect(await read({ encodeProgress: 40 })).toEqual({ status: 3, length: 0, width: 0, height: 0, encodeProgress: 40 });
    expect((await read({ encodeProgress: 0 }))?.encodeProgress).toBe(0); // a figure of 0 is a figure (the screens decide how it reads)
    expect((await read({ encodeProgress: 100 }))?.encodeProgress).toBe(100);
    expect((await read({}))?.encodeProgress).toBeNull(); // the field absent
    // a fraction is rounded, a value outside 0…100 is held to it
    expect((await read({ encodeProgress: 40.6 }))?.encodeProgress).toBe(41);
    expect((await read({ encodeProgress: 150 }))?.encodeProgress).toBe(100);
    expect((await read({ encodeProgress: -3 }))?.encodeProgress).toBe(0);
    // not a number: null, never an error and never 0
    for (const encodeProgress of ["40", null, {}, [40], true]) expect((await read({ encodeProgress }))?.encodeProgress, JSON.stringify(encodeProgress)).toBeNull();
    // (JSON.stringify turns Infinity into null, so the raw body: 1e999 parses as Infinity)
    const raw = bunnyApi(CONFIG, fakeFetch(() => new Response('{"status":3,"length":0,"encodeProgress":1e999}')).fetch);
    expect((await raw.getVideo(VIDEO))?.encodeProgress).toBeNull();
  });
  test("every request refuses redirects, so the AccessKey is never sent on to another address", async () => {
    const f = fakeFetch(() => Response.json({ guid: VIDEO, status: 4, length: 1 }));
    const api = bunnyApi(CONFIG, f.fetch);
    await api.createVideo("x");
    await api.getVideo(VIDEO);
    await api.deleteVideo(VIDEO);
    expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    for (const call of f.calls) expect(call.redirect, call.method).toBe("error");
  });
});

type Api = ReturnType<typeof bunnyApi>;
const OPS = {
  createVideo: (api: Api) => api.createVideo("x"),
  getVideo: (api: Api) => api.getVideo(VIDEO),
  deleteVideo: (api: Api) => api.deleteVideo(VIDEO),
};

describe("a redirect with the platform's own fetch (local servers, no Bunny)", () => {
  const servers: Server[] = [];
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      const server = createServer(handler).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  });

  test("is not followed: the other address never sees a request, so the key never leaves", async () => {
    const seen: { url: string | undefined; accessKey: string | string[] | undefined }[] = [];
    const elsewhere = await listen((req, res) => {
      seen.push({ url: req.url, accessKey: req.headers.accesskey });
      res.end("{}");
    });
    const api = await listen((_req, res) => {
      res.writeHead(307, { location: `${elsewhere}/stolen` }).end();
    });
    const config = bunnyConfig({ ...ENV, BUNNY_FAKE_URL: api }, false)!;
    for (const [name, run] of Object.entries(OPS)) {
      await expect(run(bunnyApi(config)), name).rejects.toThrow(TypeError);
      expect(seen, name).toEqual([]);
    }
  });
});

describe("the answer time limit (10 s, headers and body together)", () => {
  afterEach(() => vi.useRealTimers());
  const neverBody = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  type State = "pending" | "resolved" | { rejected: Error };
  /** Lets `ms` of fake time pass and says how the call stands: pending, resolved, or how it was rejected. */
  async function stateAfter(call: { state: State }, ms: number): Promise<State> {
    await vi.advanceTimersByTimeAsync(ms);
    return call.state;
  }
  function watch(promise: Promise<unknown>): { state: State } {
    const call: { state: State } = { state: "pending" };
    promise.then(
      () => (call.state = "resolved"),
      (e) => (call.state = { rejected: e }),
    );
    return call;
  }

  test.each(Object.entries(OPS))("%s: a fetch that never answers rejects with a TimeoutError at 10 s, not before, and aborts the request", async (_name, run) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fakeFetch(() => new Promise<Response>(() => {}) as unknown as Response);
    const call = watch(run(bunnyApi(CONFIG, f.fetch)));
    expect(await stateAfter(call, 9_999)).toBe("pending");
    expect(f.calls[0].signal?.aborted).toBe(false);
    const state = await stateAfter(call, 1);
    expect(state).toMatchObject({ rejected: { name: "TimeoutError" } });
    expect((state as { rejected: Error }).rejected.message).not.toMatch(/test-api-key|12345|bunnycdn/);
    expect(f.calls[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    ["createVideo", OPS.createVideo],
    ["getVideo", OPS.getVideo],
  ] as const)("%s: headers that arrive with a body that never does reject at 10 s too", async (_name, run) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fakeFetch(neverBody);
    const call = watch(run(bunnyApi(CONFIG, f.fetch)));
    expect(await stateAfter(call, 9_999)).toBe("pending");
    expect(vi.getTimerCount()).toBe(1); // still running while the body is read
    expect(await stateAfter(call, 1)).toMatchObject({ rejected: { name: "TimeoutError" } });
    expect(f.calls[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a late failure of the aborted call is not an unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let fail: (e: Error) => void = () => {};
      const f = fakeFetch(() => new Promise<Response>((_, reject) => (fail = reject)) as unknown as Response);
      const call = watch(bunnyApi(CONFIG, f.fetch).getVideo(VIDEO));
      expect(await stateAfter(call, 10_000)).toMatchObject({ rejected: { name: "TimeoutError" } });
      fail(new Error("aborted by the platform"));
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20)); // a real macrotask: Node reports unhandled rejections once the microtasks have drained
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test.each(Object.entries(OPS))("%s: the timer is cleared when the call ends, by an answer, an error status or a failing fetch", async (_name, run) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await run(bunnyApi(CONFIG, fakeFetch(() => Response.json({ guid: VIDEO, status: 4, length: 3 })).fetch));
    expect(vi.getTimerCount()).toBe(0);
    await run(bunnyApi(CONFIG, fakeFetch(() => new Response("", { status: 500 })).fetch)).catch(() => {});
    expect(vi.getTimerCount()).toBe(0);
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(run(bunnyApi(CONFIG, failing))).rejects.toThrow(TypeError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

test.each([
  [0, "uploading"], [1, "processing"], [2, "processing"], [3, "processing"], [4, "ready"], [5, "failed"], [6, "failed"], [7, "processing"], [8, "processing"],
] as const)("Bunny status %i → %s", (n, status) => expect(lessonVideoStatus(n)).toBe(status));
