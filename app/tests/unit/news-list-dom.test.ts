// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewsList, NewsScreen, type NewsRow } from "@/components/admin/news/NewsList";
import { dayMonth, fullDay, newsHref } from "@/components/admin/news/news-view";
import { stubFetch } from "../fakes";

// C3 Uudised, the list (admin UX pass piece 4b, Task 2; README §4 C3; the Part 4 C3 frame; piece4-texts S4-18, S4-19, S4-23; ruling R-f): the rows the
// uudised layout reads (thumbnail, title, `{staatus} · {dd.mm}` in the status's colour, the whole row one link, the open post's row marked), the title
// search of `?otsi=` filtered here, its empty line, „Lisa postitus +“ that makes the post at once and opens it, and „Postitus kustutatud.“ after a delete.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() },
  pathname: "/admin/uudised",
  search: "",
  params: {} as Record<string, string>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useParams: () => nav.params,
}));

const ROWS: NewsRow[] = [
  { id: 4, title: "Uued koolituskuupäevad Tartus", coverKey: "img/a.jpg", status: "changes", day: "2026-10-02" },
  { id: 3, title: "Kuidas valida kulmuvärvi", coverKey: "img/b.jpg", status: "published", day: "2026-09-18" },
  { id: 2, title: "MS LAB kolis Rüütli tänavale", coverKey: "", status: "published", day: "2026-09-01" },
  { id: 1, title: "Detsembri e-koolituse pakkumine", coverKey: "", status: "draft", day: "" },
];

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const showList = async (open: string | null = null, rows = ROWS) => {
  await act(async () => root.render(createElement(NewsList, { rows, open })));
  await settle();
};
const rows = () => $$<HTMLAnchorElement>("[data-post-row]");
/** The layout's screen round an editor (its children). */
const screen = (editor: ReactNode) => createElement(NewsScreen, { rows: ROWS } as ComponentProps<typeof NewsScreen>, editor);

