// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AutosaveStatus } from "@/domain/autosave";
import { stubFetch } from "../fakes";

// Seaded → „Järelmaks (Inbank)“ (instalments Task 5, spec D4; admin UX pass piece 3b, Task 4: piece3-texts §4 "its switch autosaves and loses
// „Salvesta“") in a browser-like document (happy-dom), with the route answered here: the saved state in the checkbox (off by default), and a tick
// saved at once on api/admin/seaded/financing under the page's one status — no „Salvesta“, no status line of its own. A failure is the page's status
// to say; what she ticked stays.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { FinancingSettings } from "@/components/admin/FinancingSettings";

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
let version: string;
/** The switch as the route holds it. */
let stored: boolean;
let down: boolean;
let statuses: AutosaveStatus[];
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url !== "/api/admin/seaded/financing") return Response.json({ ok: false }, { status: 404 });
  if (down) return Response.json({ ok: false, error: "server" }, { status: 500 });
  const body = JSON.parse(String(init?.body)) as { version: string; patch: { enabled?: boolean } };
  if (body.version !== version) return Response.json({ ok: false, error: "conflict", version, value: { enabled: stored } }, { status: 409 });
  if (typeof body.patch.enabled === "boolean") stored = body.patch.enabled;
  version = `${version}+`;
  return Response.json({ ok: true, version, savedAt: "2026-10-25T11:20:00.000Z" });
};
const sent = () => fetched.calls.map((c) => c.body);

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
let mounts = 0;
/** The card as the page renders it (a new card, as a new page load gives). */
const show = async (initial = { enabled: false, version: "f1" }) => {
  await act(async () => root.render(createElement(FinancingSettings, { key: ++mounts, initial, onStatus: (_key: string, s: AutosaveStatus) => void statuses.push(s) })));
  await settle();
};
const box = () => $<HTMLInputElement>("[data-financing-enabled]")!;
const tick = async () => {
  await act(async () => box().click());
  await settle();
};

beforeEach(() => {
  version = "f1";
  stored = false;
  down = false;
  statuses = [];
  localStorage.clear();
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
});

describe("FinancingSettings", () => {
  test("the card: its title, the checkbox with its label, the lead that describes it; one checkbox and nothing else, no „Salvesta“ and no line of its own", async () => {
    await show();
    expect($("h2")!.textContent).toBe("Järelmaks (Inbank)");
    expect($("[data-financing-settings]")!.getAttribute("aria-labelledby")).toBe($("h2")!.id);
    expect(container.querySelector(`label[for="${box().id}"]`)!.textContent).toBe("Paku järelmaksu (Inbank)");
    expect(box().getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent)).toContain(
      "Lülita sisse, kui Montonio on järelmaksu sinu poele avanud. Hind peab olema 100–5000 €.",
    );
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(box().type).toBe("checkbox");
    expect(container.querySelector("button, [data-financing-save], [data-financing-status]")).toBeNull();
    expect(container.textContent).not.toContain("Salvesta");
  });

  test("off by default; the saved state shows ticked", async () => {
    await show({ enabled: false, version: "f1" });
    expect(box().checked).toBe(false);
    await show({ enabled: true, version: "f1" });
    expect(box().checked).toBe(true);
  });

  test("a tick is saved at once, a boolean, from the card's version; untick too; the status is told", async () => {
    await show();
    await tick();
    expect(box().checked).toBe(true);
    expect(sent()).toEqual([{ version: "f1", patch: { enabled: true } }]);
    expect(statuses.at(-1)!.kind).toBe("saved");
    await tick();
    expect(sent().at(-1)).toEqual({ version: "f1+", patch: { enabled: false } });
    expect(box().checked).toBe(false);
  });

  test("review I-2: switched in another tab meanwhile, the tick is a conflict: „Taasta minu tekst“ saves what the box shows over it, and the route holds it", async () => {
    // another tab switched it on and off again since this page was read (the route is at another version, off)
    version = "f3";
    await show();
    await tick();
    expect(sent()).toEqual([{ version: "f1", patch: { enabled: true } }]);
    expect(statuses.at(-1)!.kind).toBe("conflict");
    expect(box().checked).toBe(true);
    const restore = $<HTMLButtonElement>("[data-financing-restore]")!;
    expect(restore.textContent).toBe("Taasta minu tekst");
    await act(async () => restore.click());
    await settle();
    expect(sent().at(-1)).toEqual({ version: "f3", patch: { enabled: true } });
    expect(stored).toBe(true);
    expect(box().checked).toBe(stored);
    expect(statuses.at(-1)!.kind).toBe("saved");
    expect($("[data-financing-restore]")).toBeNull();
  });

  test("a failure is the status's to say (retry); what she ticked stays", async () => {
    down = true;
    await show();
    await tick();
    expect(box().checked).toBe(true);
    expect(statuses.at(-1)!.kind).toBe("retry");
  });
});
