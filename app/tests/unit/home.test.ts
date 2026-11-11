import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstParagraph, nextSessionByCourse, nextSessions, pickHomeCourses, splitStatement, withoutRole } from "@/domain/home";
import { trainerSettings } from "@/components/site/settings";
import { formatDate, formatDayMonth, formatWeekday } from "@/i18n/format";

const c = (id: number, type: "e_learning" | "contact") => ({ id, type });

describe("pickHomeCourses", () => {
  test("four courses, both types, admin order kept", () => {
    const list = [c(1, "contact"), c(2, "contact"), c(3, "contact"), c(4, "e_learning"), c(5, "e_learning"), c(6, "e_learning")];
    expect(pickHomeCourses(list).map((x) => x.id)).toEqual([1, 2, 4, 5]);
    expect(pickHomeCourses([c(4, "e_learning"), c(1, "contact"), c(5, "e_learning"), c(2, "contact"), c(3, "contact")]).map((x) => x.id)).toEqual([4, 1, 5, 2]);
  });
  test("fills from the other type when one type has too few", () => {
    expect(pickHomeCourses([c(1, "contact"), c(2, "e_learning"), c(3, "e_learning"), c(4, "e_learning"), c(5, "e_learning")]).map((x) => x.id)).toEqual([1, 2, 3, 4]);
    expect(pickHomeCourses([c(1, "contact"), c(2, "contact"), c(3, "contact"), c(4, "contact"), c(5, "e_learning")]).map((x) => x.id)).toEqual([1, 2, 3, 5]);
    expect(pickHomeCourses([c(1, "e_learning"), c(2, "e_learning")]).map((x) => x.id)).toEqual([1, 2]);
    expect(pickHomeCourses([])).toEqual([]);
  });
});

describe("sessions", () => {
  const s = (id: number, courseId: number, status: "scheduled" | "cancelled", type: "e_learning" | "contact" = "contact") => ({ id, courseId, status, course: { type } });
  const list = [s(1, 1, "scheduled"), s(2, 2, "cancelled"), s(3, 2, "scheduled"), s(4, 9, "scheduled", "e_learning"), s(5, 3, "scheduled"), s(6, 1, "scheduled")];
  test("nextSessions skips cancelled sessions and non-contact courses", () => {
    expect(nextSessions(list).map((x) => x.id)).toEqual([1, 3, 5]);
    expect(nextSessions(list, 2).map((x) => x.id)).toEqual([1, 3]);
  });
  test("nextSessionByCourse takes the first open session of each course", () => {
    const m = nextSessionByCourse(list);
    expect(m.get(1)?.id).toBe(1);
    expect(m.get(2)?.id).toBe(3);
    expect(m.get(3)?.id).toBe(5);
  });
});

describe("text helpers", () => {
  test("splitStatement keeps the first clause in ink", () => {
    expect(splitStatement("Õpetame kulmu- ja ripsmetehnikaid nii, nagu oleksime ise tahtnud õppida.")).toEqual(["Õpetame kulmu- ja ripsmetehnikaid nii,", " nagu oleksime ise tahtnud õppida."]);
    expect(splitStatement("  Ilma komata lause.  ")).toEqual(["Ilma komata lause.", ""]);
  });
  test("firstParagraph", () => {
    expect(firstParagraph("Esimene lõik.\nSama lõik.\n\nTeine lõik.")).toBe("Esimene lõik.\nSama lõik.");
    expect(firstParagraph("")).toBe("");
  });

  // UX pass 11.11 P12 (the Vaiksed board): the course page's trainer card said the role twice, under the name and as the bio's first sentence
  test("withoutRole: the bio's first sentence goes when it is the role under the name", () => {
    const role = "Kulmu- ja ripsmetehnikate meister ja koolitaja";
    expect(withoutRole("Kulmu- ja ripsmetehnikate meister ja koolitaja. Töötan Pärnus ilukliinikus.", role)).toBe("Töötan Pärnus ilukliinikus.");
    expect(withoutRole("kulmu- ja ripsmetehnikate meister ja koolitaja!  Õpetan selgelt.", `${role}.`)).toBe("Õpetan selgelt.");
    expect(withoutRole("Töötan Pärnus. Kulmu- ja ripsmetehnikate meister ja koolitaja.", role)).toBe("Töötan Pärnus. Kulmu- ja ripsmetehnikate meister ja koolitaja.");
    expect(withoutRole("Kulmu- ja ripsmetehnikate meister ja koolitaja Pärnus.", role)).toBe("Kulmu- ja ripsmetehnikate meister ja koolitaja Pärnus.");
    expect(withoutRole("Töötan Pärnus.", "")).toBe("Töötan Pärnus.");
  });

  test("the course page's trainer card: the role once, the photo on the card's colour, the text the card's full width", () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(read("src/app/[locale]/(site)/koolitused/[slug]/page.tsx")).toMatch(/text: withoutRole\(firstParagraph\(pick\(bio\?\.body, locale\)\), pick\(t\.role, locale\)\)/);
    const css = read("src/components/site/TrainerLink.module.css");
    const rule = (selector: string) => new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule(".photo")).toMatch(/background:\s*var\(--canvas\)/);
    expect(rule(".image")).toMatch(/mix-blend-mode:\s*multiply/);
    expect(rule(".text")).not.toMatch(/max-width/);
  });
});

describe("trainerSettings", () => {
  test("reads the trainer setting", () => {
    const t = trainerSettings({
      trainer: {
        portraitKey: "/seed/a.jpg", contactPhotoKey: "/seed/b.jpg", name: " Maria Sosnina ",
        role: { et: "Koolitaja", ru: "Преподаватель" },
        stats: [{ value: "8+", label: { et: "aastat" } }, { value: "", label: { et: "x" } }, { value: "4", label: "linna" }],
      },
    });
    expect(t).toEqual({
      name: "Maria Sosnina", role: { et: "Koolitaja", ru: "Преподаватель" }, portraitKey: "/seed/a.jpg", contactPhotoKey: "/seed/b.jpg",
      contactPhotoCrop: { pos: "50% 20%", zoom: 100 }, // not framed yet (UX pass 11.11 A11)
      portraitPos: "50% 50%", portraitZoom: false, // not the seed portrait: no zoom (Task 13B)
      stats: [{ value: "8+", label: { et: "aastat" } }],
    });
  });
  test("defaults when missing or malformed", () => {
    expect(trainerSettings({})).toEqual({ name: "", role: null, portraitKey: "", portraitPos: "50% 50%", portraitZoom: false, contactPhotoKey: "", contactPhotoCrop: null, stats: [] });
    expect(trainerSettings({ trainer: { portraitKey: "/p.jpg", stats: "x" } }).contactPhotoKey).toBe("/p.jpg");
  });
});

describe("date formatting (Europe/Tallinn)", () => {
  const d = new Date("2026-11-14T08:00:00Z"); // Saturday 10:00 in Tallinn
  test("day and month", () => {
    expect(formatDayMonth(d, "et")).toBe("14.11");
    expect(formatDayMonth(d, "ru")).toBe("14.11");
    expect(formatDayMonth(new Date("2026-11-30T23:30:00Z"), "et")).toBe("01.12"); // already 1 December in Tallinn
  });
  test("full date and weekday", () => {
    expect(formatDate(new Date("2026-09-22T06:00:00Z"), "et")).toBe("22.09.2026");
    expect(formatWeekday(d, "et")).toBe("laupäev");
    expect(formatWeekday(d, "ru")).toBe("суббота");
  });
});