beforeEach(() => {
  nav.pathname = "/admin/uudised";
  nav.search = "";
  nav.params = {};
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
  nav.router.replace.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the rows (S4-18, the P4 C3 frame)", () => {
  it("each post is one link as a whole: its thumbnail, its title and `{staatus} · {dd.mm}`; „—“ without a date", async () => {
    await showList();
    expect(rows().map((a) => a.getAttribute("href"))).toEqual(["/admin/uudised/4", "/admin/uudised/3", "/admin/uudised/2", "/admin/uudised/1"]);
    expect(rows().map((a) => text(a))).toEqual([
      "Uued koolituskuupäevad Tartus Avaldamata muudatused · 02.10",
      "Kuidas valida kulmuvärvi Avaldatud · 18.09",
      "MS LAB kolis Rüütli tänavale Avaldatud · 01.09",
      "Detsembri e-koolituse pakkumine Mustand · —",
    ]);
    // the cover's thumbnail, else the empty tile; nothing inside a row is a control of its own
    expect(rows()[0].querySelector("img")?.getAttribute("src")).toBe("/media/img/a.jpg");
    expect(rows()[2].querySelector("img")).toBeNull();
    for (const row of rows()) expect(row.querySelectorAll("a, button, input")).toHaveLength(0);
    expect(dayMonth("2026-12-24")).toBe("24.12");
    expect(dayMonth("")).toBe("—");
    // (one day rule for the row and the editor's footer, review m4)
    expect(fullDay("2026-12-24")).toBe("24.12.2026");
    expect([newsHref("/admin/uudised", ""), newsHref("/admin/uudised/3", "kulmu värv"), newsHref("/admin/uudised", "kulmu", { kustutatud: "1" })]).toEqual(["/admin/uudised", "/admin/uudised/3?otsi=kulmu+v%C3%A4rv", "/admin/uudised?otsi=kulmu&kustutatud=1"]);
  });

  it("the status words and their colours: „Avaldatud“ #2f5d46, „Mustand“ #5e5559, „Avaldamata muudatused“ #6b4f5c (never „Mustand“ for a published post)", async () => {
    await showList();
    expect($$("[data-post-state]").map((el) => [el.dataset.status, text(el).split(" · ")[0]])).toEqual([
      ["changes", "Avaldamata muudatused"],
      ["published", "Avaldatud"],
      ["published", "Avaldatud"],
      ["draft", "Mustand"],
    ]);
    const css = readFileSync(join(process.cwd(), "src/components/admin/news/NewsList.module.css"), "utf8");
    const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
    expect(css).toMatch(/\.line\[data-status="published"\]\s*\{\s*color: var\(--ok\);/);
    expect(css).toMatch(/\.line\[data-status="draft"\]\s*\{\s*color: #5e5559;/);
    expect(css).toMatch(/\.line\[data-status="changes"\]\s*\{\s*color: var\(--warn\);/);
    expect(tokens).toMatch(/--ok: #2f5d46;/);
    expect(tokens).toMatch(/--warn: #6b4f5c;/);
    // the open row: white with a 1 px #222 border (drawn)
    expect(css).toMatch(/\.row\[aria-current="page"\]\s*\{\s*border-color: var\(--ink\);\s*background: var\(--paper\);/);
  });

  it("the open post's row is marked (aria-current), and with a post open the heading is the list's own (h2), not the page's H1", async () => {
    await showList("3");
    expect(rows().map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null, null]);
    expect($("h1")).toBeNull();
    expect(text($("h2"))).toBe("Uudised");
  });

  it("no post open: the list is the page — eyebrow „Blogi“, H1 „Uudised“, its lead, and „Lisa postitus +“", async () => {
    await showList();
    expect(text($("h1"))).toBe("Uudised");
    expect(text(container)).toContain("Blogi");
    expect(text(container)).toContain("Kõik postitused, ka mustandid, uuemad eespool.");
    expect(text($("[data-add-post]"))).toBe("Lisa postitus +");
  });
});

describe("the search (S4-18; R-f: `?otsi=` filtered here)", () => {
  it("„Otsi pealkirja järgi“ is the toolbar's field; `?otsi=` keeps the rows whose title has it (any case, no diacritics needed); the rows keep the search", async () => {
    nav.search = "otsi=KULMU";
    await showList();
    expect($<HTMLInputElement>('input[type="search"]')?.placeholder).toBe("Otsi pealkirja järgi");
    expect(rows().map((a) => text(a.querySelector("span span")))).toEqual(["Kuidas valida kulmuvärvi"]);
    expect(rows()[0].getAttribute("href")).toBe("/admin/uudised/3?otsi=KULMU");
    nav.search = "otsi=ruutli";
    await showList();
    expect(rows().map((a) => a.dataset.postRow)).toEqual(["2"]);
  });

  it("no hit: „„{q}“ järgi postitusi ei leitud.“ and „Tühjenda otsing ja filtrid“, back to the whole list (the open post stays open)", async () => {
    nav.search = "otsi=talv";
    nav.pathname = "/admin/uudised/3";
    await showList("3");
    expect(rows()).toHaveLength(0);
    expect(text($("[data-list-empty] p"))).toBe("„talv“ järgi postitusi ei leitud.");
    const clear = $<HTMLAnchorElement>("[data-list-empty] a");
    expect(text(clear)).toBe("Tühjenda otsing ja filtrid");
    expect(clear?.getAttribute("href")).toBe("/admin/uudised/3");
  });

  it("no posts at all: „Postitusi veel pole.“ and nothing to clear", async () => {
    await showList(null, []);
    expect(text($("[data-list-empty]"))).toBe("Postitusi veel pole.");
  });
});

describe("„Lisa postitus +“ (S4-19) and „Postitus kustutatud.“ (S4-23)", () => {
  it("makes the post at once and opens it with `?loodud=1`; the page is read again so the list has its row", async () => {
    const fetched = stubFetch(() => Response.json({ id: 9 }));
    await showList();
    await act(async () => $<HTMLButtonElement>("[data-add-post]")!.click());
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url])).toEqual([["POST", "/api/admin/uudised/uus"]]);
    expect(nav.router.push).toHaveBeenCalledWith("/admin/uudised/9?loodud=1");
    expect(nav.router.refresh).toHaveBeenCalled();
  });

  it("a failure says so under the button, and the button takes a press again", async () => {
    stubFetch(() => Response.json({ ok: false, error: "server" }, { status: 500 }));
    await showList();
    await act(async () => $<HTMLButtonElement>("[data-add-post]")!.click());
    await settle();
    expect(text($("[data-add-post] + [role=alert]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-add-post]")?.getAttribute("aria-disabled")).toBeNull();
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("after a delete (`?kustutatud=1`) the list says „Postitus kustutatud.“", async () => {
    nav.search = "kustutatud=1";
    await showList();
    expect(text($("[data-post-deleted]"))).toBe("Postitus kustutatud.");
    expect($("[data-post-deleted]")?.getAttribute("role")).toBe("status");
  });
});

describe("the screen (R-f): the list beside the open post from 1180 px, two screens below", () => {
  it("with a post open the screen is marked open and holds the editor beside the list; the CSS puts them side by side from 1180 px and hides the list below", async () => {
    nav.params = { id: "3" };
    nav.pathname = "/admin/uudised/3";
    await act(async () => root.render(screen(createElement("p", { id: "editor" }, "Editor"))));
    await settle();
    expect($("[data-news-screen]")?.hasAttribute("data-open")).toBe(true);
    expect($("[data-news-editor] #editor")).not.toBeNull();
    expect($("[data-post-row='3']")?.getAttribute("aria-current")).toBe("page");
    const css = readFileSync(join(process.cwd(), "src/components/admin/news/NewsList.module.css"), "utf8");
    expect(css).toMatch(/\.screen\[data-open\] > \.list \{\s*display: none;/);
    expect(css).toMatch(/@media \(min-width: 1180px\) \{\s*\.screen\[data-open\] \{\s*grid-template-columns: 320px minmax\(0, 1fr\);/);
  });

  it("no post open: the list alone", async () => {
    await act(async () => root.render(screen(null)));
    await settle();
    expect($("[data-news-screen]")?.hasAttribute("data-open")).toBe(false);
    expect($("[data-news-editor]")).toBeNull();
    expect(text($("h1"))).toBe("Uudised");
  });
});
