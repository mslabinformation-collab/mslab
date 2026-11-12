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

// SEO G6: the old WordPress addresses
test.describe("old addresses (SEO G6)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  test("an old address is one permanent redirect to its new page", async ({ request }) => {
    const product = await request.get("/product/kulmud-baaskoolitus/", { maxRedirects: 0 });
    expect(product.status()).toBe(308);
    expect(product.headers()["location"]).toMatch(/\/koolitused\/kulmumeistri-baaskoolitus$/);
    const about = await request.get("/meist", { maxRedirects: 0 });
    expect(about.status()).toBe(308);
    expect(about.headers()["location"]).toMatch(/\/koolitaja$/);
  });
});

// SEO G5: the structured data scripts, read from the rendered pages
test.describe("structured data (SEO G5)", () => {
  test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");

  const ldOf = async (page: import("@playwright/test").Page): Promise<{ "@type": string; [k: string]: unknown }[]> =>
    (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));

  test("a course page carries Course and BreadcrumbList data, every page the organization, and the page looks as before", async ({ page }) => {
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    const data = await ldOf(page);
    const courses = data.filter((d) => d["@type"] === "Course");
    expect(courses).toHaveLength(1);
    expect(courses[0].name).toBe((await page.locator("h1").first().innerText()).replace(/\s+/g, " ").trim());
    expect(courses[0].provider).toEqual({ "@id": `${SITE_URL}/#organization` });
    // the seeded contact course: group 350 € and individual 450 €, and its upcoming scheduled sessions as onsite instances
    const offers = courses[0].offers as { price: string; priceCurrency: string }[];
    expect(offers.map((o) => `${o.price} ${o.priceCurrency}`)).toEqual(["350.00 EUR", "450.00 EUR"]);
    const instances = courses[0].hasCourseInstance as { courseMode: string; startDate: string }[];
    expect(instances.length).toBeGreaterThan(0);
    for (const i of instances) {
      expect(i.courseMode).toBe("onsite");
      expect(new Date(i.startDate).getTime(), "an upcoming session").toBeGreaterThan(Date.now() - 24 * 3600_000);
    }
    const crumbs = data.filter((d) => d["@type"] === "BreadcrumbList");
    expect(crumbs).toHaveLength(1);
    expect((crumbs[0].itemListElement as unknown[]).length).toBe(3);
    expect(data.filter((d) => d["@type"] === "EducationalOrganization")).toHaveLength(1);

    for (const path of ["/", "/kontakt"]) {
      await page.goto(path);
      const orgs = (await ldOf(page)).filter((d) => d["@type"] === "EducationalOrganization");
      expect(orgs, path).toHaveLength(1);
      expect(orgs[0]["@id"]).toBe(`${SITE_URL}/#organization`);
    }
    await page.goto("/");
    expect((await ldOf(page)).filter((d) => d["@type"] === "WebSite")).toHaveLength(1);
  });

  test("a post page carries BlogPosting and BreadcrumbList data", async ({ page }) => {
    await page.goto("/uudised");
    const post = await page.locator("[data-news-card]").first().getAttribute("href");
    expect(post).toMatch(/^\/uudised\//);
    await page.goto(post ?? "/uudised");
    const data = await ldOf(page);
    const posts = data.filter((d) => d["@type"] === "BlogPosting");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${SITE_URL}${post}`);
    expect(data.filter((d) => d["@type"] === "BreadcrumbList")).toHaveLength(1);
  });
});

// SEO G5, the design guard: the structured data scripts change nothing on a page. Record where the page's parts are (main's element children, the footer,
// the recommendations band, the page height), take every ld+json script out of the document, record again: the two must be the same, to the pixel.
// A script that is the last child instead of the band, or that sits between two siblings a CSS rule relates, shows up as a shift here. Desktop and phone.
test.describe("structured data changes no layout (SEO G5)", () => {
  const layout = async (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)];
      };
      const record = () => ({
        main: [...(document.querySelector("main")?.children ?? [])].filter((e) => e.tagName !== "SCRIPT").map((e) => `${e.tagName}.${e.className}:${box(e)}`),
        footer: [...document.querySelectorAll("footer")].map((e) => box(e)),
        band: [...document.querySelectorAll("[data-recommendations]")].map((e) => `${getComputedStyle(e).marginBottom}:${box(e)}`),
        height: document.documentElement.scrollHeight,
      });
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      const before = record();
      for (const s of scripts) s.remove();
      return { scripts: scripts.length, before, after: record() };
    });

  test("/, /kontakt, three course pages (one an e-course) and a post page look the same with the scripts taken out", async ({ page }) => {
    await page.goto("/uudised");
    const post = (await page.locator("[data-news-card]").first().getAttribute("href")) ?? "/uudised";
    // (the e-course's page and a second contact course too: they end <main> in a different state; the seed has no course the band skips,
    // so the band is only required on the first)
    for (const path of ["/", "/kontakt", "/koolitused/kulmumeistri-baaskoolitus", "/koolitused/kulmumeistri-e-koolitus", "/koolitused/lash-lift-botox", post]) {
      await page.goto(path);
      await page.waitForLoadState("load");
      if (path === "/koolitused/kulmumeistri-baaskoolitus") await expect(page.locator("[data-recommendations]"), "the course shows its recommendations band").toHaveCount(1);
      const { scripts, before, after } = await layout(page);
      expect(scripts, `${path} has structured data`).toBeGreaterThan(0);
      expect(before, path).toEqual(after);
    }
  });
});
