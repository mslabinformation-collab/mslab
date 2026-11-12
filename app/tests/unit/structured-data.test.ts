import { describe, expect, test } from "vitest";
import { breadcrumbLd, courseLd, organizationLd, postLd, websiteLd } from "@/lib/structured-data";

// SEO G5: the structured data builders. Plain objects; JsonLd (components/site/JsonLd.tsx) prints them.

const BASE = "https://mslab.ee";
const ORG = `${BASE}/#organization`;

const course = (over: Record<string, unknown> = {}) => ({
  slug: "kulmude-lami",
  type: "contact" as const,
  title: { et: "Kulmude LAMI", ru: "Ламинирование бровей" },
  summary: { et: "Kokkuvõte.", ru: "Описание." },
  language: "ET",
  price: null as number | null,
  priceGroup: 19000 as number | null,
  priceIndividual: 25000 as number | null,
  images: [{ key: "img/11111111-1111-1111-1111-111111111111.jpg" }],
  ...over,
});
const session = (over: Record<string, unknown> = {}) => ({
  startsAt: new Date("2030-05-04T07:00:00.000Z"),
  city: "Tartu",
  venue: "Stuudio",
  language: "ET",
  status: "scheduled" as const,
  ...over,
});

describe("organizationLd", () => {
  test("an educational organization with the contact details that are set", () => {
    const o = organizationLd(BASE, "MS LAB Koolituskeskus", { email: "info@example.test", phone: "+372 5555 5555", address: "Pärnu mnt 1, Tallinn", instagram: "https://instagram.com/mslab", facebook: "" });
    expect(o).toEqual({
      "@context": "https://schema.org",
      "@type": "EducationalOrganization",
      "@id": ORG,
      name: "MS LAB Koolituskeskus",
      url: BASE,
      logo: `${BASE}/brand/logo.png`,
      email: "info@example.test",
      telephone: "+372 5555 5555",
      address: "Pärnu mnt 1, Tallinn",
      sameAs: ["https://instagram.com/mslab"],
    });
    expect(o).not.toHaveProperty("legalName");
  });

  test("unset details are left out, and sameAs with them", () => {
    const o = organizationLd(BASE, "MS LAB", { email: "", phone: "", address: "", instagram: "", facebook: "" });
    expect(Object.keys(o).sort()).toEqual(["@context", "@id", "@type", "logo", "name", "url"]);
  });

  test("both social links, Instagram first", () => {
    const o = organizationLd(BASE, "MS LAB", { email: "", phone: "", address: "", instagram: "https://i.example.test/a", facebook: "https://f.example.test/b" });
    expect(o.sameAs).toEqual(["https://i.example.test/a", "https://f.example.test/b"]);
  });
});

describe("websiteLd", () => {
  test("the site in both languages, published by the organization", () => {
    expect(websiteLd(BASE, "MS LAB")).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${BASE}/#website`,
      name: "MS LAB",
      url: BASE,
      inLanguage: ["et", "ru"],
      publisher: { "@id": ORG },
    });
  });
});

