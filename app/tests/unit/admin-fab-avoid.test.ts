// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishBar } from "@/components/admin/PublishBar";
import { SaveBar } from "@/components/admin/SaveBar";
import { Sidebar } from "@/components/admin/Sidebar";
import { SECTIONS } from "@/components/admin/sections";
import { UndoProvider, useUndo } from "@/components/admin/UndoBar";
import { adminEt } from "@/i18n/dict/admin";

// The comment bubble (public/feedback.js, Dim 22.10: on every admin page while the review tools are on) lifts itself above whatever is marked
// data-fab-avoid in its corner. The admin's bars that stand at the bottom of the screen are marked, so the bubble never covers a button of theirs:
// the UndoBar, the PublishBar (the phone's bar), the save bars of the editors, and the phone's top bar. The e2e spec checks the lift itself in a real
// browser (feedback-admin.spec.ts); this holds the marks, and finds a new bottom bar that nobody marked.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(""),
}));

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("the admin's bars are marked data-fab-avoid", () => {
  it("the UndoBar (bottom left, the whole width on a phone)", async () => {
    let api!: ReturnType<typeof useUndo>;
    const Page = () => {
      const undo = useUndo();
      useEffect(() => {
        api = undo;
      }, [undo]);
      return null;
    };
    await act(async () => root.render(createElement(UndoProvider, null, createElement(Page))));
    await act(async () => void api.show({ text: "Pilt eemaldatud.", undo: async () => true }));
    expect($("[data-undo-bar]")!.hasAttribute("data-fab-avoid")).toBe(true);
  });

  it("the PublishBar (the phone's bar at the bottom of the screen)", async () => {
    await act(async () =>
      root.render(createElement(PublishBar, { changed: ["Hind"], previewHref: "/api/admin/eelvaade?tee=%2Fkoolitused", onDiscard: async () => {}, onPublish: async () => {} })),
    );
    expect($("[data-publish-bar]")!.hasAttribute("data-fab-avoid")).toBe(true);
  });

  it("the save bar of the site editors (SaveBar: „Salvesta“ on the right, sticky at the bottom)", async () => {
    await act(async () => root.render(createElement(SaveBar, { status: { text: "", tone: "hint", stale: false }, pending: false, reloadHref: "/admin" })));
    expect($("[data-save-bar]")!.hasAttribute("data-fab-avoid")).toBe(true);
  });

  it("the course editor's own save bar (its markup is in CourseEditor.tsx)", () => {
    const source = readFileSync(join(process.cwd(), "src", "components", "admin", "CourseEditor.tsx"), "utf8");
    expect(source).toMatch(/<div className=\{styles\.saveBar\} data-save-bar="" data-fab-avoid="">/);
  });

  it("the phone's top bar", async () => {
    const t = adminEt.shell;
    const texts = {
      label: t.label, nav: t.nav, home: t.home, openMenu: t.openMenu, closeMenu: t.closeMenu, viewSite: t.preview, newWindow: t.newWindow, signedIn: t.signedIn,
      logout: t.logout, groups: adminEt.nav.groups, today: t.today, todayLine: t.todayLine,
    };
    const items = SECTIONS.map((s) => ({ ...s, label: adminEt.nav[s.key], badge: undefined }));
    await act(async () => root.render(createElement(Sidebar, { items, t: texts, total: 0, email: "maria@example.test", today: null })));
    const bar = $("header");
    expect(bar).not.toBeNull();
    expect(bar!.hasAttribute("data-fab-avoid")).toBe(true);
  });
});

describe("a bar fixed or sticky at the bottom of the screen is known", () => {
  // Rules (including those inside @media) of the admin's CSS modules that fix an element to the bottom edge. Modal dialogs (the drawers, the photo
  // viewer, the phone's menu) are `inset: 0` and in the browser's top layer, above the bubble: they are not here.
  const DIR = join(process.cwd(), "src", "components", "admin");
  function bottomBars(): string[] {
    const found: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".module.css"))) {
      const css = readFileSync(join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/position:\s*(fixed|sticky)/.test(body) && /(^|[\s;])bottom\s*:/.test(body)) found.push(`${file} ${selector.trim()}`);
      }
    }
    return found.sort();
  }

  it("is the UndoBar's region, the PublishBar's phone bar and the two save bars: each marked above; a new one is to be marked too", () => {
    expect(bottomBars()).toEqual([
      "CourseEditor.module.css .saveBar",
      "PublishBar.module.css .bar",
      "UndoBar.module.css .region",
      "site-editor.module.css .saveBar",
    ]);
  });
});
