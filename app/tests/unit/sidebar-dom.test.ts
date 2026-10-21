// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type NavItem, type TodayCard } from "@/components/admin/Sidebar";
import { GROUPS, SECTIONS } from "@/components/admin/sections";
import { adminEt } from "@/i18n/dict/admin";

// The admin menu (admin UX pass, README §1.1 and §1.2): the groups in the design's order, the folding group, the footer, and the phone bar
// with its menu. The address comes from a mocked next/navigation (the sidebar reads its active entry from it).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockPath = "/admin";
let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const EMAIL = "maria@example.test";
const FOLD_KEY = "mslab-nav-fold";

const t = adminEt.shell;
const sidebarTexts = {
  label: t.label,
  nav: t.nav,
  home: t.home,
  openMenu: t.openMenu,
  closeMenu: t.closeMenu,
  viewSite: t.preview,
  newWindow: t.newWindow,
  signedIn: t.signedIn,
  logout: t.logout,
  groups: adminEt.nav.groups,
  today: t.today,
  todayLine: t.todayLine,
};

const badge = (n: number, label: string) => ({ n, label });
const items = (badges: Partial<Record<string, NavItem["badge"]>> = {}): NavItem[] =>
  SECTIONS.map((s) => ({ ...s, label: adminEt.nav[s.key], badge: badges[s.key] }));
const BADGES = { registrations: badge(3, "3 ootab ettemaksu"), assessment: badge(2, "2 ootab hindamist"), requests: badge(7, "7 tegemata") };

let container: HTMLDivElement;
let root: Root;

type Over = { today?: TodayCard | null; badges?: Partial<Record<string, NavItem["badge"]>>; total?: number };
const element = ({ today = null, badges = {}, total = 0 }: Over = {}) =>
  createElement(Sidebar, { items: items(badges), t: sidebarTexts, total, email: EMAIL, today });
const show = (over?: Over) => act(async () => root.render(element(over)));
const at = async (path: string, search = "", over?: Over) => {
  mockPath = path;
  mockSearch = search;
  await show(over);
};

const aside = () => container.querySelector("aside")!;
const dialog = () => container.querySelector("dialog")!;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const labelsIn = (scope: Element) => Array.from(scope.querySelectorAll("[data-nav-group]")).map(text);
const itemsOf = (scope: Element, group: string) =>
  Array.from(scope.querySelectorAll(`[data-nav-items="${group}"] [data-nav-item]`)).map((li) => li.getAttribute("data-nav-item"));
const foldButton = () => aside().querySelector<HTMLButtonElement>("button[data-nav-fold]")!;
const foldList = () => aside().querySelector<HTMLElement>('[data-nav-items="site"]')!;
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const current = (scope: Element) => scope.querySelector('a[aria-current="page"]')?.getAttribute("data-nav");
const openMenu = () => click(container.querySelector("[data-admin-menu]"));
const iconPath = (el: Element | null) => el?.querySelector("svg path")?.getAttribute("d");

beforeEach(() => {
  mockPath = "/admin";
  mockSearch = "";
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  document.documentElement.style.overflow = "";
});

