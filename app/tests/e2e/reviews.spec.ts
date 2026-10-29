import type { Locator, Page } from "@playwright/test";
import { clientEmail, insertEcourseAccess } from "./account";
import { adminReady, signInAsAdmin } from "./admin-login";
import { test } from "./edit-lock";
import { holdLocalLock, HOME_REVIEWS_LOCK, LOCK_WAIT_MS, onLocalDb, removeAdminRows, removeClientRows, REVIEW_FIXTURE_NOTE } from "./fixtures";
import { noOverflow } from "./invoices";
import { insertSentProtocol, runName, storedFeedback, studentContext, studentPage } from "./protocols";
import { expect as plainExpect, submitsForms } from "./test";

// Student reviews end to end (student reviews, Task 6; spec §1–§5): one continuous path on the local server and the local Postgres, one review from the
// student's tick to its withdrawal, as the people in it meet it —
//   1. a signed-in graduate of a contact course answers the feedback form: the tick is off until the recommend answer has words, ticked it asks for the
//      name to show (prefilled „Kati K.“, required), and the answer is stored with a pending review of it, a copy of her words and her name;
//   2. Maria's „Arvustused“ lists it pending („Ootab kinnitust“) on a card with the stars of her score and its proof (the registration's status and
//      the protocol sent), the words are not hers to edit, and „Avalda“ publishes it at once (admin UX pass piece 4c: the UndoBar „Arvustus
//      avaldatud.“, whose „Võta tagasi“ puts it back to waiting; pressed again, it stays): the course page shows it, as written, with the name and the notice;
//   2b. on „Vastused“ (piece 4c, C6) a part of her address finds her answer; its drawer's „Vaata arvustust →“ opens „Arvustused“ at that card, the
//      pill Maria had pressed before (one that hides the card) notwithstanding;
//   3. „Avalehel“ (a switch, no bar) puts it on the home page, with its course as a link;
//   4. the student's course card says „Lubasid oma soovitust avaldada“; „Võta luba tagasi“ deletes the review at once: the course page and the home page no
//      longer show it, and her answers stay with Maria;
//   5. Maria, whose page still shows the review, presses „Peida“ on it: „Seda arvustust enam pole — õpilane võttis loa tagasi.“, and its row goes;
//   6. an e-course graduate answers the same form without the tick: her answer is stored, no review is made, Maria reads the answer, „Lõpetatud {date}“;
//   7. Maria adds a review she received elsewhere („Lisa arvustus +“, a drawer, with its source note): it is published at once and the course page shows
//      it; „Peida“ hides it at once („Arvustus peidetud.“); „Muuda“ is an autosave drawer whose chip says „Salvestatud …“; „Kustuta“ asks nothing
//      („Arvustus kustutatud.“) and „Võta tagasi“ brings it back;
//   8. at 375 px the view and its two drawers do not scroll sideways.
// Nothing is mailed (sample addresses, no Resend). The contact student's registration is on a seed course, in a session of its own that began five days
// ago (the form is open by the course day; no public page lists a session that has begun, and it is deleted by its id); the e-course graduate's course is
// the test's own and unpublished.
//
// It writes published and featured reviews, which the course page and the home page show, so it is one of the edit specs (playwright.config.ts EDITS:
// after every other test, desktop only, and in the production build one test at a time: edit-lock.ts). Under `next dev` the edit specs run side by side:
// reviews-public.spec.ts counts what the home section shows, so the part of this path that features a review takes the home page's turn
// (HOME_REVIEWS_LOCK, as that spec's home tests do). Its rows are found by the ids it stored and deleted by them (the reviews first), then the test
// addresses' rows by address; global-setup and global-teardown sweep what an interrupted run left (the manual review by its source note).

// (The path crosses a dozen pages and routes the dev server compiles on first use, beside the other edit specs: 15 s for an expectation, not the default 5.)
const expect = plainExpect.configure({ timeout: 15_000 });

