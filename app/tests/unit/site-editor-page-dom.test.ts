// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_TIMEOUT_MS } from "@/components/admin/autosave/constants";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { SiteEditorPage, type SiteApis, type SiteEditorProps } from "@/components/admin/site/SiteEditorPage";
import type { SectionEntry } from "@/components/admin/SectionMap";
import type { PackageDraft } from "@/domain/site-editor";
import type { SitePartState } from "@/domain/site-entities";
import { stubFetch } from "../fakes";

// The site editors' page shell (admin UX pass piece 4a, Task 2; README §4 "the site-editor template", §1.8; piece4-texts S4-1, S4-2): the header
// (eyebrow, H1, lead, ET | RU, ONE SaveStatus for every part, „Vaata lehel ↗“), the PublishBar naming the drafts' changes row by row, the 170 px
// section map when there are 4 or more cards, then the cards. Every part autosaves into its draft (POST /api/admin/sisu/<entity>/0/osa/<part>);
// „Avalda muudatused“ and „Loobu muudatustest“ first send what waits (one bound, SAVE_TIMEOUT_MS), then POST …/avalda or …/loobu, and the page is
// read again: the parts start over from a read at or past the answer's stamp. Here with Praktika's two packages and the routes answered in the test.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/praktika",
  useSearchParams: () => new URLSearchParams(),
}));

const pkg = (code: string, price: string, items: string[]): PackageDraft => ({
  name: { et: code },
  tagline: { et: "Lühike tekst" },
  models: "2",
  durationLabel: { et: "1 päev" },
  price,
  items: items.map((et) => ({ et })),
});
const MINI = pkg("MINI", "100", ["2 modelli", "Tagasiside"]);
const MAXI = pkg("MAXI", "150", ["4 modelli", "Tagasiside", "Fotod"]);
const CODES = ["MINI", "MAXI"] as const;
/** Praktika's parts by package code, as the screen types them (SiteEditorPage's generic parts). */
type Practice = Record<string, PackageDraft>;

/** The parts as the page reads them (server/site-drafts.ts readSiteEditor): live with no drafts, unless `over` says otherwise. */
function partsOf(over: Partial<Record<string, Partial<SitePartState>>> = {}): Record<string, SitePartState> {
  const live: Record<string, PackageDraft> = { MINI, MAXI };
  return Object.fromEntries(CODES.map((code) => [code, { version: `l:${code}`, value: live[code], live: live[code], ...over[code] }]));
}