describe("the sidebar: groups", () => {
  it("groups in the design's order", async () => {
    await show();
    expect(labelsIn(aside())).toEqual(["Igapäevane töö", "Koolitused", "Koduleht ja uudiskiri", "Haldus"]);
    expect(itemsOf(aside(), "daily")).toEqual(["registrations", "protocols", "assessment", "requests", "clients", "feedback", "payments"]);
    expect(itemsOf(aside(), "courses")).toEqual(["courses", "calendar", "practice"]);
    expect(itemsOf(aside(), "site")).toEqual(["home", "trainer", "news", "campaign", "newsletter"]);
    expect(itemsOf(aside(), "admin")).toEqual(["settings", "testing"]);
  });

  it("the overview stands first with no label, and the menu holds every section exactly once", async () => {
    await show();
    const nav = aside().querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Halduse menüü");
    const lists = Array.from(nav.querySelectorAll("ul"));
    expect(lists).toHaveLength(5);
    expect(Array.from(lists[0].querySelectorAll("[data-nav-item]")).map((li) => li.getAttribute("data-nav-item"))).toEqual(["overview"]);
    expect(lists[0].hasAttribute("aria-labelledby")).toBe(false);
    // every other list is named by its heading
    for (const ul of lists.slice(1)) expect(nav.querySelector(`[id="${ul.getAttribute("aria-labelledby")}"]`)?.hasAttribute("data-nav-group")).toBe(true);
    const keys = Array.from(nav.querySelectorAll("[data-nav-item]")).map((li) => li.getAttribute("data-nav-item"));
    expect(keys).toEqual(SECTIONS.map((s) => s.key));
    expect(GROUPS.flatMap((g) => g.items)).toEqual(SECTIONS.map((s) => s.key));
    expect(GROUPS.map((g) => g.id)).toEqual([null, "daily", "courses", "site", "admin"]);
    expect(GROUPS.filter((g) => g.fold).map((g) => g.id)).toEqual(["site"]);
  });

  it("labels: „Maksed ja arved“, „Protokollid“, „Testimine“, each on its own address", async () => {
    await show();
    const link = (key: string) => aside().querySelector<HTMLAnchorElement>(`a[data-nav="${key}"]`)!;
    expect([text(link("payments")), link("payments").getAttribute("href")]).toEqual(["Maksed ja arved", "/admin/maksed"]);
    expect([text(link("protocols")), link("protocols").getAttribute("href")]).toEqual(["Protokollid", "/admin/protokollid"]);
    expect([text(link("testing")), link("testing").getAttribute("href")]).toEqual(["Testimine", "/admin/testimine"]);
    expect(iconPath(link("protocols"))).toBe(iconPath(link("registrations"))); // both the clipboard
    expect(iconPath(link("testing"))).toBe(iconPath(link("assessment"))); // both the check
  });

  it("the group labels are stored in sentence case (CSS shows the capitals)", () => {
    expect(adminEt.nav.groups).toEqual({ daily: "Igapäevane töö", courses: "Koolitused", site: "Koduleht ja uudiskiri", admin: "Haldus" });
  });

  it("marks the entry of the address, and follows the address", async () => {
    await at("/admin/maksed");
    expect(current(aside())).toBe("payments");
    await at("/admin/arved");
    expect(current(aside())).toBe("payments");
    await at("/admin/protokollid", "?ligipaas=5");
    expect(current(aside())).toBe("assessment");
    await at("/admin/testimine");
    expect(current(aside())).toBe("testing");
  });

  it("the badges stay where they are, with their words for a screen reader", async () => {
    await show({ badges: BADGES, total: 12 });
    const b = (key: string) => aside().querySelector(`[data-badge="${key}"]`);
    expect([text(b("registrations")), text(b("assessment")), text(b("requests"))]).toEqual(["3, 3 ootab ettemaksu", "2, 2 ootab hindamist", "7, 7 tegemata"]);
    expect(b("payments")).toBeNull();
  });
});

