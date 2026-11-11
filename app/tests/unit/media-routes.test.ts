import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { MAX_IMAGE_BYTES } from "@/server/media";
import { fakeMediaStore } from "../fakes";

// The two routes that reach the image store: POST /api/admin/upload and GET /media/<key>. The store comes from
// mediaStore() (server/media-store.ts), which these tests replace with an in-memory fake (or null: production without
// R2). The admin check is withAdmin's own (admin-guards.test.ts, tests/db/auth.test.ts); here it lets the request through.

const store = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => store.current }));
vi.mock("@/server/auth", () => ({
  withAdmin: (handler: (request: Request, ctx: unknown, admin: { email: string }) => Response | Promise<Response>) => (request: Request, ctx: unknown) => handler(request, ctx, { email: "admin@example.test" }),
}));

import * as uploadRoute from "@/app/api/admin/upload/route";
import * as mediaRoute from "@/app/media/[...key]/route";

const { POST } = uploadRoute;
const { GET } = mediaRoute;

const ID = "0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f";
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];

const upload = (file: File | null) => {
  const body = new FormData();
  if (file) body.set("file", file);
  return POST(new Request("https://mslab.example/api/admin/upload", { method: "POST", body }), undefined);
};
const jpeg = () => new File([new Uint8Array(JPEG)], "pilt.jpg", { type: "image/jpeg" });
const media = (key: string) => GET(new Request(`https://mslab.example/media/${key}`), { params: Promise.resolve({ key: key.split("/") }) });

let log: MockInstance<typeof console.error>;
beforeEach(() => {
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  store.current = null;
  vi.restoreAllMocks();
});

describe("POST /api/admin/upload", () => {
  test("201 with the key; the bytes and the content type are in the store", async () => {
    const fake = fakeMediaStore();
    store.current = fake;
    const res = await upload(jpeg());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { ok, key } = (await res.json()) as { ok: boolean; key: string };
    expect(ok).toBe(true);
    expect(key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect(fake.objects.get(key)).toMatchObject({ contentType: "image/jpeg" });
    expect([...fake.objects.get(key)!.bytes]).toEqual(JPEG);
  });

  test("the refusals keep their statuses: no file 400, not an image 415, over 4 MB 413, empty 400, wrong bytes 415", async () => {
    const fake = fakeMediaStore();
    store.current = fake;
    const cases: [File | null, number, string][] = [
      [null, 400, "missing"],
      [new File(["<html>"], "x.html", { type: "text/html" }), 415, "type"],
      [new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "x.jpg", { type: "image/jpeg" }), 413, "size"],
      [new File([], "x.jpg", { type: "image/jpeg" }), 400, "empty"],
      [new File(["<html>"], "x.jpg", { type: "image/jpeg" }), 415, "content"],
    ];
    for (const [file, status, error] of cases) {
      const res = await upload(file);
      expect(res.status, error).toBe(status);
      expect(await res.json(), error).toEqual({ ok: false, error });
    }
    expect(fake.objects.size).toBe(0);
  });

  test("?for=certificate-background (a design's background photo): a JPEG of at most 1.5 MB; an unknown purpose is 400 `kind`", async () => {
    const fake = fakeMediaStore();
    store.current = fake;
    const send = (file: File, purpose: string, length?: number) => {
      const body = new FormData();
      body.set("file", file);
      const headers = length ? { "content-length": String(length) } : undefined;
      return POST(new Request(`https://mslab.example/api/admin/upload?for=${purpose}`, { method: "POST", body, headers }), undefined);
    };
    const ok = await send(jpeg(), "certificate-background");
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { key: string }).key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "x.png", { type: "image/png" });
    const cases: [Response, number, string][] = [
      [await send(png, "certificate-background"), 415, "type"],
      [await send(new File([new Uint8Array(1.5 * 1024 * 1024 + 1)], "x.jpg", { type: "image/jpeg" }), "certificate-background"), 413, "size"],
      // announced over 1.5 MB plus the envelope: refused before the body is read
      [await send(jpeg(), "certificate-background", 1.5 * 1024 * 1024 + 128 * 1024), 413, "size"],
      [await send(jpeg(), "poster"), 400, "kind"],
    ];
    for (const [res, status, error] of cases) {
      expect(res.status, error).toBe(status);
      expect(await res.json(), error).toEqual({ ok: false, error });
    }
    expect(fake.objects.size).toBe(1);
  });

  test("a request announced as larger than the limit plus the multipart envelope is 413 before its body is read", async () => {
    const fake = fakeMediaStore();
    store.current = fake;
    const body = new FormData();
    body.set("file", jpeg());
    const request = new Request("https://mslab.example/api/admin/upload", { method: "POST", body, headers: { "content-length": String(MAX_IMAGE_BYTES + 128 * 1024) } });
    const formData = vi.spyOn(request, "formData");
    const res = await POST(request, undefined);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "size" });
    expect(formData).not.toHaveBeenCalled();
    expect(fake.objects.size).toBe(0);
  });

  test("no store (production without R2): 503 `storage`, nothing stored, and the log says why", async () => {
    store.current = null;
    const res = await upload(jpeg());
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: false, error: "storage" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("R2_");
  });

  test("a store that fails: 500 `server`, logged without the message", async () => {
    store.current = { put: () => Promise.reject(new Error("store says: secret detail")), get: async () => null };
    const res = await upload(jpeg());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "server" });
    expect(log.mock.calls.map((c) => c.join(" "))).toEqual(["[admin] image upload failed: Error"]);
  });
});

