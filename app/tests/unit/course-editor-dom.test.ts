// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseEditor, type CourseEditorData } from "@/components/admin/CourseEditor";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { COURSE_PARTS, partValue, type EditorPart, type EditorParts } from "@/domain/course-parts";
import { newCourseDraft, type CourseDraft } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import type { AdminModule } from "@/server/admin-lessons";
import { stubFetch } from "../fakes";

// The course editor (admin UX pass piece 3a, Task 7; README B2, §1.8; piece3-texts S3-P3-a, b, g, P-2…P-6), in a browser-like document with the
// course's routes answered here: every card autosaves its part (POST api/admin/koolitus/<id>/osa/<part>), a published course's changes wait in its
// draft and the PublishBar names them („Avaldamata muudatused: {n} · {labels}. Avalikul lehel on näha eelmine versioon.“), „Avalda muudatused“ and
// „Loobu muudatustest“ go to …/avalda and …/loobu, the section map lists only the cards of the course's (drafted) type with their counts, „Avaldatud“
// and „Näidissisu“ are the instant switches, and a new course is created by its one explicit button.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ create: vi.fn(), published: vi.fn(), sample: vi.fn() }));
vi.mock("@/server/actions/admin-content", () => ({ createCourse: actions.create, setCoursePublished: actions.published, setCourseSample: actions.sample }));
vi.mock("@/server/actions/admin-lessons", () => ({
  addLesson: vi.fn(),
  addModule: vi.fn(),
  deleteModule: vi.fn(),
  moveLessonInList: vi.fn(),
  moveModuleInList: vi.fn(),
  renameModule: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/koolitused/7",
  useSearchParams: () => new URLSearchParams(),
}));

const ID = 7;
const SLUG = "kulmukuju-ja-summeetria";

/** The course as stored: an e-course with a price, two outcomes, one test question and one picture. */
const STORED: CourseDraft = {
  ...newCourseDraft(),
  id: ID,
  version: "2026-10-24T08:00:00.000Z",
  type: "e_learning",
  slug: SLUG,
  title: { et: "Kulmukuju ja sümmeetria", ru: "Форма бровей" },
  summary: { et: "Lühike tekst.", ru: "Коротко." },
  body: { et: "Pikk tekst.", ru: "Длинно." },
  outcomes: [
    { et: "Oskab mõõta", ru: "Умеет" },
    { et: "Oskab värvida", ru: "Красит" },
  ],
  price: "95",
  accessMonths: "6",
  test: { questions: [{ id: "q1", kind: "open", text: "Mis on kulm?" }], passPercent: "80", tries: "3" },
  images: [{ key: "img/a.jpg", alt: { et: "Pilt", ru: "Фото" } }],
  recommendationIds: [2],
  published: true,
};

/** Every part's version and value as the page hands them over (server/course-parts.ts readCourseEditor): live, no drafts. */
function partsOf(d: CourseDraft, over: Partial<Record<EditorPart, { version?: string; value?: unknown }>> = {}): EditorParts {
  const out: Record<string, unknown> = {};
  for (const part of COURSE_PARTS) {
    if (part === "outline") continue;
    const live = partValue(part, d);
    out[part] = { version: over[part]?.version ?? `l:${part}`, value: over[part]?.value ?? live, live };
  }
  return out as EditorParts;
}

const data = (over: Partial<CourseEditorData> = {}, d: CourseDraft = STORED): CourseEditorData => ({
  id: ID,
  slug: SLUG,
  published: d.published,
  isSample: false,
  typeLocked: false,
  liveType: d.type,
  parts: partsOf(d),
  outline: [],
  ...over,
});

const MODULES: AdminModule[] = [
  { id: 1, title: { et: "Alustame" }, unpublished: false, deletable: true, lessons: [] },
  { id: 2, title: { et: "Kujud" }, unpublished: false, deletable: true, lessons: [] },
];
const OTHERS = [
  { id: 2, title: "Lash Lift", type: "contact" as const, published: true },
  { id: 3, title: "Kulmumeister", type: "e_learning" as const, published: false },
];

