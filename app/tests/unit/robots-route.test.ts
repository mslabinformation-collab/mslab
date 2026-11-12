import { afterEach, describe, expect, test, vi } from "vitest";
import robots from "@/app/robots";

// SEO G2: /robots.txt is made by app/robots.ts. Indexing off (the gate on, or not Vercel production): exactly the text of the old
// public/robots.txt (link-preview bots may fetch pages, everyone else is shut out). Indexing on: everything but the private areas,
// and the sitemap.

afterEach(() => vi.unstubAllEnvs());

const PREVIEW_BOTS = [
  "facebookexternalhit", "Facebot", "Twitterbot", "LinkedInBot", "TelegramBot", "WhatsApp", "Slackbot-LinkExpanding", "Slackbot", "Discordbot",
  "SkypeUriPreview", "vkShare", "Pinterestbot", "redditbot",
];

describe("robots.txt while indexing is off", () => {
  test("the old text: preview bots allowed, everyone else disallowed, no sitemap", () => {
    for (const env of [{ SITE_GATE: "1", VERCEL_ENV: "production" }, { SITE_GATE: "", VERCEL_ENV: "preview" }, { SITE_GATE: "", VERCEL_ENV: "" }]) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(robots()).toEqual({
        rules: [...PREVIEW_BOTS.map((userAgent) => ({ userAgent, allow: "/" })), { userAgent: "*", disallow: "/" }],
      });
    }
  });
});

describe("robots.txt while indexing is on", () => {
  test("everything allowed but the private areas, and the sitemap of SITE_URL", () => {
    vi.stubEnv("SITE_GATE", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SITE_URL", "https://mslab.ee");
    expect(robots()).toEqual({
      rules: [
        {
          userAgent: "*",
          allow: "/",
          disallow: ["/admin", "/api/", "/konto", "/ru/konto", "/ostukorv", "/ru/ostukorv", "/makse", "/ru/makse", "/maksa/", "/guide", "/p/"],
        },
      ],
      sitemap: "https://mslab.ee/sitemap.xml",
    });
  });

  test("the sitemap follows SITE_URL, with or without a closing slash; unset is https://mslab.ee", () => {
    vi.stubEnv("SITE_GATE", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SITE_URL", "https://example.test/");
    expect(robots().sitemap).toBe("https://example.test/sitemap.xml");
    vi.stubEnv("SITE_URL", "");
    expect(robots().sitemap).toBe("https://mslab.ee/sitemap.xml");
  });
});
