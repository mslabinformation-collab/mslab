// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Seaded → „Järelmaks (Inbank)“ (instalments Task 5, spec D4) in a browser-like document (happy-dom), with the server action answered here: the
// saved state in the checkbox (off by default), „Salvesta“ sends what the checkbox says, the status says it was saved, and a failure says so
// in words and keeps what she ticked.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-financing", () => ({ saveFinancingSettingsAction: action }));

import { FinancingSettings } from "@/components/admin/FinancingSettings";

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The card as the page renders it (a new key: a new card, as a new page load gives). */
const show = async (initial = { enabled: false }) => {
  await act(async () => root.render(createElement(FinancingSettings, { key: JSON.stringify(initial), initial })));
  await settle();
};
const box = () => $<HTMLInputElement>("[data-financing-enabled]")!;
const status = () => $("[data-financing-status]")!.textContent;
const tick = async () => act(async () => box().click());
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-financing-form]")!.requestSubmit());
  await settle();
};

beforeEach(() => {
  action.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("FinancingSettings", () => {
  test("the card: its title, the checkbox with its label, the lead and „Salvesta“; one checkbox and nothing else to type", async () => {
    await show();
    expect($("h2")!.textContent).toBe("Järelmaks (Inbank)");
    expect($("[data-financing-settings]")!.getAttribute("aria-labelledby")).toBe($("h2")!.id);
    expect(container.querySelector(`label[for="${box().id}"]`)!.textContent).toBe("Paku järelmaksu (Inbank)");
    expect($("[data-financing-settings]")!.textContent).toContain("Lülita sisse, kui Montonio on järelmaksu sinu poele avanud. Hind peab olema 100–5000 €.");
    // the lead describes the checkbox
    expect(box().getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent)).toContain(
      "Lülita sisse, kui Montonio on järelmaksu sinu poele avanud. Hind peab olema 100–5000 €.",
    );
    expect($("[data-financing-save]")!.textContent).toBe("Salvesta");
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(box().type).toBe("checkbox");
    expect(status()).toBe("");
  });

  test("off by default: a shop without the stored setting shows an unticked box; the saved state shows ticked", async () => {
    await show({ enabled: false });
    expect(box().checked).toBe(false);
    await show({ enabled: true });
    expect(box().checked).toBe(true);
  });

  test("„Salvesta“ sends what the checkbox says: ticked sends { enabled: true }; the status says it was saved", async () => {
    action.mockResolvedValue({ ok: true, enabled: true });
    await show();
    await tick();
    expect(box().checked).toBe(true);
    expect(action).not.toHaveBeenCalled(); // ticking alone saves nothing
    await submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][0]).toEqual({ enabled: true });
    expect(status()).toBe("Järelmaksu seade on salvestatud.");
    expect(box().checked).toBe(true);
  });

  test("switched off again: { enabled: false } goes on, and the box shows what is stored", async () => {
    action.mockResolvedValue({ ok: true, enabled: false });
    await show({ enabled: true });
    await tick();
    await submit();
    expect(action.mock.calls[0][0]).toEqual({ enabled: false });
    expect(box().checked).toBe(false);
    expect(status()).toBe("Järelmaksu seade on salvestatud.");
  });

  test("a refusal or a failure says so in words; what she ticked stays, and nothing says it was saved", async () => {
    action.mockResolvedValue({ ok: false, error: "server" });
    await show();
    await tick();
    await submit();
    expect(status()).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(box().checked).toBe(true);
    // a throw of the action itself (the network) is the same words
    action.mockRejectedValue(new Error("offline"));
    await submit();
    expect(status()).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(box().checked).toBe(true);
    // and the next success says it was saved
    action.mockResolvedValue({ ok: true, enabled: true });
    await submit();
    expect(status()).toBe("Järelmaksu seade on salvestatud.");
  });

  test("a change after saving clears the „saved“ line (it no longer tells the truth)", async () => {
    action.mockResolvedValue({ ok: true, enabled: true });
    await show();
    await tick();
    await submit();
    expect(status()).toBe("Järelmaksu seade on salvestatud.");
    await tick();
    expect(status()).toBe("");
  });
});
