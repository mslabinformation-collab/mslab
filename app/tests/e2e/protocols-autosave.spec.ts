import type { Page } from "@playwright/test";
import { adminReady, signInAsAdmin } from "./admin-login";
import { chip, E2E_HEADINGS, editor, emptyNotes, holdRefresh, insertDraftProtocol, keptKeys, keptTexts, note, protocolRows, runName, saved, SAVE_ROUTE, saveStatus, storedProtocol } from "./protocols";
import { test, expect } from "./test";

// Phase protocols, the autosave in a real browser (spec §4, §10; Task 5's review). protocol-autosave.test.ts runs the engine against a stand-in;
// these run the screen against the real server and a real Chromium:
// - no network: the words typed stay in this browser, the status says so, and once the network is back the server has the newest text; a reload
//   while offline cannot load the page at all, so the reload is made once the network is back and the text resumes from this browser's copy;
// - Back: leaving the screen for Kalender and coming back with the browser's Back button (the screen asks the server again; see backToStaleScreen);
// - the server's refusals on POST /api/admin/protokoll (413, 400 body / text / tooLong), real ones: the screen's own request is sent on to the
//   server with a body that earns the refusal, and its answer is handed to the page as it came;
// - a box over 10 000 characters (nothing is sent), and the route's answers asked for directly.
// Every student is a sample address (`e2e-client-proto-…@example.test`, never mailed); all of it is removed after each test.

const { created, fixtures } = protocolRows();
const SAVE = SAVE_ROUTE;

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
 * Back (Task 5's review; fixed in fix round 1 of Task 11): the screen is left for Kalender (a link: the client router) and the browser's Back button
 * comes back to it. Next restores the screen from the client router's copy of the visit's server render, which is older than what was saved since.
 * The screen reads the server's text again (GET /api/admin/protokoll) and, until that answer is read, says "Kontrollin salvestatud teksti…", never
 * "Salvestatud"; the server's newer text is then taken, silently when nothing was typed here, through the conflict notice when something was; and
 * "Saada" / "Lukusta ja saada kõik" wait for it and never send text the screen has not shown.
 * Here: version 1 "Esimene." is what the visit loaded, version 2 "Teine." is saved, Kalender, Back. `refresh` (holdRefresh) keeps the screen's
 * request for the server's text waiting from the Back on, so the restored screen can be looked at, typed into and pressed before it comes;
 * `beforeBack` runs on the Kalender page, just before the Back.
 */
async function backToStaleScreen(page: Page, sessionId: number, id: number, opts: { refresh?: Awaited<ReturnType<typeof holdRefresh>>; beforeBack?: () => Promise<unknown> } = {}) {
  await page.goto(`/admin/protokollid?sessioon=${sessionId}`);
  await adminReady(page);
  await showStudent(page, id);
  await note(page, id, 0).fill("Esimene.");
  await saved(page, id);
  await page.reload(); // this visit's server render holds the first text (version 1)
  await adminReady(page);
  await showStudent(page, id);
  await expect(note(page, id, 0)).toHaveValue("Esimene.");
  await note(page, id, 0).fill("Teine.");
  await saved(page, id);
  expect((await storedProtocol(id))!.stages[0].note).toBe("Teine."); // stored: the second text (version 2)
  await page.getByRole("link", { name: "Kalendrisse" }).click();
  await expect(page).toHaveURL(/\/admin\/kalender/);
  await adminReady(page);
  opts.refresh?.arm();
  await opts.beforeBack?.();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/protokollid/);
  await showStudent(page, id);
}

/** The student's editor on the screen: with several students the first one is open, so hers is opened by her chip. */
async function showStudent(page: Page, id: number) {
  if ((await chip(page, id).count()) > 0) await chip(page, id).click();
  await expect(editor(page, id)).toBeVisible();
}

/** Records the first box's text and the save status in every frame from now on (the page is one document through the client router's moves). */
const recordFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __frames: [string, string][]; __stopFrames: () => void };
    w.__frames = [];
    let on = true;
    const look = () => {
      if (!on) return;
      const box = document.querySelector<HTMLTextAreaElement>('[data-note="0"]');
      const status = document.querySelector("[data-save-status]");
      if (box && status) w.__frames.push([box.value, status.getAttribute("data-save-status") ?? ""]);
      requestAnimationFrame(look);
    };
    w.__stopFrames = () => void (on = false);
    look();
  });
const stopFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __frames: [string, string][]; __stopFrames: () => void };
    w.__stopFrames();
    return w.__frames;
  });

test("Back from Kalender: the restored screen never says 'Salvestatud' over the older text; it ends showing the stored text, saved at its time", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("stale", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  await backToStaleScreen(page, fx.session.id, mari.id, { beforeBack: () => recordFrames(page) });
  await expect(note(page, mari.id, 0)).toHaveValue("Teine.");
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "saved");
  await expect(saveStatus(page, mari.id)).toHaveText(/^Salvestatud \d\d:\d\d$/);
  const frames = await stopFrames(page);
  info.annotations.push({ type: "frames after Back", description: JSON.stringify([...new Set(frames.map((f) => f.join(" | ")))]) });
  expect(frames.filter(([text, status]) => status === "saved" && text !== "Teine."), "frames that said 'saved' over an older text").toEqual([]);
  expect((await storedProtocol(mari.id))!.stages[0].note).toBe("Teine.");
});

test("Back from Kalender, the server's text not come yet: the old text is shown as 'Kontrollin salvestatud teksti…'; when it comes it replaces it, silently", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("check", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  const refresh = await holdRefresh(page);
  await backToStaleScreen(page, fx.session.id, mari.id, { refresh });
  await expect.poll(() => refresh.held(), { message: "the screen asked the server for its text" }).toBeGreaterThan(0);
  await expect(note(page, mari.id, 0)).toHaveValue("Esimene.");
  await expect(saveStatus(page, mari.id)).toHaveAttribute("data-save-status", "checking");
  await expect(saveStatus(page, mari.id)).toHaveText("Kontrollin salvestatud teksti…");
  refresh.release();
  await expect(note(page, mari.id, 0)).toHaveValue("Teine.");
  await expect(saveStatus(page, mari.id)).toHaveText(/^Salvestatud \d\d:\d\d$/);
  await expect(editor(page, mari.id).locator("[data-conflict]")).toHaveCount(0); // nothing of hers was lost, so nothing is told
  expect((await storedProtocol(mari.id))!.version).toBe(2); // and nothing was saved
});

test("Back from Kalender: words typed on the restored screen before the server's text came go into the conflict notice; the stored text is never overwritten", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("typed", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  const refresh = await holdRefresh(page);
  await backToStaleScreen(page, fx.session.id, mari.id, { refresh });
  await note(page, mari.id, 0).fill("Kolmas.");
  refresh.release();
  await expect(editor(page, mari.id).locator("[data-conflict]")).toBeVisible({ timeout: 30_000 });
  await expect(note(page, mari.id, 0)).toHaveValue("Teine."); // what is stored is shown …
  await expect(editor(page, mari.id).locator("[data-conflict]")).toContainText("Kolmas."); // … and the words typed are in the notice
  expect((await storedProtocol(mari.id))!.stages[0].note).toBe("Teine."); // never overwritten
  expect((await storedProtocol(mari.id))!.version).toBe(2);
});

test("Back from Kalender: 'Saada' on the restored screen sends nothing older; the stored text is shown, and pressed again it sends that", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("send1", runName(info), ["Mari Maasikas"]);
  const [mari] = fx.students;
  await signInAsAdmin(page, context, visitorIp, created);
  const refresh = await holdRefresh(page);
  await backToStaleScreen(page, fx.session.id, mari.id, { refresh });
  await expect.poll(() => refresh.held()).toBeGreaterThan(0);
  const send = editor(page, mari.id).locator('[data-send="first"]');
  await send.click();
  await expect(send).toHaveText("Saadan…"); // waiting for the server's text
  expect((await storedProtocol(mari.id))!.sentAt).toBeNull();
  refresh.release();
  await expect(editor(page, mari.id).locator("[data-send-error]")).toHaveText("Protokolli muudeti vahepeal mujal ja siin on nüüd uus tekst. Vaata see üle ja saada siis.");
  await expect(note(page, mari.id, 0)).toHaveValue("Teine.");
  await expect(send).toHaveText("Saada");
  expect((await storedProtocol(mari.id))!.sentAt, "the older text was not sent").toBeNull();
  await send.click();
  await expect(editor(page, mari.id).locator("[data-locked]")).toBeVisible();
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, sentVersion: 2, sent: { stages: [{ note: "Teine." }, ...emptyNotes(2)] } });
});

