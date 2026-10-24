// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseEditor, type CourseEditorData } from "@/components/admin/CourseEditor";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { UndoProvider } from "@/components/admin/UndoBar";
import { RETRY_MS, SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import { COURSE_PARTS, partValue, type EditorPart, type EditorParts } from "@/domain/course-parts";
import { newCourseDraft, type CourseDraft, type DraftImage } from "@/domain/course-editor";
import type { TestQuestion } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";
import { contentVersion } from "@/lib/version";
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
const lessonActions = vi.hoisted(() => ({ moveModuleTo: vi.fn() }));
vi.mock("@/server/actions/admin-lessons", () => ({
  addLesson: vi.fn(),
  addModule: vi.fn(),
  deleteModule: vi.fn(),
  moveLessonInList: vi.fn(),
  moveModuleTo: lessonActions.moveModuleTo,
}));
// a picked picture goes to the upload as it is (the browser's shrinking is lib/shrink-image's own tests')
vi.mock("@/lib/shrink-image", () => ({ shrinkImage: async (file: File) => file, ShrinkError: class ShrinkError extends Error {} }));
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
  // (the read's stamp, server/read-stamp.ts: the tests' reads are older than any press's answer that carries one, unless a test says otherwise)
  stamp: 1,
  ...over,
});

const MODULES: AdminModule[] = [
  { id: 1, title: { et: "Alustame" }, version: "t:m1", unpublished: false, changed: false, deletable: true, lessons: [] },
  { id: 2, title: { et: "Kujud" }, version: "t:m2", unpublished: false, changed: false, deletable: true, lessons: [] },
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
  /** A part's saves refused with these field codes (`when`: only a save that sends that field). */
  refuse: null as null | { part: string; fields: Record<string, string>; when?: string },
  /** A part's saves answered with this status (a server error), or not at all (null: no connection). */
  fail: null as null | { part: string; status: number | null },
  /** A part whose save is stored but its answer lost: the request hangs until the browser gives it up (its abort). */
  lose: null as null | string,
  /** A part whose saves are answered only when the test lets each one go, in order (`waiting.shift()()`): a save still on its way. */
  hold: null as null | { part: string; waiting: Array<() => void> },
  /** /api/admin/upload: a picture's upload. */
  upload: (): Response | Promise<Response> => Response.json({ ok: true, key: "img/uus.jpg" }),
  avalda: (): Response | Promise<Response> => Response.json({ published: ["basics"], blocked: [] }),
  loobu: (): Response | Promise<Response> => Response.json({ discarded: 1 }),
  log: [] as { part: string; version: string; patch: Record<string, unknown> }[],
  /** api/admin/moodul/<id>: each module's name as stored, at its „t:“ version (Task 9; R-b2). Its saves are logged as the part `moodul<id>`. */
  modules: {} as Record<number, { version: string; value: { title: unknown } }>,
};
function resetRemote(d: CourseDraft = STORED, published = d.published) {
  remote.parts = Object.fromEntries(COURSE_PARTS.filter((p) => p !== "outline").map((p) => [p, { version: `l:${p}`, value: partValue(p as EditorPart, d) as Record<string, unknown> }]));
  remote.published = published;
  remote.n = 0;
  remote.refuse = null;
  remote.fail = null;
  remote.lose = null;
  remote.hold = null;
  remote.upload = () => Response.json({ ok: true, key: "img/uus.jpg" });
  remote.avalda = () => Response.json({ published: ["basics"], blocked: [] });
  remote.loobu = () => Response.json({ discarded: 1 });
  remote.log = [];
  remote.modules = Object.fromEntries(MODULES.map((m) => [m.id, { version: m.version, value: { title: m.title } }]));
}
const route = (url: string, init: RequestInit | undefined): Response | Promise<Response> => {
  const held = remote.hold;
  if (held && (url.endsWith(`/osa/${held.part}`) || url.endsWith(`/${held.part.replace(/^moodul/, "moodul/")}`)))
    return new Promise<Response>((resolve) => held.waiting.push(() => resolve(respond(url, init))));
  return respond(url, init);
};
const respond = (url: string, init: RequestInit | undefined): Response | Promise<Response> => {
  const publish = url.match(/\/api\/admin\/koolitus\/\d+\/(avalda|loobu)$/);
  if (publish) return publish[1] === "avalda" ? remote.avalda() : remote.loobu();
  if (url === "/api/admin/upload") return remote.upload();
  const named = url.match(/^\/api\/admin\/moodul\/(\d+)$/);
  if (named) {
    const part = `moodul${named[1]}`;
    const body = JSON.parse(String(init?.body)) as { version: string; patch: { title: unknown } };
    remote.log.push({ part, ...body });
    if (remote.fail?.part === part) return Response.json({ ok: false, error: "server" }, { status: remote.fail.status ?? 500 });
    const now = remote.modules[Number(named[1])];
    if (body.version !== now.version) return Response.json({ ok: false, error: "conflict", version: now.version, value: now.value }, { status: 409 });
    remote.n += 1;
    remote.modules[Number(named[1])] = { version: `t:m${named[1]}-${remote.n}`, value: { title: body.patch.title } };
    return Response.json({ ok: true, version: `t:m${named[1]}-${remote.n}`, savedAt: "2026-10-24T09:41:00.000Z" });
  }
  const m = url.match(/\/api\/admin\/koolitus\/\d+\/osa\/(\w+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const part = m[1];
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push({ part, ...body });
  const stored = remote.parts[part];
  if (remote.fail?.part === part) {
    if (remote.fail.status === null) throw new TypeError("Failed to fetch");
    return Response.json({ ok: false, error: "server" }, { status: remote.fail.status });
  }
  if (body.version !== stored.version) return Response.json({ ok: false, error: "conflict", version: stored.version, value: stored.value }, { status: 409 });
  if (remote.refuse?.part === part && (!remote.refuse.when || remote.refuse.when in body.patch))
    return Response.json({ ok: false, error: "invalid", fields: remote.refuse.fields }, { status: 400 });
  remote.n += 1;
  stored.value = { ...stored.value, ...body.patch };
  stored.version = remote.published ? `d:1.${remote.n}` : `l:${part}-${remote.n}`;
  if (remote.lose === part)
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
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
  // (the (panel) layout's UndoBar: the list editors' removals offer „Võta tagasi“ in it)
  await act(async () => root.render(createElement(UndoProvider, null, guard ? createElement(LeaveGuardProvider, null, editor) : editor)));
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
/** Picks a picture in „Galerii“: its upload goes to /api/admin/upload (remote.upload answers it). */
const pickImage = async () => {
  const input = $<HTMLInputElement>("#course-gallery [data-image-upload] input[type=file]")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "uus.jpg", { type: "image/jpeg" })] });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
};
/** Lets `ms` go by on the fake clock. */
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

