import { describe, expect, test } from "vitest";
import { feedbackSummary } from "@/server/messages";

// Maria's notice of a new answer (spec §6): "Uus tagasiside: {nimi}, {koolitus}, {score}/10" (without the score part when none was given),
// and the answers in her own wording, whatever language the student answered in.

const ADMIN = "https://mslab.example/admin";
const base = { target: { registrationId: 7 }, publishable: false, name: "Mari Maasikas", email: "mari@example.test", course: "Kulmude lamineerimine", startsAt: new Date("2026-10-12T07:00:00Z") };

describe("feedbackSummary", () => {
  test("the subject with the score; who, the course and its day; every answered question in Maria's wording; the admin's page", () => {
    const s = feedbackSummary({ ...base, answers: { score: 9, expectations: "met", ready: "mostly", message: "Aitäh!\nVäga hea päev." } }, ADMIN);
    expect(s.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10");
    expect(s.short).toBe(s.subject);
    expect(s.text).toBe(
      [
        "Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10", "",
        "Õpilane: Mari Maasikas", "E-post: mari@example.test", "Koolitus: Kulmude lamineerimine, 12.10.2026", "",
        "Kuidas hindad koolitust tervikuna skaalal 1–10?", "9/10", "",
        "Kas koolitus vastas sinu ootustele?", "Vastas ootustele", "",
        "Kas tunned, et oled valmis peale koolitust iseseisvalt teenust pakkuma?", "Pigem jah, natuke harjutamist vajab", "",
        "Soovi korral jäta meile väike tagasiside või sõnum:", "Aitäh!\nVäga hea päev.", "",
        "Admin: https://mslab.example/admin/tagasiside", "",
      ].join("\n"),
    );
  });

  test("when she allowed publishing, the mail and the Telegram text gain the line 'Lubab avaldada' (student reviews, D2), under who and which course; otherwise neither has it", () => {
    const line = "Lubab avaldada — vaata „Tagasiside“ lehel.";
    const publishable = feedbackSummary({ ...base, publishable: true, answers: { score: 9, recommend: "Soovitaksin." } }, ADMIN);
    expect(publishable.text).toBe(
      [
        "Uus tagasiside: Mari Maasikas, Kulmude lamineerimine, 9/10", "",
        "Õpilane: Mari Maasikas", "E-post: mari@example.test", "Koolitus: Kulmude lamineerimine, 12.10.2026", "",
        line, "",
        "Kuidas hindad koolitust tervikuna skaalal 1–10?", "9/10", "",
        "Kas soovitaksid seda koolitust ka teistele? Miks?", "Soovitaksin.", "",
        "Admin: https://mslab.example/admin/tagasiside", "",
      ].join("\n"),
    );
    expect(publishable.short).toBe(`${publishable.subject}\n${line}`);
    expect(publishable.subject).not.toContain("avaldada");
    const plain = feedbackSummary({ ...base, answers: { score: 9 } }, ADMIN);
    expect(plain.text).not.toContain("avaldada");
    expect(plain.short).toBe(plain.subject);
  });

  test("an e-course answer's notice (an access, no day) reads the same as a contact course's", () => {
    const s = feedbackSummary({ ...base, target: { accessId: 3 }, startsAt: null, course: "Kulmude e-kursus", answers: { score: 10 } }, ADMIN);
    expect(s.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude e-kursus, 10/10");
    expect(s.text).toContain("Koolitus: Kulmude e-kursus\n");
  });

  test("without a score the subject has no score part; an individual course has no day", () => {
    const s = feedbackSummary({ ...base, startsAt: null, answers: { recommend: "Jah" } }, ADMIN);
    expect(s.subject).toBe("Uus tagasiside: Mari Maasikas, Kulmude lamineerimine");
    expect(s.text).toContain("Koolitus: Kulmude lamineerimine\n");
  });
});