test("Back from Kalender: 'Lukusta ja saada kõik' on the restored screen leaves out and names whose text turned out newer, sends the rest, and sends hers when pressed again", async ({ page, context, visitorIp }, info) => {
  const fx = await fixtures("sendall", runName(info), ["Mari Maasikas", "Anu Aas"]);
  const [mari, anu] = fx.students;
  await insertDraftProtocol(anu.id, ["Anu valmis.", "", ""], ""); // hers is as it was on the restored screen
  await signInAsAdmin(page, context, visitorIp, created);
  const refresh = await holdRefresh(page);
  await backToStaleScreen(page, fx.session.id, mari.id, { refresh });
  await expect.poll(() => refresh.held()).toBeGreaterThan(0);
  await page.locator("[data-send-all-open]").click();
  const confirm = page.locator("[data-send-confirm]");
  await expect(confirm.locator("[data-confirm-will]")).toContainText("Anu Aas, Mari Maasikas"); // what the old render says
  await confirm.locator("[data-confirm-send]").click();
  expect((await storedProtocol(mari.id))!.sentAt).toBeNull();
  expect((await storedProtocol(anu.id))!.sentAt).toBeNull(); // waiting for the server's text
  refresh.release();
  await expect(page.locator("[data-summary-sent]")).toHaveText("Saadetud: Anu Aas.");
  await expect(page.locator("[data-summary-failed]")).toHaveText("Ei saadetud: Mari Maasikas. Protokolli muudeti vahepeal mujal ja siin on nüüd uus tekst. Vaata see üle ja saada siis.");
  expect((await storedProtocol(mari.id))!.sentAt, "Mari's older text was not sent").toBeNull();
  expect(await storedProtocol(anu.id)).toMatchObject({ sentVersion: 1, sent: { stages: [{ note: "Anu valmis." }, ...emptyNotes(2)] } });
  await expect(note(page, mari.id, 0)).toHaveValue("Teine.");
  await page.locator("[data-send-all-open]").click();
  await confirm.locator("[data-confirm-send]").click();
  await expect(page.locator("[data-summary-sent]")).toHaveText("Saadetud: Mari Maasikas.");
  expect(await storedProtocol(mari.id)).toMatchObject({ version: 2, sentVersion: 2, sent: { stages: [{ note: "Teine." }, ...emptyNotes(2)] } });
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
    // (each request is stamped when the page sends it, so "backs off" is measured between requests, never from when this test noticed an answer)
    const answers: { at: number; status: number; body: unknown }[] = [];
    const sentAt: number[] = [];
    let handed = 0; // the requests whose answer has been handed to the page
    await page.route(SAVE, async (route) => {
      sentAt.push(Date.now());
      const sent = JSON.parse(route.request().postData() ?? "{}") as Body;
      const response = await route.fetch({ postData: refusal.body(sent) });
      answers.push({ at: sentAt[sentAt.length - 1], status: response.status(), body: await response.json().catch(() => null) });
      await route.fulfill({ response });
      handed++;
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
    // it backs off: the first retry comes 2 s after the refusal (RETRY_MS[0]), nothing between the two requests, and the retry is refused the same way
    await expect.poll(() => sentAt.length, { message: "the first retry", timeout: 20_000 }).toBeGreaterThan(1);
    expect(sentAt.length, "requests before the first retry").toBe(2);
    expect(sentAt[1] - sentAt[0], "ms between the first request and its retry").toBeGreaterThanOrEqual(1_800);
    await expect.poll(() => handed, { message: "the retry's answer handed to the page" }).toBe(2); // (a route taken away while its handler is busy answers the page 404)
    expect([answers[1].status, answers[1].body]).toMatchObject([refusal.status, { ok: false, error: refusal.error }]);
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