describe("GET /media/<key>", () => {
  test("an image of the store: 200 with the bytes and every header of the answer", async () => {
    store.current = fakeMediaStore({ [`img/${ID}.jpg`]: { bytes: JPEG, contentType: "image/jpeg" } });
    const res = await media(`img/${ID}.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=31536000, immutable"); // Vercel's CDN keeps it
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(JPEG);
  });

  test("404 for a missing image and for a key that is not one; the store is not asked about the latter", async () => {
    const fake = fakeMediaStore();
    store.current = fake;
    const missing = await media(`img/${ID}.jpg`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(fake.requested).toEqual([`img/${ID}.jpg`]);
    fake.requested.length = 0;
    for (const key of [`img/${ID}.svg`, "img/olematu.jpg", "seed/x.jpg"]) expect((await media(key)).status, key).toBe(404);
    expect(fake.requested).toEqual([]);
  });

  test("a lesson file (lessons/<uuid>.<ext>) is private: 404 from /media though the object exists, and the store is not asked", async () => {
    const fake = fakeMediaStore({ [`lessons/${ID}.pdf`]: { bytes: JPEG, contentType: "application/pdf" }, [`lessons/${ID}.jpg`]: { bytes: JPEG, contentType: "image/jpeg" } });
    store.current = fake;
    for (const key of [`lessons/${ID}.pdf`, `lessons/${ID}.jpg`]) {
      const res = await media(key);
      expect(res.status, key).toBe(404);
      expect(res.headers.get("cache-control"), key).toBe("no-store");
      expect(await res.text(), key).toBe("Not found");
    }
    expect(fake.requested).toEqual([]);
  });

  test("no store (production without R2): 404 for everything, not an error page", async () => {
    store.current = null;
    const res = await media(`img/${ID}.jpg`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  test("a store that fails: 500 that is not cached, logged without the message", async () => {
    store.current = { put: async () => {}, get: () => Promise.reject(new Error("store says: secret detail")) };
    const res = await media(`img/${ID}.jpg`);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(log.mock.calls.map((c) => c.join(" "))).toEqual(["[media] read failed: Error"]);
  });
});

describe("the time limit of the routes that reach R2", () => {
  test("both end after 30 s at most, not after Vercel's default 300 s of a request that hangs", () => {
    expect(uploadRoute.maxDuration).toBe(30);
    expect(mediaRoute.maxDuration).toBe(30);
  });
});
