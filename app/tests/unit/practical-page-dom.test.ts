// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/components/account/photo-upload", () => ({ uploadPhoto: vi.fn() }));
vi.mock("@/lib/shrink-image", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/shrink-image")>()), preparePhoto: vi.fn() }));

import { uploadPhoto } from "@/components/account/photo-upload";
import { PracticalPage } from "@/components/account/PracticalPage";
import { practicalTexts } from "@/components/account/texts";
import { getDict, type Locale } from "@/i18n/locales";
import { preparePhoto, ShrinkError, type PreparedPhoto } from "@/lib/shrink-image";
import type { PointView, PracticalView } from "@/server/practical";

// The student's practical work (e-course completion, spec §4.3) in a browser-like document (happy-dom), its API answered here, and the two
// browser-only parts replaced: preparePhoto (lib/shrink-image.ts, its own test) and uploadPhoto (photo-upload.ts, its own test). Each photo
// is made smaller and sent on its own, one at a time, with its progress; one that fails keeps its prepared copy for "Proovi uuesti" while
// the others go on (Review Focus 1); "Saada hindamiseks" waits for a photo on every point and asks once; a "Paranda" round takes photos on
// its fix points only; the frame is in her language, Maria's points and notes as she wrote them (Review Focus 5).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status: number; data: Record<string, unknown> };
/** An upload under way: its path and form, its progress callback, its signal, and the way to answer it. */
type Sent = { path: string; form: FormData; progress: (fraction: number) => void; signal?: AbortSignal; resolve: (answer: Answer) => void };

const API = "/api/konto/kursus/veebikursus/praktiline";
const TITLES = ["Ettevalmistus", "Värvimine"];
const upload = vi.mocked(uploadPhoto);
const prepare = vi.mocked(preparePhoto);
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sent: Sent[];
/** What GET answers: the first while more than one is left (each read takes one), then the last again and again. */
let reads: (PracticalView & { ok: true })[];
/** What a POST or DELETE answers. */
let write: (url: string, method: string) => Response;
let container: HTMLDivElement;
let root: Root;
let previews: number;

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

const point = (index: number, over: Partial<PointView> = {}): PointView => ({ index, title: TITLES[index], verdict: null, note: "", photos: [], earlier: [], canAdd: true, ...over });
const photo = (id: number, round = 1) => ({ id, round, width: 2048, height: 1365 });
const view = (over: Partial<PracticalView> = {}): PracticalView & { ok: true } => ({
  ok: true,
  course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" } },
  status: "open",
  round: 0,
  points: [point(0), point(1)],
  generalNote: "",
  sentAt: null,
  completedAt: null,
  locked: false,
  readOnly: false,
  notesOnly: false,
  ...over,
});
const jpg = (name: string) => new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" });
/** What preparePhoto makes of a picked file: its name in the bytes, so a test can tell which photo a form carries. */
const prepared = (name: string): PreparedPhoto => ({
  full: new Blob([name, "-full"], { type: "image/jpeg" }),
  thumb: new Blob([name, "-pisi"], { type: "image/jpeg" }),
  width: 2048,
  height: 1365,
});
const stored = (id: number): Answer => ({ status: 200, data: { ok: true, photo: photo(id) } });

const mount = async (locale: Locale = "et") => {
  await act(async () => root.render(createElement(PracticalPage, { slug: "veebikursus", locale, t: practicalTexts(getDict(locale)) })));
  await settle();
};
/** Picks `files` with point `index`'s "Lisa foto" (the file input's change, as a phone's picker gives it). */
const pick = async (index: number, files: File[]) => {
  const input = $(`[data-point='${index}'] [data-photo-add] input[type=file]`) as HTMLInputElement | null;
  expect(input, `point ${index}'s "Lisa foto"`).not.toBeNull();
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};
const answer = async (i: number, a: Answer) => {
  await act(async () => sent[i].resolve(a));
  await settle();
};
const pending = () => $$("[data-photo-pending]").map((e) => e.getAttribute("data-photo-pending"));
const photos = (index: number) => $$(`[data-point='${index}'] [data-photo]`).map((e) => e.getAttribute("data-photo"));

beforeEach(() => {
  sent = [];
  reads = [view()];
  write = () => json(500, {});
  previews = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    if ((init?.method ?? "GET") === "GET") return json(200, reads.length > 1 ? reads.shift()! : reads[0]);
    return write(String(input), init!.method!);
  });
  vi.stubGlobal("fetch", fetchMock);
  upload.mockReset();
  upload.mockImplementation((path, form, onProgress, signal) => new Promise<Answer>((resolve) => sent.push({ path, form, progress: onProgress, signal, resolve })));
  prepare.mockReset();
  prepare.mockImplementation(async (file: File) => prepared(file.name));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++previews}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("photos on a phone (Review Focus 1)", () => {
  test("three photos go one at a time with their progress; the one that fails on a weak signal keeps its prepared copy for 'Proovi uuesti', the others are stored", async () => {
    await mount();
    expect(fetchMock.mock.calls[0][0]).toBe(API);
    await pick(0, [jpg("a.jpg"), jpg("b.jpg"), jpg("c.jpg")]);
    // one at a time: the first is made smaller and sent, the other two wait their turn
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe(`${API}/foto`);
    expect(pending()).toEqual(["uploading", "waiting", "waiting"]);
    const form = sent[0].form;
    expect([form.get("stage"), form.get("width"), form.get("height")]).toEqual(["0", "2048", "1365"]);
    expect((form.get("full") as File).name).toBe("foto.jpg");
    expect(await (form.get("full") as File).text()).toBe("a.jpg-full");
    expect(await (form.get("thumb") as File).text()).toBe("a.jpg-pisi");
    // its progress, as the share sent
    await act(async () => sent[0].progress(0.45));
    expect($("[data-photo-pending='uploading'] [data-photo-progress] [role=progressbar]")!.getAttribute("aria-valuenow")).toBe("45");
    expect($("[data-photo-pending='uploading']")!.textContent).toContain("Laadin üles… 45 %");
    await answer(0, stored(101));
    expect(photos(0)).toEqual(["101"]);
    expect(sent).toHaveLength(2);
    // the second one on a weak signal: no answer at all; the third goes on
    await answer(1, { status: 0, data: {} });
    expect(sent).toHaveLength(3);
    expect($("[data-photo-pending='failed']")!.textContent).toContain("Üleslaadimine ei õnnestunud.");
    await answer(2, stored(103));
    expect(photos(0)).toEqual(["101", "103"]);
    expect(pending()).toEqual(["failed"]);
    // "Proovi uuesti": the same prepared photo again — not made again, not picked again
    await click($("[data-photo-retry]"));
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(sent).toHaveLength(4);
    expect(await (sent[3].form.get("full") as File).text()).toBe("b.jpg-full");
    await answer(3, stored(102));
    expect(photos(0)).toEqual(["101", "103", "102"]);
    expect(pending()).toEqual([]);
    // three photos: no more "Lisa foto" on that point; the other point keeps its own
    expect($("[data-point='0'] [data-photo-add]")).toBeNull();
    expect($("[data-point='1'] [data-photo-add]")).not.toBeNull();
  });

  test("a photo the browser cannot open (HEIC in Chrome) says so in its row and is never sent; it can be taken away; one too big says that", async () => {
    prepare.mockRejectedValueOnce(new ShrinkError("decode"));
    await mount();
    await pick(1, [jpg("IMG_0001.HEIC")]);
    expect(sent).toHaveLength(0);
    const row = $("[data-point='1'] [data-photo-pending='decode']")!;
    expect(row.querySelector("[role=alert]")!.textContent).toBe("Seda pilti ei saa avada. Vali JPG või PNG pilt.");
    expect(row.querySelector("[data-photo-retry]")).toBeNull();
    await click(row.querySelector("[data-photo-remove]"));
    expect(pending()).toEqual([]);
    prepare.mockRejectedValueOnce(new ShrinkError("size"));
    await pick(1, [jpg("suur.jpg")]);
    expect($("[data-photo-pending='tooBig'] [role=alert]")!.textContent).toBe("See pilt on liiga suur. Vali teine pilt.");
  });

  test("the server's refusals: a photo it will not take (400) is not offered again; 409 'full' says so; 409 'closed' loads the page again quietly", async () => {
    await mount();
    await pick(0, [jpg("a.jpg")]);
    await answer(0, { status: 400, data: { ok: false, error: "content" } });
    expect($("[data-photo-pending='refused'] [role=alert]")!.textContent).toBe("Seda pilti ei saa saata. Vali teine pilt.");
    expect($("[data-photo-pending='refused'] [data-photo-retry]")).toBeNull();
    await click($("[data-photo-pending='refused'] [data-photo-remove]"));
    await pick(0, [jpg("b.jpg")]);
    await answer(1, { status: 409, data: { ok: false, error: "full" } });
    expect($("[data-photo-pending='full'] [role=alert]")!.textContent).toBe("Sellel punktil on juba 3 fotot.");
    await click($("[data-photo-pending='full'] [data-photo-remove]"));
    // sent from another device meanwhile: the page shows what is true now
    reads = [view({ status: "review", round: 1, points: [point(0, { photos: [photo(7)] }), point(1, { photos: [photo(8)] })] })];
    await pick(0, [jpg("c.jpg")]);
    const reads0 = fetchMock.mock.calls.length;
    await answer(2, { status: 409, data: { ok: false, error: "closed" } });
    expect(fetchMock.mock.calls.length).toBe(reads0 + 1);
    expect(pending()).toEqual([]);
    expect($("[data-practical-page]")!.getAttribute("data-practical-status")).toBe("review");
  });

  test("'Lisa foto' opens the phone's camera or gallery: any image, no capture attribute; several at once, up to the free places", async () => {
    await mount();
    const input = $("[data-point='0'] [data-photo-add] input[type=file]") as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe("image/*");
    expect(input.hasAttribute("capture")).toBe(false);
    expect(input.multiple).toBe(true);
    expect($("[data-point='0'] [data-photo-add] label")!.textContent).toContain("Lisa foto");
    await pick(0, [jpg("a.jpg"), jpg("b.jpg"), jpg("c.jpg"), jpg("d.jpg")]);
    expect(pending()).toHaveLength(3); // three fit on a point; the fourth is not taken
  });

  test("leaving the page stops the upload under way", async () => {
    await mount();
    await pick(0, [jpg("a.jpg")]);
    const signal = sent[0].signal!;
    expect(signal.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    root = createRoot(container); // for afterEach
  });
});

describe("removing and sending", () => {
  test("a stored photo of the round being prepared: its thumbnail, the full photo in a new tab, and its remove; a failed removal says so and keeps it", async () => {
    reads = [view({ points: [point(0, { photos: [photo(101), photo(102)] }), point(1)] })];
    let status = 500;
    write = (url, method) => (method === "DELETE" && url === `${API}/foto/101` ? json(status, status === 200 ? { ok: true } : {}) : json(500, {}));
    await mount();
    expect($("[data-photo='101'] img")!.getAttribute("src")).toBe("/api/konto/praktiline/foto/101/pisi");
    const link = $("[data-photo='101'] a")!;
    expect([link.getAttribute("href"), link.getAttribute("target")]).toEqual(["/api/konto/praktiline/foto/101", "_blank"]);
    expect($("[data-photo='101'] [data-photo-remove]")!.getAttribute("aria-label")).toBe("Eemalda foto 1");
    await click($("[data-photo='101'] [data-photo-remove]"));
    expect(photos(0)).toEqual(["101", "102"]);
    expect($("[data-practical-error]")!.textContent).toBe("Fotot ei õnnestunud eemaldada. Proovi uuesti.");
    status = 200;
    await click($("[data-photo='101'] [data-photo-remove]"));
    expect(photos(0)).toEqual(["102"]);
    expect($("[data-practical-error]")!.textContent).toBe("");
  });

  test("'Saada hindamiseks' waits for a photo on every point and for the uploads, asks once, then the page says 'Ootab hindamist' and takes nothing more", async () => {
    reads = [view({ points: [point(0, { photos: [photo(101)] }), point(1)] })];
    write = (url, method) =>
      method === "POST" && url === `${API}/saada`
        ? json(200, view({ status: "review", round: 1, points: [point(0, { photos: [photo(101)] }), point(1, { photos: [photo(102)] })] }))
        : json(500, {});
    await mount();
    const submit = $("[data-practical-submit]")!;
    expect(submit.textContent).toBe("Saada hindamiseks");
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Lisa igale punktile vähemalt üks foto.");
    await click(submit);
    expect($("[data-practical-confirm]")).toBeNull(); // not ready: nothing is asked
    await pick(1, [jpg("b.jpg")]);
    expect($("[data-practical-submit]")!.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Oota, kuni kõik fotod on üles laaditud.");
    await answer(0, stored(102));
    expect($("[data-practical-submit]")!.getAttribute("aria-disabled")).toBeNull();
    await click($("[data-practical-submit]"));
    expect(container.textContent).toContain("Kas saadad töö hindamiseks? Pärast saatmist fotosid muuta ei saa.");
    expect(document.activeElement).toBe($("[data-practical-confirm]"));
    await click($("[data-practical-confirm]"));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual([`${API}/saada`]);
    expect($("[data-practical-page]")!.getAttribute("data-practical-status")).toBe("review");
    expect($("[data-practical-lead]")!.textContent).toBe("Ootab hindamist. Maria vaatab fotod üle ja saadab sulle hinnangu.");
    expect(document.activeElement).toBe($("[data-practical-lead]"));
    for (const gone of ["[data-practical-submit]", "[data-photo-add]", "[data-photo-remove]"]) expect($(gone), gone).toBeNull();
    expect(photos(1)).toEqual(["102"]);
  });

  test("a send the server refuses: the points still without a photo are named; too many sends: the rate line", async () => {
    reads = [view({ points: [point(0, { photos: [photo(101)] }), point(1, { photos: [photo(102)] })] })];
    let refusal = json(409, { ok: false, error: "missing", points: [1] });
    write = () => refusal;
    await mount();
    await click($("[data-practical-submit]"));
    await click($("[data-practical-confirm]"));
    expect($("[data-practical-error]")!.textContent).toBe("Lisa foto neile punktidele: 2.");
    refusal = json(429, { ok: false, error: "rate" });
    await click($("[data-practical-submit]"));
    await click($("[data-practical-confirm]"));
    expect($("[data-practical-error]")!.textContent).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
  });
});

describe("after Maria's assessment", () => {
  test("a 'Paranda' round: an approved point shows ✓ Kinnitatud and takes nothing; a fix point shows her comment, takes new photos, keeps the earlier ones folded; 'Saada uuesti'", async () => {
    reads = [
      view({
        status: "fix",
        round: 1,
        sentAt: "2026-11-02T10:00:00.000Z",
        generalNote: "Hea algus!",
        points: [
          point(0, { verdict: "ok", note: "Väga hea ettevalmistus.", earlier: [photo(11)], canAdd: false }),
          point(1, { verdict: "fix", note: "Kulmud on ebaühtlased, tee uuesti.", earlier: [photo(12), photo(13)] }),
        ],
      }),
    ];
    await mount();
    const [p0, p1] = [$("[data-point='0']")!, $("[data-point='1']")!];
    expect(p0.querySelector("[data-point-verdict]")!.getAttribute("data-point-verdict")).toBe("ok");
    expect(p0.querySelector("[data-point-verdict]")!.textContent).toBe("Kinnitatud");
    expect(p0.querySelector("[data-point-note]")!.textContent).toBe("Väga hea ettevalmistus.");
    expect(p0.querySelector("[data-photo-add]")).toBeNull();
    expect(p1.querySelector("[data-point-verdict]")!.textContent).toBe("Paranda");
    expect(p1.querySelector("[data-point-note]")!.textContent).toBe("Kulmud on ebaühtlased, tee uuesti.");
    expect(p1.querySelector("[data-photo-add]")).not.toBeNull();
    const earlier = p1.querySelector("details[data-earlier]") as HTMLDetailsElement;
    expect(earlier.open).toBe(false);
    expect(earlier.querySelector("summary")!.textContent).toBe("Varasemad fotod");
    expect([...earlier.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/api/konto/praktiline/foto/12/pisi", "/api/konto/praktiline/foto/13/pisi"]);
    expect($("[data-general-note]")!.textContent).toContain("Hea algus!");
    expect($("[data-practical-lead]")!.textContent).toBe("Lisa uued fotod punktidele, mille juures on „Paranda“, ja saada uuesti.");
    expect($("[data-practical-submit]")!.textContent).toBe("Saada uuesti");
    expect(container.textContent).toContain("Lisa igale „Paranda“ punktile vähemalt üks uus foto.");
  });

  test("waiting again after a 'Paranda' round: an approved point still says so; the old 'Paranda' is not repeated while Maria looks again", async () => {
    reads = [
      view({
        status: "review",
        round: 2,
        points: [
          point(0, { verdict: "ok", note: "Väga hea.", photos: [photo(11)] }),
          point(1, { verdict: "fix", note: "Tee uuesti.", photos: [photo(21, 2)], earlier: [photo(12)] }),
        ],
      }),
    ];
    await mount();
    expect($("[data-point='0'] [data-point-verdict]")!.textContent).toBe("Kinnitatud");
    expect($("[data-point='1'] [data-point-verdict]")).toBeNull();
    expect($("[data-point='1'] [data-point-note]")).toBeNull();
    expect($("[data-practical-submit]")).toBeNull();
  });

  test("all approved: 'Kõik punktid on kinnitatud.' and 'Lõpetatud' with the date; nothing to add, remove or send", async () => {
    reads = [
      view({
        status: "passed",
        round: 2,
        sentAt: "2026-11-14T10:00:00.000Z",
        completedAt: "2026-11-14T10:00:00.000Z",
        points: [point(0, { verdict: "ok", photos: [photo(21, 2)] }), point(1, { verdict: "ok", photos: [photo(22, 2)] })],
      }),
    ];
    await mount();
    expect($("[data-practical-lead]")!.textContent).toBe("Kõik punktid on kinnitatud.");
    expect($("[data-practical-completed]")!.textContent).toBe("Lõpetatud 14.11.2026");
    for (const gone of ["[data-practical-submit]", "[data-photo-add]", "[data-photo-remove]"]) expect($(gone), gone).toBeNull();
  });
});

describe("the other states of the page", () => {
  test("the access has ended: her results stay readable; nothing can be added, removed or sent", async () => {
    reads = [view({ readOnly: true, points: [point(0, { photos: [photo(101)] }), point(1)] })];
    await mount();
    expect($("[data-practical-lead]")!.textContent).toBe("Ligipääs on lõppenud. Saad tulemusi vaadata, kuid uusi fotosid saata ei saa.");
    expect(photos(0)).toEqual(["101"]);
    for (const gone of ["[data-practical-submit]", "[data-photo-add]", "[data-photo-remove]"]) expect($(gone), gone).toBeNull();
  });

  test("not open yet, or not there for her: one sentence and the way back to the course", async () => {
    reads = [view({ locked: true })];
    await mount();
    expect($("[data-account-state='locked'] h1")!.textContent).toBe("Praktiline töö avaneb, kui eelnevad sammud on tehtud.");
    expect($("[data-account-state='locked'] a")!.getAttribute("href")).toBe("/konto/kursus/veebikursus");
    await act(async () => root.unmount());
    root = createRoot(container);
    fetchMock.mockImplementation(async () => json(404, { ok: false }));
    await mount();
    expect($("[data-account-state='notFound'] h1")!.textContent).toBe("Praktilist tööd ei leitud.");
  });

  test("an e-course without points: Maria's notes only, as the protocol", async () => {
    reads = [view({ notesOnly: true, points: [], generalNote: "Tubli töö!\nJätka harjutamist.", sentAt: "2026-11-14T10:00:00.000Z" })];
    await mount();
    expect(container.textContent).toContain("Koolituse protokoll");
    expect($("[data-general-note] p")!.textContent).toBe("Tubli töö!\nJätka harjutamist.");
    expect(container.textContent).toContain("Saadetud 14.11.2026");
    for (const gone of ["[data-point]", "[data-practical-submit]", "[data-practical-lead]"]) expect($(gone), gone).toBeNull();
  });

  test("Review Focus 5: Russian: the frame in Russian, Maria's points and comments as she wrote them, the addresses under /ru", async () => {
    reads = [view({ status: "fix", round: 1, points: [point(0, { verdict: "ok", note: "Väga hea." }), point(1, { verdict: "fix", note: "Tee uuesti." })] })];
    await mount("ru");
    expect($("h1")!.textContent).toBe("Онлайн-курс бровиста");
    for (const text of ["Практическая работа", "Подтверждено", "Исправить", "Добавить фото", "Ettevalmistus", "Värvimine", "Väga hea.", "Tee uuesti."])
      expect(container.textContent).toContain(text);
    expect($("[data-practical-submit]")!.textContent).toBe("Отправить снова");
    expect($("[data-practical-back]")!.getAttribute("href")).toBe("/ru/konto/kursus/veebikursus");
    prepare.mockRejectedValueOnce(new ShrinkError("decode"));
    await pick(1, [jpg("IMG_0001.HEIC")]);
    expect($("[data-photo-pending='decode'] [role=alert]")!.textContent).toBe("Это изображение не открывается. Выберите фото в формате JPG или PNG.");
  });
});