/**
 * The course's routes as the editor needs them: each part's version and value (a save from another version is a 409 with what is stored; a published
 * course's save is a draft „d:1.<n>“, an unpublished one's a new live hash), …/avalda and …/loobu with the answers the test sets. `log` lists the
 * saves in order.
 */
const remote = {
  parts: {} as Record<string, { version: string; value: Record<string, unknown> }>,
  published: true,
  n: 0,
  refuse: null as null | { part: string; fields: Record<string, string> },
  avalda: (): Response => Response.json({ published: ["basics"], blocked: [] }),
  loobu: (): Response => Response.json({ discarded: 1 }),
  log: [] as { part: string; version: string; patch: Record<string, unknown> }[],
};
function resetRemote(d: CourseDraft = STORED, published = d.published) {
  remote.parts = Object.fromEntries(COURSE_PARTS.filter((p) => p !== "outline").map((p) => [p, { version: `l:${p}`, value: partValue(p as EditorPart, d) as Record<string, unknown> }]));
  remote.published = published;
  remote.n = 0;
  remote.refuse = null;
  remote.avalda = () => Response.json({ published: ["basics"], blocked: [] });
  remote.loobu = () => Response.json({ discarded: 1 });
  remote.log = [];
}
const route = (url: string, init: RequestInit | undefined): Response => {
  const publish = url.match(/\/api\/admin\/koolitus\/\d+\/(avalda|loobu)$/);
  if (publish) return publish[1] === "avalda" ? remote.avalda() : remote.loobu();
  const m = url.match(/\/api\/admin\/koolitus\/\d+\/osa\/(\w+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const part = m[1];
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push({ part, ...body });
  const stored = remote.parts[part];
  if (body.version !== stored.version) return Response.json({ ok: false, error: "conflict", version: stored.version, value: stored.value }, { status: 409 });
  if (remote.refuse?.part === part) return Response.json({ ok: false, error: "invalid", fields: remote.refuse.fields }, { status: 400 });
  remote.n += 1;
  stored.value = { ...stored.value, ...body.patch };
  stored.version = remote.published ? `d:1.${remote.n}` : `l:${part}-${remote.n}`;
  return Response.json({ ok: true, version: stored.version, savedAt: "2026-10-24T09:41:00.000Z" });
};

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });

type Props = Parameters<typeof CourseEditor>[0];
const props = (over: Partial<Props> = {}): Props => ({ course: data(), others: OTHERS, next: null, created: false, modules: MODULES, ...over });
const show = async (over: Partial<Props> = {}, guard = false) => {
  const editor = createElement(CourseEditor, props(over));
  await act(async () => root.render(guard ? createElement(LeaveGuardProvider, null, editor) : editor));
  await settle();
};

