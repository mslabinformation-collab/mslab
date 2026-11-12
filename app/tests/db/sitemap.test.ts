import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses, posts } from "@/db/schema";
import { PUBLIC_SITEMAP_PATHS } from "@/lib/alternates";
import { makeTestDb } from "./helpers";

// SEO G4: /sitemap.xml lists the public pages and each published course and post, in both languages, with their other-language links. It reads the
// database when asked (force-dynamic), so a draft is never listed.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import sitemap, { dynamic } from "@/app/sitemap";

const SITE = "https://mslab.ee";
let db: Db;
beforeEach(async () => {
  vi.stubEnv("SITE_URL", SITE);
  db = await makeTestDb();
  state.db = db;
});

const base = { type: "contact" as const, level: "basic" as const, title: { et: "T" }, summary: { et: "" }, body: { et: "" } };

describe("sitemap", () => {
  test("is read when asked, never at build", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("lists every public page in both languages", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    for (const p of PUBLIC_SITEMAP_PATHS) {
      expect(urls).toContain(p === "/" ? SITE : SITE + p);
      expect(urls).toContain(p === "/" ? SITE + "/ru" : SITE + "/ru" + p);
    }
    expect(urls.length).toBe(PUBLIC_SITEMAP_PATHS.length * 2);
  });

  test("lists a published course and post in both languages with their alternates and dates; drafts are absent", async () => {
    const [c] = await db.insert(courses).values({ ...base, slug: "pub-course", published: true, updatedAt: new Date("2026-10-01T10:00:00Z") }).returning();
    await db.insert(courses).values({ ...base, slug: "draft-course", published: false });
    await db.insert(posts).values([
      { slug: "pub-post", title: { et: "P" }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "", published: true, publishedAt: new Date("2026-09-01T10:00:00Z") },
      { slug: "draft-post", title: { et: "D" }, excerpt: { et: "" }, body: { et: "" }, category: { et: "" }, coverKey: "", published: false },
    ]);
    const list = await sitemap();
    const urls = list.map((e) => e.url);
    expect(urls.some((u) => u.includes("draft-"))).toBe(false);
    const languages = (path: string) => ({ et: SITE + path, ru: SITE + "/ru" + path, "x-default": SITE + path });
    for (const [path, date] of [["/koolitused/pub-course", c.updatedAt], ["/uudised/pub-post", new Date("2026-09-01T10:00:00Z")]] as const) {
      for (const url of [SITE + path, SITE + "/ru" + path]) {
        const e = list.find((x) => x.url === url);
        expect(e, url).toBeDefined();
        expect(e!.alternates?.languages).toEqual(languages(path));
        expect(e!.lastModified).toEqual(date);
      }
    }
  });
});
