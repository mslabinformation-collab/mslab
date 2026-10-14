import { describe, expect, test } from "vitest";
import { practicalSubmittedSummary, testReviewSummary, triesUsedSummary } from "@/server/messages";

// Maria's notices of the e-course completion (spec §6): Estonian whatever the student's language, the course's Estonian title, who and her
// address, and the link to the item itself (the access's assessment, the attempt's review, Hindamine). Never an answer or a note.

const ADMIN = "https://mslab.example/admin";
const who = { accessId: 7, name: "Мария Иванова", email: "maria.ivanova@example.test", course: "Kulmude e-kursus" };

describe("practicalSubmittedSummary", () => {
  test("the first submission: the subject, who, the course, the round, the access's protocol screen", () => {
    const s = practicalSubmittedSummary({ ...who, round: 1 }, ADMIN);
    expect(s.subject).toBe("Praktiline töö hindamiseks: Мария Иванова, Kulmude e-kursus");
    expect(s.short).toBe(s.subject);
    expect(s.text).toBe(
      [
        "Praktiline töö hindamiseks: Мария Иванова, Kulmude e-kursus", "",
        "Õpilane: Мария Иванова", "E-post: maria.ivanova@example.test", "Koolitus: Kulmude e-kursus", "Saadetud: 1. kord", "",
        "Admin: https://mslab.example/admin/protokollid?ligipaas=7", "",
      ].join("\n"),
    );
  });

  test("a resubmission says which time in the subject: (2. kord), (3. kord)", () => {
    expect(practicalSubmittedSummary({ ...who, round: 2 }, ADMIN).subject).toBe("Praktiline töö hindamiseks: Мария Иванова, Kulmude e-kursus (2. kord)");
    const third = practicalSubmittedSummary({ ...who, round: 3 }, ADMIN);
    expect(third.subject).toBe("Praktiline töö hindamiseks: Мария Иванова, Kulmude e-kursus (3. kord)");
    expect(third.text).toContain("Saadetud: 3. kord");
  });
});

describe("testReviewSummary", () => {
  test("the subject, who, the course, the try, the attempt's review page", () => {
    const s = testReviewSummary({ ...who, attemptId: 41, number: 2 }, ADMIN);
    expect(s.subject).toBe("Test ootab hindamist: Мария Иванова, Kulmude e-kursus");
    expect(s.short).toBe(s.subject);
    expect(s.text).toBe(
      [
        "Test ootab hindamist: Мария Иванова, Kulmude e-kursus", "",
        "Õpilane: Мария Иванова", "E-post: maria.ivanova@example.test", "Koolitus: Kulmude e-kursus", "Katse: 2.", "",
        "Admin: https://mslab.example/admin/hindamine/test?id=41", "",
      ].join("\n"),
    );
  });
});

describe("triesUsedSummary", () => {
  test("the subject, who, the course, the tries made, how to give new ones, Hindamine", () => {
    const s = triesUsedSummary({ ...who, tries: 3 }, ADMIN);
    expect(s.subject).toBe("Testi katsed otsas: Мария Иванова, Kulmude e-kursus");
    expect(s.short).toBe(s.subject);
    expect(s.text).toBe(
      [
        "Testi katsed otsas: Мария Иванова, Kulmude e-kursus", "",
        "Õpilane: Мария Иванова", "E-post: maria.ivanova@example.test", "Koolitus: Kulmude e-kursus", "Katseid tehtud: 3", "",
        "Uued katsed annab nupp „Ava test uuesti“ lehel Hindamine.", "",
        "Admin: https://mslab.example/admin/hindamine", "",
      ].join("\n"),
    );
  });
});