const localDb = <T>(work: Parameters<typeof onLocalDb<T>>[0]): Promise<T> => onLocalDb(work, { marksPages: false });

/** The seed course the contact student is registered on, and its address. Reviews-public.spec.ts uses other seed courses, so the two never count each other's reviews. */
const COURSE = "kulmumeistri-baaskoolitus";
const COURSE_PAGE = `/koolitused/${COURSE}`;

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
/** The rows this test made, by id (and the addresses of its students), for the clean-up. */
const mine: { reviews: number[]; registrations: number[]; sessions: number[]; emails: string[] } = { reviews: [], registrations: [], sessions: [], emails: [] };

test.afterEach(async () => {
  try {
    // exactly the ids the test noted: the reviews first, then the registrations (the answers go with them), then their session, then the addresses' own rows
    await localDb(async (sql) => {
      if (mine.reviews.length) await sql`delete from reviews where id in ${sql(mine.reviews)}`;
      if (mine.registrations.length) await sql`delete from registrations where id in ${sql(mine.registrations)}`;
      if (mine.sessions.length) await sql`delete from course_sessions where id in ${sql(mine.sessions)}`;
    });
    for (const email of mine.emails) expect(await removeClientRows(email), `rows of ${email} left`).toBe(0);
    await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  } finally {
    mine.reviews = [];
    mine.registrations = [];
    mine.sessions = [];
    mine.emails = [];
    created.tokens.clear();
    created.sessions.clear();
  }
});

/**
 * A confirmed group registration on the seed contact course `slug`, in a session of its own that began five days ago (so the course card is a contact
 * course's, and the feedback form is open), whose protocol Maria has sent (the proof Maria reads). The rows are noted by id for the clean-up.
 */
async function registeredStudent(slug: string, email: string, name: string): Promise<{ registrationId: number; courseId: number; sessionId: number }> {
  await removeClientRows(email);
  mine.emails.push(email);
  const row = await localDb(async (sql) => {
    const [course] = await sql<{ id: number }[]>`select id from courses where slug = ${slug} and type = 'contact' and published`;
    if (!course) throw new Error(`e2e fixtures: no published contact course ${slug} — is the local DB seeded?`);
    const [session] = await sql<{ id: number }[]>`
      insert into course_sessions (course_id, starts_at, city, venue, capacity)
      values (${course.id}, (date_trunc('day', now() at time zone 'Europe/Tallinn') + make_interval(days => -5, hours => 10)) at time zone 'Europe/Tallinn', 'Pärnu', 'MS LAB stuudio', 6)
      returning id`;
    const [r] = await sql<{ id: number }[]>`
      insert into registrations (course_id, course_session_id, kind, name, email, phone, payment_choice, status, paid_cents)
      values (${course.id}, ${session.id}, 'group', ${name}, ${email}, '+372 5555 0101', 'full', 'confirmed', 35000)
      returning id`;
    return { registrationId: r.id, courseId: course.id, sessionId: session.id };
  });
  mine.registrations.push(row.registrationId);
  mine.sessions.push(row.sessionId);
  await insertSentProtocol(row.registrationId, ["Ühtlane joon."], "Tubli töö!");
  return row;
}

type StoredReview = { id: number; kind: string; status: string; featured: boolean; name: string; text: string; locale: string; decided: boolean; courseId: number };

/** A review as stored, by its id (the manual one's text, status and mark of „Kustuta“). */
const storedReview = (id: number) =>
  localDb(async (sql) => (await sql<{ status: string; text: string; removed: boolean }[]>`select status, text, removed_at is not null as removed from reviews where id = ${id}`)[0] ?? null);

/** The reviews of one feedback answer as stored (a student's has at most one). */
const reviewsOfFeedback = (feedbackId: number) =>
  localDb((sql) => sql<StoredReview[]>`select id, kind, status, featured, name, text, locale, decided_at is not null as decided, course_id as "courseId" from reviews where feedback_id = ${feedbackId}`);

