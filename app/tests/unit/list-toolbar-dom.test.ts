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

  it("Päringud has two lists on a page (the open ones, and the fold „Tehtud“): a new search starts both at page 1 (leht and tehtud go)", async () => {
    await show("/admin/paringud?liik=praktika&leht=3&tehtud=2");
    await type("liis");
    await wait(300);
    expect(router.replace).toHaveBeenCalledWith("/admin/paringud?liik=praktika&otsi=liis", { scroll: false });
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

  it("the toolbar is one shrinkable column, so a long option in the scope select (a long city or course title) never widens it past the phone (the stylesheet)", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/ListToolbar.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // (a grid item's minimum width is its content: with the default auto column the select's widest option set the width of the whole toolbar)
    expect(/\.toolbar \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    expect(/\.select \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/max-width:\s*100%;/);
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
  // The page builds each option's address (it knows the other filters), so one select can set `?koolitus=` (a whole course) or `?toimumine=` (one session).
  const scope: NonNullable<Props["scope"]> = {
    label: "Koolitus ja toimumine",
    value: "",
    options: [
      { value: "", label: "Kõik koolitused ja toimumised", href: "/admin/registreerimised?staatus=ootab" },
      { value: "k3", label: "Kulmumeistri baaskoolitus", href: "/admin/registreerimised?staatus=ootab&koolitus=3" },
      { value: "t7", label: "Pärnu 05.12", href: "/admin/registreerimised?staatus=ootab&toimumine=7" },
      { value: "t9", label: "Tallinn 12.12", href: "/admin/registreerimised?staatus=ootab&toimumine=9" },
    ],
  };
  const choose = (value: string) =>
    act(async () => {
      select().value = value;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("shows the options, the current one chosen, and a label for the screen reader", async () => {
    await show("/admin/registreerimised?staatus=ootab&toimumine=9", { scope: { ...scope, value: "t9" } });
    expect(Array.from(select().options).map((o) => [o.value, o.textContent])).toEqual(scope.options.map((o) => [o.value, o.label]));
    expect(select().value).toBe("t9");
    expect(select().getAttribute("aria-label")).toBe("Koolitus ja toimumine");
  });

  it("applies on change: router.replace with the option's own address (the page's), leht not in it", async () => {
    await show("/admin/registreerimised?staatus=ootab&leht=2", { scope });
    await choose("t7");
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?staatus=ootab&toimumine=7", { scroll: false });
  });

  it("one select sets either parameter: a course (?koolitus=) or a session (?toimumine=)", async () => {
    await show("/admin/registreerimised?staatus=ootab", { scope });
    await choose("k3");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/registreerimised?staatus=ootab&koolitus=3", { scroll: false });
    await go("/admin/registreerimised?staatus=ootab&koolitus=3");
    await choose("t9");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/registreerimised?staatus=ootab&toimumine=9", { scroll: false });
  });

  it("an option's address with a page in it goes without it: a new filter starts at page 1", async () => {
    await show("/admin/registreerimised?leht=3", { scope: { ...scope, options: [{ value: "t7", label: "Pärnu", href: "/admin/registreerimised?leht=3&toimumine=7" }] } });
    await choose("t7");
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?toimumine=7", { scroll: false });
  });

  it("the search typed so far goes with the choice (the page built the address before it was typed)", async () => {
    await show("/admin/registreerimised?staatus=ootab", { scope });
    await type("kas");
    await choose("t7");
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?staatus=ootab&toimumine=7&otsi=kas", { scroll: false });
  });

  it("the search in the option's address stays when nothing else is typed, and an emptied field takes it away", async () => {
    const withSearch = { ...scope, options: scope.options.map((o) => ({ ...o, href: `${o.href}&otsi=kas` })) };
    await show("/admin/registreerimised?staatus=ootab&otsi=kas", { scope: withSearch });
    await choose("t7");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/registreerimised?staatus=ootab&toimumine=7&otsi=kas", { scroll: false });
    await go("/admin/registreerimised?staatus=ootab&toimumine=7&otsi=kas");
    await type("");
    await choose("t9");
    expect(router.replace).toHaveBeenLastCalledWith("/admin/registreerimised?staatus=ootab&toimumine=9", { scroll: false });
  });

  it("shows the choice at once, and follows the address when that changes (Back)", async () => {
    await show("/admin/registreerimised", { scope });
    await choose("t7");
    expect(select().value).toBe("t7"); // the address has not arrived yet
    props = { ...props, scope: { ...scope, value: "t9" } };
    await go("/admin/registreerimised?toimumine=9");
    expect(select().value).toBe("t9");
    props = { ...props, scope };
    await go("/admin/registreerimised");
    expect(select().value).toBe("");
  });

  it("the empty option goes to the address without the parameter", async () => {
    await show("/admin/registreerimised?staatus=ootab&toimumine=7&leht=3", { scope: { ...scope, value: "t7" } });
    await choose("");
    expect(router.replace).toHaveBeenCalledWith("/admin/registreerimised?staatus=ootab", { scroll: false });
  });

  it("choosing what the list is showing already sends nothing", async () => {
    await show("/admin/registreerimised?staatus=ootab", { scope });
    await choose("");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("there is no select without a scope", async () => {
    await show("/admin/registreerimised");
    expect($("select")).toBeNull();
  });
});

describe("ListToolbar: pill rows and the count line", () => {
  const status: NonNullable<Props["pillRows"]>[number] = {
    label: "Staatus",
    pills: [
      { href: "/admin/registreerimised", label: "Kõik", count: 42, current: false },
      { href: "/admin/registreerimised?staatus=ootab", label: "Ootab ettemaksu", count: 5, current: true },
      { href: "/admin/registreerimised?staatus=tuhistatud", label: "Tühistatud", current: false },
    ],
  };
  const kind: NonNullable<Props["pillRows"]>[number] = {
    label: "Vorm",
    pills: [
      { href: "/admin/registreerimised?staatus=ootab", label: "Kõik vormid", count: 5, current: false },
      { href: "/admin/registreerimised?staatus=ootab&vorm=e", label: "E-õpe", count: 2, current: false },
      { href: "/admin/registreerimised?staatus=ootab&vorm=k", label: "Kontaktõpe", count: 3, current: true },
    ],
  };
  const rowLinks = (nav: Element) => Array.from(nav.querySelectorAll<HTMLAnchorElement>("a"));

  it("a row is a nav under its own label; its pills are links with their count bubble, the current one has aria-current", async () => {
    await show("/admin/registreerimised?staatus=ootab", { pillRows: [status] });
    const navs = container.querySelectorAll("nav");
    expect(navs).toHaveLength(1);
    expect(navs[0].getAttribute("aria-label")).toBe("Staatus");
    const links = rowLinks(navs[0]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(status.pills.map((p) => p.href));
    expect(links.map((a) => a.textContent)).toEqual(["Kõik42", "Ootab ettemaksu5", "Tühistatud"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "true", null]);
    const bubbles = Array.from(navs[0].querySelectorAll("a > span")).filter((s) => /^\d+$/.test(s.textContent ?? ""));
    expect(bubbles.map((s) => s.textContent)).toEqual(["42", "5"]);
    expect(bubbles[0].className).toMatch(/pillCount/);
    expect(links[0].className).toMatch(/pill/);
  });

  it("two rows render side by side in the markup's order, each under its own label, each with its own current pill", async () => {
    await show("/admin/registreerimised?staatus=ootab&vorm=k", { pillRows: [status, kind] });
    const navs = Array.from(container.querySelectorAll("nav"));
    expect(navs.map((n) => n.getAttribute("aria-label"))).toEqual(["Staatus", "Vorm"]);
    expect(rowLinks(navs[0]).map((a) => a.textContent)).toEqual(["Kõik42", "Ootab ettemaksu5", "Tühistatud"]);
    expect(rowLinks(navs[1]).map((a) => a.textContent)).toEqual(["Kõik vormid5", "E-õpe2", "Kontaktõpe3"]);
    expect(rowLinks(navs[0]).map((a) => a.getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect(rowLinks(navs[1]).map((a) => a.getAttribute("aria-current"))).toEqual([null, null, "true"]);
    // one current pill in each row, none shared
    expect(container.querySelectorAll('a[aria-current="true"]')).toHaveLength(2);
  });

  it("a count of 0 is shown (it is a number, not a missing one)", async () => {
    await show("/admin/registreerimised", { pillRows: [{ label: "Staatus", pills: [{ href: "/x", label: "Viga", count: 0, current: false }] }] });
    expect($("a")!.textContent).toBe("Viga0");
  });

  it("a light row (tone: „light“, the prototype's form pills) says so on its nav, carries no count when the page gives none; the first row does not", async () => {
    const light: NonNullable<Props["pillRows"]>[number] = {
      label: "Õppevorm",
      tone: "light",
      pills: [
        { href: "/admin/registreerimised", label: "Kõik vormid", current: false },
        { href: "/admin/registreerimised?vorm=e", label: "E-õpe", current: false },
        { href: "/admin/registreerimised?vorm=k", label: "Kontaktõpe", current: true },
      ],
    };
    await show("/admin/registreerimised?staatus=ootab&vorm=k", { pillRows: [status, light] });
    const navs = Array.from(container.querySelectorAll("nav"));
    expect(navs.map((n) => n.getAttribute("data-tone"))).toEqual([null, "light"]);
    expect(rowLinks(navs[1]).map((a) => a.textContent)).toEqual(["Kõik vormid", "E-õpe", "Kontaktõpe"]);
    expect(navs[1].querySelectorAll("a > span")).toHaveLength(0); // no bubbles
    expect(rowLinks(navs[1]).map((a) => a.getAttribute("aria-current"))).toEqual([null, null, "true"]);
  });

  it("the stylesheet draws the chosen pill of a light row as the first-light fill with the ink border, and leaves the first row's ink fill alone", () => {
    const css = readFileSync(join(process.cwd(), "src/components/admin/ListToolbar.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const light = /\.pills\[data-tone="light"\] a\[aria-current="true"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(light).toMatch(/border-color:\s*var\(--ink\);/);
    expect(light).toMatch(/background:\s*var\(--first\);/);
    expect(light).toMatch(/color:\s*var\(--ink\);/);
    // (the ink fill of a chosen pill is ui .pill's own: nothing here touches a row without the tone)
    expect(css).not.toMatch(/\.pills a\[aria-current/);
  });

  it("there is no row without pills, and no nav without rows", async () => {
    await show("/admin/registreerimised");
    expect($("nav")).toBeNull();
    expect($("a")).toBeNull();
    await show("/admin/registreerimised", { pillRows: [] });
    expect($("nav")).toBeNull();
    await show("/admin/registreerimised", { pillRows: [{ label: "Staatus", pills: [] }, kind] });
    expect(Array.from(container.querySelectorAll("nav")).map((n) => n.getAttribute("aria-label"))).toEqual(["Vorm"]);
  });

  it("the count line is the page's own text", async () => {
    await show("/admin/registreerimised", { countLine: "Registreerimisi: 42" });
    expect($("[data-list-count]")!.textContent).toBe("Registreerimisi: 42");
    await show("/admin/registreerimised");
    expect($("[data-list-count]")).toBeNull();
  });

  it("the parts keep their order: search and scope, then the pill rows, then the count line", async () => {
    await show("/admin/registreerimised", {
      pillRows: [status, kind],
      countLine: "Registreerimisi: 42",
      scope: { label: "Koolitus", value: "", options: [{ value: "", label: "Kõik", href: "/admin/registreerimised" }] },
    });
    const order = Array.from(container.querySelectorAll("[role=search], select, nav, [data-list-count]")).map((e) => e.getAttribute("role") ?? e.tagName.toLowerCase());
    expect(order).toEqual(["search", "select", "nav", "nav", "p"]);
  });
});

describe("ListToolbar: one address for every replace", () => {
  // Next keeps one navigation at a time: a replace started while another is on its way discards the first, so the second must carry
  // everything the first did. Every replace is built from the address the list is heading for, not the one on the screen. The scope's
  // addresses are the page's, built before the search was typed: the search goes onto the one chosen.
  const scope: NonNullable<Props["scope"]> = {
    label: "Koolitus ja toimumine",
    value: "",
    options: [
      { value: "", label: "Kõik koolitused ja toimumised", href: "/admin/registreerimised" },
      { value: "7", label: "Pärnu 05.12", href: "/admin/registreerimised?toimumine=7" },
    ],
  };
  const choose = (value: string) =>
    act(async () => {
      select().value = value;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
  const link = (name: string) => Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((a) => a.textContent?.startsWith(name))!;
  const pillRows: NonNullable<Props["pillRows"]> = [
    {
      label: "Staatus",
      pills: [
        { href: "/admin/registreerimised", label: "Kõik", count: 4, current: true },
        { href: "/admin/registreerimised?staatus=ootab", label: "Ootab", count: 2, current: false },
      ],
    },
  ];
  const calls = () => router.replace.mock.calls.map((c) => c[0]);

  it("a search on its way, then a scope: the scope replace carries the search, and the address that arrives has both", async () => {
    await show("/admin/registreerimised?leht=2", { scope });
    await type("kas");
    await wait(300);
    await choose("7"); // the search has not arrived yet
    expect(calls()).toEqual(["/admin/registreerimised?otsi=kas", "/admin/registreerimised?toimumine=7&otsi=kas"]);
    // Next dropped the first replace: the address goes straight to the second
    props = { ...props, scope: { ...scope, value: "7" } };
    await go("/admin/registreerimised?toimumine=7&otsi=kas");
    expect(field().value).toBe("kas");
    expect(select().value).toBe("7");
    await wait(300);
    expect(router.replace).toHaveBeenCalledTimes(2);
  });

  it("a scope on its way, then a search: the search replace carries the scope", async () => {
    await show("/admin/registreerimised", { scope });
    await choose("7");
    await type("kas");
    await wait(300);
    expect(calls()).toEqual(["/admin/registreerimised?toimumine=7", "/admin/registreerimised?toimumine=7&otsi=kas"]);
    props = { ...props, scope: { ...scope, value: "7" } };
    await go("/admin/registreerimised?toimumine=7&otsi=kas");
    expect(select().value).toBe("7");
    expect(field().value).toBe("kas");
  });

  it("text still waiting for its 300 ms goes with the scope change at once, and the timer is not left behind", async () => {
    await show("/admin/registreerimised?staatus=ootab", {
      scope: { ...scope, options: scope.options.map((o) => ({ ...o, href: `${o.href}${o.href.includes("?") ? "&" : "?"}staatus=ootab` })) },
    });
    await type("kas");
    await wait(100);
    await choose("7");
    expect(calls()).toEqual(["/admin/registreerimised?toimumine=7&staatus=ootab&otsi=kas"]);
    await wait(500);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("once a replace has arrived the next one is built from the address as it is now", async () => {
    await show("/admin/registreerimised", { scope });
    await type("kas");
    await wait(300);
    await go("/admin/registreerimised?otsi=kas");
    await choose("7");
    expect(calls()[1]).toBe("/admin/registreerimised?toimumine=7&otsi=kas");
    await go("/admin/registreerimised?toimumine=7&otsi=kas");
    await type("kask");
    await wait(300);
    expect(calls()[2]).toBe("/admin/registreerimised?toimumine=7&otsi=kask");
  });

  it("a pill clicked while a search is still waiting: the search is dropped (sent after the click it would take the pill's navigation away), and the field follows the address", async () => {
    container.addEventListener("click", (e) => e.preventDefault()); // happy-dom must not try to follow the link
    await show("/admin/registreerimised", { pillRows });
    await type("kas");
    await wait(100);
    await click(link("Ootab"));
    await wait(500);
    expect(router.replace).not.toHaveBeenCalled();
    await go("/admin/registreerimised?staatus=ootab"); // the pill's address: no search
    expect(field().value).toBe("");
    expect(clear()).toBeNull();
  });

  it("a pill clicked while a search is on its way: the pill's address wins, and the field and the list agree on it", async () => {
    container.addEventListener("click", (e) => e.preventDefault());
    await show("/admin/registreerimised", { pillRows });
    await type("kas");
    await wait(300);
    expect(calls()).toEqual(["/admin/registreerimised?otsi=kas"]);
    await click(link("Ootab")); // Next drops the search's replace and goes to the pill
    await go("/admin/registreerimised?staatus=ootab");
    expect(field().value).toBe("");
    await type("mari");
    await wait(300);
    expect(calls()[1]).toBe("/admin/registreerimised?staatus=ootab&otsi=mari"); // built from where the list is, not from the dropped search
  });

  it("a pill of the second row drops a waiting search the same way", async () => {
    container.addEventListener("click", (e) => e.preventDefault());
    const rows: NonNullable<Props["pillRows"]> = [
      ...pillRows,
      { label: "Vorm", pills: [{ href: "/admin/registreerimised?vorm=e", label: "E-õpe", count: 1, current: false }] },
    ];
    await show("/admin/registreerimised", { pillRows: rows });
    await type("kas");
    await wait(100);
    await click(link("E-õpe"));
    await wait(500);
    expect(router.replace).not.toHaveBeenCalled();
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

  it("a search with no hit says so with the words typed: „{q}“ järgi {asju} ei leitud. (piece 2 texts P-9), and offers the same button", async () => {
    await empty({ things: "registreerimisi", filtered: true, search: "Kati 5", clearHref: "/admin/registreerimised" });
    expect($("[data-list-empty]")!.textContent).toBe("„Kati 5“ järgi registreerimisi ei leitud.Tühjenda otsing ja filtrid");
    expect($<HTMLAnchorElement>("a")!.getAttribute("href")).toBe("/admin/registreerimised");
    // the text is data, not markup
    await empty({ things: "makseid", filtered: true, search: "<b>x</b>" });
    expect(container.textContent).toBe("„<b>x</b>“ järgi makseid ei leitud.");
    expect($("b")).toBeNull();
  });

  it("no search typed (only a filter) keeps „Selle valikuga …“; nothing filtered ignores the search", async () => {
    await empty({ things: "registreerimisi", filtered: true, search: "", clearHref: "/admin/registreerimised" });
    expect($("[data-list-empty]")!.textContent).toBe("Selle valikuga registreerimisi pole.Tühjenda otsing ja filtrid");
    await empty({ things: "registreerimisi", filtered: false, search: "Kati" });
    expect(container.textContent).toBe("Registreerimisi veel pole.");
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
      emptySearch: "„{q}“ järgi {asju} ei leitud.",
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
