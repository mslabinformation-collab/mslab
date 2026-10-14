import { describe, expect, test, vi } from "vitest";
import { privateFileAnswer } from "@/server/private-file";
import { fakeMediaStore } from "../fakes";

// A private object for a page that shows it (e-course completion: a practical work's photo): R2 signs a 5-minute address and the browser
// fetches the object there (a 302); the local folder of `next dev` and the e2e run has no addresses, so its bytes come back inline.

const KEY = "practical/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2];
const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

describe("privateFileAnswer", () => {
  test("a store that signs: a 302 to its 5-minute address with the caller's headers; the object itself is not read", async () => {
    const signedGetUrl = vi.fn(async () => "https://r2.example/signed");
    const store = { ...fakeMediaStore({ [KEY]: { bytes: JPEG, contentType: "image/jpeg" } }), signedGetUrl };
    const res = (await privateFileAnswer(store, KEY, { contentType: "image/jpeg", headers: HEADERS }))!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://r2.example/signed");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(signedGetUrl).toHaveBeenCalledWith(KEY, { expiresSec: 300 });
    expect(store.requested).toEqual([]);
  });

  test("the local folder: the bytes inline, with the type given, nosniff and the caller's headers", async () => {
    const store = fakeMediaStore({ [KEY]: { bytes: JPEG, contentType: "image/jpeg" } });
    const res = (await privateFileAnswer(store, KEY, { contentType: "image/jpeg", headers: HEADERS }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(JPEG);
  });

  test("the local folder without the object: null; no headers given: only the type's", async () => {
    expect(await privateFileAnswer(fakeMediaStore(), KEY, { contentType: "image/jpeg" })).toBeNull();
    const res = (await privateFileAnswer(fakeMediaStore({ [KEY]: { bytes: JPEG } }), KEY, { contentType: "image/jpeg" }))!;
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });
});
