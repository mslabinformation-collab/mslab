import { describe, expect, test } from "vitest";
import { trainerSettings, shellSettings } from "@/components/site/settings";
import {
  contactDraft,
  DARK_MOBILE_FOCAL,
  DEFAULT_FOCAL,
  mobileFocalForTone,
  formatFocal,
  hasLocalePrefix,
  isFocal,
  isHttpsUrl,
  isSiteHref,
  linkFor,
  newSlideDraft,
  packageDraft,
  pageDraft,
  parseFocal,
  portraitFraming,
  slideDraft,
  trainerDraft,
} from "@/domain/site-editor";
import { contentVersion, stableJson } from "@/lib/version";

// Task 13B: the site editors' pure rules (links, focal points, the portrait's framing, drafts) and the content version.

describe("links an admin may store", () => {
  test("site paths and https addresses only", () => {
    for (const ok of ["/", "/koolitused", "/koolitused/lash-lift-botox", "/praktika?pakett=MINI#taotlus", "https://www.instagram.com/mslab", "https://mslab.ee/a?b=c"])
      expect(isSiteHref(ok), ok).toBe(true);
    for (const bad of [
      "",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:x",
      "http://example.com",
      "//evil.example/x",
      "/\\evil.example",
      "koolitused",
      "mailto:a@example.ee",
      "/koolitused x",
      "/a\nb",
      "https://",
      "https://user:pw@evil.example",
      "https://localhost/x",
      `/${"a".repeat(400)}`,
    ])
      expect(isSiteHref(bad), JSON.stringify(bad)).toBe(false);
  });

  test("https URLs for social links", () => {
    expect(isHttpsUrl("https://www.facebook.com/mslab")).toBe(true);
    expect(isHttpsUrl("HTTPS://www.facebook.com/mslab")).toBe(true);
    for (const bad of ["http://facebook.com", "javascript:alert(1)", "/kontakt", "https://", "https://x", "ftp://a.b"]) expect(isHttpsUrl(bad), bad).toBe(false);
  });

  test("linkFor: a site path gets the locale, an https address stays, anything else falls back", () => {
    const to = (p: string) => `/ru${p}`;
    expect(linkFor("/praktika", to, "/koolitused")).toBe("/ru/praktika");
    expect(linkFor("https://www.instagram.com/mslab", to, "/koolitused")).toBe("https://www.instagram.com/mslab");
    expect(linkFor("javascript:alert(1)", to, "/koolitused")).toBe("/ru/koolitused");
    expect(linkFor("//evil.example", to, "/koolitused")).toBe("/ru/koolitused");
  });

  test("a path stored with a locale never doubles it (/ru/ru/…); the admin refuses such a path", () => {
    for (const p of ["/ru", "/ru/praktika", "/RU/praktika", "/et/koolitused", "/ru?x=1", "/ru#a"]) expect(hasLocalePrefix(p), p).toBe(true);
    for (const p of ["/", "/ruumid", "/praktika", "/koolitused/ru", "/etendus"]) expect(hasLocalePrefix(p), p).toBe(false);
    const ru = (p: string) => (p === "/" ? "/ru" : `/ru${p}`);
    const et = (p: string) => p;
    expect(linkFor("/ru/praktika", ru, "/koolitused")).toBe("/ru/praktika");
    expect(linkFor("/ru/praktika", et, "/koolitused")).toBe("/praktika");
    expect(linkFor("/et/koolitused?vorm=e", ru, "/koolitused")).toBe("/ru/koolitused?vorm=e");
    expect(linkFor("/ru", ru, "/koolitused")).toBe("/ru");
    expect(linkFor("/ru?x=1", et, "/koolitused")).toBe("/?x=1");
    expect(linkFor("/ruumid", ru, "/koolitused")).toBe("/ru/ruumid");
  });

  test("a stored path that is another site once its locale is gone ('/ru//evil.example') falls back", () => {
    const ru = (p: string) => (p === "/" ? "/ru" : `/ru${p}`);
    const et = (p: string) => p;
    for (const bad of ["/ru//evil.example", "/et//evil.example/x", "/RU//evil.example", "/ru//", "/ru//?x", "/et//#a"]) {
      expect(isSiteHref(bad), bad).toBe(true); // a site path as written: only the strip makes it another site
      expect(linkFor(bad, et, "/koolitused"), bad).toBe("/koolitused");
      expect(linkFor(bad, ru, "/koolitused"), bad).toBe("/ru/koolitused");
    }
    // the backslash forms browsers also read as another site are refused before the strip (isSiteHref)
    for (const bad of ["/ru/\\evil.example", "/et/\\/evil.example", "/\\evil.example"]) {
      expect(isSiteHref(bad), bad).toBe(false);
      expect(linkFor(bad, et, "/koolitused"), bad).toBe("/koolitused");
    }
    // a bare locale and a locale with a path still work
    expect(linkFor("/ru/", et, "/koolitused")).toBe("/");
    expect(linkFor("/ru/praktika//x", et, "/koolitused")).toBe("/praktika//x");
  });
});

