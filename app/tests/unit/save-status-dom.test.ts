// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutosaveStatus } from "@/domain/autosave";
import { SaveStatus } from "@/components/admin/SaveStatus";

// SaveStatus (admin UX pass, README §1.4, strings.md D1): the one status chip of a screen. The visible chip is aria-hidden and a separate
// visually-hidden status region speaks, and only when the KIND of status changes (the time of a save and the typing of a field are not news).
// The colours are in the CSS module; here the class names tell the tone (saved green, neutral grey, error red).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

type Props = Parameters<typeof SaveStatus>[0];
const show = (props: Props) => act(async () => root.render(createElement(SaveStatus, props)));
/** A new chip (another page or drawer): the status region starts from this state, as a page just opened does. */
let pages = 0;
const open = (props: Props) => act(async () => root.render(createElement(SaveStatus, { key: ++pages, ...props })));
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const chip = () => $("[data-save-status]")!;
const visible = () => $("[data-save-text]")!;
const live = () => $('[role="status"]')!;
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());

/** 12:04 in Tallinn (EEST, UTC+3). */
const NOON = new Date("2026-10-21T09:04:00Z");

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

const STATES: [AutosaveStatus, string][] = [
  [{ kind: "saved", at: NOON }, "Salvestatud 12:04"],
  [{ kind: "dirty" }, "Salvestamata muudatused"],
  [{ kind: "saving" }, "Salvestan…"],
  [{ kind: "checking" }, "Kontrollin salvestatud teksti…"],
  [{ kind: "retry" }, "Salvestamata — proovin uuesti"],
  [{ kind: "invalid", fields: ["Hind"] }, "Salvestamata — kontrolli märgitud välja"],
  [{ kind: "signedOut" }, "Salvestamata — logi uuesti sisse"],
  [{ kind: "conflict" }, "Muudeti teises aknas — vaata üle"],
];

describe("SaveStatus: the states", () => {
  it.each(STATES)("%o → %s", async (status, expected) => {
    await show({ status });
    expect(live().textContent).toBe(expected);
    // what she sees: the same words (the saved chip with its ✓ in front)
    expect(visible().textContent).toBe(status.kind === "saved" ? `✓ ${expected}` : expected);
  });

  it("each state has its tone: saved green, the waiting ones grey, the ones that need her red", async () => {
    const tone = async (status: AutosaveStatus) => {
      await show({ status, thing: "registreerimist" });
      return chip().className;
    };
    const green = await tone({ kind: "saved", at: NOON });
    expect(green).toMatch(/saved/);
    expect(green).not.toMatch(/neutral|error/);
    for (const kind of ["dirty", "saving", "checking"] as const) {
      const grey = await tone({ kind });
      expect(grey, kind).toMatch(/neutral/);
      expect(grey, kind).not.toMatch(/saved|error/);
    }
    for (const status of [{ kind: "retry" }, { kind: "invalid", fields: ["Hind"] }, { kind: "signedOut" }, { kind: "conflict" }, { kind: "gone" }] as AutosaveStatus[]) {
      const red = await tone(status);
      expect(red, status.kind).toMatch(/error/);
      expect(red, status.kind).not.toMatch(/saved|neutral/);
    }
  });

  it("draft: „Mustand salvestatud {HH:MM}“", async () => {
    await show({ status: { kind: "saved", at: new Date("2026-10-21T11:02:00Z") }, draft: true });
    expect(live().textContent).toBe("Mustand salvestatud 14:02");
    expect(visible().textContent).toBe("✓ Mustand salvestatud 14:02");
  });

  it("draft only changes the saved state", async () => {
    await show({ status: { kind: "dirty" }, draft: true });
    expect(live().textContent).toBe("Salvestamata muudatused");
  });

  it("gone: „Seda registreerimist enam ei ole. Tekst on selles seadmes alles.“", async () => {
    await show({ status: { kind: "gone" }, thing: "registreerimist" });
    expect(live().textContent).toBe("Seda registreerimist enam ei ole. Tekst on selles seadmes alles.");
    expect(visible().textContent).toBe("Seda registreerimist enam ei ole. Tekst on selles seadmes alles.");
    await show({ status: { kind: "gone" }, thing: "postitust" });
    expect(visible().textContent).toBe("Seda postitust enam ei ole. Tekst on selles seadmes alles.");
  });

  it("gone without a `thing` still reads as a sentence (README's „{asja}“)", async () => {
    await show({ status: { kind: "gone" } });
    expect(visible().textContent).toBe("Seda asja enam ei ole. Tekst on selles seadmes alles.");
  });

  it("the time is Tallinn's, summer and winter, and the day's edge", async () => {
    await open({ status: { kind: "saved", at: new Date("2026-12-01T10:00:00Z") } }); // UTC+2
    expect(live().textContent).toBe("Salvestatud 12:00");
    await open({ status: { kind: "saved", at: new Date("2026-06-30T21:30:00Z") } }); // UTC+3, already the next day
    expect(live().textContent).toBe("Salvestatud 00:30");
  });

  it("saved with no time yet (the page was just opened): no clock, and no invented one", async () => {
    await open({ status: { kind: "saved", at: null } });
    expect(live().textContent).toBe("Salvestatud");
    expect(visible().textContent).toBe("✓ Salvestatud");
    await open({ status: { kind: "saved", at: null }, draft: true });
    expect(live().textContent).toBe("Mustand salvestatud");
    expect(visible().textContent).toBe("✓ Mustand salvestatud");
    await open({ status: { kind: "saved", at: new Date(NaN) } });
    expect(live().textContent).toBe("Salvestatud");
  });
});

