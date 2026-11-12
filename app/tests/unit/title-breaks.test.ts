import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepNameTogether } from "@/domain/title-breaks";

// UX pass 11.11 P18 (the Vaiksed board): on a phone „Lash Lift BOTOX baaskoolitus“ broke as „Lash Lift / BOTOX baaskoolitus“, splitting the product's
// name. A course title's run of two or three capitalised words (a name: „Lash Lift BOTOX“) is joined by no-break spaces, so it wraps as one word.

const NBSP = " ";

describe("keepNameTogether", () => {
  it("joins the words of „Lash Lift BOTOX“ and leaves the space before „baaskoolitus“", () => {
    expect(keepNameTogether("Lash Lift BOTOX baaskoolitus")).toBe(`Lash${NBSP}Lift${NBSP}BOTOX baaskoolitus`);
    expect(keepNameTogether("Lash Lift BOTOX базовый курс")).toBe(`Lash${NBSP}Lift${NBSP}BOTOX базовый курс`);
  });

  it("a title of ordinary words is as it was; one capitalised word has nothing to join", () => {
    expect(keepNameTogether("Kulmumeistri baaskoolitus")).toBe("Kulmumeistri baaskoolitus");
    expect(keepNameTogether("Ripsmepikendus klassikaline ja volüüm")).toBe("Ripsmepikendus klassikaline ja volüüm");
    expect(keepNameTogether("")).toBe("");
  });

  it("a long run (four words, or more than 16 letters) is left to wrap: it may not fit a phone's line", () => {
    expect(keepNameTogether("Brow Lamination Master Class")).toBe("Brow Lamination Master Class");
    expect(keepNameTogether("Kulmulaminatsiooni Meistriklass")).toBe("Kulmulaminatsiooni Meistriklass");
    // (review: 17–20 letters in the course page's 36 px heading are wider than a 360 px phone's line)
    expect(keepNameTogether("Brow Lamination Pro kursus")).toBe("Brow Lamination Pro kursus");
    expect(keepNameTogether("Lash Lift Pro kursus")).toBe(`Lash${NBSP}Lift${NBSP}Pro kursus`);
  });

  it("a word longer than the line still breaks rather than run out of it (the heading, the card's title, the calendar's name)", () => {
    const rule = (file: string, selector: string) => {
      const css = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
      const at = css.indexOf(`\n${selector} {`);
      expect(at, `${file} ${selector}`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule("src/app/[locale]/(site)/koolitused/[slug]/course.module.css", ".title")).toMatch(/overflow-wrap: break-word;/);
    expect(rule("src/components/site/CourseCard.module.css", ".title")).toMatch(/overflow-wrap: break-word;/);
    expect(rule("src/components/site/Calendar.module.css", ".name")).toMatch(/overflow-wrap: break-word;/);
  });

  it("the cards, the calendar's rows and the course page's heading use it", () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
    expect(read("src/components/site/CourseCard.tsx")).toMatch(/keepNameTogether\(c\.title\)/);
    expect(read("src/components/site/CalendarRow.tsx")).toMatch(/keepNameTogether\(row\.title\)/);
    expect(read("src/app/[locale]/(site)/koolitused/[slug]/page.tsx")).toMatch(/<h1 className=\{styles\.title\}>\{keepNameTogether\(title\)\}<\/h1>/);
  });
});