describe("focal points", () => {
  test("parse and format whole percentages 0…100", () => {
    expect(parseFocal("73% 50%")).toEqual({ x: 73, y: 50 });
    expect(parseFocal(" 0% 100% ")).toEqual({ x: 0, y: 100 });
    for (const bad of ["50%", "101% 0%", "50 50", "-1% 5%", "50.5% 50%", "", null, undefined]) expect(parseFocal(bad), String(bad)).toBeNull();
    expect(isFocal("50% 50%")).toBe(true);
    expect(formatFocal({ x: 33.6, y: -4 })).toBe("34% 0%");
    expect(formatFocal({ x: 140, y: Number.NaN })).toBe("100% 50%");
  });

  test("the portrait: the seed photo is zoomed (Task 9 crop), an upload is framed by its focal point only", () => {
    expect(portraitFraming("/seed/maria-standing.jpg", "")).toEqual({ pos: "50% 20%", zoom: true });
    expect(portraitFraming("/seed/maria-standing.jpg", "40% 10%")).toEqual({ pos: "40% 10%", zoom: true });
    expect(portraitFraming("img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg", "")).toEqual({ pos: "50% 50%", zoom: false });
    expect(portraitFraming("img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg", "30% 25%")).toEqual({ pos: "30% 25%", zoom: false });
    expect(portraitFraming("/seed/maria-seated.jpg", "nonsense")).toEqual({ pos: "50% 50%", zoom: false });
    const upload = trainerSettings({ trainer: { portraitKey: "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg", portraitPos: "30% 25%", name: "Maria" } }).portraitZoom;
    expect(upload).toBe(false);
    expect(trainerSettings({ trainer: { portraitKey: "/seed/maria-standing.jpg", name: "Maria" } })).toMatchObject({ portraitPos: "50% 20%", portraitZoom: true });
  });
});

describe("a dark hero slide's phone focal point (item 6)", () => {
  test("the default follows the tone; a point set by hand stays", () => {
    expect(DARK_MOBILE_FOCAL).toBe("90% 50%");
    expect(mobileFocalForTone(DEFAULT_FOCAL, "dark")).toBe(DARK_MOBILE_FOCAL);
    expect(mobileFocalForTone(DARK_MOBILE_FOCAL, "light")).toBe(DEFAULT_FOCAL);
    expect(mobileFocalForTone("73% 50%", "dark")).toBe("73% 50%");
    expect(mobileFocalForTone("30% 40%", "light")).toBe("30% 40%");
    expect(mobileFocalForTone(DEFAULT_FOCAL, "light")).toBe(DEFAULT_FOCAL);
  });

  test("the seed's dark slides use it, the light ones keep B's flower framing", async () => {
    const { heroSeeds } = await import("@/db/seed-data");
    for (const s of heroSeeds) expect(s.imagePosMobile, s.imageKey).toBe(s.tone === "dark" ? DARK_MOBILE_FOCAL : "73% 50%");
  });
});

