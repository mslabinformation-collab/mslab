import { describe, expect, test } from "vitest";
import {
  LIMITS, parseChangeRequest, parseDeletion, parseFavourite, parseMerge, parseNewsletter, parsePassword, parseProfile, parseProgress, parseSlug, parseTerms,
} from "@/server/account-input";

// The bodies of the account's data endpoints, parsed without a database: a wrong shape, a wrong type, a value over its limit
// or text Postgres cannot store is { ok: false, error: "<field>" }, never an exception.

const err = (field: string) => ({ ok: false, error: field });
const ok = (data: unknown) => ({ ok: true, data });

/** Everything that is not an object: the endpoint hands null for a body that is not a JSON object, zod would also see these. */
const NOT_OBJECTS: unknown[] = [null, undefined, "x", 7, true, []];

describe("every parser refuses a body that is not an object", () => {
  test.each([
    ["favourite", parseFavourite], ["merge", parseMerge], ["profile", parseProfile], ["newsletter", parseNewsletter],
    ["change request", parseChangeRequest], ["terms", parseTerms], ["deletion", parseDeletion], ["password", parsePassword],
  ] as const)("%s", (_name, parse) => {
    for (const body of NOT_OBJECTS) expect(parse(body), String(body)).toEqual(err("body"));
    expect(parse({})).toMatchObject({ ok: false });
  });
});

describe("favourite { slug, on }", () => {
  test("a slug and a boolean", () => {
    expect(parseFavourite({ slug: "kulmude-lami", on: true })).toEqual(ok({ slug: "kulmude-lami", on: true }));
    expect(parseFavourite({ slug: "x", on: false, extra: 1 })).toEqual(ok({ slug: "x", on: false })); // unknown keys are dropped
  });

  test("the first wrong field is named", () => {
    expect(parseFavourite({ on: true })).toEqual(err("slug"));
    expect(parseFavourite({ slug: 5, on: true })).toEqual(err("slug"));
    expect(parseFavourite({ slug: "", on: true })).toEqual(err("slug"));
    expect(parseFavourite({ slug: "a".repeat(LIMITS.slug + 1), on: true })).toEqual(err("slug"));
    expect(parseFavourite({ slug: "a".repeat(LIMITS.slug), on: true })).toMatchObject({ ok: true });
    expect(parseFavourite({ slug: "x" })).toEqual(err("on"));
    for (const on of ["true", 1, 0, null, "on", {}, []]) expect(parseFavourite({ slug: "x", on }), String(on)).toEqual(err("on"));
  });

  test("a slug the database cannot hold (NUL, other control characters, a lone surrogate) is refused", () => {
    for (const slug of ["a\u0000b", "a\u0001b", "a\u007fb", "a\ud800b", "a\udc00b", "\ud83d"]) expect(parseFavourite({ slug, on: true }), JSON.stringify(slug)).toEqual(err("slug"));
    expect(parseFavourite({ slug: "kõrvaklapid-😀", on: true })).toMatchObject({ ok: true }); // a real surrogate pair is fine
  });
});

describe("merge { slugs }", () => {
  test("a list of at most 100 slugs, empty allowed", () => {
    expect(parseMerge({ slugs: [] })).toEqual(ok({ slugs: [] }));
    expect(parseMerge({ slugs: ["a", "b", "a"] })).toEqual(ok({ slugs: ["a", "b", "a"] })); // duplicates are the database's to ignore
    expect(parseMerge({ slugs: Array.from({ length: LIMITS.mergeSlugs }, (_, i) => `s${i}`) })).toMatchObject({ ok: true });
    expect(parseMerge({ slugs: Array.from({ length: LIMITS.mergeSlugs + 1 }, (_, i) => `s${i}`) })).toEqual(err("slugs"));
  });

  test("not a list, or a list with an element that is not a slug", () => {
    for (const slugs of ["a", { 0: "a" }, null, 7, undefined]) expect(parseMerge({ slugs }), String(slugs)).toEqual(err("slugs"));
    for (const bad of [5, null, "", "a".repeat(LIMITS.slug + 1), "a\u0000", ["a"], { a: 1 }]) expect(parseMerge({ slugs: ["ok", bad] }), JSON.stringify(bad)).toEqual(err("slugs"));
  });
});

