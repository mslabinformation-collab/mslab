import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UX audit 2 A26: one card-title size and one sub-heading size in the editors and drawers the audit lists (Praktika, Avaleht, Uudiskiri, Uudised, the
// drawers). Each title is ui .h2 (Jost 300 27 px) and each sub-heading ui .h3 (400 20 px); the component's own class keeps only margins and wrapping, no
// font of its own, at any width (the drawers had 28–30 px, 24–26 px on a phone; Praktika 30, Avaleht 26, Uudiskiri's preview and send cards 20).

const src = (path: string): string => readFileSync(join(process.cwd(), "src", path), "utf8");

const cases: { tsx: string; css: string; cls: string; ui: "h2" | "h3"; n: number }[] = [
  { tsx: "components/admin/PracticeEditor.tsx", css: "components/admin/PracticeEditor.module.css", cls: "name", ui: "h2", n: 1 },
  { tsx: "components/admin/HomeEditor.tsx", css: "components/admin/HomeEditor.module.css", cls: "title", ui: "h2", n: 3 },
  { tsx: "components/admin/NewsletterCampaignEditor.tsx", css: "components/admin/CampaignsPanel.module.css", cls: "formTitle", ui: "h2", n: 2 },
  { tsx: "components/admin/NewsletterCampaignEditor.tsx", css: "components/admin/CampaignsPanel.module.css", cls: "cardTitle", ui: "h2", n: 2 },
  { tsx: "components/admin/news/PublishedCard.tsx", css: "components/admin/news/PublishedCard.module.css", cls: "title", ui: "h2", n: 1 },
  { tsx: "app/admin/(panel)/registreerimised/page.tsx", css: "app/admin/(panel)/registreerimised/registrations.module.css", cls: "name", ui: "h2", n: 1 },
  { tsx: "components/admin/SessionForm.tsx", css: "components/admin/SessionForm.module.css", cls: "title", ui: "h2", n: 2 },
  { tsx: "components/admin/DiscountCodeDrawer.tsx", css: "components/admin/DiscountCodeDrawer.module.css", cls: "title", ui: "h2", n: 2 },
  { tsx: "components/admin/DiscountCodeDrawer.tsx", css: "components/admin/DiscountCodeDrawer.module.css", cls: "usesTitle", ui: "h3", n: 1 },
  { tsx: "components/admin/LessonDrawer.tsx", css: "components/admin/LessonsEditor.module.css", cls: "drawerTitle", ui: "h2", n: 1 },
  { tsx: "components/admin/ManualReviewForm.tsx", css: "components/admin/ReviewsPanel.module.css", cls: "drawerTitle", ui: "h2", n: 2 },
];

describe("UX audit 2 A26: one card-title size, one sub-heading size", () => {
  it.each(cases)("$tsx: styles.$cls is ui .$ui ($n×), and $css gives it no font", ({ tsx, css, cls, ui, n }) => {
    const uses = src(tsx)
      .split(/\r?\n/)
      .filter((line) => line.includes(`styles.${cls}}`) && /<h[23]\b|titleClassName=/.test(line));
    expect(uses).toHaveLength(n);
    for (const line of uses) expect(line).toContain(`\${ui.${ui}} \${styles.${cls}}`);
    const rules = [...src(css).matchAll(new RegExp(`(?:^|[\\s,}])\\.${cls}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) expect(body).not.toMatch(/\bfont(-size|-weight|-family)?\s*:|letter-spacing\s*:/);
  });
});