describe("shell settings keep only https social links", () => {
  test("an older javascript: or http value is not linked", () => {
    const s = shellSettings({ contact: { email: "a@example.ee", instagram: "javascript:alert(1)", facebook: "https://facebook.com/mslab" } });
    expect(s.contact).toEqual({ email: "a@example.ee", phone: "", instagram: "", facebook: "https://facebook.com/mslab" });
  });
});

describe("drafts from stored values", () => {
  test("slides, packages, pages, the trainer and contact", () => {
    const slide = slideDraft({
      id: 7,
      imageKey: "/seed/x.jpg",
      imagePos: "bad",
      imagePosMobile: "73% 50%",
      tone: "weird",
      kicker: { et: "K" },
      title: { et: "T", ru: "Т" },
      text: { et: "" },
      ctaLabel: { et: "L" },
      ctaHref: "/x",
      active: false,
    });
    expect(slide).toEqual({ uid: "s7", id: 7, imageKey: "/seed/x.jpg", imagePos: "50% 50%", imagePosMobile: "73% 50%", tone: "light", kicker: { et: "K" }, title: { et: "T", ru: "Т" }, text: { et: "" }, ctaLabel: { et: "L" }, ctaHref: "/x", active: false });
    expect(newSlideDraft("n1")).toMatchObject({ uid: "n1", id: null, imageKey: "", tone: "light", ctaHref: "/koolitused", active: true });
    expect(packageDraft({ name: { et: "MAXI" }, tagline: { et: "" }, models: 4, durationLabel: { et: "8 ak" }, price: 15050, items: [{ et: "a", ru: "б" }] })).toEqual({
      name: { et: "MAXI" },
      tagline: { et: "" },
      models: "4",
      durationLabel: { et: "8 ak" },
      price: "150,50",
      items: [{ et: "a", ru: "б" }],
    });
    expect(pageDraft(null)).toEqual({ title: { et: "" }, body: { et: "" } });
    expect(trainerDraft(null)).toEqual({ portraitKey: "", portraitPos: "50% 50%", name: { et: "" }, role: { et: "" }, stats: [] });
    expect(trainerDraft({ name: { et: "Maria", ru: "Мария" } }).name).toEqual({ et: "Maria", ru: "Мария" });
    expect(trainerDraft({ portraitKey: "/seed/maria-standing.jpg", name: "M", stats: [{ value: "8+", label: { et: "aastat" } }, "junk"] })).toEqual({
      portraitKey: "/seed/maria-standing.jpg",
      portraitPos: "50% 20%",
      name: { et: "M" }, // a plain string, as stored before round 2: the Estonian name
      role: { et: "" },
      stats: [
        { uid: "t0", value: "8+", label: { et: "aastat" } },
        { uid: "t1", value: "", label: { et: "" } },
      ],
    });
    expect(contactDraft({ email: "a@example.ee", phone: 5 })).toEqual({ email: "a@example.ee", phone: "", address: "", instagram: "", facebook: "" });
  });
});

describe("content version", () => {
  test("the same value gives the same version whatever the key order; a change gives another", async () => {
    expect(stableJson({ b: 1, a: [{ d: new Date("2026-10-02T06:00:00Z"), c: undefined }] })).toBe('{"a":[{"d":"2026-10-02T06:00:00.000Z"}],"b":1}');
    const a = await contentVersion({ et: "x", ru: "y", n: [1, 2] });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await contentVersion({ n: [1, 2], ru: "y", et: "x" })).toBe(a);
    expect(await contentVersion({ et: "x", ru: "y", n: [2, 1] })).not.toBe(a);
    expect(await contentVersion(null)).toBe(await contentVersion(undefined));
  });
});
