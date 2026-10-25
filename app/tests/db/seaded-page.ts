// The Seaded page's db tests (seaded-*-page.test.ts): which section of the page (admin UX pass piece 3b, Task 4: Kontakt, Uudiskiri, Maksmine,
// Tunnistus, Lepingud ja tingimused, Halduse ligipääs; SettingsEditor.tsx) a marker of the rendered HTML is in.

/** The id of the section (`data-seaded-section`) that holds the first `marker` in `html`, or null without one. Sections are not nested. */
export function sectionOf(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let id: string | null = null;
  for (const m of html.matchAll(/<div id="([^"]+)"[^>]*data-seaded-section=""/g)) {
    if ((m.index ?? 0) > at) break;
    id = m[1];
  }
  return id;
}
