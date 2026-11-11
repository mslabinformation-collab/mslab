import { describe, expect, test } from "vitest";
import { BACKGROUND_MAX_BYTES } from "@/domain/certificate-design";
import { isMediaKey, MAX_IMAGE_BYTES, MEDIA_CACHE, MEDIA_CDN_CACHE_HEADER, NO_MEDIA, putImage, serveMedia, UPLOAD_RULES, UploadError } from "@/server/media";
import { fakeMediaStore } from "../fakes";

// Task 13: the server side of an image upload. putImage trusts nothing the browser says: the declared type must be
// JPEG, PNG or WebP, the size at most 4 MB (Vercel refuses request bodies over 4.5 MB), and the first bytes must really be that kind of image (an HTML page renamed
// to .jpg is refused). The store is an in-memory fake of the MediaStore interface (R2 through the S3 API in production,
// a local folder in development: r2.test.ts, media-local.test.ts).

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]; // "RIFF" <size> "WEBP"
const HTML = [...new TextEncoder().encode("<!doctype html><script>alert(1)</script>")];

/** A file of `size` bytes that starts with `head`. */
function file(head: number[], size: number, type: string, name = "pilt"): File {
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head);
  return new File([bytes], name, { type });
}

const MB = 1024 * 1024;
const reason = (e: unknown) => (e instanceof UploadError ? e.reason : e);