describe("profile { name, phone, locale }", () => {
  test("trimmed, one line, both may be empty", () => {
    expect(parseProfile({ name: "  Kati   Tamm ", phone: " +372 555\n1234 ", locale: "ru" })).toEqual(ok({ name: "Kati Tamm", phone: "+372 555 1234", locale: "ru" }));
    expect(parseProfile({ name: "", phone: "", locale: "et" })).toEqual(ok({ name: "", phone: "", locale: "et" }));
  });

  test("the limits: name 120, phone 40 (counted after trimming)", () => {
    expect(parseProfile({ name: "a".repeat(LIMITS.name), phone: "", locale: "et" })).toMatchObject({ ok: true });
    expect(parseProfile({ name: "a".repeat(LIMITS.name + 1), phone: "", locale: "et" })).toEqual(err("name"));
    expect(parseProfile({ name: ` ${"a".repeat(LIMITS.name)} `, phone: "", locale: "et" })).toMatchObject({ ok: true });
    expect(parseProfile({ name: "", phone: "1".repeat(LIMITS.phone), locale: "et" })).toMatchObject({ ok: true });
    expect(parseProfile({ name: "", phone: "1".repeat(LIMITS.phone + 1), locale: "et" })).toEqual(err("phone"));
  });

  test("wrong types, a missing field, a language that is not et or ru", () => {
    expect(parseProfile({ phone: "", locale: "et" })).toEqual(err("name"));
    expect(parseProfile({ name: 5, phone: "", locale: "et" })).toEqual(err("name"));
    expect(parseProfile({ name: "x", phone: null, locale: "et" })).toEqual(err("phone"));
    expect(parseProfile({ name: "x", phone: ["1"], locale: "et" })).toEqual(err("phone"));
    for (const locale of ["en", "ET", "", null, 1, undefined]) expect(parseProfile({ name: "x", phone: "", locale }), String(locale)).toEqual(err("locale"));
  });

  test("a name or phone with a NUL or other control character (a database error) or a lone surrogate is refused", () => {
    expect(parseProfile({ name: "Ka\u0000ti", phone: "", locale: "et" })).toEqual(err("name"));
    expect(parseProfile({ name: "x", phone: "12\u0007", locale: "et" })).toEqual(err("phone"));
    expect(parseProfile({ name: "Kati\ud800", phone: "", locale: "et" })).toEqual(err("name"));
  });
});

describe("newsletter { on }", () => {
  test("a boolean", () => {
    expect(parseNewsletter({ on: true })).toEqual(ok({ on: true }));
    expect(parseNewsletter({ on: false })).toEqual(ok({ on: false }));
    for (const on of ["true", 1, null, undefined]) expect(parseNewsletter({ on }), String(on)).toEqual(err("on"));
  });
});

describe("change request { registrationId, kind, message }", () => {
  test("a registration id, cancel or change, a message of up to 1000 characters (trimmed, line breaks kept, optional)", () => {
    expect(parseChangeRequest({ registrationId: 7, kind: "cancel", message: "  Haigestusin.\nPalun tühistada. " })).toEqual(
      ok({ registrationId: 7, kind: "cancel", message: "Haigestusin.\nPalun tühistada." }),
    );
    expect(parseChangeRequest({ registrationId: 7, kind: "change" })).toEqual(ok({ registrationId: 7, kind: "change", message: "" }));
    expect(parseChangeRequest({ registrationId: 7, kind: "change", message: "" })).toMatchObject({ ok: true });
    expect(parseChangeRequest({ registrationId: 7, kind: "change", message: "a".repeat(LIMITS.message) })).toMatchObject({ ok: true });
    expect(parseChangeRequest({ registrationId: 7, kind: "change", message: "a".repeat(LIMITS.message + 1) })).toEqual(err("message"));
  });

  test("the registration id is a whole number that fits the database's integer", () => {
    for (const registrationId of [0, -1, 1.5, "7", null, undefined, [7], 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity])
      expect(parseChangeRequest({ registrationId, kind: "cancel", message: "" }), String(registrationId)).toEqual(err("registrationId"));
    expect(parseChangeRequest({ registrationId: 2_147_483_647, kind: "cancel", message: "" })).toMatchObject({ ok: true });
  });

  test("the kind is exactly cancel or change", () => {
    for (const kind of ["Cancel", "cancel ", "delete", "", null, undefined, 1, ["cancel"]]) expect(parseChangeRequest({ registrationId: 1, kind, message: "" }), String(kind)).toEqual(err("kind"));
  });

  test("the message is a string without characters the database cannot hold (NUL, a lone surrogate); tab and line breaks are fine", () => {
    for (const message of [5, null, ["x"], {}]) expect(parseChangeRequest({ registrationId: 1, kind: "cancel", message }), String(message)).toEqual(err("message"));
    expect(parseChangeRequest({ registrationId: 1, kind: "cancel", message: "a\u0000b" })).toEqual(err("message"));
    expect(parseChangeRequest({ registrationId: 1, kind: "cancel", message: "a\ud800" })).toEqual(err("message"));
    expect(parseChangeRequest({ registrationId: 1, kind: "cancel", message: "a\tb\r\nc" })).toMatchObject({ ok: true });
  });

  test("the first wrong field is named, in the order the endpoint documents", () => {
    expect(parseChangeRequest({ kind: "cancel", message: "" })).toEqual(err("registrationId"));
    expect(parseChangeRequest({ registrationId: 1, message: "" })).toEqual(err("kind"));
  });
});