describe("the sidebar: the folding group „Koduleht ja uudiskiri“", () => {
  it("is a 44 px button that is closed on a page outside the group, and opens on a tap", async () => {
    await at("/admin/maksed");
    const button = foldButton();
    expect(button.tagName).toBe("BUTTON");
    expect(Array.from(button.children).map(text)).toEqual(["Koduleht ja uudiskiri", "▸"]);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(foldList().id);
    expect(foldList().hidden).toBe(true);
    // the plain headings are not buttons
    expect(aside().querySelectorAll("button[data-nav-fold]")).toHaveLength(1);
    expect(aside().querySelectorAll("p[data-nav-group]")).toHaveLength(3);

    await click(button);
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    expect(Array.from(foldButton().children).map(text)).toEqual(["Koduleht ja uudiskiri", "▾"]);
    expect(foldList().hidden).toBe(false);
    expect(localStorage.getItem(FOLD_KEY)).toBe("open");

    await click(foldButton());
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");
    expect(foldList().hidden).toBe(true);
    expect(localStorage.getItem(FOLD_KEY)).toBe("closed");
  });

  it("is open whenever the page is inside it, whatever was chosen, and then a tap leaves it open", async () => {
    localStorage.setItem(FOLD_KEY, "closed");
    for (const [path, key] of [["/admin/avaleht", "home"], ["/admin/koolitaja", "trainer"], ["/admin/uudised/4", "news"], ["/admin/kampaania", "campaign"], ["/admin/uudiskiri", "newsletter"]]) {
      await at(path);
      expect(foldButton().getAttribute("aria-expanded"), path).toBe("true");
      expect(foldList().hidden, path).toBe(false);
      expect(current(aside()), path).toBe(key);
    }
    await click(foldButton());
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(FOLD_KEY)).toBe("closed"); // the choice is not touched by a page that forces it open
    // away from the group, the stored choice rules again
    await at("/admin/kalender");
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("follows the stored choice on a page outside the group", async () => {
    localStorage.setItem(FOLD_KEY, "open");
    await at("/admin/kalender");
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    localStorage.setItem(FOLD_KEY, "closed");
    await at("/admin/seaded");
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");
    localStorage.setItem(FOLD_KEY, "something else");
    await at("/admin/seaded");
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("reads and writes the choice inside try/catch: a browser that refuses storage still gets a working fold", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await at("/admin/maksed");
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");
    await click(foldButton());
    expect(foldButton().getAttribute("aria-expanded")).toBe("true");
    await click(foldButton());
    expect(foldButton().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the sidebar: the footer", () => {
  it("„Sisse logitud“, the e-mail, „Logi välja“ — and no „Vaata lehte“", async () => {
    await show();
    const foot = aside().querySelector("[data-nav-foot]")!;
    expect(Array.from(foot.children).map(text)).toEqual(["Sisse logitud", EMAIL, "Logi välja"]);
    const logout = foot.querySelector("form")!;
    expect([logout.method.toLowerCase(), logout.getAttribute("action")]).toEqual(["post", "/api/auth/logout"]);
    expect(logout.querySelector("button")!.type).toBe("submit");
    expect(text(aside())).not.toContain("Vaata lehte");
    expect(text(aside())).not.toContain("Vaata kodulehte");
    expect(aside().querySelector("a[href='/api/admin/preview']")).toBeNull();
    expect(aside().querySelector("[data-admin-view-site]")).toBeNull();
  });
});

describe("the phone bar and its menu", () => {
  it("shows the name of the current page on the left, and the logo on the overview", async () => {
    await at("/admin/registreerimised");
    const bar = container.querySelector("header")!;
    expect(text(bar.querySelector("[data-admin-bar-title]"))).toBe("Registreerimised");
    expect(bar.querySelector("img")).toBeNull();
    await at("/admin/arved");
    expect(text(container.querySelector("header [data-admin-bar-title]"))).toBe("Maksed ja arved");
    await at("/admin");
    expect(container.querySelector("header [data-admin-bar-title]")).toBeNull();
    expect(container.querySelector("header img")).not.toBeNull();
  });

  it("the first HTML (rendered with no browser) holds the menu once, with the entry marked, the fold and the bar's title right: no fallback copy follows", () => {
    mockPath = "/admin/avaleht";
    mockSearch = "";
    const html = document.createElement("div");
    html.innerHTML = renderToString(element());
    expect(html.querySelectorAll("aside")).toHaveLength(1);
    expect(html.querySelectorAll("dialog")).toHaveLength(1);
    expect(current(html.querySelector("aside")!)).toBe("home");
    expect(html.querySelector("button[data-nav-fold]")!.getAttribute("aria-expanded")).toBe("true");
    expect(html.querySelector<HTMLElement>('[data-nav-items="site"]')!.hidden).toBe(false);
    expect(text(html.querySelector("header [data-admin-bar-title]"))).toBe("Avaleht");
    expect(html.querySelector("header img")).toBeNull();
    mockPath = "/admin/maksed";
    html.innerHTML = renderToString(element());
    expect(html.querySelector("button[data-nav-fold]")!.getAttribute("aria-expanded")).toBe("false");
    expect(text(html.querySelector("header [data-admin-bar-title]"))).toBe("Maksed ja arved");
  });

  it("the ≡ button carries the sum of the badges, is a 44 px menu button, and turns into ✕ while the menu is open", async () => {
    await at("/admin/maksed", "", { badges: BADGES, total: 12 });
    const button = container.querySelector<HTMLButtonElement>("header [data-admin-menu]")!;
    expect(button.getAttribute("aria-label")).toBe("Ava menüü");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(text(button)).toBe("12");
    const menuGlyph = iconPath(button);
    await openMenu();
    expect(dialog().open).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(iconPath(button)).not.toBe(menuGlyph);
    expect(iconPath(button)).toBe(iconPath(dialog().querySelector("[data-admin-menu-close]")));
    expect(text(dialog().querySelector("[data-admin-menu-close]"))).toBe("12");
    await click(dialog().querySelector("[data-admin-menu-close]"));
    expect(dialog().open).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(iconPath(button)).toBe(menuGlyph);
  });

  it("no sum when nothing waits", async () => {
    await show({ total: 0 });
    expect(text(container.querySelector("header [data-admin-menu]"))).toBe("");
  });

  it("the menu lists the same groups, all expanded, with no fold", async () => {
    await at("/admin/maksed");
    await openMenu();
    const d = dialog();
    expect(labelsIn(d)).toEqual(["Igapäevane töö", "Koolitused", "Koduleht ja uudiskiri", "Haldus"]);
    expect(d.querySelectorAll("button[data-nav-fold]")).toHaveLength(0);
    expect(itemsOf(d, "site")).toEqual(["home", "trainer", "news", "campaign", "newsletter"]);
    expect(d.querySelectorAll("[hidden]")).toHaveLength(0);
    expect(d.querySelectorAll("[data-nav-item]")).toHaveLength(SECTIONS.length);
    expect(current(d)).toBe("payments");
    expect(d.getAttribute("aria-label")).toBe("Halduse menüü");
  });

  it("the TÄNA card is there when a session is on today, and only then", async () => {
    await show({ today: null });
    await openMenu();
    expect(dialog().querySelector("[data-admin-today]")).toBeNull();
    await click(dialog().querySelector("[data-admin-menu-close]"));

    await show({ today: { href: "/admin/protokollid?sessioon=7", time: "10:00", course: "Kulmumeistri baaskoolitus" } });
    await openMenu();
    const card = dialog().querySelector<HTMLAnchorElement>("[data-admin-today]")!;
    expect(card.getAttribute("href")).toBe("/admin/protokollid?sessioon=7");
    expect(Array.from(card.children).map(text)).toEqual(["TÄNA 10:00", "Protokollid · Kulmumeistri baaskoolitus"]);
    // the card comes before the groups, and the desktop sidebar has none
    expect(card.compareDocumentPosition(dialog().querySelector("nav")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aside().querySelector("[data-admin-today]")).toBeNull();
  });

  it("the footer: the e-mail, „Vaata kodulehte ↗“ in a new window, „Logi välja“", async () => {
    await show();
    await openMenu();
    const foot = dialog().querySelector("[data-nav-foot]")!;
    expect(Array.from(foot.children).map(text)).toEqual(["Sisse logitud", EMAIL, "Vaata kodulehte ↗ (avaneb uues aknas)", "Logi välja"]);
    const site = foot.querySelector<HTMLAnchorElement>("a[href='/api/admin/preview']")!;
    expect([site.target, site.rel]).toEqual(["_blank", "noopener"]);
    expect(foot.querySelector("form[action='/api/auth/logout'] button[type=submit]")).not.toBeNull();
  });

  it("a click on a link closes the menu; so does the backdrop; so does a navigation that is not a click (Back)", async () => {
    await at("/admin/maksed");
    await openMenu();
    expect(dialog().open).toBe(true);
    await click(dialog().querySelector('a[data-nav="requests"]'));
    expect(dialog().open).toBe(false);

    await openMenu();
    await click(dialog()); // the backdrop is the dialog itself
    expect(dialog().open).toBe(false);

    await openMenu();
    expect(dialog().open).toBe(true);
    await at("/admin/registreerimised"); // Back / an iOS swipe: only the address changes
    expect(dialog().open).toBe(false);
    expect(container.querySelector("header [data-admin-menu]")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("the menu is closed again when the window grows into the sidebar layout (900 px)", async () => {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return {
        matches: false,
        media: query,
        addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.add(l),
        removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.delete(l),
      };
    });
    try {
      await show();
      expect(queries).toContain("(min-width: 900px)");
      await openMenu();
      expect(dialog().open).toBe(true);
      await act(async () => listeners.forEach((l) => l({ matches: true })));
      expect(dialog().open).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
