import { describe, expect, it } from "vitest";
import { courseRowOf, courseStatus, priceLines } from "@/components/admin/course-rows";
import { reorder } from "@/components/admin/reorder";
import type { CourseListRow } from "@/db/queries/admin";

// B1 Koolitused (piece 3a, Task 3; README B1): what a row of the course list shows, as plain strings the client list can draw. The price is on two
// lines („Grupp 350 €“ / „Individuaal 450 €“), the status is „Avaldatud“ / „Mustand“ / „Avaldamata muudatused“ (from the draft layer), and the
// thumbnail is the course's first picture.

const course = (over: Partial<CourseListRow> = {}): CourseListRow =>
  ({
    id: 7,
    slug: "kulmude-lami",
    type: "contact",
    level: "advanced",
    title: { et: "Kulmude LAMI", ru: "Ламинирование бровей" },
    summary: { et: "" },
    body: { et: "" },
    outcomes: [],
    includes: [],
    language: "ET",
    price: null,
    priceGroup: 22000,
    priceIndividual: 30000,
    accessMonths: null,
    videoCount: null,
    durationLabel: null,
    nextDiscount: null,
    badge: null,
    recommendationIds: [],
    protocolStages: [],
    certificateSkills: [],
    certificateVolume: "",
    published: true,
    sort: 1,
    isSample: false,
    updatedAt: new Date("2026-10-20T10:00:00Z"),
    images: [],
    changes: false,
    ...over,
  }) as CourseListRow;

describe("priceLines: the price column on two lines", () => {
  it("a contact course: „Grupp 220 €“ and „Individuaal 300 €“, one line each", () => {
    expect(priceLines(course())).toEqual(["Grupp 220 €", "Individuaal 300 €"]);
  });

  it("only the prices offered: a group price alone, an individual price alone", () => {
    expect(priceLines(course({ priceIndividual: null }))).toEqual(["Grupp 220 €"]);
    expect(priceLines(course({ priceGroup: null }))).toEqual(["Individuaal 300 €"]);
  });

  it("an e-course has its one price on one line; cents are written when there are some", () => {
    expect(priceLines(course({ type: "e_learning", price: 19000, priceGroup: null, priceIndividual: null }))).toEqual(["190 €"]);
    expect(priceLines(course({ type: "e_learning", price: 14950 }))).toEqual(["149,50 €"]);
  });

  it("no price at all is one dash, whichever the type", () => {
    expect(priceLines(course({ priceGroup: null, priceIndividual: null }))).toEqual(["—"]);
    expect(priceLines(course({ type: "e_learning", price: null }))).toEqual(["—"]);
  });

  it("an e-course ignores a contact price left in the row, and a contact course the e-course price", () => {
    expect(priceLines(course({ type: "e_learning", price: null, priceGroup: 100 }))).toEqual(["—"]);
    expect(priceLines(course({ price: 5000, priceGroup: null, priceIndividual: null }))).toEqual(["—"]);
  });
});

describe("courseStatus", () => {
  it("a published course is „Avaldatud“, or „Avaldamata muudatused“ while the draft layer holds changes of it", () => {
    expect(courseStatus(course())).toBe("published");
    expect(courseStatus(course({ changes: true }))).toBe("changes");
  });

  it("an unpublished course is „Mustand“ whatever the draft layer holds (it saves live; the layer only holds a published course's changes)", () => {
    expect(courseStatus(course({ published: false }))).toBe("draft");
    expect(courseStatus(course({ published: false, changes: true }))).toBe("draft");
  });
});

describe("courseRowOf", () => {
  it("the row as the list draws it: the Estonian title, „{tase} · /{slug}“, the type, the price lines, the status and the first picture", () => {
    const row = courseRowOf(course({ images: [{ id: 1, courseId: 7, key: "/seed/brow.jpg", alt: null, sort: 0 }, { id: 2, courseId: 7, key: "img/second.jpg", alt: null, sort: 1 }] }));
    expect(row).toEqual({
      id: 7,
      slug: "kulmude-lami",
      name: "Kulmude LAMI",
      image: "/seed/brow.jpg",
      sub: "Täiendkoolitus · /kulmude-lami",
      type: "contact",
      typeLabel: "Kontaktõpe",
      price: ["Grupp 220 €", "Individuaal 300 €"],
      badge: null,
      status: "published",
      statusLabel: "Avaldatud",
      sample: false,
    });
  });

  it("an uploaded picture's key becomes its address; a course without pictures has none", () => {
    expect(courseRowOf(course({ images: [{ id: 1, courseId: 7, key: "img/0f8b6c2e.jpg", alt: null, sort: 0 }] })).image).toMatch(/img\/0f8b6c2e\.jpg$/);
    expect(courseRowOf(course()).image).toBeNull();
  });

  it("the e-learning type, the base level, the draft and the sample mark", () => {
    const row = courseRowOf(course({ type: "e_learning", level: "basic", published: false, isSample: true, price: 9500 }));
    expect(row).toMatchObject({ typeLabel: "E-õpe", sub: "Baaskoolitus · /kulmude-lami", status: "draft", statusLabel: "Mustand", sample: true, price: ["95 €"] });
    expect(courseRowOf(course({ changes: true })).statusLabel).toBe("Avaldamata muudatused");
  });

  it("the badge as the card shows it (the Estonian label with its colours); none without a label", () => {
    expect(courseRowOf(course({ badge: { label: { et: "Uus", ru: "Новинка" }, bg: "#ddd4dc", fg: "#000000" } })).badge).toEqual({ label: "Uus", bg: "#ddd4dc", fg: "#000000" });
    expect(courseRowOf(course({ badge: null })).badge).toBeNull();
  });
});

describe("reorder: the optimistic list", () => {
  const list = ["a", "b", "c", "d"];
  it("takes the item from one place and puts it in another, the rest keep their order, and the list given is not changed", () => {
    expect(reorder(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("a place outside the list, or the item's own, leaves the order as it is", () => {
    expect(reorder(list, 1, 1)).toEqual(list);
    expect(reorder(list, -1, 2)).toEqual(list);
    expect(reorder(list, 1, 9)).toEqual(list);
  });
});