describe("SaveStatus: the phone page's short form (strings.md D1)", () => {
  it("compact: „✓ {HH:MM}“ and „✓ Mustand {HH:MM}“; the spoken text stays whole", async () => {
    await open({ status: { kind: "saved", at: new Date("2026-10-21T08:20:00Z") }, compact: true });
    expect(visible().textContent).toBe("✓ 11:20");
    expect(live().textContent).toBe("Salvestatud 11:20");
    await open({ status: { kind: "saved", at: new Date("2026-10-21T11:02:00Z") }, compact: true, draft: true });
    expect(visible().textContent).toBe("✓ Mustand 14:02");
    expect(live().textContent).toBe("Mustand salvestatud 14:02");
  });

  it("compact shortens only the saved chip; the others keep their words", async () => {
    for (const [status, expected] of STATES.slice(1)) {
      await show({ status, compact: true });
      expect(visible().textContent, status.kind).toBe(expected);
    }
    await show({ status: { kind: "gone" }, compact: true, thing: "registreerimist" });
    expect(visible().textContent).toBe("Seda registreerimist enam ei ole. Tekst on selles seadmes alles.");
  });

  it("compact with no time: the words alone", async () => {
    await open({ status: { kind: "saved", at: null }, compact: true });
    expect(visible().textContent).toBe("✓ Salvestatud");
    await open({ status: { kind: "saved", at: null }, compact: true, draft: true });
    expect(visible().textContent).toBe("✓ Mustand");
  });
});

