import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Global constraint: only the colour tokens of src/styles/tokens.css. The course components (catalogue, cards, course
// page, buying, galleries) had prototype B's greys as literals (Task 8 / 14 review, Task 16 item 9); they now use the
// tokens, and a literal colour in them fails here. The client account's styles are held to the same rule.

const COURSE_CSS = [
  "src/components/site/CourseActions.module.css",
  "src/components/site/CourseBuy.module.css",
  "src/components/site/CourseCard.module.css",
  "src/components/site/CourseLists.module.css",
  "src/components/site/CourseSummary.module.css",
  "src/components/site/CatalogueFilters.module.css",
  "src/components/site/FormatExplainer.module.css",
  "src/components/site/Recommendations.module.css",
  "src/components/site/Gallery.module.css",
  "src/components/site/PurchaseInterest.module.css",
  "src/app/[locale]/(site)/koolitused/catalogue.module.css",
  "src/app/[locale]/(site)/koolitused/[slug]/course.module.css",
  // the client account (phase 2a)
  "src/components/account/LoginForm.module.css",
  "src/components/account/AccountLoader.module.css",
  "src/components/account/AccountShell.module.css",
  "src/components/account/CoursesTab.module.css",
  "src/components/account/AccountCourseCard.module.css",
  "src/components/account/Skeleton.module.css",
  "src/components/account/PrepaymentInfo.module.css",
  "src/components/account/ChangeRequestDialog.module.css",
  "src/components/account/TermsGate.module.css",
  "src/components/account/EcourseView.module.css",
  "src/components/account/EcoursePage.module.css",
  "src/components/account/FavouritesTab.module.css",
  "src/components/account/DetailsTab.module.css",
  // the lesson's player (phase 3a Task 8)
  "src/components/account/LessonPlayer.module.css",
  // the lesson's page (phase 3a Task 9)
  "src/components/account/LessonPage.module.css",
  // the dashboard's progress (phase 2c)
  "src/components/account/ProgressBar.module.css",
  "src/components/account/ResumeCard.module.css",
  // the student's protocol (phase protocols)
  "src/components/account/AccountPage.module.css",
  "src/components/account/ProtocolPage.module.css",
  "src/components/account/FeedbackForm.module.css",
  // the student's practical work (e-course completion)
  "src/components/account/PracticalPage.module.css",
  "src/components/account/CompletionSteps.module.css",
  // the student's knowledge test (e-course completion, Task 6)
  "src/components/account/TestPage.module.css",
  // the admin's Õpilased and its read-only "view as client" (phase 2a Task 9)
  "src/components/admin/ClientDrawer.module.css",
  "src/components/admin/list-table.module.css",
  "src/app/admin/(panel)/registreerimised/registrations.module.css",
  "src/app/admin/(panel)/opilased/clients.module.css",
  "src/app/admin/(panel)/opilased/[id]/vaade/view.module.css",
  // the admin's Maksed (phase 2b)
  "src/components/admin/PaymentLines.module.css",
  "src/app/admin/(panel)/maksed/payments.module.css",
  // the course day's protocols (phase protocols)
  "src/components/admin/ProtocolScreen.module.css",
  "src/components/admin/FeedbackAnswers.module.css",
  "src/app/admin/(panel)/tagasiside/feedback.module.css",
  "src/app/admin/(panel)/overview.module.css",
  // the course editor's "Moodulid ja õppetunnid" and the lesson drawer (phase 3a Task 5)
  "src/components/admin/LessonsEditor.module.css",
  // Hindamine and the test review (e-course completion)
  "src/app/admin/(panel)/hindamine/assessment.module.css",
  "src/components/admin/TestReview.module.css",
  // the site's modal dialog (the campaign popup and the account's change request)
  "src/components/ui/modal.module.css",
  "src/components/site/CampaignPopup.module.css",
  // the course editor's "Teadmiste test" (e-course completion, Task 3)
  "src/components/admin/TestEditor.module.css",
  // Maria's assessment screen and its photo viewer (phase e-course completion, Task 11)
  "src/components/admin/Assessment.module.css",
  // Seaded → "Tunnistus" (phase 3d, Task 5)
  "src/components/admin/CertificateSettings.module.css",
];

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); // comments aside
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

describe("colour tokens only (item 9)", () => {
  test.each(COURSE_CSS)("%s has no colour literals", (file) => {
    expect(read(file).match(LITERAL) ?? []).toEqual([]);
  });

  test("the course components mix colours from tokens only", () => {
    for (const file of COURSE_CSS)
      for (const [mix] of read(file).matchAll(/color-mix\([^;]*\)/g))
        expect(mix.replace(/var\(--[a-z0-9-]+\)|in srgb|transparent|\d+%|[\s,()]|color-mix/g, ""), `${file}: ${mix}`).toBe("");
  });

  test("the text shades in tokens.css are mixed from palette tokens", () => {
    const tokens = read("src/styles/tokens.css");
    for (const name of ["ink-soft", "muted", "muted-2"]) {
      const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens)?.[1] ?? "";
      expect(value, name).toMatch(/^color-mix\(in srgb, var\(--(ink|rose|fog)\) \d+%, var\(--(ink|rose|fog)\)\)$/);
    }
  });
});
