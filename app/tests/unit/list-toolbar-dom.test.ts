// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withListParams } from "@/components/admin/list-params";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { ListEmpty } from "@/components/admin/ListStates";
import { adminEt } from "@/i18n/dict/admin";

// ListToolbar (admin UX pass, README §1.10, screens §2.7): the search field, the filter pills with their counts, an optional scope select and the
// count line. All of it lives in the URL: typing waits 300 ms and then `router.replace`s `?otsi=` (a new search starts at page 1: `leht` goes), the
// ✕ clears at once, the select applies on change, and the field keeps its focus through every replace. ListEmpty is the two empty texts, and
// withListParams keeps the list's address in a drawer's close link. Fake timers: the 300 ms are the real code's.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

let container: HTMLDivElement;
let root: Root;

type Props = Parameters<typeof ListToolbar>[0];
const PLACEHOLDER = "Otsi nime, e-posti või telefoni järgi";
let props: Props;
const draw = () => act(async () => root.render(createElement(ListToolbar, props)));
/** Shows the toolbar at an address (the page's own, as the browser has it). */
async function show(url: string, over: Partial<Props> = {}) {
  window.history.replaceState(null, "", url);
  props = { placeholder: PLACEHOLDER, ...over };
  await draw();
}
/** The address changes by itself (Back, a link, the router having caught up with a replace). */
async function go(url: string) {
  window.history.replaceState(null, "", url);
  await draw();
}

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const field = () => $<HTMLInputElement>("input[type=search]")!;
const clear = () => $<HTMLButtonElement>("[data-search-clear]");
const select = () => $<HTMLSelectElement>("select")!;
const type = async (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  router.replace.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ListToolbar: search", () => {
  it("typing waits 300 ms, then router.replace(?otsi=…) with leht dropped and the other params kept", async () => {
    await show("/admin/registreerimised?staatus=ootab&leht=3");
    await type("kas");
    await wait(299);
    expect(router.replace).not.toHaveBeenCalled();
    await wait(1);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?staatus=ootab&otsi=kas", { scroll: false });
  });

  it("each keystroke starts the 300 ms again: one replace, with the last text", async () => {
    await show("/admin/registreerimised");
    await type("k");
    await wait(200);
    await type("kas");
    await wait(200);
    expect(router.replace).not.toHaveBeenCalled();
    await wait(100);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?otsi=kas", { scroll: false });
  });

  it("the text is sent as it is typed, trimmed: a phone number keeps its + and spaces", async () => {
    await show("/admin/opilased");
    await type("  +372 5000 0007 ");
    await wait(300);
    expect(router.replace).toHaveBeenCalledWith("/admin/opilased?otsi=%2B372+5000+0007", { scroll: false });
  });

  it("an emptied field takes ?otsi= away (and leht with it)", async () => {
    await show("/admin/opilased?vorm=e&otsi=kas&leht=2");
    expect(field().value).toBe("kas");
    await type("   ");
    await wait(300);
    expect(router.replace).toHaveBeenCalledWith("/admin/opilased?vorm=e", { scroll: false });
  });

  it("a text that is the address's search already (a trailing space) sends nothing", async () => {
    await show("/admin/opilased?otsi=kas");
    await type("kas ");
    await wait(300);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("Enter sends it at once", async () => {
    await show("/admin/opilased?leht=4");
    await type("kati");
    await act(async () => void field().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/opilased?otsi=kati", { scroll: false });
    await wait(300);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("the field is a labelled search box: the label is the page's placeholder", async () => {
    await show("/admin/opilased");
    expect(field().placeholder).toBe(PLACEHOLDER);
    expect(field().getAttribute("aria-label")).toBe(PLACEHOLDER);
    expect(field().maxLength).toBe(100);
    expect(field().closest("form")?.getAttribute("role")).toBe("search");
  });

  it("the ✕ is there only while there is text; it clears at once, drops leht and keeps the focus in the field", async () => {
    await show("/admin/registreerimised?staatus=ootab");
    expect(clear()).toBeNull();
    await type("kas");
    expect(clear()).not.toBeNull();
    expect(clear()!.getAttribute("aria-label")).toBe(adminEt.lists.clearSearch);
    await wait(300);
    router.replace.mockClear();
    await go("/admin/registreerimised?staatus=ootab&otsi=kas&leht=2");
    await act(async () => void field().focus());
    await click(clear()!);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?staatus=ootab", { scroll: false });
    expect(field().value).toBe("");
    expect(clear()).toBeNull();
    expect(document.activeElement).toBe(field());
  });

  it("the ✕ also cancels a search still waiting for its 300 ms", async () => {
    await show("/admin/opilased?otsi=kati");
    await type("kati ma");
    await click(clear()!);
    await wait(300);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/opilased", { scroll: false });
  });

  it("the field keeps its focus and its text while the address catches up with a replace", async () => {
    await show("/admin/opilased");
    await act(async () => void field().focus());
    const input = field();
    await type("ka");
    await wait(300);
    expect(router.replace).toHaveBeenCalledWith("/admin/opilased?otsi=ka", { scroll: false });
    await type("kas"); // typed while the first replace is on its way
    await go("/admin/opilased?otsi=ka"); // …and it arrives: not what the field says now, but what we sent
    expect(field()).toBe(input);
    expect(field().value).toBe("kas");
    expect(document.activeElement).toBe(input);
    await wait(300);
    expect(router.replace).toHaveBeenLastCalledWith("/admin/opilased?otsi=kas", { scroll: false });
  });

  it("two replaces on their way (a slow page): the older one arriving first does not take the newer text back", async () => {
    await show("/admin/opilased");
    await act(async () => void field().focus());
    await type("ka");
    await wait(300);
    await type("kas");
    await wait(300);
    expect(router.replace.mock.calls.map((c) => c[0])).toEqual(["/admin/opilased?otsi=ka", "/admin/opilased?otsi=kas"]);
    await go("/admin/opilased?otsi=ka");
    expect(field().value).toBe("kas");
    expect(document.activeElement).toBe(field());
    await go("/admin/opilased?otsi=kas");
    expect(field().value).toBe("kas");
    // both have arrived: an address that is neither is somebody else's (Back)
    await go("/admin/opilased?otsi=ka");
    expect(field().value).toBe("ka");
    expect(router.replace).toHaveBeenCalledTimes(2);
  });

  it("an address that changes from outside (Back, „Tühjenda otsing ja filtrid“) is shown in the field and cancels what was waiting", async () => {
    await show("/admin/opilased?otsi=kas");
    await type("kas ma");
    await go("/admin/opilased");
    expect(field().value).toBe("");
    await wait(300);
    expect(router.replace).not.toHaveBeenCalled();
    await go("/admin/opilased?otsi=mari");
    expect(field().value).toBe("mari");
  });

  it("the search field is a 48 px pill (the stylesheet)", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/ListToolbar.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const search = /\.search \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(search).toMatch(/min-height:\s*48px;/);
    expect(search).toMatch(/border-radius:\s*99px;/);
    // the ✕ is a 44 px target
    expect(/\.clear \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/min-width:\s*44px;[^}]*min-height:\s*44px;|width:\s*44px;[^}]*height:\s*44px;/);
  });
});

describe("ListToolbar: scope select", () => {
  const scope: NonNullable<Props["scope"]> = {
    label: "Koolitus ja toimumine",
    name: "toimumine",
    value: "",
    options: [
      { value: "", label: "Kõik koolitused ja toimumised" },
      { value: "7", label: "Pärnu 05.12" },
      { value: "9", label: "Tallinn 12.12" },
    ],
  };

  it("shows the options, the current one chosen, and a label for the screen reader", async () => {
    await show("/admin/registreerimised?toimumine=9", { scope: { ...scope, value: "9" } });
    expect(Array.from(select().options).map((o) => [o.value, o.textContent])).toEqual(scope.options.map((o) => [o.value, o.label]));
    expect(select().value).toBe("9");
    expect(select().getAttribute("aria-label")).toBe("Koolitus ja toimumine");
    expect(select().name).toBe("toimumine");
  });

  it("applies on change: router.replace with the param set, leht dropped and the rest kept", async () => {
    await show("/admin/registreerimised?staatus=ootab&leht=2&otsi=kas", { scope });
    await act(async () => {
      select().value = "7";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?staatus=ootab&otsi=kas&toimumine=7", { scroll: false });
  });

  it("shows the choice at once, and follows the address when that changes (Back)", async () => {
    await show("/admin/registreerimised", { scope });
    await act(async () => {
      select().value = "7";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select().value).toBe("7"); // the address has not arrived yet
    props = { ...props, scope: { ...scope, value: "9" } };
    await go("/admin/registreerimised?toimumine=9");
    expect(select().value).toBe("9");
    props = { ...props, scope };
    await go("/admin/registreerimised");
    expect(select().value).toBe("");
  });

  it("the empty option takes the param away", async () => {
    await show("/admin/registreerimised?toimumine=7&leht=3", { scope: { ...scope, value: "7" } });
    await act(async () => {
      select().value = "";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised", { scroll: false });
  });

  it("there is no select without a scope", async () => {
    await show("/admin/registreerimised");
    expect($("select")).toBeNull();
  });
});

describe("ListToolbar: pills and the count line", () => {
  const pills: NonNullable<Props["pills"]> = [
    { href: "/admin/registreerimised", label: "Kõik", count: 42, current: false },
    { href: "/admin/registreerimised?staatus=ootab", label: "Ootab ettemaksu", count: 5, current: true },
    { href: "/admin/registreerimised?staatus=tuhistatud", label: "Tühistatud", current: false },
  ];

  it("pills are links with their count bubble; the current one has aria-current", async () => {
    await show("/admin/registreerimised?staatus=ootab", { pills, pillsLabel: "Staatus" });
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(pills.map((p) => p.href));
    expect(links.map((a) => a.textContent)).toEqual(["Kõik42", "Ootab ettemaksu5", "Tühistatud"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "true", null]);
    const bubbles = Array.from(container.querySelectorAll("a > span")).filter((s) => /^\d+$/.test(s.textContent ?? ""));
    expect(bubbles.map((s) => s.textContent)).toEqual(["42", "5"]);
    expect(bubbles[0].className).toMatch(/pillCount/);
    expect(links[0].className).toMatch(/pill/);
    expect($("nav")!.getAttribute("aria-label")).toBe("Staatus");
  });

  it("a count of 0 is shown (it is a number, not a missing one)", async () => {
    await show("/admin/registreerimised", { pills: [{ href: "/x", label: "Viga", count: 0, current: false }] });
    expect($("a")!.textContent).toBe("Viga0");
  });

  it("there is no pill row without pills", async () => {
    await show("/admin/registreerimised");
    expect($("nav")).toBeNull();
    expect($("a")).toBeNull();
  });

  it("the count line is the page's own text", async () => {
    await show("/admin/registreerimised", { countLine: "Registreerimisi: 42" });
    expect($("[data-list-count]")!.textContent).toBe("Registreerimisi: 42");
    await show("/admin/registreerimised");
    expect($("[data-list-count]")).toBeNull();
  });
});

describe("ListEmpty", () => {
  const empty = (p: Parameters<typeof ListEmpty>[0]) => act(async () => root.render(createElement(ListEmpty, p)));

  it("nothing exists: „{Asju} veel pole.“ and no button", async () => {
    await empty({ things: "registreerimisi", filtered: false });
    expect(container.textContent).toBe("Registreerimisi veel pole.");
    expect($("a")).toBeNull();
    await empty({ things: "õpilasi", filtered: false });
    expect(container.textContent).toBe("Õpilasi veel pole.");
  });

  it("filtered: „Selle valikuga {asju} pole.“ + „Tühjenda otsing ja filtrid“, a link to the unfiltered list", async () => {
    await empty({ things: "registreerimisi", filtered: true, clearHref: "/admin/registreerimised" });
    expect($("[data-list-empty]")!.textContent).toBe("Selle valikuga registreerimisi pole.Tühjenda otsing ja filtrid");
    const link = $<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("Tühjenda otsing ja filtrid");
    expect(link.getAttribute("href")).toBe("/admin/registreerimised");
  });

  it("filtered without a clearHref has the text only", async () => {
    await empty({ things: "makseid", filtered: true });
    expect(container.textContent).toBe("Selle valikuga makseid pole.");
    expect($("a")).toBeNull();
  });

  it("the sentence frames are the README's (§1.10)", () => {
    expect(adminEt.lists).toEqual({
      empty: "{Asju} veel pole.",
      emptyFiltered: "Selle valikuga {asju} pole.",
      clearAll: "Tühjenda otsing ja filtrid",
      clearSearch: "Tühjenda otsing",
      count: "{Asju}: {n}",
    });
  });
});

describe("withListParams", () => {
  const sp = (q: string) => new URLSearchParams(q);

  it("copies the list's search, filters and page onto a link, but not the drawer's id", () => {
    expect(withListParams("/admin/opilased", sp("vorm=e&otsi=kas&leht=2&id=17"))).toBe("/admin/opilased?vorm=e&otsi=kas&leht=2");
  });

  it("keeps what the link sets itself", () => {
    expect(withListParams("/admin/opilased?vorm=k", sp("vorm=e&otsi=kas"))).toBe("/admin/opilased?vorm=k&otsi=kas");
    expect(withListParams("/admin/opilased?id=3", sp("id=17&otsi=kas"))).toBe("/admin/opilased?id=3&otsi=kas");
  });

  it("a link with no list state stays as it is; the hash is kept at the end", () => {
    expect(withListParams("/admin/opilased", sp(""))).toBe("/admin/opilased");
    expect(withListParams("/admin/opilased", sp("id=17"))).toBe("/admin/opilased");
    expect(withListParams("/admin/arved#arveta", sp("kuu=2026-10"))).toBe("/admin/arved?kuu=2026-10#arveta");
  });

  it("encodes values and keeps repeated params", () => {
    expect(withListParams("/admin/maksed", sp("otsi=%2B372+5000"))).toBe("/admin/maksed?otsi=%2B372+5000");
    expect(withListParams("/admin/maksed", sp("a=1&a=2"))).toBe("/admin/maksed?a=1&a=2");
  });
});

describe("list tables (the stylesheet)", () => {
  const css = readFileSync(join(process.cwd(), "src/components/admin/list-table.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("a row becomes a block of label/value lines below a 760 px card, no longer below 980", () => {
    expect(css).toMatch(/@container \(max-width: 760px\)/);
    expect(css).not.toMatch(/980px/);
  });

  it("the name link is stretched over its row with ::after, and the controls in a row stay above it", () => {
    expect(css).toMatch(/a\.name::after \{[^}]*content: "";[^}]*position: absolute;/);
    expect(css).toMatch(/\.table a:not\(\.name\),[^{]*\{[^}]*position: relative;[^}]*z-index: 2;/);
  });
});