describe("SaveStatus: for a screen reader", () => {
  it("the visible chip and the ✓ are aria-hidden; the status region is the one that speaks", async () => {
    await show({ status: { kind: "saved", at: NOON } });
    expect(visible().getAttribute("aria-hidden")).toBe("true");
    const check = $("[data-save-check]")!;
    expect(check.textContent).toBe("✓");
    expect(check.getAttribute("aria-hidden")).toBe("true");
    expect(live().getAttribute("role")).toBe("status");
    expect(live().closest('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    // the ✓ belongs to the saved chip only
    await show({ status: { kind: "dirty" } });
    expect($("[data-save-check]")).toBeNull();
  });

  it("the live region is visually hidden (the .sr class), not display:none", async () => {
    await show({ status: { kind: "dirty" } });
    expect(live().className).toMatch(/sr/);
  });

  it("the live region changes only when the kind changes", async () => {
    await show({ status: { kind: "saved", at: NOON } });
    const region = live();
    expect(region.textContent).toBe("Salvestatud 12:04");
    // the same kind again, later (another save): what she sees moves on, what is spoken does not
    await show({ status: { kind: "saved", at: new Date("2026-10-21T09:07:00Z") } });
    expect(visible().textContent).toBe("✓ Salvestatud 12:07");
    expect(live()).toBe(region);
    expect(region.textContent).toBe("Salvestatud 12:04");
    // the same kind with other details: invalid with other fields, the draft flag
    await show({ status: { kind: "saved", at: new Date("2026-10-21T09:07:00Z") }, draft: true });
    expect(region.textContent).toBe("Salvestatud 12:04");
    // a new kind: spoken
    await show({ status: { kind: "dirty" } });
    expect(region.textContent).toBe("Salvestamata muudatused");
    await show({ status: { kind: "saving" } });
    expect(region.textContent).toBe("Salvestan…");
    await show({ status: { kind: "saved", at: new Date("2026-10-21T09:08:00Z") }, compact: true });
    expect(region.textContent).toBe("Salvestatud 12:08");
  });

  it("invalid with other fields is still the same news", async () => {
    await show({ status: { kind: "invalid", fields: ["Hind"] } });
    const region = live();
    await show({ status: { kind: "invalid", fields: ["Hind", "Nimi"] } });
    expect(live()).toBe(region);
    expect(region.textContent).toBe("Salvestamata — kontrolli märgitud välja");
  });
});

describe("SaveStatus: „Näita“", () => {
  it("invalid: „Näita“ calls onShowInvalid", async () => {
    const onShowInvalid = vi.fn();
    await show({ status: { kind: "invalid", fields: ["Hind"] }, onShowInvalid });
    const link = $<HTMLButtonElement>("button")!;
    expect(link.textContent).toBe("Näita");
    expect(link.type).toBe("button");
    // reachable by a screen reader: it is not inside the aria-hidden text
    expect(link.closest('[aria-hidden="true"]')).toBeNull();
    // and not in the spoken line either
    expect(live().textContent).toBe("Salvestamata — kontrolli märgitud välja");
    await click(link);
    expect(onShowInvalid).toHaveBeenCalledTimes(1);
  });

  it("no handler, no link; and only the invalid state has one", async () => {
    await show({ status: { kind: "invalid", fields: ["Hind"] } });
    expect($("button")).toBeNull();
    const onShowInvalid = vi.fn();
    for (const [status] of STATES.filter(([s]) => s.kind !== "invalid")) {
      await show({ status, onShowInvalid });
      expect($("button"), status.kind).toBeNull();
    }
  });
});

// B19 (admin UX pass piece 4c, Task 5): signed out, the words „logi uuesti sisse“ are a link to the login page, which brings her back to this page after
// signing in (?tagasi= with the path, the query and the fragment). No new words: the chip says what it said.
describe("SaveStatus: signed out, „logi uuesti sisse“ is the way to sign in again", () => {
  const link = () => $<HTMLAnchorElement>("[data-save-status] a")!;
  afterEach(() => history.replaceState(null, "", "/"));

  it("links to /admin/login?tagasi=<this page>, the same words as before", async () => {
    history.replaceState(null, "", "/admin/testimine?kes=koik#kirjad-halduse-link");
    await show({ status: { kind: "signedOut" } });
    expect(link().textContent).toBe("logi uuesti sisse");
    expect(link().getAttribute("href")).toBe("/admin/login?tagasi=%2Fadmin%2Ftestimine%3Fkes%3Dkoik%23kirjad-halduse-link");
    expect(visible().textContent).toBe("Salvestamata — logi uuesti sisse");
    expect(live().textContent).toBe("Salvestamata — logi uuesti sisse");
  });

  it("the link is reachable by a screen reader; the words before it are hidden (the status region says the whole sentence)", async () => {
    history.replaceState(null, "", "/admin/opilased?id=4");
    await show({ status: { kind: "signedOut" } });
    expect(link().closest('[aria-hidden="true"]')).toBeNull();
    const before = [...visible().childNodes].filter((n) => n !== link());
    expect(before.map((n) => n.textContent).join("")).toBe("Salvestamata — ");
    for (const n of before) expect((n as Element).getAttribute?.("aria-hidden"), n.textContent ?? "").toBe("true");
  });

  it("the compact chip has the link too, and the panel's front page gives the plain login page", async () => {
    history.replaceState(null, "", "/admin");
    await show({ status: { kind: "signedOut" }, compact: true });
    expect(link().getAttribute("href")).toBe("/admin/login");
  });

  it("the page she is on when she reaches for it: a fragment or a drawer opened since is in the link", async () => {
    history.replaceState(null, "", "/admin/testimine");
    await show({ status: { kind: "signedOut" } });
    expect(link().getAttribute("href")).toBe("/admin/login?tagasi=%2Fadmin%2Ftestimine");
    await act(async () => {
      history.replaceState(null, "", "/admin/testimine#x");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(link().getAttribute("href")).toBe("/admin/login?tagasi=%2Fadmin%2Ftestimine%23x");
    // a move the router made without an event (pushState): read again as the link is focused or pressed
    history.replaceState(null, "", "/admin/kalender?id=3");
    await act(async () => link().focus());
    expect(link().getAttribute("href")).toBe("/admin/login?tagasi=%2Fadmin%2Fkalender%3Fid%3D3");
  });

  it("only the signed-out state has a link", async () => {
    for (const [status] of STATES.filter(([s]) => s.kind !== "signedOut")) {
      await show({ status, onShowInvalid: () => {} });
      expect($("[data-save-status] a"), status.kind).toBeNull();
      expect(visible().getAttribute("aria-hidden"), status.kind).toBe("true");
    }
  });
});