describe("terms { slug, version } and deletion { confirm }", () => {
  test("terms: a slug and the version the page showed", () => {
    expect(parseTerms({ slug: "veebikursus", version: "2026-10-02T09:00:00.000Z" })).toEqual(ok({ slug: "veebikursus", version: "2026-10-02T09:00:00.000Z" }));
    expect(parseTerms({ slug: "x", version: "v".repeat(LIMITS.version) })).toMatchObject({ ok: true });
    expect(parseTerms({ slug: 5, version: "1" })).toEqual(err("slug"));
    expect(parseTerms({ version: "1" })).toEqual(err("slug"));
    expect(parseTerms({})).toEqual(err("slug"));
  });

  test("terms: the version is a string of 1 to 64 characters the database can hold, and it is required", () => {
    expect(parseTerms({ slug: "veebikursus" })).toEqual(err("version"));
    for (const version of ["", "v".repeat(LIMITS.version + 1), 1, null, ["1"], { v: 1 }, "a\u0000b", "a\ud800"]) expect(parseTerms({ slug: "veebikursus", version }), JSON.stringify(version)).toEqual(err("version"));
  });

  test("terms: the page's language (the contract's, contracts Task 4) is et or ru, and may be left out by a page from before it", () => {
    expect(parseTerms({ slug: "veebikursus", version: "1", locale: "ru" })).toEqual(ok({ slug: "veebikursus", version: "1", locale: "ru" }));
    expect(parseTerms({ slug: "veebikursus", version: "1" })).toEqual(ok({ slug: "veebikursus", version: "1" }));
    for (const locale of ["en", "", 1, null]) expect(parseTerms({ slug: "veebikursus", version: "1", locale }), JSON.stringify(locale)).toEqual(err("locale"));
  });

  test("deletion: confirm is exactly true", () => {
    expect(parseDeletion({ confirm: true })).toEqual(ok({ confirm: true }));
    for (const confirm of [false, "true", 1, null, undefined, {}]) expect(parseDeletion({ confirm }), String(confirm)).toEqual(err("confirm"));
  });
});

describe("parseSlug (the path of an e-course)", () => {
  test("decodes the path segment", () => {
    expect(parseSlug("kulmude-lami")).toBe("kulmude-lami");
    expect(parseSlug("k%C3%B5rv")).toBe("kõrv");
  });

  test("not decodable, empty, too long, or text the database cannot hold: null", () => {
    for (const raw of ["%E0%A4%A", "%", "", "a".repeat(LIMITS.slug + 1), "a%00b", "%01", "%ED%A0%80"]) expect(parseSlug(raw), raw).toBeNull();
  });
});

test("progress: a number of seconds, 0 … two days", () => {
  expect(parseProgress({ watchedSec: 12.5 })).toEqual({ ok: true, data: { watchedSec: 12.5 } });
  expect(parseProgress({ watchedSec: "x" })).toEqual({ ok: false, error: "watchedSec" });
  for (const bad of [{ watchedSec: "12" }, { watchedSec: -1 }, { watchedSec: 172_801 }, {}, null]) expect(parseProgress(bad).ok, JSON.stringify(bad)).toBe(false);
});

test("parsePassword (phase 2c): any string the database can store, 1 … 800 UTF-16 units, kept exactly as typed; the length rule is the server's (domain/password.ts)", () => {
  expect(parsePassword({ password: " pikk-parool-2026 " })).toEqual({ ok: true, data: { password: " pikk-parool-2026 " } });
  for (const body of [{ password: "" }, { password: 12345678901 }, { password: "x".repeat(801) }, { password: "a\u0000b".repeat(4) }, {}])
    expect(parsePassword(body)).toEqual({ ok: false, error: "password" });
  expect(parsePassword(null)).toEqual({ ok: false, error: "body" });
});