/** The routes: each part's version and value; a save from another version is a 409; a save is a draft „d:<n>.<k>“. `log`: the saves in order. */
const remote = {
  parts: {} as Record<string, { version: string; value: Record<string, unknown> }>,
  n: 0,
  /** A part whose saves never answer (the request hangs until the browser gives it up). */
  hang: null as string | null,
  /** A part whose saves the server's check refuses with these field codes. */
  refuse: null as null | { part: string; fields: Record<string, string> },
  /** A part whose saves answer a server error. */
  fail: null as string | null,
  avalda: (): Response | Promise<Response> => Response.json({ stamp: 5, published: ["MAXI"], blocked: [] }),
  loobu: (): Response | Promise<Response> => Response.json({ stamp: 5 }),
  log: [] as { part: string; version: string; patch: Record<string, unknown> }[],
};
function resetRemote() {
  remote.parts = Object.fromEntries(CODES.map((code) => [code, { version: `l:${code}`, value: { ...(code === "MINI" ? MINI : MAXI) } }]));
  remote.n = 0;
  remote.hang = null;
  remote.fail = null;
  remote.refuse = null;
  remote.avalda = () => Response.json({ stamp: 5, published: ["MAXI"], blocked: [] });
  remote.loobu = () => Response.json({ stamp: 5 });
  remote.log = [];
}
const respond = (url: string, init: RequestInit | undefined): Response | Promise<Response> => {
  const press = url.match(/^\/api\/admin\/sisu\/practice\/0\/(avalda|loobu)$/);
  if (press) return press[1] === "avalda" ? remote.avalda() : remote.loobu();
  const m = url.match(/^\/api\/admin\/sisu\/practice\/0\/osa\/(\w+)$/);
  if (!m) return Response.json({ ok: false }, { status: 404 });
  const part = m[1];
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push({ part, ...body });
  if (remote.hang === part)
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
  if (remote.fail === part) return Response.json({ ok: false, error: "server" }, { status: 500 });
  if (remote.refuse?.part === part) return Response.json({ ok: false, error: "invalid", fields: remote.refuse.fields }, { status: 400 });
  const stored = remote.parts[part];
  if (body.version !== stored.version) return Response.json({ ok: false, error: "conflict", version: stored.version, value: stored.value }, { status: 409 });
  remote.n += 1;
  stored.value = { ...stored.value, ...body.patch };
  stored.version = `d:${part === "MINI" ? 1 : 2}.${remote.n}`;
  return Response.json({ ok: true, version: stored.version, savedAt: "2026-10-26T10:41:00.000Z" });
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

/** The cards: each package's price, typed (set) and left (flush), and its points (a row's text through `update`), as a screen's fields do. */
const cards = (apis: SiteApis<Practice>) =>
  createElement(
    Fragment,
    null,
    CODES.map((code) => {
      const api = apis[code];
      return createElement(
        "section",
        { key: code, id: `pakett-${code}`, "data-card": code },
        createElement("input", {
          "aria-label": `${code} hind`,
          "data-field": `${code}.price`,
          value: api.fields.price,
          onChange: (e: { target: { value: string } }) => api.set("price", e.target.value),
          onBlur: () => void api.flush(),
        }),
        api.fields.items.map((item, i) =>
          createElement("input", {
            key: i,
            "aria-label": `${code} punkt ${i + 1}`,
            "data-field": `${code}.items.${i}`,
            value: item.et,
            onChange: (e: { target: { value: string } }) => api.update("items", (items) => items.map((x, j) => (j === i ? { ...x, et: e.target.value } : x))),
            onBlur: () => void api.flush(),
          }),
        ),
      );
    }),
  );

type Props = SiteEditorProps<Practice>;
const props = (over: Partial<Props> = {}): Props => ({
  entity: "practice",
  eyebrow: "Koolitused",
  title: "Praktikapaketid",
  lead: "MINI ja MAXI pakett.",
  viewHref: "/praktika",
  previewPath: "/praktika",
  parts: partsOf(),
  // (the read's stamp: the tests' reads are older than a press's answer, stamp 5, unless a test says otherwise)
  stamp: 1,
  render: cards,
  ...over,
});
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(SiteEditorPage<Practice>, props(over))));
  await settle();
};

