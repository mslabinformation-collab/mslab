import { PROD_ENV } from "./prod-build";
import { DEV_ENV } from "./server";
import { LOCAL_ENV } from "../local-secrets";
import { PROD_BUILD, TARGET } from "./target";
import { test, expect } from "./test";

// SEO groundwork (spec G3, G4): the answers themselves, read-only. The sitemap and the language links name SITE_URL, whichever host served them.

const SITE_URL = (PROD_BUILD ? PROD_ENV.SITE_URL : TARGET ? LOCAL_ENV.SITE_URL : DEV_ENV.SITE_URL).replace(/\/+$/, "");

test.describe("sitemap and language links (SEO G3, G4)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  test("sitemap.xml lists the public pages in both languages and a course with its alternates; the home page links its Russian version", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/xml");
    const xml = await res.text();
    for (const loc of [`${SITE_URL}/koolitused`, `${SITE_URL}/ru/koolitused`, `${SITE_URL}/koolitused/kulmumeistri-baaskoolitus`, `${SITE_URL}/ru/koolitused/kulmumeistri-baaskoolitus`]) {
      expect(xml, loc).toContain(`<loc>${loc}</loc>`);
    }
    const course = /<url>\s*<loc>[^<]*\/ru\/koolitused\/kulmumeistri-baaskoolitus<\/loc>[\s\S]*?<\/url>/.exec(xml)?.[0] ?? "";
    expect(course).toContain(`hreflang="ru" href="${SITE_URL}/ru/koolitused/kulmumeistri-baaskoolitus"`);
    expect(course).toContain(`hreflang="et" href="${SITE_URL}/koolitused/kulmumeistri-baaskoolitus"`);
    expect(course).toContain(`hreflang="x-default" href="${SITE_URL}/koolitused/kulmumeistri-baaskoolitus"`);
    expect(xml, "a draft or private page is never listed").not.toMatch(/<loc>[^<]*\/(konto|ostukorv|makse|admin)/);

    const home = await (await request.get("/")).text();
    // (Next writes the Estonian home page's address without the slash and the attribute as hrefLang; HTML does not mind the case)
    expect(home).toContain(`<link rel="canonical" href="${SITE_URL}"`);
    expect(home).toMatch(new RegExp(`<link rel="alternate" hreflang="ru" href="${SITE_URL}/ru"`, "i"));
    const ru = await (await request.get("/ru")).text();
    expect(ru).toContain(`<link rel="canonical" href="${SITE_URL}/ru"`);
    expect(ru).toMatch(new RegExp(`<link rel="alternate" hreflang="et" href="${SITE_URL}"`, "i"));
  });
});