/** Whether a public page shows a review by its words and its name. */
async function shows(page: Page, path: string, ...words: string[]): Promise<boolean> {
  await page.goto(path);
  const text = await page.locator("body").innerText();
  return words.every((w) => text.includes(w));
}

/** The tick of the feedback form and the name it shows. */
const consent = (form: Locator) => ({ tick: form.locator("[data-consent-tick]"), name: form.locator("[data-consent-name]"), error: form.locator("[data-consent-error]") });

test("a review from the student's tick to her withdrawal: answered with her permission, published and featured by Maria, taken back; an e-course graduate answers without the tick; Maria adds one of her own", async ({ page, context, visitorIp, browser }, info) => {
  submitsForms();
  test.skip(info.project.name.startsWith("mobile"), "one path on the desktop project (the public blocks' widths are reviews-public.spec.ts)");
  info.setTimeout(info.timeout + 240_000);

  const WORDS = "E2E Soovitan seda koolitust kõigile, kes tahavad kulme õppida.";
  const SHOWN = "E2E Kati K.";
  const MANUAL_NAME = "E2E Liis L.";
  const MANUAL_WORDS = "E2E Paberil vormil: väga hea koolitus, soovitan!";

  const kati = await registeredStudent(COURSE, clientEmail("reviews-contact", runName(info)), "Kati Kask");
  const visitor = await (await studentContext(browser, visitorIp, "visitor")).newPage(); // a visitor of the public site, with no account
  const student = await studentPage(browser, clientEmail("reviews-contact", runName(info)), visitorIp);
  const s = student.page;
  let reviewId = 0;

  // ---------- 1. the student answers, with the tick ----------
  await test.step("1. the graduate's form: the tick, the name it shows, and the answer stored with a pending review", async () => {
    const card = s.locator(`[data-feedback-card="registration-${kati.registrationId}"]`);
    await expect(card).toContainText("Kuidas koolitus läks?");
    await card.locator("[data-feedback-open]").click();
    await expect(s).toHaveURL(new RegExp(`/konto/tagasiside#id=${kati.registrationId}$`));
    const form = s.locator("[data-feedback-form]");
    await expect(form.locator("h1")).toHaveText("Sinu kogemus MS LAB koolitusel");
    const { tick, name, error } = consent(form);
    // the permission sits under the recommend question, with the spec's words, and is off until that answer has words
    await expect(form.getByText("Luban seda vastust avaldada MS LAB kodulehel — selle koolituse lehel ja avalehel.")).toBeVisible();
    await expect(tick).toBeDisabled();
    await expect(tick).not.toBeChecked();
    await form.locator('[data-question="score"] input[value="9"]').check();
    await form.locator('[data-question="recommend"] textarea').fill(WORDS);
    await expect(tick).toBeEnabled();
    await tick.check();
    // ticked, it asks for the name to show, prefilled with her first name and the initial of her last
    await expect(form.getByLabel("Nimi, mida näidatakse")).toBeVisible();
    await expect(name).toHaveValue("Kati K.");
    // no name, no send: the form says so and nothing is stored
    await name.fill("");
    await form.locator("[data-feedback-submit]").click();
    await expect(error).toHaveText("Kirjuta nimi, mida näidata (kuni 40 tähemärki).");
    await expect(name).toBeFocused();
    expect(await storedFeedback(kati.registrationId)).toBeNull();
    // the name she chooses is the one shown
    await name.fill(SHOWN);
    await form.locator("[data-feedback-submit]").click();
    await expect(s.locator('[data-feedback-done="done"]')).toContainText("Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust.");

    const feedback = (await storedFeedback(kati.registrationId))!;
    expect(feedback).toMatchObject({ answers: { score: 9, recommend: WORDS }, locale: "et", submitted: true, dismissed: false });
    const made = await reviewsOfFeedback(feedback.id);
    // a copy of her words and her name, waiting for Maria; the course is the one she took
    expect(made).toEqual([{ id: made[0]?.id, kind: "student", status: "pending", featured: false, name: SHOWN, text: WORDS, locale: "et", decided: false, courseId: kati.courseId }]);
    reviewId = made[0].id;
    mine.reviews.push(reviewId);
    // nothing is public before Maria's decision
    expect(await shows(visitor, COURSE_PAGE, WORDS)).toBe(false);
  });

  // ---------- 2. Maria publishes it ----------
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/tagasiside?vaade=arvustused");
  await adminReady(page);
  const row = page.locator(`[data-review="${reviewId}"]`);
  const bar = page.locator("[data-undo-bar]");
  await test.step("2. „Arvustused“ lists it pending on a card with its stars and proof; „Avalda“ at once, „Võta tagasi“, „Avalda“ again: on the course page", async () => {
    await expect(page.locator('nav[aria-label="Olek"] a').first()).toContainText(/^Ootab kinnitust\s*\d+$/); // (the pills with their counts)
    await expect(row).toHaveAttribute("id", `arvustus-${reviewId}`);
    await expect(row).toHaveAttribute("data-review-status", "pending");
    await expect(row).toHaveAttribute("data-review-kind", "student");
    await expect(row.locator("[data-review-tag]")).toHaveText("Ootab kinnitust");
    await expect(row.locator("[data-review-stars]")).toHaveText("★★★★★"); // her „Hinne“ 9
    await expect(row.locator("[data-review-who]")).toContainText(SHOWN);
    await expect(row.locator("[data-review-text]")).toHaveText(WORDS);
    await expect(row.locator("[data-review-proof]")).toHaveText("Registreering: Kinnitatud · Protokoll saadetud"); // what she judges the writer by
    await expect(row.locator("[data-review-edit], [data-review-delete]")).toHaveCount(0); // a student's words are not hers to change
    const stored = async () => (await reviewsOfFeedback((await storedFeedback(kati.registrationId))!.id))[0];
    await row.locator("[data-review-publish]").click();
    await expect(row).toHaveAttribute("data-review-status", "published");
    await expect(bar).toContainText("Arvustus avaldatud.");
    await expect(row).toBeFocused(); // D5: the focus stays on the card
    // „Võta tagasi“: waiting again, as before the press
    await bar.getByRole("button", { name: "Võta tagasi" }).click();
    await expect(row).toHaveAttribute("data-review-status", "pending");
    await expect(bar).toHaveCount(0);
    expect(await stored()).toMatchObject({ status: "pending", decided: false });
    // and published for good, from the menu badge's address (?olek=ootel): the card leaves the list and the focus lands on what is left — the next
    // waiting card, or with none (Task 2 review I-2) the empty list's words — never on the page
    await page.goto("/admin/tagasiside?vaade=arvustused&olek=ootel");
    await adminReady(page);
    const waiting = page.locator("[data-review-list] [data-review]");
    const others = (await waiting.count()) - 1;
    await row.locator("[data-review-publish]").click();
    await expect(row).toHaveCount(0);
    await expect(bar).toContainText("Arvustus avaldatud.");
    if (others === 0) await expect(page.locator("[data-reviews-empty]")).toBeFocused();
    else await expect(page.locator("[data-review-list] [data-review]:focus")).toHaveCount(1);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    expect(await stored()).toMatchObject({ status: "published", featured: false, name: SHOWN, text: WORDS, decided: true });
    // back on the view of all for what follows
    await page.goto("/admin/tagasiside?vaade=arvustused");
    await adminReady(page);
    await expect(row.locator("[data-review-tag]")).toHaveText("Avaldatud");

    await visitor.goto(COURSE_PAGE);
    const block = visitor.locator('[data-reviews="course"]');
    await expect(block.getByRole("heading", { level: 2, name: "Õpilaste tagasiside" })).toBeVisible();
    await expect(block.locator("[data-review]")).toHaveCount(1);
    await expect(block.locator("blockquote")).toHaveText(WORDS); // as she wrote it
    await expect(block.locator("figcaption")).toContainText(SHOWN);
    await expect(block.locator("[data-reviews-notice]")).toHaveText("Tagasiside on MS LAB-i koolituse läbinud õpilastelt. Avaldame selle õpilase loal ja pärast kontrolli.");
    // not on the home page yet: „Avalehel“ is Maria's second press
    expect(await shows(visitor, "/", WORDS)).toBe(false);
  });

  // ---------- 2b. from her answer to the card ----------
  await test.step("2b. „Vastused“: a part of her address finds the answer; „Vaata arvustust →“ opens Arvustused at its card, whichever pill was pressed before", async () => {
    const feedbackId = (await storedFeedback(kati.registrationId))!.id;
    // Maria had been looking at „Peidetud“: that pill hides this published card, and the link must not carry it
    await page.goto("/admin/tagasiside?vaade=arvustused&olek=peidetud");
    await adminReady(page);
    await expect(row).toHaveCount(0);
    await page.getByRole("navigation", { name: "Vaade" }).getByRole("link", { name: "Vastused" }).click();
    const search = page.getByRole("searchbox", { name: "Otsi nime või e-posti järgi" });
    await expect(search).toBeVisible();
    // (the part of the address that is hers alone: the run's name, so no other answer of the local database is found with it)
    await search.fill(clientEmail("reviews-contact", runName(info)).split("@")[0]);
    await expect(page).toHaveURL(/[?&]otsi=/);
    const answer = page.locator("[data-feedback-row]");
    await expect(answer).toHaveCount(1);
    await expect(answer).toHaveAttribute("data-feedback-row", String(feedbackId));
    await answer.getByRole("link", { name: "Kati Kask" }).click();
    const detail = page.locator(`[data-feedback-detail="${feedbackId}"]`);
    await expect(detail).toBeVisible();
    await detail.getByRole("link", { name: "Vaata arvustust →" }).click();
    // the address is Arvustused of every status, at the card: no ?olek=, and the card is on the screen
    await expect(page).toHaveURL(new RegExp(`/admin/tagasiside\\?vaade=arvustused#arvustus-${reviewId}$`));
    await adminReady(page);
    await expect(row).toHaveAttribute("data-review-status", "published");
    await expect(row).toBeInViewport();
  });

  // ---------- 3. „Avalehel“ ----------
  // (the home section shows whatever review is featured: from here to the withdrawal this test has the home page's turn)
  info.setTimeout(info.timeout + LOCK_WAIT_MS);
  const giveBackHome = await holdLocalLock(HOME_REVIEWS_LOCK, LOCK_WAIT_MS);
  try {
    await test.step("3. „Avalehel“ (a switch, no bar) puts it on the home page, with its course as a link", async () => {
      const featured = row.locator("[data-review-featured-toggle]");
      await expect(featured).toHaveAttribute("role", "switch");
      await expect(featured).not.toBeChecked();
      await featured.click();
      await expect(row).toHaveAttribute("data-review-featured", "true");
      await expect(featured).toBeChecked();
      await visitor.goto("/");
      const section = visitor.locator('[data-reviews="home"]');
      await expect(section.getByRole("heading", { level: 2, name: "Õpilaste kogemused" })).toBeVisible();
      const card = section.locator("[data-review]").filter({ hasText: WORDS });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(SHOWN);
      await expect(card.getByRole("link")).toHaveAttribute("href", COURSE_PAGE);
      await expect(section.locator("[data-reviews-notice]")).toBeVisible();
    });

    // ---------- 4. the student takes her permission back ----------
    await test.step("4. her course card says so, „Võta luba tagasi“ deletes the review, and neither page shows it", async () => {
      await s.goto("/konto");
      const card = s.locator(`[data-card="registration-${kati.registrationId}"]`);
      await expect(card).toBeVisible();
      await expect(s.locator("[data-feedback-card]")).toHaveCount(0); // (answered: no card asks again)
      const line = card.locator("[data-card-review]");
      await expect(line).toContainText("Lubasid oma soovitust avaldada");
      await expect(line).not.toContainText(/Avaldatud|Ootab kinnitust|Peidetud/); // she is not told what Maria did with it
      await line.getByRole("button", { name: /^Võta luba tagasi/ }).click();
      await expect(card.locator("[data-card-review]")).toHaveCount(0);
      await expect(card.getByRole("heading")).toBeFocused(); // the button she pressed is gone: the card's heading takes the focus
      // the review is deleted at once, whatever its status; her answers stay with Maria
      expect(await reviewsOfFeedback((await storedFeedback(kati.registrationId))!.id)).toEqual([]);
      expect(await storedFeedback(kati.registrationId)).toMatchObject({ answers: { score: 9, recommend: WORDS }, submitted: true });
      // and the line does not come back
      await s.reload();
      await expect(card).toBeVisible();
      await expect(card.locator("[data-card-review]")).toHaveCount(0);
      // neither page shows it any more: the very next request
      await visitor.goto(COURSE_PAGE);
      await expect(visitor.locator("[data-reviews]")).toHaveCount(0);
      expect(await shows(visitor, COURSE_PAGE, WORDS)).toBe(false);
      expect(await shows(visitor, "/", WORDS)).toBe(false);
    });
  } finally {
    await giveBackHome();
  }

  // ---------- 5. Maria's press on the withdrawn review ----------
  await test.step("5. Maria's page still shows it; her press says the review is gone, in words, and the row goes", async () => {
    await expect(row).toHaveAttribute("data-review-status", "published"); // (her page was not loaded again)
    await row.locator("[data-review-hide]").click();
    await expect(page.locator("[data-reviews-status]")).toHaveText("Seda arvustust enam pole — õpilane võttis loa tagasi.");
    await expect(row).toHaveCount(0);
    mine.reviews = mine.reviews.filter((id) => id !== reviewId); // (nothing is left of it to delete)
    expect(await localDb((sql) => sql`select 1 from reviews where id = ${reviewId}`)).toHaveLength(0);
    // and the list, loaded again, does not have it
    await page.goto("/admin/tagasiside?vaade=arvustused");
    await adminReady(page);
    await expect(page.locator(`[data-review="${reviewId}"]`)).toHaveCount(0);
  });
  await student.close();

  // ---------- 6. an e-course graduate answers, without the tick ----------
  await test.step("6. an e-course graduate answers the same form without the tick: the answer is stored, no review is made, and Maria reads it", async () => {
    const email = clientEmail("reviews-ecourse", runName(info));
    await removeClientRows(email);
    mine.emails.push(email);
    const ecourse = await insertEcourseAccess(email, { own: true, name: "Mari Maasikas" });
    const [access] = await localDb((sql) => sql<{ id: number }[]>`update course_access set completed_at = now() where client_id = ${ecourse.clientId} returning id`);
    const graduate = await studentPage(browser, email, visitorIp);
    const g = graduate.page;
    const card = g.locator(`[data-feedback-card="course-${ecourse.slug}"]`);
    await expect(card).toContainText("Kuidas koolitus läks?");
    await card.locator("[data-feedback-open]").click();
    await expect(g).toHaveURL(new RegExp(`/konto/tagasiside#kursus=${ecourse.slug}$`));
    const form = g.locator("[data-feedback-form]");
    await expect(form.locator("h1")).toHaveText("Sinu kogemus MS LAB koolitusel");
    const { tick } = consent(form);
    await expect(tick).toBeDisabled();
    await form.locator('[data-question="score"] input[value="10"]').check();
    await form.locator('[data-question="recommend"] textarea').fill("E2E Soovitan, e-kursus oli selge.");
    await expect(tick).toBeEnabled();
    await expect(tick).not.toBeChecked(); // (the permission is hers to give: it is never on by itself)
    await form.locator("[data-feedback-submit]").click();
    await expect(g.locator('[data-feedback-done="done"]')).toBeVisible();
    const answer = await localDb((sql) => sql<{ id: number; answers: Record<string, unknown> }[]>`select id, answers from course_feedback where access_id = ${access.id}`);
    expect(answer).toHaveLength(1);
    expect(answer[0].answers).toMatchObject({ score: 10, recommend: "E2E Soovitan, e-kursus oli selge." });
    expect(await reviewsOfFeedback(answer[0].id)).toEqual([]); // no tick, no review
    // her card has no permission line, since there is nothing to take back
    await g.goto("/konto");
    await expect(g.locator("[data-account-dashboard]")).toBeVisible();
    await expect(g.locator("[data-card-review]")).toHaveCount(0);
    await graduate.close();
    // Maria reads the answer on „Tagasiside“: the e-course, „Lõpetatud {date}“; it has no entry in „Arvustused“
    await page.goto("/admin/tagasiside");
    await adminReady(page);
    const listed = page.locator(`[data-feedback-row="${answer[0].id}"]`);
    await expect(listed).toContainText("E2E e-koolitus");
    await expect(listed).toContainText("Lõpetatud");
    await expect(listed).toContainText("10/10");
    await page.goto("/admin/tagasiside?vaade=arvustused");
    await adminReady(page);
    await expect(page.locator("[data-review-text]").filter({ hasText: "E2E Soovitan, e-kursus oli selge." })).toHaveCount(0);
  });

  // ---------- 7. Maria adds a review she received elsewhere ----------
  const EDITED_WORDS = "E2E Paberil vormil: väga hea koolitus, soovitan kõigile!";
  let manualId = 0;
  await test.step("7. „Lisa arvustus +“ opens the drawer; „Lisa arvustus“ with its source note: published at once, and the course page shows it", async () => {
    const add = page.locator("[data-review-add]");
    await expect(add).toHaveText("Lisa arvustus +");
    await add.click();
    const form = page.locator('dialog[data-drawer] [data-review-form="new"]');
    await expect(form.locator("h2")).toHaveText("Uus arvustus");
    await expect(form).toContainText("Lisa ainult päris õpilase sõnad tema loal.");
    await expect(form.locator("[data-new-review-line]")).toHaveText("Täida kohustuslikud väljad");
    await form.locator('[data-review-field="courseId"]').selectOption({ value: String(kati.courseId) });
    await form.locator('[data-review-field="name"]').fill(MANUAL_NAME);
    await form.locator('[data-review-field="text"]').fill(MANUAL_WORDS);
    await expect(form.getByLabel("Kust see pärit on?")).toBeVisible();
    await form.locator('[data-review-field="note"]').fill(REVIEW_FIXTURE_NOTE);
    await expect(form.locator("[data-new-review-line]")).toHaveText("Vajuta „Lisa arvustus“.");
    await form.locator("[data-review-create]").click();
    // R-c: the drawer closes with no result line, the focus back on „Lisa arvustus +“
    await expect(page.locator("dialog[data-drawer]")).toHaveCount(0);
    await expect(add).toBeFocused();
    // by its name (the new row's id is learned from the database, and noted for the clean-up)
    const [manual] = await localDb((sql) => sql<{ id: number; kind: string; status: string; featured: boolean }[]>`select id, kind, status, featured from reviews where name = ${MANUAL_NAME} and note = ${REVIEW_FIXTURE_NOTE}`);
    expect(manual).toMatchObject({ kind: "manual", status: "published", featured: false });
    mine.reviews.push(manual.id);
    manualId = manual.id;
    const added = page.locator(`[data-review="${manual.id}"]`);
    await expect(added).toHaveAttribute("data-review-status", "published");
    await expect(added.locator("[data-review-manual]")).toHaveText("Lisatud käsitsi");
    await expect(added.locator("[data-review-note]")).toHaveText(`Allikas: ${REVIEW_FIXTURE_NOTE}`);
    await expect(added.locator("[data-review-stars]")).toHaveCount(0); // (no score)
    await visitor.goto(COURSE_PAGE);
    const block = visitor.locator('[data-reviews="course"]');
    await expect(block.locator("[data-review]")).toHaveCount(1);
    await expect(block.locator("blockquote")).toHaveText(MANUAL_WORDS);
    await expect(block.locator("figcaption")).toContainText(MANUAL_NAME);
    await expect(block).not.toContainText(REVIEW_FIXTURE_NOTE); // the note is Maria's only
  });

  await test.step("7b. „Peida“ hides it at once („Arvustus peidetud.“) and the course page no longer shows it; „Avalda“ shows it again", async () => {
    const added = page.locator(`[data-review="${manualId}"]`);
    await added.locator("[data-review-hide]").click();
    await expect(added).toHaveAttribute("data-review-status", "hidden");
    await expect(bar).toContainText("Arvustus peidetud.");
    expect(await storedReview(manualId)).toMatchObject({ status: "hidden" });
    expect(await shows(visitor, COURSE_PAGE, MANUAL_WORDS)).toBe(false);
    await added.locator("[data-review-publish]").click();
    await expect(added).toHaveAttribute("data-review-status", "published");
    await expect(bar).toContainText("Arvustus avaldatud.");
  });

  await test.step("7c. „Muuda“ is an autosave drawer: the text typed is saved, its chip says „Salvestatud …“, and the card shows it", async () => {
    const added = page.locator(`[data-review="${manualId}"]`);
    await added.locator("[data-review-edit]").click();
    const form = page.locator(`dialog[data-drawer] [data-review-form="${manualId}"]`);
    await expect(form.locator("h2")).toHaveText("Muuda arvustust");
    const text = form.locator('[data-review-field="text"]');
    await expect(text).toHaveValue(MANUAL_WORDS);
    await text.fill(EDITED_WORDS);
    await expect(form.locator("[data-review-head] [data-save-status]")).toContainText(/Salvestatud \d{2}:\d{2}/, { timeout: 30_000 });
    expect(await storedReview(manualId)).toMatchObject({ text: EDITED_WORDS, status: "published" });
    await page.locator("dialog[data-drawer]").getByRole("button", { name: "Sulge" }).click();
    await expect(page.locator("dialog[data-drawer]")).toHaveCount(0);
    await expect(added.locator("[data-review-text]")).toHaveText(EDITED_WORDS);
    await expect(added.locator("[data-review-edit]")).toBeFocused();
  });

  await test.step("7d. „Kustuta“ asks nothing: the card goes („Arvustus kustutatud.“), and „Võta tagasi“ brings it back", async () => {
    const added = page.locator(`[data-review="${manualId}"]`);
    await added.locator("[data-review-delete]").click();
    await expect(added).toHaveCount(0);
    await expect(bar).toContainText("Arvustus kustutatud.");
    expect(await storedReview(manualId)).toMatchObject({ removed: true });
    expect(await shows(visitor, COURSE_PAGE, EDITED_WORDS)).toBe(false);
    await bar.getByRole("button", { name: "Võta tagasi" }).click();
    await expect(added).toHaveAttribute("data-review-status", "published");
    expect(await storedReview(manualId)).toMatchObject({ removed: false, status: "published", text: EDITED_WORDS });
    expect(await shows(visitor, COURSE_PAGE, EDITED_WORDS)).toBe(true);
  });
  await visitor.context().close();

  await test.step("8. at 375 px the view and its drawers do not scroll sideways", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/tagasiside?vaade=arvustused");
    await adminReady(page);
    await expect(page.locator(`[data-review="${manualId}"]`)).toBeVisible();
    expect(await noOverflow(page), "the cards").toBe(true);
    await page.goto(`/admin/tagasiside?vaade=arvustused&id=${manualId}`);
    await expect(page.locator(`dialog[data-drawer] [data-review-form="${manualId}"]`)).toBeVisible();
    expect(await noOverflow(page), "„Muuda“").toBe(true);
    await page.goto("/admin/tagasiside?vaade=arvustused&id=uus");
    await expect(page.locator('dialog[data-drawer] [data-review-form="new"]')).toBeVisible();
    expect(await noOverflow(page), "„Lisa arvustus +“").toBe(true);
  });
});
