import type { Page } from "@playwright/test";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { removeAdminRows, removeClientRows } from "./fixtures";
import { E2E_HEADINGS, editor, insertProtocolFixtures, keptKeys, note, runName, saved, saveStatus, storedProtocol } from "./protocols";
import { submitsForms, test, expect } from "./test";

// Phase protocols, the autosave in a real browser (spec §4, §10; Task 5's review). protocol-autosave.test.ts runs the engine against a stand-in;
// these run the screen against the real server and a real Chromium:
// - no network: the words typed stay in this browser, the status says so, and once the network is back the server has the newest text; a reload
//   while offline cannot load the page at all, so the reload is made once the network is back and the text resumes from this browser's copy;
// - Back: leaving the screen for Kalender and coming back with the browser's Back button;
// - the server's refusals on POST /api/admin/protokoll (413, 400 body / text / tooLong), real ones: the screen's own request is sent on to the
//   server with a body that earns the refusal, and its answer is handed to the page as it came;
// - a box over 10 000 characters (nothing is sent), and the route's answers asked for directly.
// Every student is a sample address (`e2e-client-proto-…@example.test`, never mailed); all of it is removed after each test.

const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
const SAVE = "**/api/admin/protokoll";

test.beforeEach(() => {
  submitsForms();
  test.setTimeout(180_000);
});
test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

async function fixtures(...args: Parameters<typeof insertProtocolFixtures>) {
  const fx = await insertProtocolFixtures(...args);
  for (const s of fx.students) made.add(s.email);
  return fx;
}

const emptyNotes = (n: number) => Array.from({ length: n }, () => expect.objectContaining({ note: "" }));
/** The first box's text in every copy this browser keeps of a protocol (one per tab; this test has one). */
const keptTexts = (page: Page, id: number) =>
  page.evaluate(
    (n) =>
      Object.entries(localStorage)
        .filter(([k]) => k.startsWith(`mslab-protocol:${n}`))
        .map(([, v]) => (JSON.parse(v) as { content: { notes: string[] } }).content.notes[0]),
    id,
  );