/** Types into an input or a textarea as a person does (React listens to the input event). */
const type = async (el: Element | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** Leaves the field (React's onBlur listens to focusout): the card's part saves now. */
const leave = async (el: Element | null) => {
  await act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const field = (name: string) => $<HTMLInputElement | HTMLTextAreaElement>(`[data-i18n="${name}"], [data-field="${name}"]`);
const chip = () => $("[data-save-status]");
const bar = () => $("[data-publish-bar]");
/** The map's entries as read: the label, then its status when it has one („Õpiväljundid 2“, „Õpiväljundid 1 · RU puudub“). */
const mapEntries = () =>
  $$("nav[aria-label='Jaotised'] a").map((a) => [text(a.querySelector("[data-section-label]")), text(a.querySelector("[data-section-status]"))].filter(Boolean).join(" "));
const button = (name: string) => $$<HTMLButtonElement>("button").find((b) => text(b) === name) ?? null;

beforeEach(() => {
  localStorage.clear();
  resetRemote();
  fetched = stubFetch(route);
  router.refresh.mockReset();
  for (const a of Object.values(actions)) a.mockReset();
  actions.published.mockResolvedValue({ ok: true });
  actions.sample.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.restoreAllMocks();
});

describe("a published course: the cards save to its draft, the PublishBar names the changes", () => {
  it("two card edits: „Avaldamata muudatused: 2 · Lühikirjeldus, Hind. Avalikul lehel on näha eelmine versioon.“, the chip „Mustand salvestatud {HH:MM}“", async () => {
    await show();
    expect(bar()).toBeNull(); // nothing unpublished yet
    expect(button("Salvesta")).toBeNull(); // no page-wide save any more
    await type(field("summary"), "Lühike tekst. Proov.");
    await leave(field("summary"));
    await type(field("price"), "99");
    await leave(field("price"));
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 2 · Lühikirjeldus, Hind. Avalikul lehel on näha eelmine versioon.");
    // each card saved its own part, the fields it changed, from its own version
    expect(remote.log.map((s) => [s.part, s.version, s.patch])).toEqual([
      ["basics", "l:basics", { summary: { et: "Lühike tekst. Proov.", ru: "Коротко." } }],
      ["price", "l:price", { price: "99" }],
    ]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(text(chip()!.querySelector("[role=status]"))).toBe("Mustand salvestatud 12:41");
    // the preview is the public page at the course's live address, in draft mode
    expect($<HTMLAnchorElement>("[data-publish-preview]")!.getAttribute("href")).toBe(`/api/admin/eelvaade?tee=${encodeURIComponent(`/koolitused/${SLUG}`)}`);
  });

  it("a drafted address change: the preview still opens the live address (it is live only after the publish)", async () => {
    await show();
    await type(field("slug"), "uus-aadress");
    await leave(field("slug"));
    expect(text($("[data-publish-words]"))).toContain("Aadress");
    expect($<HTMLAnchorElement>("[data-publish-preview]")!.getAttribute("href")).toBe(`/api/admin/eelvaade?tee=${encodeURIComponent(`/koolitused/${SLUG}`)}`);
  });

  it("a changed field's label says „· avaldamata“; typed back to live, the bar goes", async () => {
    await show();
    await type(field("summary"), "Teine tekst.");
    const box = field("summary")!.closest("[data-i18n-box]")!;
    expect(text(box.querySelector("[data-unpublished-tag]"))).toBe("· avaldamata");
    await type(field("summary"), "Lühike tekst.");
    expect(box.querySelector("[data-unpublished-tag]")).toBeNull();
    expect(bar()).toBeNull();
  });

  it("a blocked publish lists „Puudub: hind“ and the price field says why; nothing is reloaded", async () => {
    resetRemote();
    remote.avalda = () => Response.json({ published: [], blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] });
    await show();
    await type(field("price"), "");
    await leave(field("price"));
    await click($("[data-publish-go]"));
    expect(fetched.calls.some((c) => c.url === `/api/admin/koolitus/${ID}/avalda` && c.method === "POST")).toBe(true);
    const blocked = $("[data-publish-blocked]")!;
    expect(text(blocked)).toBe("Puudub: hind");
    expect(text(field("price")!.closest("[data-plain-field]")!.querySelector("[data-field-error]"))).toBe("Avaldatud koolitusel peab olema hind.");
    expect(router.refresh).not.toHaveBeenCalled();
    // S3-P3-a stays on the bar
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · Hind. Avalikul lehel on näha eelmine versioon.");
  });

  it("a part changed meanwhile in another tab: „Neid välju ei avaldatud, sest neid muudeti vahepeal teises aknas. Vaata need üle.“ and its labels", async () => {
    remote.avalda = () => Response.json({ published: ["price"], blocked: [{ part: "basics", reason: "changed", fields: ["Lühikirjeldus"] }] });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    const blocked = $("[data-publish-blocked]")!;
    expect(text(blocked.querySelector("[data-blocked-changed]"))).toBe("Neid välju ei avaldatud, sest neid muudeti vahepeal teises aknas. Vaata need üle.");
    expect($$("[data-publish-blocked] li").map(text)).toEqual(["Lühikirjeldus"]);
  });

  it("„Avalda muudatused“ goes through: the page is read again and every card starts from its new version", async () => {
    await show();
    await type(field("summary"), "Avaldatav.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // the server's new state arrives: the draft is live now (its version "l:…" again)
    const after = { ...STORED, summary: { et: "Avaldatav.", ru: "Коротко." } };
    resetRemote(after);
    remote.parts.basics.version = "l:basics-live";
    await show({ course: data({ parts: partsOf(after, { basics: { version: "l:basics-live" } }) }) });
    expect(bar()).toBeNull();
    // the chip: no longer the draft's words, and the publish's time (piece3-texts §4: „Mustand salvestatud“ → „Salvestatud {time}“)
    expect(text(chip()!.querySelector("[role=status]"))).toMatch(/^Salvestatud \d\d:\d\d$/);
    await type(field("summary"), "Veel üks.");
    await leave(field("summary"));
    expect(remote.log.at(-1)).toMatchObject({ part: "basics", version: "l:basics-live" });
  });

  it("a publish that fails says „Salvestamine ei õnnestunud. Proovi uuesti.“; signed out, „Logi uuesti sisse.“", async () => {
    remote.avalda = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-error]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    remote.avalda = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-error]"))).toBe("Logi uuesti sisse.");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("„Loobu muudatustest“ asks, then discards: the page is read again; a failed discard says so and keeps the question", async () => {
    remote.loobu = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-discard]"));
    expect(text($("[data-confirm-panel]"))).toContain("Kas loobun 1 muudatusest? Avalikul lehel jääb praegune versioon.");
    await click(button("Jah, loobu"));
    expect(text($("[data-publish-error]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-confirm-panel]")).not.toBeNull();
    remote.loobu = () => Response.json({ discarded: 1 });
    await click(button("Jah, loobu"));
    expect(fetched.calls.filter((c) => c.url === `/api/admin/koolitus/${ID}/loobu`)).toHaveLength(2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect($("[data-publish-error]")).toBeNull();
  });

  it("„Avaldatud“ is instant (R-d): off asks the server once; a blocked part is listed and the switch stays on; done, the page is read again", async () => {
    actions.published.mockResolvedValue({ ok: false, error: "blocked", blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] });
    await show();
    const published = () => $<HTMLInputElement>("[data-field='published']")!;
    expect(published().checked).toBe(true);
    await click(published());
    expect(actions.published).toHaveBeenCalledWith({ id: ID, on: false });
    expect(published().checked).toBe(true);
    expect(text($("[data-publish-blocked]"))).toBe("Puudub: hind");
    expect(router.refresh).not.toHaveBeenCalled();
    // switched off for real: the drafts are published first on the server, so every card starts again from the page read anew
    actions.published.mockResolvedValue({ ok: true });
    await click(published());
    expect(actions.published).toHaveBeenCalledTimes(2);
    expect(published().checked).toBe(false); // (what was asked, until the page's new state arrives)
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect($("[data-publish-blocked]")).toBeNull();
  });

  it("„Näidissisu“ is instant: one action; the box shows the choice; a refusal says so and the box goes back", async () => {
    await show();
    const sample = () => $<HTMLInputElement>("[data-field='isSample']")!;
    await click(sample());
    expect(actions.sample).toHaveBeenCalledWith({ id: ID, on: true });
    expect(sample().checked).toBe(true);
    // the page's new state (the action's refresh) arrives: the stored value
    await show({ course: data({ isSample: true }) });
    expect(sample().checked).toBe(true);
    actions.sample.mockResolvedValue({ ok: false, error: "server" });
    await click(sample());
    expect(sample().checked).toBe(true);
    expect(text($("[data-switch-error]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });
});

describe("an unpublished course: its cards save to the record", () => {
  const DRAFT: CourseDraft = { ...STORED, published: false };

  it("no PublishBar, and the chip says „Salvestatud {HH:MM}“ after a save", async () => {
    resetRemote(DRAFT);
    await show({ course: data({}, DRAFT) });
    await type(field("summary"), "Lühike tekst. Proov.");
    await leave(field("summary"));
    expect(remote.log).toHaveLength(1);
    expect(bar()).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(text(chip()!.querySelector("[role=status]"))).toBe("Salvestatud 12:41");
    expect(field("summary")!.closest("[data-i18n-box]")!.querySelector("[data-unpublished-tag]")).toBeNull();
  });

  it("a type change empties the other type's parts on the server: once it is saved the page is read again and those cards start from their new versions", async () => {
    resetRemote(DRAFT);
    await show({ course: data({}, DRAFT) });
    await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
    expect(remote.log).toEqual([{ part: "basics", version: "l:basics", patch: { type: "contact" } }]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // the server's answer: a contact course; its price part has a new version (the e-course's price was emptied)
    const contact: CourseDraft = { ...DRAFT, type: "contact", price: "", accessMonths: "" };
    resetRemote(contact, false);
    remote.parts.price.version = "l:price-emptied";
    await show({ course: data({ liveType: "contact", parts: partsOf(contact, { price: { version: "l:price-emptied" } }) }, contact) });
    await type(field("priceGroup"), "350");
    await leave(field("priceGroup"));
    expect(remote.log.at(-1)).toEqual({ part: "price", version: "l:price-emptied", patch: { priceGroup: "350" } });
  });

  it("a field the server refuses is marked with its error and held back; the rest still saves", async () => {
    resetRemote(DRAFT);
    remote.refuse = { part: "price", fields: { price: "amount" } };
    await show({ course: data({}, DRAFT) });
    await type(field("price"), "abc");
    await leave(field("price"));
    expect(field("price")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(field("price")!.closest("[data-plain-field]")!.querySelector("[data-field-error]"))).toBe("Sisesta summa eurodes, näiteks 290 või 290,50.");
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
  });
});

describe("the layout: the section map lists only this type's cards", () => {
  it("an e-course: its cards with their counts; no „Koolitus sisaldab“", async () => {
    await show();
    expect(mapEntries()).toEqual([
      "Põhiinfo",
      "Õppevorm ja hind",
      "Õpiväljundid 2",
      "Moodulid ja õppetunnid 2",
      "Protokolli punktid 0",
      "Teadmiste test 1",
      "Tunnistus",
      "Galerii 1",
      "Soovitused 1",
    ]);
    // each entry points at its card on the page
    for (const a of $$<HTMLAnchorElement>("nav[aria-label='Jaotised'] a")) expect(container.querySelector(a.getAttribute("href")!), a.getAttribute("href")!).not.toBeNull();
    // below 1180 px the same entries are the „Jaotised“ select
    expect($$("[data-section-select] option").map(text)).toHaveLength(9);
  });

  it("a contact course: „Programm“ and „Koolitus sisaldab“, no test and no certificate; the drafted type decides", async () => {
    const contact: CourseDraft = { ...STORED, type: "contact", price: "", priceGroup: "350", includes: [{ et: "Materjalid", ru: "Материалы" }], test: { ...STORED.test, questions: [] } };
    resetRemote(contact);
    await show({ course: data({}, contact) });
    expect(mapEntries()).toEqual(["Põhiinfo", "Õppevorm ja hind", "Õpiväljundid 2", "Programm 2", "Koolitus sisaldab 1", "Protokolli punktid 0", "Galerii 1", "Soovitused 1"]);
    expect($("[data-test-editor]")).toBeNull();
    expect($("[data-certificate-card]")).toBeNull();
    // the type switched in the draft: the cards follow at once
    await click($<HTMLInputElement>("[data-type-switch] input[value='e_learning']"));
    expect(mapEntries()).toContain("Teadmiste test 0");
    expect(mapEntries()).not.toContain("Koolitus sisaldab 1");
  });

  it("a card with an Estonian text and no Russian is flagged „RU puudub“; a card with a field held back „Kontrolli“", async () => {
    const half: CourseDraft = { ...STORED, outcomes: [{ et: "Oskab mõõta" }] };
    resetRemote(half);
    await show({ course: data({}, half) });
    expect(mapEntries()).toContain("Õpiväljundid 1 · RU puudub");
    remote.refuse = { part: "price", fields: { price: "amount" } };
    await type(field("price"), "abc");
    await leave(field("price"));
    expect(mapEntries()).toContain("Õppevorm ja hind Kontrolli");
  });
});

describe("a new course: one explicit „Lisa koolitus“", () => {
  it("the header says „Täida kohustuslikud väljad“, then „Vajuta „Lisa koolitus“.“; the press sends the draft", async () => {
    actions.create.mockResolvedValue({ ok: false, error: "server" });
    await show({ course: null, modules: [] });
    const line = $("[data-new-course-line]")!;
    expect(text(line)).toBe("Täida kohustuslikud väljad");
    expect(chip()).toBeNull(); // nothing autosaves before the course exists
    expect(text($("[data-lessons-editor]"))).toContain("Vajuta „Lisa koolitus“, et lisada mooduleid.");
    await type(field("title"), "Uus kulmukoolitus");
    expect(text(line)).toBe("Vajuta „Lisa koolitus“.");
    await click(button("Lisa koolitus"));
    expect(actions.create).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((actions.create.mock.calls[0][1] as FormData).get("data"))) as CourseDraft;
    expect(sent).toMatchObject({ id: null, title: { et: "Uus kulmukoolitus" }, type: "contact", published: false });
    expect(fetched.calls).toHaveLength(0); // no autosave route
    expect(text($("[data-new-course-error]"))).toBe(adminEt.common.saveError);
  });

  it("a refused create marks its fields with their words and puts the focus on the first; typing in it again takes the words away", async () => {
    actions.create.mockResolvedValue({ ok: false, error: "invalid", fields: { priceGroup: "amount" } });
    await show({ course: null, modules: [] });
    await type(field("title"), "Uus kulmukoolitus");
    await type(field("priceGroup"), "kakssada");
    await click(button("Lisa koolitus"));
    const price = field("priceGroup")!;
    expect(price.getAttribute("aria-invalid")).toBe("true");
    expect(text(price.closest("[data-plain-field]")!.querySelector("[data-field-error]"))).toBe("Sisesta summa eurodes, näiteks 290 või 290,50.");
    expect(document.activeElement).toBe(price);
    expect(text($("[data-new-course-error]"))).toBe("Kontrolli märgitud välju.");
    await type(price, "200");
    expect(price.getAttribute("aria-invalid")).toBeNull();
    expect(price.closest("[data-plain-field]")!.querySelector("[data-field-error]")).toBeNull();
  });

  it("what was typed stays in this browser and comes back on the next visit; the created course's page lets it go", async () => {
    await show({ course: null, modules: [] });
    await type(field("title"), "Pooleli kursus");
    expect(JSON.parse(localStorage.getItem("mslab-draft:koolitus:uus")!)).toMatchObject({ title: { et: "Pooleli kursus" } });
    await act(async () => root.unmount());
    root = createRoot(container);
    await show({ course: null, modules: [] });
    expect(field("title")!.value).toBe("Pooleli kursus");
    expect(text($("[data-new-course-line]"))).toBe("Vajuta „Lisa koolitus“.");
    await act(async () => root.unmount());
    root = createRoot(container);
    await show({ created: true });
    expect(localStorage.getItem("mslab-draft:koolitus:uus")).toBeNull();
  });

  it("leaving with typed text asks with the reason „Koolitust pole veel lisatud.“", async () => {
    await show({ course: null, modules: [] }, true);
    await type(field("title"), "Pooleli");
    const away = document.createElement("a");
    away.href = "/admin/koolitused";
    away.textContent = "Koolitused";
    container.append(away);
    await click(away);
    expect(router.push).not.toHaveBeenCalled();
    expect(text(document.querySelector("[data-leave-title]"))).toBe("Muudatust „Koolituse nimi“ ei saanud veel salvestada.");
    expect(text(document.querySelector("[data-leave-reason]"))).toBe("Koolitust pole veel lisatud.");
  });
});
