import { describe, expect, it } from "vitest";
import { isJourneyPlaceholder, JOURNEY_PLACEHOLDER } from "@/domain/trainer-journey";
import { pageSeeds } from "@/db/seed-data";

// UX pass 11.11 P1 (the Vaiksed board): „Koolitaja teekond“ is hidden on /koolitaja while it holds the seeded note to Maria („… Maria täiendab.“)

describe("isJourneyPlaceholder", () => {
  it("the seeded note in either language, its spaces aside, is the placeholder", () => {
    expect(isJourneyPlaceholder(JOURNEY_PLACEHOLDER.et)).toBe(true);
    expect(isJourneyPlaceholder(`  ${JOURNEY_PLACEHOLDER.ru.replace(/ /g, "\n")} `)).toBe(true);
  });

  it("Maria's own text, or the note with her words added, is not", () => {
    expect(isJourneyPlaceholder("Alustasin kulmumeistrina 2012. aastal.")).toBe(false);
    expect(isJourneyPlaceholder(`${JOURNEY_PLACEHOLDER.et} Alustasin 2012.`)).toBe(false);
    expect(isJourneyPlaceholder("")).toBe(false);
  });

  it("the seed writes that very note", () => {
    expect(pageSeeds.find((p) => p.key === "trainer_journey")?.body).toEqual(JOURNEY_PLACEHOLDER);
  });
});