describe("putImage", () => {
  test("rejects text/html, and stores nothing", async () => {
    const store = fakeMediaStore();
    const err = await putImage(store, file(HTML, 2000, "text/html", "page.html")).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(reason(err)).toBe("type");
    expect(store.objects.size).toBe(0);
  });

  test("rejects a 5 MB JPEG (the limit is 4 MB, below Vercel's 4.5 MB request body limit)", async () => {
    const store = fakeMediaStore();
    expect(MAX_IMAGE_BYTES).toBe(4 * MB);
    expect(MAX_IMAGE_BYTES).toBeLessThan(4.5 * MB);
    expect(reason(await putImage(store, file(JPEG, 5 * MB, "image/jpeg")).catch((e) => e))).toBe("size");
    expect(reason(await putImage(store, file(JPEG, 4 * MB + 1, "image/jpeg")).catch((e) => e))).toBe("size");
    expect(store.objects.size).toBe(0);
  });

  test("accepts a 1 MB JPEG: key img/<uuid>.jpg, the bytes and the content type are stored", async () => {
    const store = fakeMediaStore();
    const upload = file(JPEG, MB, "image/jpeg", "IMG_0001.JPG");
    const { key } = await putImage(store, upload);
    expect(key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect(isMediaKey(key)).toBe(true);
    const stored = store.objects.get(key)!;
    expect(stored.contentType).toBe("image/jpeg");
    expect(stored.bytes.byteLength).toBe(MB);
    expect([...stored.bytes.slice(0, 4)]).toEqual(JPEG);
    // the visitor's file name is not part of the key
    expect(key).not.toContain("IMG_0001");
  });

  test("a certificate design's background (2026-11-11 certificate designs, spec §4): a JPEG of at most 1.5 MB, nothing else", async () => {
    const store = fakeMediaStore();
    expect(UPLOAD_RULES["certificate-background"]).toEqual({ types: ["image/jpeg"], maxBytes: 1.5 * MB });
    expect(BACKGROUND_MAX_BYTES).toBe(1.5 * MB);
    const { key } = await putImage(store, file(JPEG, 1.5 * MB, "image/jpeg"), "certificate-background");
    expect(key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect(store.objects.get(key)!.contentType).toBe("image/jpeg");
    expect(reason(await putImage(store, file(JPEG, 1.5 * MB + 1, "image/jpeg"), "certificate-background").catch((e) => e))).toBe("size");
    expect(reason(await putImage(store, file(PNG, 500, "image/png"), "certificate-background").catch((e) => e))).toBe("type");
    expect(reason(await putImage(store, file(WEBP, 500, "image/webp"), "certificate-background").catch((e) => e))).toBe("type");
    expect(reason(await putImage(store, file(PNG, 500, "image/jpeg"), "certificate-background").catch((e) => e))).toBe("content");
    expect(store.objects.size).toBe(1);
    // any other picture keeps its limits
    expect(UPLOAD_RULES.image).toEqual({ types: ["image/jpeg", "image/png", "image/webp"], maxBytes: MAX_IMAGE_BYTES });
    await putImage(store, file(JPEG, 2 * MB, "image/jpeg"), "image");
    expect(store.objects.size).toBe(2);
  });

  test("a 4 MB image is still accepted; every upload gets its own key", async () => {
    const store = fakeMediaStore();
    const a = await putImage(store, file(JPEG, 4 * MB, "image/jpeg"));
    const b = await putImage(store, file(JPEG, 10, "image/jpeg"));
    expect(a.key).not.toBe(b.key);
    expect(store.objects.size).toBe(2);
  });

  test("PNG and WebP keep their own extension and content type", async () => {
    const store = fakeMediaStore();
    const png = await putImage(store, file(PNG, 500, "image/png"));
    const webp = await putImage(store, file(WEBP, 500, "image/webp"));
    expect(png.key).toMatch(/^img\/[0-9a-f-]{36}\.png$/);
    expect(webp.key).toMatch(/^img\/[0-9a-f-]{36}\.webp$/);
    expect(store.objects.get(png.key)!.contentType).toBe("image/png");
    expect(store.objects.get(webp.key)!.contentType).toBe("image/webp");
  });

  test("the first bytes must match the declared type: HTML renamed to .jpg, a PNG sent as JPEG, RIFF that is not WebP", async () => {
    const store = fakeMediaStore();
    const cases: [number[], string][] = [
      [HTML, "image/jpeg"],
      [HTML, "image/png"],
      [HTML, "image/webp"],
      [PNG, "image/jpeg"],
      [JPEG, "image/png"],
      [JPEG, "image/webp"],
      [[0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], "image/webp"], // RIFF....WAVE
      [[0xff, 0xd8], "image/jpeg"], // too short to be a JPEG
    ];
    for (const [head, type] of cases) {
      const err = await putImage(store, file(head, head.length, type, "x.jpg")).catch((e) => e);
      expect(reason(err), `${type} ${head.slice(0, 4)}`).toBe("content");
    }
    expect(store.objects.size).toBe(0);
  });

  test("an empty file and other image types (SVG, GIF, HEIC) are refused", async () => {
    const store = fakeMediaStore();
    expect(reason(await putImage(store, new File([], "x.jpg", { type: "image/jpeg" })).catch((e) => e))).toBe("empty");
    for (const type of ["image/svg+xml", "image/gif", "image/heic", "", "application/octet-stream"]) {
      expect(reason(await putImage(store, file(JPEG, 100, type)).catch((e) => e)), type).toBe("type");
    }
    expect(store.objects.size).toBe(0);
  });

  test("a store that fails is the store's own error, not an UploadError", async () => {
    const failing = { put: () => Promise.reject(new Error("store failed")), get: async () => null };
    const err = await putImage(failing, file(JPEG, 100, "image/jpeg")).catch((e) => e);
    expect(err).not.toBeInstanceOf(UploadError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("serveMedia (GET /media/<key>)", () => {
  const id = "0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f";

  test("an uploaded image: the bytes, the stored type, nosniff, a sandbox CSP and a year of immutable caching", async () => {
    const store = fakeMediaStore({ [`img/${id}.jpg`]: { bytes: JPEG, contentType: "image/jpeg" } });
    const res = await serveMedia(store, `img/${id}.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("cache-control")).toBe(MEDIA_CACHE);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("etag")).toBe('"e1"');
    // Vercel's CDN caches a function's response only when told to: the same year, for the CDN
    expect(MEDIA_CDN_CACHE_HEADER).toBe("vercel-cdn-cache-control");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=31536000, immutable");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(JPEG);
  });

  test("an object whose body is already in memory (ArrayBuffer) is served the same way; no etag, no header", async () => {
    const bytes = new Uint8Array(JPEG).buffer;
    const store = { get: async () => ({ body: bytes, contentType: "image/jpeg", etag: null }) };
    const res = await serveMedia(store, `img/${id}.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(JPEG);
  });

  test("a stored type that is not the key's image type is not passed on (the extension decides)", async () => {
    const store = fakeMediaStore({
      [`img/${id}.png`]: { bytes: PNG, contentType: "text/html" },
      [`img/${id}.webp`]: { bytes: WEBP },
      [`img/${id}.jpg`]: { bytes: JPEG, contentType: "image/png" },
    });
    expect((await serveMedia(store, `img/${id}.png`)).headers.get("content-type")).toBe("image/png");
    expect((await serveMedia(store, `img/${id}.webp`)).headers.get("content-type")).toBe("image/webp");
    expect((await serveMedia(store, `img/${id}.jpg`)).headers.get("content-type")).toBe("image/jpeg");
  });

  test("404 for a missing object, and for any other key without asking the store", async () => {
    const store = fakeMediaStore({ "seed/x.jpg": { bytes: JPEG, contentType: "image/jpeg" } });
    const missing = await serveMedia(store, `img/${id}.jpg`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
    expect(missing.headers.get("vercel-cdn-cache-control")).toBeNull(); // a 404 is never kept by the CDN
    store.requested.length = 0;
    for (const key of ["seed/x.jpg", `img/${id}.svg`, "img/../secret", "", `img/${id}.jpg/..`]) expect((await serveMedia(store, key)).status, key).toBe(404);
    expect(store.requested).toEqual([]);
  });

  test("a lesson file is never public: lessons/<uuid>.<any lesson file extension> is a 404 and the store is not even asked", async () => {
    const lesson = (ext: string) => `lessons/${id}.${ext}`;
    const exts = ["pdf", "docx", "jpg", "png", "webp"]; // jpg, png and webp are image extensions too: only the img/ prefix keeps them private
    const store = fakeMediaStore(Object.fromEntries(exts.map((ext) => [lesson(ext), { bytes: JPEG, contentType: ext === "jpg" ? "image/jpeg" : "application/octet-stream" }])));
    for (const ext of exts) expect((await serveMedia(store, lesson(ext))).status, ext).toBe(404);
    for (const key of [`img/../lessons/${id}.jpg`, `img/lessons/${id}.jpg`, `lessons/img/${id}.jpg`, `/lessons/${id}.jpg`, `lessons/${id}.jpg/..`]) expect((await serveMedia(store, key)).status, key).toBe(404);
    expect(store.requested).toEqual([]);
  });

  test("NO_MEDIA (production without R2) is a store with nothing in it: every key is a 404", async () => {
    const res = await serveMedia(NO_MEDIA, `img/${id}.jpg`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBeNull();
  });
});

describe("isMediaKey (what /media serves)", () => {
  test("only img/<uuid>.<jpg|png|webp>", () => {
    const id = "0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f";
    for (const ext of ["jpg", "png", "webp"]) expect(isMediaKey(`img/${id}.${ext}`), ext).toBe(true);
    for (const bad of [
      `img/${id}.svg`,
      `img/${id}.html`,
      `img/${id}.JPG`,
      `img/${id.toUpperCase()}.jpg`,
      `img/${id}.jpg/x`,
      `x/${id}.jpg`,
      `lessons/${id}.jpg`,
      `lessons/${id}.pdf`,
      `img/../${id}.jpg`,
      `img/${id}`,
      `img/abc.jpg`,
      `/img/${id}.jpg`,
      `img/${id}.jpg\n`,
      "",
    ])
      expect(isMediaKey(bad), JSON.stringify(bad)).toBe(false);
  });
});
