// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewBar, PreviewLabelBar, type PreviewBarTexts } from "@/components/site/PreviewBar";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";

// PreviewBar (admin UX pass piece 3a, Task 6 review; spec C3 „The phone's „Loobu muudatustest“ on the preview page (Part 4) is shown only in draft mode“;
// README §1.8, the phone's PublishBar of Part 4: „Avaldamata {n} · Eelvaade“ + „Avalda“, „Loobu muudatustest“ behind „Eelvaade“). The bar the course
// page shows in the admin's draft preview, and nowhere else: „Avaldamata {n}“, the way out, and „Loobu muudatustest“ behind the same ConfirmPanel as the
// PublishBar's, which discards the course's drafts (Task 4's route) and then ends the preview. Piece 4a, Task 3 (R-f): the same bar on the home page,
// /koolitaja and /praktika, discarding through the page's entity's route (`discardHref`) and dropping that entity's editor copies; no `discardHref`, no
// „Loobu muudatustest“.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const EXIT = "/api/admin/eelvaade?lopeta=1&tee=%2Fkoolitused%2Fkulmud";
type Props = Parameters<typeof PreviewBar>[0];
/** The words as the server fills them (server/preview-bar.ts): the admin's, whatever the page's language. */
const texts = (n: number): PreviewBarTexts => ({
  count: fill(adminEt.publish.phoneCount, { n }),
  exit: "Lõpeta eelvaade",
  discard: adminEt.publish.discard,
  question: fill(adminEt.publish.confirm, { n }),
  yes: adminEt.publish.confirmYes,
  failed: adminEt.publish.discardFailed,
  signedOut: adminEt.leave.reasons.signedOut,
});
const show = (over: Partial<Props> = {}) =>
  act(async () => root.render(createElement(PreviewBar, { discardHref: "/api/admin/koolitus/7/loobu", copies: { course: 7 }, count: 3, exitHref: EXIT, t: texts(over.count ?? 3), ...over })));

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const discard = () => $<HTMLButtonElement>("[data-preview-discard]");
const exit = () => $<HTMLAnchorElement>("[data-preview-exit]");
const panel = () => $("[data-confirm-panel]");
const panelButtons = () => Array.from(panel()?.querySelectorAll("button") ?? []);
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
/** Presses „Loobu muudatustest“: the ConfirmPanel is loaded when the question is first asked (a chunk of its own), so wait until it is there. */
async function ask() {
  await click(discard()!);
  for (let i = 0; i < 50 && !panel(); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  expect(panel(), "the question").not.toBeNull();
}

/** A fetch the test answers by hand. */
function fakeFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const waiting: ((res: Response | Error) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Promise<Response>((resolve, reject) => waiting.push((r) => (r instanceof Error ? reject(r) : resolve(r))));
    }),
  );
  return { calls, answer: (res: Response | Error) => act(async () => void waiting.shift()!(res)) };
}
const ok = () => Response.json({ discarded: 3 });

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ assign } as unknown as Location);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PreviewBar", () => {
  it("„Avaldamata 3“, the way out („Lõpeta eelvaade“, Dim 24.10, in this tab) and „Loobu muudatustest“; a bottom bar the 💬 bubble stays above", async () => {
    expect(adminEt.publish).toMatchObject({ phoneCount: "Avaldamata {n}", discard: "Loobu muudatustest", confirm: "Kas loobun {n} muudatusest? Avalikul lehel jääb praegune versioon.", confirmYes: "Jah, loobu" });
    await show();
    const bar = $("[data-preview-bar]")!;
    expect(bar.hasAttribute("data-fab-avoid")).toBe(true);
    expect($("[data-preview-count]")!.textContent).toBe("Avaldamata 3");
    expect(exit()!.textContent).toBe("Lõpeta eelvaade");
    expect(exit()!.getAttribute("href")).toBe(EXIT);
    expect(exit()!.target).toBe(""); // this tab: the preview ends where it was
    expect(discard()!.textContent).toBe("Loobu muudatustest");
    expect(panel()).toBeNull();
  });

  it("nothing to discard (no unpublished change): no count and no „Loobu muudatustest“, the way out stays", async () => {
    await show({ count: 0 });
    expect($("[data-preview-count]")).toBeNull();
    expect(discard()).toBeNull();
    expect(exit()!.getAttribute("href")).toBe(EXIT);
  });

  it("„Loobu muudatustest“ asks first, in the PublishBar's ConfirmPanel; „Katkesta“ closes it and the focus goes back; nothing was sent", async () => {
    const f = fakeFetch();
    await show();
    await ask();
    expect(discard()).toBeNull(); // the question takes its trigger's place
    expect(panel()!.textContent).toContain("Kas loobun 3 muudatusest? Avalikul lehel jääb praegune versioon.");
    expect(panelButtons().map((b) => b.textContent)).toEqual(["Jah, loobu", "Katkesta"]);
    expect(document.activeElement).toBe(panel());
    await click(panelButtons()[1]);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(discard());
    expect(f.calls).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("„Jah, loobu“ discards through the course's route, then ends the preview (the way out); while it runs a second press does nothing", async () => {
    const f = fakeFetch();
    await show();
    await ask();
    // two presses in one turn of the event loop (before React shows busy), and a third after it
    const yes = panelButtons()[0];
    await act(async () => {
      yes.click();
      yes.click();
    });
    await click(panelButtons()[0]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("/api/admin/koolitus/7/loobu");
    expect(f.calls[0].init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(panelButtons().map((b) => b.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
    expect(assign).not.toHaveBeenCalled();
    await f.answer(ok());
    expect(assign).toHaveBeenCalledExactlyOnceWith(EXIT);
  });

  it("a discard that fails (the server's answer, or no connection) leaves the question open and goes nowhere; it can be tried again", async () => {
    const f = fakeFetch();
    await show();
    await ask();
    await click(panelButtons()[0]);
    await f.answer(Response.json({ ok: false, error: "server" }, { status: 500 }));
    expect(assign).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
    expect(panelButtons().map((b) => b.getAttribute("aria-disabled"))).toEqual([null, null]);
    // the PublishBar's words of a discard that failed (Dim 24.10, D-2), as an alert in the bar
    const line = () => $("[data-preview-error]");
    expect(line()!.textContent).toBe("Muudatustest loobumine ei õnnestunud. Proovi uuesti.");
    expect(line()!.getAttribute("role")).toBe("alert");
    await click(panelButtons()[0]);
    expect(line()).toBeNull(); // (gone while it is tried again)
    await f.answer(new TypeError("Failed to fetch"));
    expect(assign).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
    expect(line()!.textContent).toBe("Muudatustest loobumine ei õnnestunud. Proovi uuesti.");
    // signed out meanwhile (withAdmin's 401): „Logi uuesti sisse.“
    await click(panelButtons()[0]);
    await f.answer(Response.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    expect(line()!.textContent).toBe("Logi uuesti sisse.");
    await click(panelButtons()[0]);
    expect(f.calls).toHaveLength(4);
    await f.answer(ok());
    expect(assign).toHaveBeenCalledExactlyOnceWith(EXIT);
  });

  it("a discard that goes through drops this browser's course-editor copies of this course, and only those; one that fails keeps them", async () => {
    localStorage.clear();
    const keep = [
      "mslab-draft:koolitus:70-basics:t1", // another course (7 is not 70)
      "mslab-draft:koolitus:uus", // the new-course page's
      "mslab-draft:registreering:7:t1", // another owner's
      "mslab-edit-lang",
    ];
    const mine = ["mslab-draft:koolitus:7-basics:t1", "mslab-draft:koolitus:7-price:t2"];
    for (const key of [...keep, ...mine]) localStorage.setItem(key, "{}");
    const f = fakeFetch();
    await show();
    await ask();
    await click(panelButtons()[0]);
    await f.answer(Response.json({ ok: false, error: "server" }, { status: 500 }));
    expect(Object.keys(localStorage).sort()).toEqual([...keep, ...mine].sort());
    await click(panelButtons()[0]);
    await f.answer(ok());
    expect(Object.keys(localStorage).sort()).toEqual([...keep].sort());
    expect(assign).toHaveBeenCalledExactlyOnceWith(EXIT);
    // (the bar loads no admin dictionary or engine: its copy rule is lib/course-copies.ts)
    const source = readFileSync(join(process.cwd(), "src/components/site/PreviewBar.tsx"), "utf8");
    expect(source).not.toMatch(/i18n\/dict\/admin|autosave\/engine|components\/admin\/(?!ConfirmPanel)/);
    localStorage.clear();
  });

  it("no discardHref (a page whose drafts it does not discard): no „Loobu muudatustest“ and no question; the count and the way out stay", async () => {
    const f = fakeFetch();
    await show({ discardHref: null, copies: null });
    expect($("[data-preview-count]")!.textContent).toBe("Avaldamata 3");
    expect(exit()!.getAttribute("href")).toBe(EXIT);
    expect(discard()).toBeNull();
    expect(panel()).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("a site page's bar (piece 4a, R-f): „Jah, loobu“ posts to its discardHref, drops this browser's copies of that entity only, then ends the preview", async () => {
    localStorage.clear();
    const keep = [
      "mslab-draft:site:home:slides:t1", // another entity's
      "mslab-draft:site:practiceX:MAXI:t1", // not this entity (a longer name)
      "mslab-draft:koolitus:7-basics:t1", // a course's
      "mslab-draft:site:practice", // not a copy
      "mslab-edit-lang",
    ];
    const mine = ["mslab-draft:site:practice:MAXI:t1", "mslab-draft:site:practice:MINI:t2-x"];
    for (const key of [...keep, ...mine]) localStorage.setItem(key, "{}");
    const f = fakeFetch();
    await show({ discardHref: "/api/admin/sisu/practice/0/loobu", copies: { site: "practice" }, count: 1 });
    await ask();
    expect(panel()!.textContent).toContain("Kas loobun 1 muudatusest? Avalikul lehel jääb praegune versioon.");
    await click(panelButtons()[0]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("/api/admin/sisu/practice/0/loobu");
    expect(f.calls[0].init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    // one that fails keeps them
    await f.answer(Response.json({ ok: false, error: "server" }, { status: 500 }));
    expect(Object.keys(localStorage).sort()).toEqual([...keep, ...mine].sort());
    expect(assign).not.toHaveBeenCalled();
    await click(panelButtons()[0]);
    await f.answer(Response.json({ stamp: 5 }));
    expect(Object.keys(localStorage).sort()).toEqual([...keep].sort());
    expect(assign).toHaveBeenCalledExactlyOnceWith(EXIT);
    // (the site's copy rule is lib/site-copies.ts, the admin hook's own: the bar loads no admin code)
    const source = readFileSync(join(process.cwd(), "src/components/site/PreviewBar.tsx"), "utf8");
    expect(source).toContain('from "@/lib/site-copies"');
    expect(source).not.toMatch(/components\/admin\/site|useSitePart/);
    localStorage.clear();
  });

  it("the catalogue's bar (Dim 24.10, D-4): „Eelvaade“ and the way out „Lõpeta eelvaade“, nothing to discard; a bottom bar the 💬 bubble stays above", async () => {
    const out = "/api/admin/eelvaade?lopeta=1&tee=%2Fkoolitused";
    await act(async () => root.render(createElement(PreviewLabelBar, { exitHref: out, t: { label: "Eelvaade", exit: "Lõpeta eelvaade" } })));
    expect($("[data-preview-bar]")!.hasAttribute("data-fab-avoid")).toBe(true);
    expect($("[data-preview-label]")!.textContent).toBe("Eelvaade");
    expect(exit()!.textContent).toBe("Lõpeta eelvaade");
    expect(exit()!.getAttribute("href")).toBe(out);
    expect(discard()).toBeNull();
    expect($("[data-preview-count]")).toBeNull();
  });

  it("the bar's stylesheet: stuck to the bottom of the page, 44px targets, the ring, no motion under prefers-reduced-motion", () => {
    const css = readFileSync(join(process.cwd(), "src/components/site/PreviewBar.module.css"), "utf8");
    expect(css).toMatch(/\.bar\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0/);
    expect(css).toMatch(/\.exit\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.discard\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/:focus-visible[^}]*outline:\s*2px solid var\(--rose\)/);
    expect(css).not.toMatch(/transition|animation/);
  });
});
