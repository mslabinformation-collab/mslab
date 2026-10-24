// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishBar } from "@/components/admin/PublishBar";
import { SaveBar } from "@/components/admin/SaveBar";
import { UndoProvider, useUndo } from "@/components/admin/UndoBar";

// The comment bubble (public/feedback.js, Dim 22.10: on every signed-in admin page while the review tools are on) lifts itself above whatever is
// marked data-fab-avoid in its corner. The admin's bars that stand at the bottom of the screen are marked, so the bubble never covers a button of
// theirs: the UndoBar, the PublishBar (the phone's bar) and the save bars of the editors. (The phone's top bar is not: it is at the top, where the
// bubble never is.) The e2e spec checks the lift itself in a real browser (e2e/feedback.spec.ts); this holds the marks, and finds a new bottom bar
// that nobody marked.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

  it("the course editor has no save bar of its own any more (piece 3a, Task 7: every card autosaves; the PublishBar is the bottom bar there)", () => {
    const source = readFileSync(join(process.cwd(), "src", "components", "admin", "CourseEditor.tsx"), "utf8");
    expect(source).not.toContain("data-save-bar");
    expect(source).not.toContain("saveBar");
  });

  it("the practical work's send bar (fixed at the bottom on a phone; its markup is in AssessmentSend.tsx)", () => {
    const source = readFileSync(join(process.cwd(), "src", "components", "admin", "AssessmentSend.tsx"), "utf8");
    expect(source).toMatch(/className=\{styles\.dock\} data-assess-dock="" data-fab-avoid="">/);
  });

  it("the phone's top bar is not marked (it is at the top: the mark would do nothing)", () => {
    const source = readFileSync(join(process.cwd(), "src", "components", "admin", "Sidebar.tsx"), "utf8");
    expect(source).toContain("<header className={styles.bar}>");
    expect(source).not.toContain("data-fab-avoid");
  });
});

describe("a bar fixed or sticky at the bottom of the screen is known", () => {
  // Rules (including those inside @media) of the admin's stylesheets, the components' (src/components/admin) and the pages' (src/app/admin, every
  // folder below it), that fix an element to the bottom edge. Modal dialogs (the drawers, the photo viewer, the phone's menu) are `inset: 0` and in
  // the browser's top layer, above the bubble: they are not here.
  const SRC = join(process.cwd(), "src");
  const ROOTS = [join(SRC, "components", "admin"), join(SRC, "app", "admin")];

  /** Every .css file below `dir`. */
  function stylesheets(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return stylesheets(path);
      return entry.name.endsWith(".css") ? [path] : [];
    });
  }

  const files = ROOTS.flatMap(stylesheets);

  function bottomBars(): string[] {
    const found: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/position:\s*(fixed|sticky)/.test(body) && /(^|[\s;])bottom\s*:/.test(body)) found.push(`${relative(SRC, file).split(sep).join("/")} ${selector.trim()}`);
      }
    }
    return found.sort();
  }

  it("scans the components' stylesheets and the pages' (the admin's page folders have some of their own)", () => {
    const names = files.map((f) => relative(SRC, f).split(sep).join("/"));
    expect(names.some((n) => n.startsWith("components/admin/") && n.endsWith("UndoBar.module.css"))).toBe(true);
    expect(names.some((n) => n.startsWith("app/admin/") && n.endsWith(".css"))).toBe(true);
  });

  it("is the UndoBar's region, the PublishBar's phone bar, the site editors' save bar and the practical work's send bar: each marked above; a new one is to be marked too", () => {
    expect(bottomBars()).toEqual([
      "components/admin/Assessment.module.css .dock",
      "components/admin/PublishBar.module.css .bar",
      "components/admin/UndoBar.module.css .region",
      "components/admin/site-editor.module.css .saveBar",
    ]);
  });
});
