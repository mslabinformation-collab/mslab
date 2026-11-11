// „Koolitaja teekond“ (page trainer_journey) holds, until Maria writes her story, the seeded note to her (db/seed-data.ts): „Siia tuleb Maria lugu: …
// Maria täiendab.“ A visitor never sees that note: the public /koolitaja hides the block while it shows it (UX pass 11.11 P1). Pure and import-free.

export const JOURNEY_PLACEHOLDER = {
  et: "Siia tuleb Maria lugu: kuidas kulmu- ja ripsmemeistrist sai koolitaja ja mis teda iga päev edasi viib. Maria täiendab.",
  ru: "Здесь будет история Марии: как мастер бровей и ресниц стала преподавателем и что вдохновляет её каждый день. Мария дополнит.",
} as const;

const plain = (text: string) => text.replace(/\s+/g, " ").trim();

/** Is this text (the block's body in the page's language) the seeded note, in either language, its spaces aside? */
export function isJourneyPlaceholder(body: string): boolean {
  const text = plain(body);
  return text === JOURNEY_PLACEHOLDER.et || text === JOURNEY_PLACEHOLDER.ru;
}