test("no network: the typed words stay in this browser and the status says so; back online, the server has the newest text", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("offline", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/protokollid?sessioon=${fx.session.id}`);
  await adminReady(page);
  await context.setOffline(true);
  await note(page, mari.id, 0).fill("Ühendus katkes.");
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "retrying", { timeout: 20_000 });
  await expect(saveStatus(page, mari.id)).toHaveText("Salvestamata — proovin uuesti");
  await note(page, mari.id, 0).fill("Ühendus katkes. Kirjutan edasi.");
  expect(await keptTexts(page, mari.id)).toEqual(["Ühendus katkes. Kirjutan edasi."]); // the newest words are in this browser
  expect(await storedProtocol(mari.id)).toBeNull(); // and nothing reached the server
  await context.setOffline(false); // the "online" event: the autosave tries at once
  await saved(page, mari.id);
  await expect(editor(page, mari.id).locator("[data-conflict]")).toHaveCount(0);
  await expect(note(page, mari.id, 0)).toHaveValue("Ühendus katkes. Kirjutan edasi.");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, stages: [{ note: "Ühendus katkes. Kirjutan edasi." }, ...emptyNotes(2)] });
  expect(await keptKeys(page, mari.id)).toEqual([]); // the browser's copy is gone once confirmed
});

test("a reload while offline cannot load the page; once online the text resumes from this browser's copy and is stored", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("reload", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  const url = `/admin/protokollid?sessioon=${fx.session.id}`;
  await signInAsAdmin(page, context, visitorIp, created);
  page.on("dialog", (dialog) => void dialog.accept()); // "leave the page?" while a text is not confirmed: yes
  await page.goto(url);
  await adminReady(page);
  await note(page, mari.id, 0).fill("Esimene.");
  await saved(page, mari.id);
  await context.setOffline(true);
  await note(page, mari.id, 0).fill("Esimene. Teine, ilma ühenduseta.");
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "retrying", { timeout: 20_000 });
  const reloadedOffline = await page.reload().then(
    () => true,
    () => false,
  );
  info.annotations.push({ type: "reload while offline", description: reloadedOffline ? "the page loaded (served without the network)" : "the reload failed (no network): the page is gone until it is back" });
  await context.setOffline(false);
  await page.goto(url);
  await adminReady(page);
  // the words typed offline come back from this browser, and are saved
  await expect(note(page, mari.id, 0)).toHaveValue("Esimene. Teine, ilma ühenduseta.");
  await saved(page, mari.id);
  await expect(editor(page, mari.id).locator("[data-conflict]")).toHaveCount(0);
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, stages: [{ note: "Esimene. Teine, ilma ühenduseta." }, ...emptyNotes(2)] });
  expect(await keptKeys(page, mari.id)).toEqual([]);
});

/**
 * Back (Task 5's review): the screen is left for Kalender (a link: the client router) and the browser's Back button comes back to it. Next restores the
 * screen from the client router's copy of the page, the server render of the visit, which is older than what was saved since. What this pins:
 * - always: typing into the restored screen gives the conflict notice, with the stored text on the screen and the words typed in the notice,
 *   and the server keeps the newer text (a stale screen never overwrites);
 * - the finding (below, expected to fail): the restored screen shows the old text as "saved".
 */
async function backToStaleScreen(page: Page, sessionId: number, id: number) {
  await page.goto(`/admin/protokollid?sessioon=${sessionId}`);
  await adminReady(page);
  await note(page, id, 0).fill("Esimene.");
  await saved(page, id);
  await page.reload(); // this visit's server render holds the first text (version 1)
  await adminReady(page);
  await expect(note(page, id, 0)).toHaveValue("Esimene.");
  await note(page, id, 0).fill("Teine.");
  await saved(page, id);
  expect((await storedProtocol(id))!.stages[0].note).toBe("Teine."); // stored: the second text (version 2)
  await page.getByRole("link", { name: "Kalendrisse" }).click();
  await expect(page).toHaveURL(/\/admin\/kalender/);
  await adminReady(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/protokollid/);
  await expect(editor(page, id)).toBeVisible();
}

test("Back from Kalender: typing into the restored screen gives the conflict notice, and the newer stored text is never overwritten", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("back", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await backToStaleScreen(page, fx.session.id, mari.id);
  const shown = { value: await note(page, mari.id, 0).inputValue(), status: await saveStatus(page, mari.id).getAttribute("data-save-status"), text: await saveStatus(page, mari.id).textContent() };
  info.annotations.push({ type: "the screen after Back", description: JSON.stringify(shown) }); // the evidence of the finding below
  await note(page, mari.id, 0).fill("Kolmas.");
  await expect(editor(page, mari.id).locator("[data-conflict]")).toBeVisible({ timeout: 30_000 });
  await expect(note(page, mari.id, 0)).toHaveValue("Teine."); // what is stored is shown …
  await expect(editor(page, mari.id).locator("[data-conflict]")).toContainText("Kolmas."); // … and the words typed are in the notice
  expect((await storedProtocol(mari.id))!.stages[0].note).toBe("Teine."); // never overwritten
});

test("FINDING: Back from Kalender shows the stored text, not the visit's older one, as 'Salvestatud' (expected to fail until the screen asks the server again)", async ({ page, context, visitorIp }, info) => {
  // Next restores the page from the client router's copy of its server render, so the screen is the one the visit began with: "Esimene." and its
  // "Salvestatud HH:MM" while the server holds "Teine.". The conflict notice (above) is what keeps it from doing harm. When the screen reads the
  // server again on its return, this passes: remove the line below.
  test.fail(true, "finding: the restored screen claims 'saved' over an older text");
  const fx = await fixtures("stale", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await backToStaleScreen(page, fx.session.id, mari.id);
  await expect(note(page, mari.id, 0)).toHaveValue("Teine.", { timeout: 5_000 });
});

/** The refusals the route can answer, each with a body that earns it (b: the screen's own body). */
type Body = { registrationId: number; version: number; titles: string[]; notes: string[]; generalNote: string };
const REFUSALS: { name: string; status: number; error: string; body: (b: Body) => string }[] = [
  { name: "413 size (a body over MAX_SAVE_CHARS)", status: 413, error: "size", body: (b) => JSON.stringify({ ...b, generalNote: "x".repeat(700_000) }) },
  { name: "400 body (not a save)", status: 400, error: "body", body: () => "{" },
  { name: "400 text (a character Postgres cannot store)", status: 400, error: "text", body: (b) => JSON.stringify({ ...b, notes: [`${b.notes[0]}\u0000`, ...b.notes.slice(1)] }) },
  { name: "400 tooLong (a box over 10 000 characters)", status: 400, error: "tooLong", body: (b) => JSON.stringify({ ...b, notes: ["x".repeat(10_001), ...b.notes.slice(1)] }) },
];

for (const refusal of REFUSALS) {
  test(`the server's ${refusal.name}: the screen says it is not saved, keeps the words (in the box and in this browser), backs off, and saves them when the server takes them`, async ({ page, context, visitorIp }, info) => {
    const fx = await fixtures(`r${refusal.status}${refusal.error}`, runName(info), ["Mari Maasikas"]);
    const [mari] = fx.students;
    await signInAsAdmin(page, context, visitorIp, created);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/admin/protokollid?sessioon=${fx.session.id}`);
    await adminReady(page);
    // the screen's own request goes to the server with a body that earns the refusal; the server's answer reaches the page as it came
    const answers: { status: number; body: unknown }[] = [];
    await page.route(SAVE, async (route) => {
      const sent = JSON.parse(route.request().postData() ?? "{}") as Body;
      const response = await route.fetch({ postData: refusal.body(sent) });
      answers.push({ status: response.status(), body: await response.json().catch(() => null) });
      await route.fulfill({ response });
    });
    await note(page, mari.id, 0).fill("Sõnad, mis ei lähe kaduma.");
    await expect.poll(() => answers.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(answers[0].status, "the real route's status").toBe(refusal.status);
    expect(answers[0].body).toMatchObject({ ok: false, error: refusal.error });
    await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "retrying");
    await expect(saveStatus(page, mari.id)).toHaveText("Salvestamata — proovin uuesti");
    await expect(note(page, mari.id, 0)).toHaveValue("Sõnad, mis ei lähe kaduma.");
    expect(await keptTexts(page, mari.id)).toEqual(["Sõnad, mis ei lähe kaduma."]);
    expect(await storedProtocol(mari.id)).toBeNull();
    // it backs off (the first retry is 2 s away), it does not ask again and again
    await page.waitForTimeout(1_000);
    expect(answers.length, "the requests in the second after the refusal").toBe(1);
    // the server takes it: the next try (here, leaving the box) stores it
    await page.unroute(SAVE);
    await page.getByRole("heading", { level: 1 }).click();
    await saved(page, mari.id);
    expect(await storedProtocol(mari.id)).toMatchObject({ version: 1, stages: [{ note: "Sõnad, mis ei lähe kaduma." }, ...emptyNotes(2)] });
    expect(await keptKeys(page, mari.id)).toEqual([]);
    expect(errors, "uncaught errors in the page").toEqual([]);
  });
}

test("a box over 10 000 characters is never cut and nothing is sent; shortened, it is saved", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("long", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/protokollid?sessioon=${fx.session.id}`);
  await adminReady(page);
  let sent = 0;
  await page.route(SAVE, async (route) => {
    sent++;
    await route.continue();
  });
  const over = "a".repeat(10_001);
  await note(page, mari.id, 0).fill(over);
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "tooLong");
  await expect(saveStatus(page, mari.id)).toHaveText("Salvestamata — üks tekst on liiga pikk");
  await expect(editor(page, mari.id).locator("[data-note-long]")).toHaveText("Liiga pikk: 10001 / 10000 märki. Lühenda, siis salvestan.");
  await expect(note(page, mari.id, 0)).toHaveValue(over); // nothing is cut
  await page.getByRole("heading", { level: 1 }).click(); // leaving the box tries a save: still nothing goes
  await page.waitForTimeout(2_500);
  expect(sent, "saves sent while a box is over its limit").toBe(0);
  expect(await storedProtocol(mari.id)).toBeNull();
  const exact = "a".repeat(10_000);
  await note(page, mari.id, 0).fill(exact);
  await saved(page, mari.id);
  await expect(editor(page, mari.id).locator("[data-note-long]")).toHaveCount(0);
  expect((await storedProtocol(mari.id))!.stages[0].note).toBe(exact);
});