beforeEach(() => {
  localStorage.clear();
  resetRemote();
  fetched = stubFetch(route);
  router.refresh.mockReset();
  for (const a of Object.values(actions)) a.mockReset();
  lessonActions.moveModuleTo.mockReset();
  lessonActions.moveModuleTo.mockResolvedValue({ ok: true, id: 2 });
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
    // the price typed in and saved again: the line goes with the field's words (review M-3)
    await type(field("price"), "95,5");
    await leave(field("price"));
    expect($("[data-publish-blocked]")).toBeNull();
    expect(field("price")!.closest("[data-plain-field]")!.querySelector("[data-field-error]")).toBeNull();
  });

  it("a held part typed back to live: no bar at all, never „Avaldamata muudatused: 0“ (review M-3)", async () => {
    remote.avalda = () => Response.json({ published: [], blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] });
    await show();
    await type(field("price"), "");
    await leave(field("price"));
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-blocked]"))).toBe("Puudub: hind");
    await type(field("price"), "95");
    expect(bar()).toBeNull();
    expect($("[data-publish-blocked]")).toBeNull();
  });

  it("a publish that publishes nothing and holds nothing (another tab published meanwhile), or an answer that cannot be read: the page is read again (review M-2)", async () => {
    remote.avalda = () => Response.json({ published: [], blocked: [] });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    remote.avalda = () => new Response("<html>", { status: 200 });
    resetRemote();
    remote.avalda = () => new Response("<html>", { status: 200 });
    await show({ course: data() });
    await type(field("summary"), "Veel.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect(router.refresh).toHaveBeenCalledTimes(2);
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

  it("a publish that fails says „Avaldamine ei õnnestunud. Proovi uuesti.“ (Dim 24.10); signed out, „Logi uuesti sisse.“", async () => {
    remote.avalda = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-error]"))).toBe("Avaldamine ei õnnestunud. Proovi uuesti.");
    remote.avalda = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-error]"))).toBe("Logi uuesti sisse.");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("„Loobu muudatustest“ asks, then discards: the page is read again; a failed discard says „Muudatustest loobumine ei õnnestunud. Proovi uuesti.“ (Dim 24.10) and keeps the question", async () => {
    remote.loobu = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-discard]"));
    expect(text($("[data-confirm-panel]"))).toContain("Kas loobun 1 muudatusest? Avalikul lehel jääb praegune versioon.");
    await click(button("Jah, loobu"));
    expect(text($("[data-publish-error]"))).toBe("Muudatustest loobumine ei õnnestunud. Proovi uuesti.");
    expect($("[data-confirm-panel]")).not.toBeNull();
    remote.loobu = () => Response.json({ discarded: 1 });
    await click(button("Jah, loobu"));
    expect(fetched.calls.filter((c) => c.url === `/api/admin/koolitus/${ID}/loobu`)).toHaveLength(2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect($("[data-publish-error]")).toBeNull();
  });

  it("„Loobu muudatustest“ with a field held back: the copy goes too — after the read the field shows live and nothing is sent again (review I-1)", async () => {
    remote.refuse = { part: "price", fields: { price: "amount" } };
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await type(field("price"), "abc");
    await leave(field("price"));
    expect(field("price")!.getAttribute("aria-invalid")).toBe("true");
    expect(Object.keys(localStorage).filter((k) => k.startsWith(`mslab-draft:koolitus:${ID}-price:`))).toHaveLength(1);
    await click($("[data-publish-discard]"));
    await click(button("Jah, loobu"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(Object.keys(localStorage).filter((k) => k.startsWith(`mslab-draft:koolitus:${ID}-`))).toEqual([]);
    // the server's state after the discard: live, no drafts
    const sent = fetched.calls.length;
    resetRemote();
    await show({ course: data() });
    await settle();
    expect(field("price")!.value).toBe("95");
    expect(field("summary")!.value).toBe("Lühike tekst.");
    expect(field("price")!.getAttribute("aria-invalid")).toBeNull();
    expect(bar()).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(fetched.calls).toHaveLength(sent);
  });

  it("from the press of „Avalda muudatused“ through its request the cards wait: text typed then is no copy on the old draft version, no conflict after (review round 2)", async () => {
    let answer!: (r: Response) => void;
    remote.avalda = () => new Promise<Response>((resolve) => (answer = resolve));
    await show();
    await type(field("summary"), "Avaldatav.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect($("[data-cards-waiting]")).not.toBeNull();
    // typed while the publish is on its way: nothing lands, nothing is kept or sent
    const sent = remote.log.length;
    await type(field("summary"), "Hilja.");
    await leave(field("summary"));
    expect(field("summary")!.value).toBe("Avaldatav.");
    expect(Object.keys(localStorage).filter((k) => k.startsWith(`mslab-draft:koolitus:${ID}-basics:`))).toEqual([]);
    expect(remote.log).toHaveLength(sent);
    await act(async () => answer(Response.json({ published: ["basics"], blocked: [] })));
    await settle();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const after = { ...STORED, summary: { et: "Avaldatav.", ru: "Коротко." } };
    resetRemote(after);
    await show({ course: data({ parts: partsOf(after) }) });
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect($("[data-part-restore]")).toBeNull();
    await type(field("summary"), "Uus päev.");
    await leave(field("summary"));
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("a publish refused (a server error): the cards take typing again, nothing lost", async () => {
    remote.avalda = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await type(field("summary"), "Uus.");
    await leave(field("summary"));
    await click($("[data-publish-go]"));
    expect($("[data-cards-waiting]")).toBeNull();
    await type(field("summary"), "Uus ja parem.");
    expect(field("summary")!.value).toBe("Uus ja parem.");
  });

  it.each([
    ["during the publish's request", "post"],
    ["after the cards have started over", "restart"],
  ])("a picture on its way at the press of „Avalda muudatused“ that ends %s goes in once, on the fresh version, with no conflict (review round 3 N-3)", async (_when, when) => {
    let uploaded!: (r: Response) => void;
    remote.upload = () => new Promise<Response>((resolve) => (uploaded = resolve));
    let answer!: (r: Response) => void;
    remote.avalda = () => new Promise<Response>((resolve) => (answer = resolve));
    await show();
    await type(field("summary"), "Avaldatav.");
    await leave(field("summary"));
    await pickImage();
    await click($("[data-publish-go]"));
    const ends = async () => {
      await act(async () => uploaded(Response.json({ ok: true, key: "img/uus.jpg" })));
      await settle();
    };
    if (when === "post") {
      await ends();
      // it waits with the cards: nothing goes onto the version the publish is moving
      expect(remote.log.filter((s) => s.part === "gallery")).toEqual([]);
    }
    await act(async () => answer(Response.json({ published: ["basics"], blocked: [] })));
    await settle();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const after = { ...STORED, summary: { et: "Avaldatav.", ru: "Коротко." } };
    resetRemote(after);
    await show({ course: data({ parts: partsOf(after) }) });
    if (when === "restart") await ends();
    await settle();
    expect($$("[data-gallery-item]").map((el) => el.getAttribute("data-gallery-item"))).toEqual(["img/a.jpg", "img/uus.jpg"]);
    expect(remote.log.filter((s) => s.part === "gallery")).toEqual([
      { part: "gallery", version: "l:gallery", patch: { images: [...STORED.images, { key: "img/uus.jpg", alt: { et: "" } }] } },
    ]);
    expect($("[data-part-restore]")).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("after a discard the cards wait for the read; none in SAVE_TIMEOUT_MS: they start over from the live text on its live versions, take typing, and the next read starts them over again (review round 2 N-1, round 3)", async () => {
    fakeClock();
    try {
      // the server after a discard: every part live again, at its live hash (server/course-parts.ts partStateOf)
      remote.loobu = async () => {
        for (const part of Object.keys(remote.parts)) {
          const value = partValue(part as EditorPart, STORED) as Record<string, unknown>;
          remote.parts[part] = { version: `l:${await contentVersion(value)}`, value };
        }
        return Response.json({ discarded: 1 });
      };
      await show();
      await type(field("summary"), "Uus.");
      await leave(field("summary"));
      await click($("[data-publish-discard]"));
      await click(button("Jah, loobu"));
      expect(router.refresh).toHaveBeenCalledTimes(1);
      // the (muted) cards wait: nothing typed lands
      expect($("[data-cards-waiting]")).not.toBeNull();
      await type(field("price"), "99");
      expect(field("price")!.value).toBe("95");
      // no read in SAVE_TIMEOUT_MS: they start over from what the discard left (live), and the page is asked for again
      await wait(SAVE_TIMEOUT_MS);
      expect($("[data-cards-waiting]")).toBeNull();
      expect(router.refresh).toHaveBeenCalledTimes(2);
      expect(field("summary")!.value).toBe("Lühike tekst.");
      expect(bar()).toBeNull();
      await type(field("price"), "99");
      await leave(field("price"));
      expect(remote.log.at(-1)).toEqual({ part: "price", version: `l:${await contentVersion(partValue("price", STORED))}`, patch: { price: "99" } });
      expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
      // the read comes at last: the cards start over from it
      const price = { ...remote.parts.price };
      await show({ course: data({ parts: partsOf(STORED, { price: { version: price.version, value: price.value } }) }) });
      expect(field("price")!.value).toBe("99");
      await type(field("price"), "100");
      await leave(field("price"));
      expect(remote.log.at(-1)).toEqual({ part: "price", version: price.version, patch: { price: "100" } });
      expect(Object.keys(localStorage).filter((k) => k.startsWith(`mslab-draft:koolitus:${ID}-`))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a publish whose request is never answered: SAVE_TIMEOUT_MS after the press the cards take typing and the page is read, with no failure line; its late answer changes nothing (review round 3 NB-4)", async () => {
    fakeClock();
    try {
      let answer!: (r: Response) => void;
      // (a request that does not even hear its abort)
      remote.avalda = () => new Promise<Response>((resolve) => (answer = resolve));
      await show();
      await type(field("summary"), "Avaldatav.");
      await leave(field("summary"));
      await click($("[data-publish-go]"));
      expect($("[data-cards-waiting]")).not.toBeNull();
      await wait(SAVE_TIMEOUT_MS - 2000);
      expect($("[data-cards-waiting]")).not.toBeNull();
      await wait(2000);
      expect($("[data-cards-waiting]")).toBeNull();
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect($("[data-publish-error]")).toBeNull();
      expect(bar()!.getAttribute("aria-busy")).toBeNull();
      await type(field("summary"), "Edasi.");
      expect(field("summary")!.value).toBe("Edasi.");
      // the answer comes after all: nothing more happens
      await act(async () => answer(Response.json({ published: ["basics"], blocked: [] })));
      await settle();
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect($("[data-cards-waiting]")).toBeNull();
      expect($("[data-publish-error]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("„Avalikul lehel“ or „Näidissisu“ never answered: SAVE_TIMEOUT_MS after the press the switch shows the stored state and takes a press again, nothing waits, the page is read; no failure line (review round 3 NB-4)", async () => {
    fakeClock();
    try {
      actions.published.mockReturnValue(new Promise(() => {}));
      actions.sample.mockReturnValue(new Promise(() => {}));
      await show();
      const published = () => $<HTMLInputElement>("[data-field='published']")!;
      const sample = () => $<HTMLInputElement>("[data-field='isSample']")!;
      await click(published());
      expect(published().checked).toBe(false);
      expect($("[data-cards-waiting]")).not.toBeNull();
      await wait(SAVE_TIMEOUT_MS);
      expect($("[data-cards-waiting]")).toBeNull();
      expect(published().checked).toBe(true);
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect($("[data-switch-error]")).toBeNull();
      expect($("[data-publish-card]")!.getAttribute("aria-busy")).toBeNull();
      // „Näidissisu“ (it holds no card): the same bound
      await click(sample());
      expect(actions.sample).toHaveBeenCalledTimes(1);
      expect(sample().checked).toBe(true);
      await wait(SAVE_TIMEOUT_MS);
      expect(sample().checked).toBe(false);
      expect(router.refresh).toHaveBeenCalledTimes(2);
      expect($("[data-switch-error]")).toBeNull();
      // each takes a press again
      await click(published());
      expect(actions.published).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a part blocked", { ok: false, error: "blocked", blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] }],
    ["the price required", { ok: false, error: "invalid", fields: { price: "priceRequired" } }],
    ["an error", { ok: false, error: "server" }],
  ])("„Avalikul lehel“ refused (%s): the cards take typing again and the focus is back on the switch (review round 3 NB-3)", async (_what, refusal) => {
    let answer!: (r: unknown) => void;
    actions.published.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show();
    const published = $<HTMLInputElement>("[data-field='published']")!;
    await act(async () => published.focus());
    await click(published);
    expect($("[data-cards-waiting]")).not.toBeNull();
    // the waiting cards are inert: the browser takes the focus off the switch (happy-dom does not, so it is done here)
    await act(async () => published.blur());
    expect(document.activeElement).toBe(document.body);
    await act(async () => answer(refusal));
    await settle();
    expect($("[data-cards-waiting]")).toBeNull();
    expect(document.activeElement).toBe($("[data-field='published']"));
  });

  it("„Avalikul lehel“ is an instant switch (R-d): off asks the server once; a blocked part is listed and the switch stays on; done, the page is read again", async () => {
    actions.published.mockResolvedValue({ ok: false, error: "blocked", blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] });
    await show();
    const published = () => $<HTMLInputElement>("[data-field='published']")!;
    // the drawn switches (Part 3 L111): „Avalikul lehel“ and „Näidissisu“, role switch, no hints
    const card = $("[data-publish-card]")!;
    expect($$("[data-publish-card] input").map((i) => [i.getAttribute("role"), i.getAttribute("type"), text(i.closest("label"))])).toEqual([
      ["switch", "checkbox", "Avalikul lehel"],
      ["switch", "checkbox", "Näidissisu"],
    ]);
    expect(card.textContent).toBe("AvaldamineAvalikul lehelNäidissisu"); // (the title and the two labels: no hints)
    expect(published().checked).toBe(true);
    // a price emptied in the draft: switched off, R-d publishes first, and the server holds it
    await type(field("price"), "");
    await leave(field("price"));
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

  it("from the type's choice until the new read the cards wait (inert, aria-busy, nothing typed taken); after it no conflict, the focus back on the radio (review I-2)", async () => {
    resetRemote(DRAFT);
    await show({ course: data({}, DRAFT) });
    const radio = $<HTMLInputElement>("[data-type-switch] input[value='contact']")!;
    await act(async () => radio.focus());
    await click(radio);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const layout = $("[data-cards-waiting]")!;
    expect(layout.hasAttribute("inert")).toBe(true);
    expect(layout.getAttribute("aria-busy")).toBe("true");
    // she goes straight on to the contact course's price: nothing lands, nothing is kept on the price's old version, nothing is sent
    await type(field("priceGroup"), "350");
    await leave(field("priceGroup"));
    expect(field("priceGroup")!.value).toBe("");
    expect(Object.keys(localStorage).filter((k) => k.startsWith(`mslab-draft:koolitus:${ID}-price:`))).toEqual([]);
    expect(remote.log.map((r) => r.part)).toEqual(["basics"]);
    // the new read: the cards take typing again, no false conflict, the focus where it was
    const contact: CourseDraft = { ...DRAFT, type: "contact", price: "", accessMonths: "" };
    resetRemote(contact, false);
    remote.parts.price.version = "l:price-emptied";
    await show({ course: data({ liveType: "contact", parts: partsOf(contact, { price: { version: "l:price-emptied" } }) }, contact) });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(document.activeElement).toBe($("[data-type-switch] input[value='contact']"));
    await type(field("priceGroup"), "350");
    await leave(field("priceGroup"));
    expect(remote.log.at(-1)).toEqual({ part: "price", version: "l:price-emptied", patch: { priceGroup: "350" } });
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("the restart puts the focus on the control she moved to meanwhile, never back on the one she left", async () => {
    resetRemote(DRAFT);
    await show({ course: data({}, DRAFT) });
    await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
    // she has gone to the header's language switch (outside the waiting cards)
    const ru = $<HTMLButtonElement>("[data-edit-lang='ru']")!;
    await act(async () => ru.focus());
    const contact: CourseDraft = { ...DRAFT, type: "contact", price: "", accessMonths: "" };
    resetRemote(contact, false);
    await show({ course: data({ liveType: "contact", parts: partsOf(contact) }, contact) });
    expect(document.activeElement).toBe($("[data-edit-lang='ru']"));
  });

  it("a read that never comes: SAVE_TIMEOUT_MS after the freeze began the cards take typing again and the page is asked for again; the next read starts them over (review M-4, round 3)", async () => {
    fakeClock();
    try {
      resetRemote(DRAFT);
      await show({ course: data({}, DRAFT) });
      await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
      expect(router.refresh).toHaveBeenCalledTimes(1);
      await wait(SAVE_TIMEOUT_MS - 2000);
      expect($("[data-cards-waiting]")).not.toBeNull();
      await wait(2000);
      expect($("[data-cards-waiting]")).toBeNull();
      expect(router.refresh).toHaveBeenCalledTimes(2);
      // the read at last: the cards start over from it (the contact course's emptied price, on its new version)
      const contact: CourseDraft = { ...DRAFT, type: "contact", price: "", accessMonths: "" };
      resetRemote(contact, false);
      remote.parts.price.version = "l:price-emptied";
      await show({ course: data({ liveType: "contact", parts: partsOf(contact, { price: { version: "l:price-emptied" } }) }, contact) });
      await type(field("priceGroup"), "350");
      await leave(field("priceGroup"));
      expect(remote.log.at(-1)).toEqual({ part: "price", version: "l:price-emptied", patch: { priceGroup: "350" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the type's save unanswered for SAVE_TIMEOUT_MS: the cards take typing and the page is asked for; the retry meets the stored type (a 409 with what was sent): the page is read again, the cards start from it (review round 3 NB-2)", async () => {
    fakeClock();
    try {
      resetRemote(DRAFT);
      remote.lose = "basics";
      await show({ course: data({}, DRAFT) });
      await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
      expect($("[data-cards-waiting]")).not.toBeNull();
      // no answer (the server stored it): its outcome unknown, the cards take typing and the page is asked for
      await wait(SAVE_TIMEOUT_MS);
      expect($("[data-cards-waiting]")).toBeNull();
      expect(router.refresh).toHaveBeenCalledTimes(1);
      // the engine's retry: a 409 whose stored value is the one it sent — confirmed, and the page is read again (the server emptied the e-course's parts)
      await wait(RETRY_MS[0]);
      await settle();
      expect(remote.log.map((s) => [s.part, s.version, s.patch])).toEqual([
        ["basics", "l:basics", { type: "contact" }],
        ["basics", "l:basics", { type: "contact" }],
      ]);
      expect(router.refresh).toHaveBeenCalledTimes(2);
      expect($("[data-cards-waiting]")).not.toBeNull();
      const contact: CourseDraft = { ...DRAFT, type: "contact", price: "", accessMonths: "" };
      resetRemote(contact, false);
      remote.parts.price.version = "l:price-emptied";
      await show({ course: data({ liveType: "contact", parts: partsOf(contact, { price: { version: "l:price-emptied" } }) }, contact) });
      expect($("[data-cards-waiting]")).toBeNull();
      await type(field("priceGroup"), "350");
      await leave(field("priceGroup"));
      expect(remote.log.at(-1)).toEqual({ part: "price", version: "l:price-emptied", patch: { priceGroup: "350" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a type chosen while „Põhiinfo“ is in conflict: nothing waits (no save can go); „Taasta minu tekst“ sends it, and the page is read again (review round 3 NB-1)", async () => {
    resetRemote(DRAFT);
    await show({ course: data({}, DRAFT) });
    // another window changed „Põhiinfo“ meanwhile
    remote.parts.basics = { version: "l:basics-other", value: { ...remote.parts.basics.value, summary: { et: "Teises aknas.", ru: "Коротко." } } };
    await type(field("summary"), "Minu tekst.");
    await leave(field("summary"));
    expect($("#course-basics [data-part-restore]")).not.toBeNull();
    await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
    expect($("[data-cards-waiting]")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(remote.log).toHaveLength(1); // (the summary's save that met the conflict)
    // „Taasta minu tekst“: the text and the type over the other window's version; the type confirmed, the page is read again
    await click($("#course-basics [data-part-restore]"));
    expect(remote.log.at(-1)).toEqual({ part: "basics", version: "l:basics-other", patch: { type: "contact", summary: { et: "Minu tekst.", ru: "Коротко." } } });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const contact: CourseDraft = { ...DRAFT, type: "contact", summary: { et: "Minu tekst.", ru: "Коротко." }, price: "", accessMonths: "" };
    resetRemote(contact, false);
    await show({ course: data({ liveType: "contact", parts: partsOf(contact) }, contact) });
    expect($("[data-cards-waiting]")).toBeNull();
    expect($("[data-part-restore]")).toBeNull();
  });

  it("the type confirmed while another field of „Põhiinfo“ is held back (refused): the page is read again (review round 2 N-2, round 3)", async () => {
    resetRemote(DRAFT);
    remote.refuse = { part: "basics", fields: { title: "required" }, when: "title" };
    await show({ course: data({}, DRAFT) });
    await type(field("title"), "");
    await leave(field("title"));
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
    await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
    expect(remote.log.at(-1)).toEqual({ part: "basics", version: "l:basics", patch: { type: "contact" } });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a server error", 500],
    ["no connection", null],
  ])("the type's save meets %s: the cards take typing again at once, basics' own retries never freeze them, no re-read (review round 2 N-2)", async (_what, status) => {
    resetRemote(DRAFT);
    remote.fail = { part: "basics", status };
    await show({ course: data({}, DRAFT) });
    await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
    expect($("[data-cards-waiting]")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(chip()!.getAttribute("data-save-kind")).toBe("retry");
    // she types on in „Põhiinfo“ (basics: dirty, then a save that fails again): nothing waits, every keystroke lands, the focus stays
    const summary = field("summary")!;
    await act(async () => summary.focus());
    await type(summary, "Kirjutan edasi.");
    expect($("[data-cards-waiting]")).toBeNull();
    expect(summary.value).toBe("Kirjutan edasi.");
    await type(summary, "Kirjutan edasi veel.");
    expect(summary.value).toBe("Kirjutan edasi veel.");
    expect(document.activeElement).toBe(summary);
    // back online: the type goes through with the text, and only then is the page read again
    remote.fail = null;
    await leave(summary);
    expect(remote.log.at(-1)).toMatchObject({ part: "basics", patch: { type: "contact", summary: { et: "Kirjutan edasi veel.", ru: "Коротко." } } });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("the type's save refused (the type itself held back): nothing waits, typing goes on, no re-read (review round 2 N-2)", async () => {
    resetRemote(DRAFT);
    remote.refuse = { part: "basics", fields: { type: "typeLocked" } };
    await show({ course: data({}, DRAFT) });
    await click($<HTMLInputElement>("[data-type-switch] input[value='contact']"));
    expect($("[data-cards-waiting]")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    await type(field("summary"), "Edasi.");
    expect(field("summary")!.value).toBe("Edasi.");
    expect($("[data-cards-waiting]")).toBeNull();
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

describe("the list editors (Task 8): drag and arrows, removal with the UndoBar, errors by row id", () => {
  const undoBar = () => document.querySelector<HTMLElement>("[data-undo-bar]");
  const undoIt = () => click(undoBar()!.querySelector("button"));
  const outcomeTexts = () => $$<HTMLInputElement>("[data-list-editor='outcomes'] [data-lang-field]").map((f) => f.value);
  const IMAGES: DraftImage[] = [
    { key: "img/a.jpg", alt: { et: "Esimene", ru: "Первый" } },
    { key: "img/b.jpg", alt: { et: "Teine" } },
    { key: "img/c.jpg", alt: { et: "Kolmas" } },
  ];
  const THREE: CourseDraft = { ...STORED, images: IMAGES };

  it.each([
    ["after the cards have started over", "restart"],
    ["while the cards wait for the publish", "waiting"],
  ])("a row removed, then „Avalda muudatused“ starts the cards over; „Võta tagasi“ pressed %s: the row is back on the fresh form, saved once on its new version", async (_when, when) => {
    let answer!: (r: Response) => void;
    remote.avalda = () => new Promise<Response>((resolve) => (answer = resolve));
    await show();
    await click($('[data-list-editor="outcomes"] [aria-label="Eemalda rida 2"]'));
    // the removal saved at once (an instant change), and the bar offers it back
    expect(remote.log).toEqual([{ part: "outcomes", version: "l:outcomes", patch: { outcomes: [STORED.outcomes[0]] } }]);
    expect(text(undoBar()!.querySelector("p"))).toBe("Rida eemaldatud.");
    await click($("[data-publish-go]"));
    if (when === "waiting") {
      expect($("[data-cards-waiting]")).not.toBeNull();
      await undoIt();
      // it waits with the cards: nothing goes onto the version the publish is moving
      expect(remote.log.filter((x) => x.part === "outcomes")).toHaveLength(1);
    }
    await act(async () => answer(Response.json({ published: ["outcomes"], blocked: [] })));
    await settle();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // the server's new state arrives: the removal is live now, on a new version
    const live = { ...STORED, outcomes: [STORED.outcomes[0]] };
    resetRemote(live);
    remote.parts.outcomes.version = "l:outcomes-live";
    await show({ course: data({ parts: partsOf(live, { outcomes: { version: "l:outcomes-live" } }) }) });
    if (when === "restart") {
      expect(outcomeTexts()).toEqual(["Oskab mõõta"]);
      await undoIt();
    }
    await settle();
    expect(outcomeTexts()).toEqual(["Oskab mõõta", "Oskab värvida"]);
    expect(remote.log).toEqual([{ part: "outcomes", version: "l:outcomes-live", patch: { outcomes: STORED.outcomes } }]);
    expect($("[data-part-restore]")).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("a list that waits for „Avalda muudatused“ says „· avaldamata“ after its title (outcomes, protocol points, test, certificate lines, gallery); back as live, the tag goes", async () => {
    await show();
    const tagIn = (selector: string) => $(selector)?.querySelector("[data-unpublished-tag]") ?? null;
    expect($$("[data-unpublished-tag]")).toHaveLength(0);
    await click($('[data-list-editor="outcomes"] [aria-label="Eemalda rida 2"]'));
    expect(text(tagIn("[data-list-editor='outcomes'] h3"))).toBe("· avaldamata");
    await click($("[data-add-stage]"));
    expect(text(tagIn("[data-protocol-stages] h3"))).toBe("· avaldamata");
    await click($('[data-question="0"] [data-question-remove]'));
    expect(text(tagIn("[data-test-editor] h3"))).toBe("· avaldamata");
    await click($("[data-add-skill]"));
    expect(text(tagIn("[data-certificate-skills] h3"))).toBe("· avaldamata");
    await click($('#course-gallery [aria-label="Eemalda pilt 1"]'));
    expect(text(tagIn("#course-gallery h2"))).toBe("· avaldamata");
    // the picture comes back: the gallery is live again
    await undoIt();
    expect(tagIn("#course-gallery h2")).toBeNull();
    expect(text(tagIn("[data-list-editor='outcomes'] h3"))).toBe("· avaldamata");
  });

  it("an unpublished course's lists save to the record: no „· avaldamata“", async () => {
    const draft: CourseDraft = { ...STORED, published: false };
    resetRemote(draft);
    await show({ course: data({}, draft) });
    await click($('[data-list-editor="outcomes"] [aria-label="Eemalda rida 2"]'));
    expect($$("[data-unpublished-tag]")).toHaveLength(0);
  });

  it("a picture removed and brought back: the gallery saves the list without it, then with it at its place again; nothing else is asked of the server (no stored file is deleted)", async () => {
    resetRemote(THREE);
    await show({ course: data({}, THREE) });
    const before = fetched.calls.length;
    await click($('#course-gallery [aria-label="Eemalda pilt 2"]'));
    expect(text(undoBar()!.querySelector("p"))).toBe("Pilt eemaldatud.");
    await undoIt();
    expect($$("[data-gallery-item]").map((el) => el.getAttribute("data-gallery-item"))).toEqual(["img/a.jpg", "img/b.jpg", "img/c.jpg"]);
    expect(remote.log).toEqual([
      { part: "gallery", version: "l:gallery", patch: { images: [IMAGES[0], IMAGES[2]] } },
      { part: "gallery", version: "d:1.1", patch: { images: IMAGES } },
    ]);
    expect(fetched.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([`POST /api/admin/koolitus/${ID}/osa/gallery`, `POST /api/admin/koolitus/${ID}/osa/gallery`]);
  });

  it("dragging picture 3 to the top with a finger on its handle saves the new order once", async () => {
    const ROW = 120;
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.hasAttribute("data-drag-row")) return original.call(this);
      const top = Array.prototype.indexOf.call(this.parentElement!.children, this) * ROW;
      return { top, bottom: top + ROW, left: 0, right: 600, width: 600, height: ROW, x: 0, y: top, toJSON: () => ({}) };
    };
    try {
      resetRemote(THREE);
      await show({ course: data({}, THREE) });
      const handle = $$("#course-gallery [data-gallery-item]")[2].querySelector<HTMLElement>('[data-drag-tool="handle"]')!;
      const pointer = (type: string, clientY: number) =>
        act(async () => void handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", button: 0, isPrimary: true, clientY })));
      await pointer("pointerdown", 2 * ROW + 20);
      await pointer("pointermove", 10);
      await pointer("pointerup", 10);
      await settle();
      expect(remote.log).toEqual([{ part: "gallery", version: "l:gallery", patch: { images: [IMAGES[2], IMAGES[0], IMAGES[1]] } }]);
      expect($$("[data-gallery-item]").map((el) => el.getAttribute("data-gallery-item"))).toEqual(["img/c.jpg", "img/a.jpg", "img/b.jpg"]);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("a refusal of the questions is placed by what that save sent, on the question's id: moved before the answer came, the words stay on the question they are about", async () => {
    // both questions fail the check: as sent, A (no right answer) is the first problem; after the move B (no text) would be
    const A: TestQuestion = { id: "qa", kind: "choice", text: "Mis värv?", options: [{ id: "oa1", text: "Pruun", correct: false }, { id: "oa2", text: "Must", correct: false }] };
    const B: TestQuestion = { id: "qb", kind: "open", text: "" };
    const withTest: CourseDraft = { ...STORED, test: { ...STORED.test, questions: [A, B] } };
    resetRemote(withTest);
    remote.refuse = { part: "test", fields: { questions: "testNoCorrect" } };
    remote.hold = { part: "test", waiting: [] };
    await show({ course: data({}, withTest) });
    const cardOf = (id: string) => $(`[data-drag-row="${id}"] [data-question]`)!;
    await type(cardOf("qa").querySelector("[data-question-text]"), "Mis värvi?");
    await leave(cardOf("qa").querySelector("[data-question-text]"));
    expect(remote.hold.waiting).toHaveLength(1); // the save of [A, B] is on its way
    await click(cardOf("qb").querySelector('[data-drag-tool="up"]'));
    expect($$("[data-question] [data-question-text]").map((el) => (el as HTMLTextAreaElement).value)).toEqual(["", "Mis värvi?"]);
    // its answer comes: „Märgi vähemalt üks vastus õigeks.“ is about A, which is second now
    await act(async () => remote.hold!.waiting.shift()!());
    await settle();
    expect(cardOf("qa").hasAttribute("data-invalid")).toBe(true);
    expect(text(cardOf("qa"))).toContain("Märgi vähemalt üks vastus õigeks.");
    expect(cardOf("qb").hasAttribute("data-invalid")).toBe(false);
    expect(text(cardOf("qb"))).not.toContain("Märgi vähemalt üks vastus õigeks.");
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

describe("the modules card in the editor (Task 9; README B2, B18; R-b2)", () => {
  const moduleName = (id: number) => $<HTMLInputElement>(`[data-i18n="module-${id}"]`);
  const moduleCopies = () => Object.keys(localStorage).filter((k) => k.startsWith(`mslab-draft:koolitus:${ID}-moodul`));

  it("a module moved: the PublishBar's labels follow the page's new read, and a field typed but not saved in another card stays as it is (no card starts over)", async () => {
    await show();
    const summary = field("summary");
    await type(summary, "Pooleli tekst.");
    // ↑ on „Kujud“ (DragList: the same one move as a drag)
    await click($('[data-lessons-editor] [data-drag-row="2"] [data-drag-tool="up"]'));
    expect(lessonActions.moveModuleTo).toHaveBeenCalledExactlyOnceWith({ id: 2, index: 0 });
    // the action's answer brings the page's new read: the modules in their new order and the outline's labels (server/course-parts.ts courseChanges)
    await show({ course: data({ outline: ["Moodulite järjekord"] }), modules: [MODULES[1], MODULES[0]] });
    expect(field("summary")).toBe(summary); // the same node: the card did not start over
    expect(field("summary")!.value).toBe("Pooleli tekst.");
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 2 · Lühikirjeldus, Moodulite järjekord. Avalikul lehel on näha eelmine versioon.");
    expect($$("[data-lessons-editor] [data-drag-row]").map((r) => r.dataset.dragRow)).toEqual(["2", "1"]);
    expect(router.refresh).not.toHaveBeenCalled();
    // the typed text still saves, from the version the card started with
    await leave(field("summary"));
    expect(remote.log.map((s) => [s.part, s.version])).toEqual([["basics", "l:basics"]]);
  });

  it("a module's name autosaves on its own route; the page is read again for the bar's labels, and its cards do not start over", async () => {
    await show();
    await type(field("summary"), "Pooleli.");
    const summary = field("summary");
    await type(moduleName(1), "Alustame uuesti");
    await leave(moduleName(1));
    expect(remote.log.map((s) => [s.part, s.version, s.patch])).toEqual([["moodul1", "t:m1", { title: { et: "Alustame uuesti" } }]]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await show({ course: data({ outline: ["Moodul 01"] }), modules: [{ ...MODULES[0], title: { et: "Alustame uuesti" }, version: "t:m1-1", changed: true }, MODULES[1]] });
    expect(field("summary")).toBe(summary);
    expect(field("summary")!.value).toBe("Pooleli.");
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 2 · Lühikirjeldus, Moodul 01. Avalikul lehel on näha eelmine versioon.");
    expect(text($('[data-module="1"] [data-module-tag]'))).toBe("avaldamata");
  });

  it("„Avalda muudatused“ first saves a module's name still being typed, then publishes; that save asks for no read of its own", async () => {
    await show({ course: data({ outline: ["Moodul 01"] }) });
    await type(moduleName(1), "Alustame kolmandat korda");
    await click($("[data-publish-go]"));
    const order = fetched.calls.map((c) => c.url).filter((u) => u.includes("/moodul/") || u.endsWith("/avalda"));
    expect(order).toEqual(["/api/admin/moodul/1", `/api/admin/koolitus/${ID}/avalda`]);
    expect(router.refresh).toHaveBeenCalledTimes(1); // the publish's read only
  });

  it("„Loobu muudatustest“ drops a module name's copy in this browser too, and nothing is sent for it again", async () => {
    remote.fail = { part: "moodul1", status: 500 };
    await show({ course: data({ outline: ["Moodul 01"] }) });
    await type(moduleName(1), "Ei salvestu");
    await leave(moduleName(1));
    expect(moduleCopies()).toHaveLength(1);
    await click($("[data-publish-discard]"));
    await click(button("Jah, loobu"));
    expect(moduleCopies()).toEqual([]);
    const sent = remote.log.length;
    resetRemote();
    await show({ course: data() });
    await settle();
    expect(moduleName(1)!.value).toBe("Alustame");
    expect(remote.log).toHaveLength(0);
    expect(sent).toBeGreaterThan(0);
  });

  it("a module's name is in the editor's one chip and its map entry: typed, „Salvestamata muudatused“; another tab's name, „Kontrolli“ and „Taasta minu tekst“", async () => {
    await show();
    await type(moduleName(2), "Kujud ja");
    expect(chip()!.getAttribute("data-save-kind")).toBe("dirty");
    remote.modules[2] = { version: "t:other", value: { title: { et: "Teise akna nimi" } } };
    await leave(moduleName(2));
    expect(chip()!.getAttribute("data-save-kind")).toBe("conflict");
    expect(mapEntries()).toContain("Moodulid ja õppetunnid 2 · Kontrolli");
    expect(text($('[data-module="2"] [data-module-restore]'))).toBe("Taasta minu tekst");
  });

  // Which read starts the cards over (review M-1): the press's answer carries the database's stamp after its commit (server/read-stamp.ts), every page
  // read its own; only a read at or past the answer's starts them over. The router may land reads in any order and at any time.
  const publishedAfter = () => {
    const after = { ...STORED, summary: { et: "Avaldatav.", ru: "Коротко." } };
    resetRemote(after);
    remote.parts.basics.version = "l:basics-live";
    remote.avalda = () => Response.json({ published: ["basics"], blocked: [], stamp: 100 });
    return data({ parts: partsOf(after, { basics: { version: "l:basics-live" } }) });
  };

  it("a module action's read lands while a labels read is on its way, then „Avalda muudatused“: the reads from before the press start nothing, the publish's own does, and the bar is the fresh one", async () => {
    await show({ course: data({ outline: ["Moodul 01"], stamp: 10 }) });
    await type(moduleName(1), "Alustame uuesti");
    await leave(moduleName(1));
    expect(router.refresh).toHaveBeenCalledTimes(1); // the labels' read, on its way
    // a module's move: the action's read lands first (its stamp after the rename's, before the press)
    await click($('[data-lessons-editor] [data-drag-row="2"] [data-drag-tool="up"]'));
    await show({ course: data({ outline: ["Moodulite järjekord", "Moodul 02"], stamp: 20 }), modules: [MODULES[1], MODULES[0]] });
    await type(field("summary"), "Avaldatav.");
    await leave(field("summary"));
    remote.avalda = () => Response.json({ published: ["basics", "outline"], blocked: [], stamp: 100 });
    await click($("[data-publish-go]"));
    expect(router.refresh).toHaveBeenCalledTimes(2); // the publish's own
    // the labels' read lands now, from before the press: the cards keep waiting, nothing starts over
    await show({ course: data({ outline: ["Moodul 02"], stamp: 30 }), modules: [MODULES[1], MODULES[0]] });
    expect($("[data-cards-waiting]")).not.toBeNull();
    // the publish's read: the cards start over from it, and the bar is gone (live is what was published)
    const fresh = publishedAfter();
    remote.avalda = () => Response.json({ published: [], blocked: [] });
    await show({ course: { ...fresh, stamp: 120 }, modules: [{ ...MODULES[1] }, { ...MODULES[0], title: { et: "Alustame uuesti" }, version: "t:m1-1" }] });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(bar()).toBeNull();
    await type(field("summary"), "Veel üks.");
    await leave(field("summary"));
    expect(remote.log.at(-1)).toMatchObject({ part: "basics", version: "l:basics-live" });
  });

  it("„Loobu muudatustest“: a read from before its answer starts nothing; one at the answer's stamp starts the cards over from live", async () => {
    remote.loobu = () => Response.json({ discarded: 1, stamp: 200 });
    await show({ course: data({ outline: ["Moodul 01"], stamp: 10 }) });
    await type(field("summary"), "Ära.");
    await leave(field("summary"));
    await click($("[data-publish-discard]"));
    await click(button("Jah, loobu"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // a read asked before the press lands after it: still the draft's version; nothing starts over
    await show({ course: data({ outline: ["Moodul 01"], stamp: 150, parts: partsOf(STORED, { basics: { version: "d:1.1", value: { ...partValue("basics", STORED), summary: { et: "Ära." } } } }) }) });
    expect($("[data-cards-waiting]")).not.toBeNull();
    // the read at the answer's stamp (at, not only past it): live, and the cards start from it
    resetRemote();
    await show({ course: data({ stamp: 200 }) });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(field("summary")!.value).toBe("Lühike tekst.");
    expect(bar()).toBeNull();
  });

  it("two of the router's reads in one render (only the later one seen): it is past the answer, the cards start over — nothing waits for a read already seen", async () => {
    await show({ course: data({ stamp: 10 }) });
    await type(field("summary"), "Avaldatav.");
    await leave(field("summary"));
    remote.avalda = () => Response.json({ published: ["basics"], blocked: [], stamp: 100 });
    await click($("[data-publish-go]"));
    expect($("[data-cards-waiting]")).not.toBeNull();
    const fresh = publishedAfter();
    await show({ course: { ...fresh, stamp: 180 } });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(bar()).toBeNull();
  });

  it("„Näidissisu“: a read that lands before the switch's answer leaves the box as asked; the answer's stamp decides — its own read may come first, or after", async () => {
    let answer: (v: unknown) => void = () => {};
    actions.sample.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await show({ course: data({ stamp: 10 }) });
    const sample = () => $<HTMLInputElement>("[data-field='isSample']")!;
    await click(sample());
    expect(sample().checked).toBe(true);
    // a read asked before the press (a labels read) lands: the stored state is still the old one, the box stays as asked
    await show({ course: data({ stamp: 20 }) });
    expect(sample().checked).toBe(true);
    // the answer, then an older read: still as asked; the action's own read: the stored state
    await act(async () => answer({ ok: true, stamp: 50 }));
    await settle();
    expect(sample().checked).toBe(true);
    await show({ course: data({ stamp: 30 }) });
    expect(sample().checked).toBe(true);
    await show({ course: data({ isSample: true, stamp: 60 }) });
    expect(sample().checked).toBe(true);
    // the other way round: the action's read before its answer — once the answer says its stamp, the box shows the stored state at once
    actions.sample.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await click(sample());
    expect(sample().checked).toBe(false);
    await show({ course: data({ isSample: false, stamp: 90 }) });
    await act(async () => answer({ ok: true, stamp: 80 }));
    await settle();
    expect(sample().checked).toBe(false);
    // and then a later click is taken (nothing asked any more)
    actions.sample.mockResolvedValue({ ok: true, stamp: 95 });
    await click(sample());
    expect(actions.sample).toHaveBeenLastCalledWith({ id: ID, on: true });
  });

  it("a contact course whose draft makes it an e-course: the card follows the drafted „Õppevorm“ (lessons and „Lisa õppetund“)", async () => {
    const contact: CourseDraft = { ...STORED, type: "contact", price: "", priceGroup: "350" };
    const drafted = { ...partValue("basics", contact), type: "e_learning" as const };
    await show({ course: data({ liveType: "contact", parts: partsOf(contact, { basics: { version: "d:1.1", value: drafted } }) }, contact) });
    expect($("[data-lessons-editor] h2")!.textContent).toBe("Moodulid ja õppetunnid");
    expect($('[data-add-lesson="1"]')).not.toBeNull();
  });
});
