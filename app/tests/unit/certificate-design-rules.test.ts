import { describe, expect, test } from "vitest";
import {
  BACKGROUND_MAX_BYTES, checkDesignName, DESIGN_LIMITS, designFor, firstDesign, frozenOf, isBackgroundKey, isDesignTone, readFrozenDesign,
  type CertificateDesign,
} from "@/domain/certificate-design";

// The certificate designs' pure rules (2026-11-11 certificate designs, spec §3–§5): the tones, the name's rules, what a background may be, the design a
// course's certificate gets (its pick, else the first: lowest sort, then lowest id) and the frozen copy a certificate keeps, read defensively.

const UUID = "0f8c2a4e-1b3d-4c5e-8f9a-0123456789ab";

describe("the limits and the tones", () => {
  test("a name of at most 40 characters; a background JPEG of at most 1.5 MB; the tones light and dark", () => {
    expect(DESIGN_LIMITS).toEqual({ name: 40 });
    expect(BACKGROUND_MAX_BYTES).toBe(1.5 * 1024 * 1024);
    expect(["light", "dark"].every(isDesignTone)).toBe(true);
    for (const v of ["Light", "", null, 1, "white"]) expect(isDesignTone(v), String(v)).toBe(false);
  });
});

describe("isBackgroundKey: none, or a JPEG of the admin's upload", () => {
  test("empty (no photo) or img/<uuid>.jpg; never a PNG, a WebP, a seed picture or another site's address", () => {
    expect(isBackgroundKey("")).toBe(true);
    expect(isBackgroundKey(`img/${UUID}.jpg`)).toBe(true);
    for (const key of [`img/${UUID}.png`, `img/${UUID}.webp`, "/seed/certificate-white.jpg", "https://evil.example/a.jpg", `lessons/${UUID}.jpg`, `img/${UUID}.jpg `, "img/x.jpg"]) {
      expect(isBackgroundKey(key), key).toBe(false);
    }
  });
});

describe("firstDesign and designFor: the design a course's certificate gets", () => {
  const designs = [
    { id: 7, sort: 2, name: "Tume" },
    { id: 9, sort: 1, name: "Teine hele" },
    { id: 4, sort: 1, name: "Hele" },
  ];

  test("the first is the lowest sort, then the lowest id; none without designs", () => {
    expect(firstDesign(designs)?.name).toBe("Hele");
    expect(firstDesign([{ id: 3, sort: 5 }, { id: 2, sort: 5 }])?.id).toBe(2);
    expect(firstDesign([])).toBeNull();
  });

  test("a course's pick when it is a design; no pick (null), or one that is no design, gets the first", () => {
    expect(designFor(designs, 7)?.name).toBe("Tume");
    expect(designFor(designs, null)?.name).toBe("Hele");
    expect(designFor(designs, 999)?.name).toBe("Hele");
    expect(designFor([], null)).toBeNull();
  });
});

describe("frozenOf and readFrozenDesign: the copy a certificate keeps", () => {
  test("the tone and the background key, nothing else of the design", () => {
    const design: CertificateDesign = { id: 4, name: "Hele", tone: "light", backgroundKey: `img/${UUID}.jpg`, sort: 1 };
    expect(frozenOf(design)).toEqual({ tone: "light", backgroundKey: `img/${UUID}.jpg` });
  });

  test("read back as stored; null (an older certificate, or anything that is not a design) draws today's dark page", () => {
    expect(readFrozenDesign({ tone: "light", backgroundKey: `img/${UUID}.jpg` })).toEqual({ tone: "light", backgroundKey: `img/${UUID}.jpg` });
    expect(readFrozenDesign({ tone: "dark", backgroundKey: "" })).toEqual({ tone: "dark", backgroundKey: "" });
    expect(readFrozenDesign({ tone: "light" })).toEqual({ tone: "light", backgroundKey: "" });
    // a key that is no background is not read from the store: the tone stays, the photo goes
    expect(readFrozenDesign({ tone: "light", backgroundKey: "https://evil.example/a.jpg" })).toEqual({ tone: "light", backgroundKey: "" });
    for (const v of [null, undefined, "light", [], { tone: "white", backgroundKey: "" }, { backgroundKey: `img/${UUID}.jpg` }]) expect(readFrozenDesign(v), JSON.stringify(v)).toBeNull();
  });
});

describe("checkDesignName: „Nimi“", () => {
  test("required, on one line and trimmed, at most 40 characters", () => {
    expect(checkDesignName("  Hele \n  taust ", [])).toEqual({ ok: true, name: "Hele taust" });
    expect(checkDesignName("   ", [])).toEqual({ ok: false, error: "required" });
    expect(checkDesignName("x".repeat(40), [])).toEqual({ ok: true, name: "x".repeat(40) });
    expect(checkDesignName("x".repeat(41), [])).toEqual({ ok: false, error: "tooLong" });
    // what Postgres cannot store goes first (a NUL, a lone surrogate)
    expect(checkDesignName("He\u0000le\ud800", [])).toEqual({ ok: true, name: "Hele" });
  });

  test("unique among the other designs, whatever the case", () => {
    expect(checkDesignName("hele", ["Hele", "Tume"])).toEqual({ ok: false, error: "taken" });
    expect(checkDesignName(" TUME ", ["Hele", "Tume"])).toEqual({ ok: false, error: "taken" });
    expect(checkDesignName("Hele 2", ["Hele", "Tume"])).toEqual({ ok: true, name: "Hele 2" });
  });
});