describe("courseLd", () => {
  test("a contact course: group and individual offers in EUR", () => {
    const c = courseLd(BASE, "et", course(), []);
    expect(c["@type"]).toBe("Course");
    expect(c.name).toBe("Kulmude LAMI");
    expect(c.description).toBe("Kokkuvõte.");
    expect(c.url).toBe(`${BASE}/koolitused/kulmude-lami`);
    expect(c.image).toBe(`${BASE}/media/img/11111111-1111-1111-1111-111111111111.jpg`);
    expect(c.provider).toEqual({ "@id": ORG });
    expect(c.inLanguage).toEqual(["et"]);
    const offers = c.offers as { price: string; priceCurrency: string }[];
    expect(offers.map((o) => [o.price, o.priceCurrency])).toEqual([["190.00", "EUR"], ["250.00", "EUR"]]);
  });

  test("an e-course: one offer from its price, one online instance", () => {
    const c = courseLd(BASE, "et", course({ type: "e_learning", price: 9900, priceGroup: null, priceIndividual: null }), []);
    expect((c.offers as { price: string }[]).map((o) => o.price)).toEqual(["99.00"]);
    expect(c.hasCourseInstance).toEqual([{ "@type": "CourseInstance", courseMode: "online" }]);
  });

  test("no price, no offer", () => {
    const c = courseLd(BASE, "et", course({ priceGroup: null, priceIndividual: null }), []);
    expect(c).not.toHaveProperty("offers");
  });

  test("an upcoming scheduled session is an onsite instance; a cancelled one is left out", () => {
    const c = courseLd(BASE, "et", course(), [session(), session({ startsAt: new Date("2030-06-01T07:00:00.000Z"), city: "Tallinn", venue: "" }), session({ status: "cancelled", city: "Narva" })]);
    const inst = c.hasCourseInstance as { courseMode: string; startDate: string; location: { address: string; name?: string }; inLanguage: string[] }[];
    expect(inst).toHaveLength(2);
    expect(inst.map((i) => i.courseMode)).toEqual(["onsite", "onsite"]);
    expect(inst.map((i) => i.startDate)).toEqual(["2030-05-04T07:00:00.000Z", "2030-06-01T07:00:00.000Z"]);
    expect(inst.map((i) => i.location.address)).toEqual(["Tartu", "Tallinn"]);
    expect(inst[0].location.name).toBe("Stuudio");
    expect(inst[1].location).not.toHaveProperty("name");
    expect(inst[0].inLanguage).toEqual(["et"]);
  });

  test("a contact course without upcoming sessions has no instances", () => {
    expect(courseLd(BASE, "et", course(), [])).not.toHaveProperty("hasCourseInstance");
  });

  test("\"ET / RU\" is both languages", () => {
    expect(courseLd(BASE, "et", course({ language: "ET / RU" }), []).inLanguage).toEqual(["et", "ru"]);
  });

  test("the Russian page uses the Russian text and address", () => {
    const c = courseLd(BASE, "ru", course(), []);
    expect(c.name).toBe("Ламинирование бровей");
    expect(c.url).toBe(`${BASE}/ru/koolitused/kulmude-lami`);
  });

  test("without a picture there is no image", () => {
    expect(courseLd(BASE, "et", course({ images: [] }), [])).not.toHaveProperty("image");
  });
});

describe("postLd", () => {
  test("a blog posting by the organization", () => {
    const p = postLd(BASE, "ru", {
      slug: "nov",
      title: { et: "Uudis", ru: "Новость" },
      excerpt: { et: "Lühidalt", ru: "Кратко" },
      coverKey: "img/22222222-2222-2222-2222-222222222222.jpg",
      publishedAt: new Date("2030-01-02T10:00:00.000Z"),
    });
    expect(p).toEqual({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Новость",
      description: "Кратко",
      url: `${BASE}/ru/uudised/nov`,
      mainEntityOfPage: `${BASE}/ru/uudised/nov`,
      datePublished: "2030-01-02T10:00:00.000Z",
      inLanguage: "ru",
      image: `${BASE}/media/img/22222222-2222-2222-2222-222222222222.jpg`,
      author: { "@id": ORG },
      publisher: { "@id": ORG },
    });
  });
});

describe("breadcrumbLd", () => {
  test("positions from 1 with absolute addresses", () => {
    expect(
      breadcrumbLd(BASE, [
        { name: "Avaleht", path: "/" },
        { name: "Koolitused", path: "/koolitused" },
        { name: "Kulmude LAMI", path: "/koolitused/kulmude-lami" },
      ]),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Avaleht", item: BASE },
        { "@type": "ListItem", position: 2, name: "Koolitused", item: `${BASE}/koolitused` },
        { "@type": "ListItem", position: 3, name: "Kulmude LAMI", item: `${BASE}/koolitused/kulmude-lami` },
      ],
    });
  });
});
