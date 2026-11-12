import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PUBLIC_SITEMAP_PATHS, pageAlternates } from "@/lib/alternates";

// SEO G3: every public page names its own address (canonical) and its other language (hreflang), as site paths: metadataBase
// (the locale layout) makes them absolute. Next replaces a parent's `alternates` wholesale, so each page sets its own.

describe("pageAlternates", () => {
  test("a Russian page: canonical is its own address, languages name both versions and x-default is Estonian", () => {
    expect(pageAlternates("ru", "/koolitused/x")).toEqual({
      canonical: "/ru/koolitused/x",
      languages: { et: "/koolitused/x", ru: "/ru/koolitused/x", "x-default": "/koolitused/x" },
    });
  });

  test("the home page: / and /ru", () => {
    expect(pageAlternates("et", "/")).toEqual({ canonical: "/", languages: { et: "/", ru: "/ru", "x-default": "/" } });
    expect(pageAlternates("ru", "/").canonical).toBe("/ru");
  });
});

describe("the sitemap's static pages", () => {
  test("are the public pages, nothing private", () => {
    expect([...PUBLIC_SITEMAP_PATHS]).toEqual(["/", "/koolitused", "/koolituskalender", "/praktika", "/koolitaja", "/kontakt", "/uudised", "/privaatsus", "/tingimused"]);
  });
});

describe("the public pages set their alternates (source pin)", () => {
  const root = join(__dirname, "../../src/app/[locale]/(site)");
  const pages: [string, string][] = [
    ["page.tsx", `"/"`],
    ["koolitused/page.tsx", `"/koolitused"`],
    ["koolitused/[slug]/page.tsx", "`/koolitused/${course.slug}`"],
    ["koolituskalender/page.tsx", `"/koolituskalender"`],
    ["praktika/page.tsx", `"/praktika"`],
    ["koolitaja/page.tsx", `"/koolitaja"`],
    ["kontakt/page.tsx", `"/kontakt"`],
    ["uudised/page.tsx", `"/uudised"`],
    ["uudised/[slug]/page.tsx", "`/uudised/${post.slug}`"],
    ["privaatsus/page.tsx", `"/privaatsus"`],
    ["tingimused/page.tsx", `"/tingimused"`],
  ];
  test.each(pages)("%s", (file, path) => {
    const src = readFileSync(join(root, file), "utf8");
    const meta = src.slice(src.indexOf("export async function generateMetadata"));
    expect(meta).toContain(`alternates: pageAlternates(locale, ${path})`);
    expect(src).toContain(`import { pageAlternates } from "@/lib/alternates"`);
  });
});