const type = async (el: Element | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const leave = async (el: Element | null) => {
  await act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const field = (name: string) => $<HTMLInputElement>(`[data-field="${name}"]`);
const chip = () => $("[data-save-status]");
const bar = () => $("[data-publish-bar]");
const button = (name: string) => $$<HTMLButtonElement>("button").find((b) => text(b) === name) ?? null;
/** The requests to a route, in order: „osa/MAXI“, „avalda“, „loobu“. */
const posts = () => fetched.calls.filter((c) => c.method === "POST").map((c) => c.url.replace("/api/admin/sisu/practice/0/", ""));
const copies = () => Object.keys(localStorage).filter((k) => k.startsWith("mslab-draft:site:practice:"));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

beforeEach(() => {
  localStorage.clear();
  resetRemote();
  fetched = stubFetch(respond);
  router.refresh.mockReset();
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

describe("the header and the one chip", () => {
  it("eyebrow, H1, lead, ET | RU, one SaveStatus and „Vaata lehel ↗“ (a new tab); no bar while nothing waits", async () => {
    await show();
    expect(text($("[data-site-eyebrow]"))).toBe("Koolitused");
    expect(text($("h1"))).toBe("Praktikapaketid");
    expect(text($("[data-site-lead]"))).toBe("MINI ja MAXI pakett.");
    expect($("[data-edit-lang-switch]")).not.toBeNull();
    const view = $<HTMLAnchorElement>("[data-site-view]")!;
    expect(text(view)).toBe("Vaata lehel ↗ (avaneb uues aknas)");
    expect(view.getAttribute("href")).toBe("/praktika");
    expect(view.getAttribute("target")).toBe("_blank");
    expect($$("[data-save-status]")).toHaveLength(1);
    expect(bar()).toBeNull();
  });

  it("one chip for both parts: either part typed makes it „Salvestamata muudatused“; both saved, „Mustand salvestatud {HH:MM}“", async () => {
    await show();
    await type(field("MINI.price"), "110");
    expect($$("[data-save-status]")).toHaveLength(1);
    expect(chip()!.getAttribute("data-save-kind")).toBe("dirty");
    await leave(field("MINI.price"));
    await type(field("MAXI.price"), "155");
    expect(chip()!.getAttribute("data-save-kind")).toBe("dirty");
    await leave(field("MAXI.price"));
    expect($$("[data-save-status]")).toHaveLength(1);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(text(chip()!.querySelector("[role=status]"))).toBe("Mustand salvestatud 12:41");
    // each part saved its own field to its own route, from its own version
    expect(remote.log.map((s) => [s.part, s.version, s.patch])).toEqual([
      ["MINI", "l:MINI", { price: "110" }],
      ["MAXI", "l:MAXI", { price: "155" }],
    ]);
  });
});

describe("the PublishBar", () => {
  it("names the drafts' changes row by row (S4-34), with the preview of the public page in draft mode", async () => {
    await show();
    await type(field("MAXI.price"), "155");
    await leave(field("MAXI.price"));
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MAXI hind. Avalikul lehel on näha eelmine versioon.");
    expect($<HTMLAnchorElement>("[data-publish-preview]")!.getAttribute("href")).toBe(`/api/admin/eelvaade?tee=${encodeURIComponent("/praktika")}`);
    // all three buttons on every bar (README §1.8)
    expect($("[data-publish-discard]")).not.toBeNull();
    expect($("[data-publish-go]")).not.toBeNull();
    // typed back to live: no bar
    await type(field("MAXI.price"), "150");
    expect(bar()).toBeNull();
  });

  it("„Avalda muudatused“ flushes a pending edit before the publish POST, then the page is read again", async () => {
    await show();
    await type(field("MAXI.price"), "155");
    // (still being typed: its save has not gone)
    expect(remote.log).toEqual([]);
    await click($("[data-publish-go]"));
    expect(posts()).toEqual(["osa/MAXI", "avalda"]);
    expect(remote.log).toEqual([{ part: "MAXI", version: "l:MAXI", patch: { price: "155" } }]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("the parts start over from a read at or past the answer's stamp; an older read starts nothing", async () => {
    await show();
    await type(field("MAXI.price"), "155");
    await leave(field("MAXI.price"));
    await click($("[data-publish-go]"));
    expect($("[data-cards-waiting]")).not.toBeNull();
    // a read from before the press (stamp 4 < 5): the cards still wait for theirs
    await show({ parts: partsOf({ MAXI: { version: remote.parts.MAXI.version, value: { ...MAXI, price: "155" } } }), stamp: 4 });
    expect($("[data-cards-waiting]")).not.toBeNull();
    // the publish's own read: MAXI is live now, at its new live version
    const published = { ...MAXI, price: "155" };
    remote.parts.MAXI = { version: "l:MAXI-2", value: published };
    await show({ parts: partsOf({ MAXI: { version: "l:MAXI-2", value: published, live: published } }), stamp: 5 });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(bar()).toBeNull();
    expect(field("MAXI.price")!.value).toBe("155");
    // the chip keeps the publish's time until a save of its own
    expect(text(chip()!.querySelector("[role=status]"))).toMatch(/^Salvestatud \d\d:\d\d$/);
    await type(field("MAXI.price"), "160");
    await leave(field("MAXI.price"));
    expect(remote.log.at(-1)).toEqual({ part: "MAXI", version: "l:MAXI-2", patch: { price: "160" } });
  });

  it("a blocked answer renders „Puudub: …“ under the bar and reads nothing; the part's next save takes the line away", async () => {
    remote.avalda = () => Response.json({ stamp: 5, published: [], blocked: [{ part: "MAXI", reason: "missing", fields: ["MAXI hind"] }] });
    await show();
    await type(field("MAXI.price"), "");
    await leave(field("MAXI.price"));
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-blocked]"))).toBe("Puudub: MAXI hind");
    expect(router.refresh).not.toHaveBeenCalled();
    expect($("[data-cards-waiting]")).toBeNull();
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MAXI hind. Avalikul lehel on näha eelmine versioon.");
    await type(field("MAXI.price"), "175");
    await leave(field("MAXI.price"));
    expect($("[data-publish-blocked]")).toBeNull();
  });

  it("a press straight after typing, answered „blocked“ only: „Puudub: MAXI hind“ stays on the bar — the press's own save is counted (review I-1)", async () => {
    remote.avalda = () => Response.json({ stamp: 5, published: [], blocked: [{ part: "MAXI", reason: "missing", fields: ["MAXI hind"] }] });
    await show({ sections: (apis) => CODES.flatMap((code) => [{ id: code, label: code, ...(apis[code].attention ? { flag: "check" as const } : {}) }, { id: `${code}-2`, label: `${code} 2` }]) });
    await type(field("MAXI.price"), "");
    // (not left: the press itself sends the edit)
    await click($("[data-publish-go]"));
    expect(posts()).toEqual(["osa/MAXI", "avalda"]);
    expect(text($("[data-publish-blocked]"))).toBe("Puudub: MAXI hind");
    // and the part's map entry says „Kontrolli“
    expect($$("nav[aria-label='Jaotised'] [data-flag]").map((el) => el.closest("a")!.getAttribute("href"))).toEqual(["#MAXI"]);
    // the part's next save takes the line away
    await type(field("MAXI.price"), "175");
    await leave(field("MAXI.price"));
    expect($("[data-publish-blocked]")).toBeNull();
  });

  it("the parts that were published leave the bar; the one held stays on it with its „Puudub: …“", async () => {
    remote.avalda = () => Response.json({ stamp: 5, published: ["MINI"], blocked: [{ part: "MAXI", reason: "missing", fields: ["MAXI hind"] }] });
    await show();
    await type(field("MINI.price"), "110");
    await leave(field("MINI.price"));
    await type(field("MAXI.price"), "");
    await leave(field("MAXI.price"));
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 2 · MINI hind, MAXI hind. Avalikul lehel on näha eelmine versioon.");
    await click($("[data-publish-go]"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const mini = { ...MINI, price: "110" };
    const maxi = { ...MAXI, price: "" };
    await show({ parts: partsOf({ MINI: { version: "l:MINI-2", value: mini, live: mini }, MAXI: { version: remote.parts.MAXI.version, value: maxi } }), stamp: 5 });
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · MAXI hind. Avalikul lehel on näha eelmine versioon.");
    expect(text($("[data-publish-blocked]"))).toBe("Puudub: MAXI hind");
  });

  it("the publish carries every part's version as the screen holds it after its flush, `{ versions }` (final review I-1)", async () => {
    await show();
    await type(field("MINI.price"), "110");
    await leave(field("MINI.price"));
    expect(remote.parts.MINI.version).toBe("d:1.1");
    // MAXI still being typed: the press's own flush saves it first, and its version after that save is the one sent
    await type(field("MAXI.price"), "155");
    await click($("[data-publish-go]"));
    expect(posts()).toEqual(["osa/MINI", "osa/MAXI", "avalda"]);
    const press = fetched.calls.find((c) => c.url.endsWith("/avalda"))!;
    expect(press.body).toEqual({ versions: { MINI: "d:1.1", MAXI: "d:2.2" } });
    expect(press.headers.get("content-type")).toBe("application/json");
  });

  it("a part held as changed (another window saved its draft after this screen's read): the page is read again, and the bar lists it until its next save", async () => {
    remote.avalda = () => Response.json({ stamp: 5, published: [], blocked: [{ part: "MAXI", reason: "changed", fields: ["MAXI hind"] }] });
    await show();
    await type(field("MAXI.price"), "155");
    await leave(field("MAXI.price"));
    await click($("[data-publish-go]"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect($("[data-cards-waiting]")).not.toBeNull();
    // the read: the other window's newer draft is on the screen, under the bar's words for a change made meanwhile
    const newer = { ...MAXI, price: "170" };
    remote.parts.MAXI = { version: "d:2.9", value: newer };
    await show({ parts: partsOf({ MAXI: { version: "d:2.9", value: newer } }), stamp: 5 });
    expect($("[data-cards-waiting]")).toBeNull();
    expect(field("MAXI.price")!.value).toBe("170");
    expect(text($("[data-blocked-changed]"))).toBe("Neid välju ei avaldatud, sest neid muudeti vahepeal teises aknas. Vaata need üle.");
    expect(text($("[data-publish-blocked] li"))).toBe("MAXI hind");
    // her next save of the part takes the line away (from the version the read gave)
    await type(field("MAXI.price"), "175");
    await leave(field("MAXI.price"));
    expect(remote.log.at(-1)).toEqual({ part: "MAXI", version: "d:2.9", patch: { price: "175" } });
    expect($("[data-publish-blocked]")).toBeNull();
  });

  it("a publish that fails says so on the bar and keeps the cards as they are", async () => {
    remote.avalda = () => Response.json({ ok: false, error: "server" }, { status: 500 });
    await show();
    await type(field("MAXI.price"), "155");
    await leave(field("MAXI.price"));
    await click($("[data-publish-go]"));
    expect(text($("[data-publish-error]"))).toBe("Avaldamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-cards-waiting]")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    await type(field("MAXI.price"), "156");
    expect(field("MAXI.price")!.value).toBe("156");
  });

  it("„Loobu muudatustest“ → confirm → the POST; every copy in this browser goes, and after the read the fields show live", async () => {
    await show();
    await type(field("MINI.price"), "110");
    await leave(field("MINI.price"));
    await type(field("MAXI.price"), "155");
    await click($("[data-publish-discard]"));
    expect(text($("[data-confirm-panel]"))).toContain("Kas loobun 2 muudatusest? Avalikul lehel jääb praegune versioon.");
    await click(button("Jah, loobu"));
    // the edit still being typed was sent first, then the discard
    expect(posts()).toEqual(["osa/MINI", "osa/MAXI", "loobu"]);
    expect(copies()).toEqual([]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // the read after the discard: live, no drafts
    resetRemote();
    const sent = fetched.calls.length;
    await show({ parts: partsOf(), stamp: 5 });
    expect(field("MINI.price")!.value).toBe("100");
    expect(field("MAXI.price")!.value).toBe("150");
    expect(bar()).toBeNull();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(fetched.calls).toHaveLength(sent);
  });

  it("a discard whose POST passes the bound (its outcome unknown): this browser's copies go, so the next read's parts do not bring the discarded text back (review M-4)", async () => {
    fakeClock();
    try {
      // MAXI's price is held back by the server's check: its text is kept in this browser's copy
      remote.refuse = { part: "MAXI", fields: { price: "amount" } };
      remote.loobu = () => new Promise<Response>(() => {});
      await show();
      await type(field("MAXI.price"), "abc");
      await leave(field("MAXI.price"));
      expect(copies()).toHaveLength(1);
      await click($("[data-publish-discard]"));
      await click(button("Jah, loobu"));
      expect(posts().at(-1)).toBe("loobu");
      await wait(SAVE_TIMEOUT_MS);
      expect(copies()).toEqual([]);
      expect(router.refresh).toHaveBeenCalledTimes(1);
      // the next read (the discard did land: live, no drafts) starts the parts over; nothing comes back from this browser, nothing is sent
      resetRemote();
      const saves = remote.log.length;
      await show({ parts: partsOf(), stamp: 6 });
      await wait(2000);
      expect(field("MAXI.price")!.value).toBe("150");
      expect(copies()).toEqual([]);
      expect(remote.log).toHaveLength(saves);
      expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a publish while a save hangs waits at most SAVE_TIMEOUT_MS, then shows the save's failure, not a publish", async () => {
    fakeClock();
    try {
      remote.hang = "MAXI";
      await show();
      await type(field("MAXI.price"), "155");
      await click($("[data-publish-go]"));
      expect(bar()!.getAttribute("aria-busy")).toBe("true");
      expect($("[data-cards-waiting]")).not.toBeNull();
      await wait(SAVE_TIMEOUT_MS - 1000);
      expect($("[data-cards-waiting]")).not.toBeNull();
      expect(posts()).toEqual(["osa/MAXI"]);
      await wait(1000);
      expect($("[data-cards-waiting]")).toBeNull();
      expect(bar()!.getAttribute("aria-busy")).toBeNull();
      expect(chip()!.getAttribute("data-save-kind")).toBe("retry");
      expect(posts()).not.toContain("avalda");
      expect($("[data-publish-error]")).toBeNull();
      // the text is still there, and in this browser's copy
      expect(field("MAXI.price")!.value).toBe("155");
      expect(copies()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the site screens' stricter publish (requireSaved; final review I-2, M-1): a save that did not go through publishes nothing", () => {
  const cases = [
    {
      name: "refused by the server's check (400)",
      kind: "invalid",
      arrange: () => void (remote.refuse = { part: "MAXI", fields: { price: "amount" } }),
    },
    { name: "failing (500)", kind: "retry", arrange: () => void (remote.fail = "MAXI") },
    {
      name: "in conflict with another window's text (409)",
      kind: "conflict",
      arrange: () => void (remote.parts.MAXI = { version: "d:2.9", value: { ...MAXI, price: "170" } }),
    },
  ] as const;

  for (const c of cases) {
    it(`a save ${c.name}, then „Avalda muudatused“: no publish POST, the cards take typing again, the chip says why and is brought into view`, async () => {
      c.arrange();
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
      await show();
      await type(field("MAXI.price"), "abc");
      await leave(field("MAXI.price"));
      expect(chip()!.getAttribute("data-save-kind")).toBe(c.kind);
      scrolled.mockClear();
      const go = $<HTMLButtonElement>("[data-publish-go]")!;
      go.focus();
      await click(go);
      expect(posts()).not.toContain("avalda");
      expect($("[data-cards-waiting]")).toBeNull();
      expect(router.refresh).not.toHaveBeenCalled();
      expect($("[data-publish-error]")).toBeNull();
      expect(chip()!.getAttribute("data-save-kind")).toBe(c.kind);
      // she pressed at the bar: the page brings the chip into view (no new words), and the focus goes to its „Näita“ when it has one
      expect(scrolled.mock.contexts).toContain(chip());
      const showLink = chip()!.querySelector("button");
      if (c.kind === "invalid") {
        expect(text(showLink)).toBe("Näita");
        expect(document.activeElement).toBe(showLink);
      } else {
        expect(showLink).toBeNull();
        expect(document.activeElement).toBe(go);
      }
      // the text is still there to correct, and the cards take typing
      expect(field("MAXI.price")!.value).toBe("abc");
      await type(field("MAXI.price"), "abcd");
      expect(field("MAXI.price")!.value).toBe("abcd");
    });
  }

  it("the chip's „Näita“ then puts the cursor in the field held back", async () => {
    remote.refuse = { part: "MAXI", fields: { price: "amount" } };
    await show();
    await type(field("MAXI.price"), "abc");
    await leave(field("MAXI.price"));
    await click($("[data-publish-go]"));
    expect(document.activeElement).toBe(chip()!.querySelector("button"));
    await click(chip()!.querySelector("button"));
    expect(document.activeElement).toBe(field("MAXI.price"));
  });
});

describe("a part's own options (partOptions → useSitePart)", () => {
  it("a screen's check before a save holds the field back without a request; the chip says „Salvestamata — kontrolli märgitud välja“", async () => {
    await show({ partOptions: { MAXI: { validate: (f): Record<string, string> => (f.price === "x" ? { price: "amount" } : {}) } } });
    await type(field("MAXI.price"), "x");
    await leave(field("MAXI.price"));
    expect(remote.log).toEqual([]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
    expect(text(chip()!.querySelector("[role=status]"))).toBe("Salvestamata — kontrolli märgitud välja");
    await type(field("MAXI.price"), "160");
    await leave(field("MAXI.price"));
    expect(remote.log.map((s) => [s.part, s.patch])).toEqual([["MAXI", { price: "160" }]]);
  });
});

describe("the leave guard", () => {
  it("leaving with a point's change the server did not take: the notice names the row as the bar does („MAXI punkt 2“, S4-1)", async () => {
    remote.fail = "MAXI";
    // (Next's Link stands in on the menu link: reached only when the guard lets the click through)
    const followed = vi.fn((e: MouseEvent) => e.preventDefault());
    document.addEventListener("click", followed);
    try {
      const menu = createElement("a", { href: "/admin/kalender", "data-menu": "" }, "Kalender");
      await act(async () => root.render(createElement(LeaveGuardProvider, null, menu, createElement(SiteEditorPage<Practice>, props()))));
      await settle();
      await type(field("MAXI.items.1"), "Tagasiside protokolliga");
      await click($("[data-menu]"));
      expect(router.push).not.toHaveBeenCalled();
      expect(text($("[data-leave-title]"))).toBe("Muudatust „MAXI punkt 2“ ei saanud veel salvestada.");
      // „Jää siia“ goes back to that row's field
      await click($$<HTMLButtonElement>("[data-leave-notice] button").find((b) => text(b) === "Jää siia") ?? null);
      expect(document.activeElement).toBe(field("MAXI.items.1"));
    } finally {
      document.removeEventListener("click", followed);
    }
  });
});

describe("the section map", () => {
  const sections = (n: number): SectionEntry[] => Array.from({ length: n }, (_, i) => ({ id: `kaart-${i}`, label: `Kaart ${i + 1}` }));

  it("4 or more cards: the map at 170 px beside the cards; fewer: none", async () => {
    await show({ sections: sections(4) });
    const nav = $("nav[aria-label='Jaotised']")!;
    expect(nav).not.toBeNull();
    expect(nav.className).toContain("narrow");
    expect($$("nav[aria-label='Jaotised'] a")).toHaveLength(4);
    await show({ sections: sections(3) });
    expect($("nav[aria-label='Jaotised']")).toBeNull();
    expect($("[data-section-select]")).toBeNull();
  });

  it("the entries may follow the parts (a count, „Kontrolli“): a function of the parts' state", async () => {
    await show({ sections: (apis) => CODES.flatMap((code) => [{ id: `pakett-${code}`, label: code, count: (apis[code].fields.items as unknown[]).length }, { id: `${code}-2`, label: `${code} 2` }]) });
    expect($$("nav[aria-label='Jaotised'] a").map((a) => text(a))).toEqual(["MINI2", "MINI 2", "MAXI3", "MAXI 2"]);
  });
});