test("the route's answers, asked for directly: 401 without a session, 403 from another site, 404 for no such registration, 400 for what is not a save, 413 for a body over the limit", async ({ page, context, visitorIp, playwright }, info) => {
  const fx = await fixtures("api", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  const anon = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  const body = { registrationId: mari.id, version: 0, titles: E2E_HEADINGS, notes: ["x", "", ""], generalNote: "" };
  const unsigned = await anon.post("/api/admin/protokoll", { data: body });
  expect(unsigned.status()).toBe(401);
  await anon.dispose();
  await signInAsAdmin(page, context, visitorIp, created);
  const post = (data: unknown, headers: Record<string, string> = {}) => page.request.post("/api/admin/protokoll", { data, headers });
  const foreign = await post(body, { origin: "https://evil.example" });
  expect(foreign.status()).toBe(403);
  expect(await storedProtocol(mari.id)).toBeNull();
  const none = await post({ ...body, registrationId: 2_147_483_647 });
  expect(none.status()).toBe(404);
  expect(await none.json()).toEqual({ ok: false, error: "notFound" });
  const notASave = await post({ registrationId: "1" });
  expect(notASave.status()).toBe(400);
  expect(await notASave.json()).toEqual({ ok: false, error: "body" });
  const rawBody = await page.request.post("/api/admin/protokoll", { headers: { "content-type": "application/json" }, data: "{" });
  expect(rawBody.status()).toBe(400);
  expect(await rawBody.json()).toEqual({ ok: false, error: "body" });
  const text = await post({ ...body, notes: ["a\u0000b", "", ""] });
  expect(text.status()).toBe(400);
  expect(await text.json()).toEqual({ ok: false, error: "text" });
  const tooLong = await post({ ...body, notes: ["x".repeat(10_001), "", ""] });
  expect(tooLong.status()).toBe(400);
  expect(await tooLong.json()).toMatchObject({ ok: false, error: "tooLong" });
  const big = await post({ ...body, generalNote: "x".repeat(700_000) });
  expect(big.status()).toBe(413);
  expect(await big.json()).toEqual({ ok: false, error: "size" });
  expect(await storedProtocol(mari.id), "none of the refusals stored anything").toBeNull();
  // and the same body, right, is taken
  const ok = await post(body);
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, version: 1 });
});

