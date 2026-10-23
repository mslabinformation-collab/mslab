// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccessActions } from "@/components/admin/AccessActions";
import { UndoProvider } from "@/components/admin/UndoBar";
import { adminEt } from "@/i18n/dict/admin";

// An e-course card's actions in a student's drawer (README A5), in a browser-like document (happy-dom) with the server actions answered here:
// „Hinda“, „Pikenda ▾“ and „Veel ▾“ — the rarer ones under it: „Ava järgmine õppetund“ and „Lõpeta ligipääs“ ask with a ConfirmPanel (P-13: the question,
// the consequence, „Jah, …“ and „Katkesta“), „Katkesta“ puts the focus back on „Veel ▾“; the line that says what was opened is kept when the page comes
// back with nothing left to open; a failed answer stays in the question; an access ended here sends the focus to the card's state line.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { ok: true } | { ok: false; error: string };
const unlock = vi.hoisted(() => vi.fn<(prev: unknown, formData: FormData) => Promise<Answer>>());
const revoke = vi.hoisted(() => vi.fn<(prev: unknown, formData: FormData) => Promise<Answer>>());
vi.mock("@/server/actions/admin-clients", () => ({
  addStudent: vi.fn(),
  grantCourseAccess: vi.fn(),
  revokeCourseAccess: revoke,
  unlockNextLesson: unlock,
  extendAccessAction: vi.fn(),
}));

const third = { id: 7, title: "Kolmas tund" };
const fourth = { id: 8, title: "Neljas tund" };
type Props = Parameters<typeof AccessActions>[0];
const base: Props = {
  clientId: 3,
  accessId: 41,
  courseId: 5,
  course: "Kulmumeistri e-koolitus",
  state: "active",
  expiresAt: "2027-03-17T21:59:59.999Z",
  extendMin: "2027-03-18",
  extendMax: "2036-10-04",
  assessHref: null,
  protocol: { href: "/admin/protokollid?ligipaas=41", label: "Lisa protokoll" },
  attemptsHref: null,
  viewHref: null,
  lesson: null,
  stateId: "access-41-state",
};

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The drawer's page: the card's actions as the page says they are now. */
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(UndoProvider, null, createElement(AccessActions, { ...base, ...over }), createElement("span", { id: "access-41-state", tabIndex: -1 }))));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
const veel = () => $<HTMLButtonElement>('[data-more="veel"] button[aria-haspopup=menu]')!;
const items = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
const item = (name: string) => items().find((i) => i.textContent === name) ?? null;
/** Opens „Veel ▾“ unless it is open already (a page coming back leaves an open menu as it was). */
const openMenu = async () => {
  if (items().length === 0) await click(veel());
};
const choose = async (name: string) => {
  await openMenu();
  await click(item(name));
};
const panel = () => $("[data-confirm-panel]");
const doneLine = () => $("[data-unlock-done]");
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  unlock.mockReset();
  revoke.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the actions of an access card", () => {
  test("„Hinda“ only when work waits; „Pikenda ▾“ and „Veel ▾“ always on a live access", async () => {
    await show();
    expect($("[data-access-assess]")).toBeNull();
    expect(text(veel())).toBe("Veel ▾");
    expect(veel().getAttribute("aria-label")).toBe("Veel: Kulmumeistri e-koolitus");
    expect($('[data-extend] button[aria-haspopup=menu]')!.textContent).toContain("Pikenda");
    await show({ assessHref: "/admin/protokollid?ligipaas=41" });
    const assess = $<HTMLAnchorElement>("[data-access-assess]")!;
    expect(text(assess)).toBe("Hinda");
    expect(assess.getAttribute("href")).toBe("/admin/protokollid?ligipaas=41");
  });

  test("an access an admin ended has no actions at all", async () => {
    await show({ state: "revoked", assessHref: "/x", lesson: third });
    expect(container.querySelector("button, a")).toBeNull();
  });

  test("„Veel ▾“ holds, in README's order, only what the access allows (an open one with a locked lesson, attempts and a course page has them all)", async () => {
    await show({ lesson: third, attemptsHref: "/admin/hindamine/test?ligipaas=41", viewHref: "/admin/opilased/3/vaade/kulm" });
    await openMenu();
    expect(items().map((i) => i.textContent)).toEqual(["Ava järgmine õppetund", "Lisa protokoll", "Testi katsed", "Vaata tema vaadet", "Lõpeta ligipääs"]);
    expect(items().map((i) => i.getAttribute("href"))).toEqual([null, "/admin/protokollid?ligipaas=41", "/admin/hindamine/test?ligipaas=41", "/admin/opilased/3/vaade/kulm", null]);
    expect(item("Lõpeta ligipääs")!.getAttribute("data-tone")).toBe("danger");
    // one that ran out: the protocol and the attempts remain; nothing to unlock, no page of hers, nothing to end
    await show({ state: "expired", lesson: third, attemptsHref: "/admin/hindamine/test?ligipaas=41", viewHref: "/admin/opilased/3/vaade/kulm", protocol: { href: "/admin/protokollid?ligipaas=41", label: "Ava protokoll" } });
    await openMenu();
    expect(items().map((i) => i.textContent)).toEqual(["Ava protokoll", "Testi katsed"]);
  });
});

describe("„Ava järgmine õppetund“", () => {
  test("it asks with a ConfirmPanel: the question, the consequence, „Jah, ava“ and „Katkesta“; „Katkesta“ sends nothing and the focus is back on „Veel ▾“", async () => {
    await show({ lesson: third });
    expect(panel()).toBeNull();
    await choose("Ava järgmine õppetund");
    expect(text($("[data-confirm-panel] p"))).toBe("Kas avan õpilasele õppetunni „Kolmas tund“?");
    expect(text($("[data-confirm-panel] li"))).toBe("Ta saab selle kohe vaadata.");
    expect([...document.querySelectorAll("[data-confirm-panel] button")].map((b) => b.textContent)).toEqual(["Jah, ava", "Katkesta"]);
    expect(document.activeElement).toBe(panel());
    await click(button("Katkesta"));
    expect(panel()).toBeNull();
    expect(unlock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(veel());
  });

  test("an open question ends when the page comes back with nothing locked, and does not come back asking by itself when a lesson is locked again", async () => {
    await show({ lesson: third });
    await choose("Ava järgmine õppetund");
    expect(panel()).not.toBeNull();
    await show({ lesson: null }); // opened elsewhere, or hidden
    expect(panel()).toBeNull();
    await openMenu();
    expect(item("Ava järgmine õppetund")).toBeNull();
    await show({ lesson: fourth });
    expect(panel()).toBeNull();
    await openMenu();
    expect(item("Ava järgmine õppetund")).not.toBeNull();
  });

  test("ok: it sends the three ids, the line says which lesson was opened and keeps saying it when the page comes back with nothing locked; the focus is on it", async () => {
    unlock.mockResolvedValue({ ok: true });
    await show({ lesson: third });
    expect(doneLine()!.textContent).toBe(""); // a status region from the start (an empty one is announced when it fills)
    expect(doneLine()!.getAttribute("role")).toBe("status");
    await choose("Ava järgmine õppetund");
    await click(button("Jah, ava"));
    expect(unlock).toHaveBeenCalledTimes(1);
    const sent = unlock.mock.calls[0][1];
    expect([sent.get("clientId"), sent.get("courseId"), sent.get("lessonId")]).toEqual(["3", "5", "7"]);
    expect(doneLine()!.textContent).toBe("Õppetund „Kolmas tund“ on avatud.");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(doneLine());
    await show({ lesson: null }); // the page's refresh: that was the last locked lesson
    expect(doneLine()!.textContent).toBe("Õppetund „Kolmas tund“ on avatud.");
    await show({ lesson: fourth }); // or the next one is locked: its item under the same line
    expect(doneLine()!.textContent).toBe("Õppetund „Kolmas tund“ on avatud.");
    await choose("Ava järgmine õppetund"); // asking about the next one takes the old line away
    expect(doneLine()!.textContent).toBe("");
  });

  test("not ok: the question stays with the error; asking again later does not show the old error", async () => {
    unlock.mockResolvedValue({ ok: false, error: "notFound" });
    await show({ lesson: third });
    await choose("Ava järgmine õppetund");
    await click(button("Jah, ava"));
    expect($("[data-unlock-panel] [role='alert']")!.textContent).toBe(adminEt.common.saveError);
    expect(doneLine()!.textContent).toBe("");
    await click(button("Katkesta"));
    await choose("Ava järgmine õppetund");
    expect($("[data-unlock-panel] [role='alert']")).toBeNull();
  });
});

describe("„Lõpeta ligipääs“", () => {
  test("it asks with a red ConfirmPanel: „Kas lõpetan ligipääsu koolitusele „…“?“, „Õpilane ei saa seda enam avada.“, „Jah, lõpeta“, „Katkesta“", async () => {
    await show();
    await choose("Lõpeta ligipääs");
    expect(text($("[data-confirm-panel] p"))).toBe("Kas lõpetan ligipääsu koolitusele „Kulmumeistri e-koolitus“?");
    expect(text($("[data-confirm-panel] li"))).toBe("Õpilane ei saa seda enam avada.");
    expect([...document.querySelectorAll("[data-confirm-panel] button")].map((b) => b.textContent)).toEqual(["Jah, lõpeta", "Katkesta"]);
    expect(document.activeElement).toBe(panel());
    await click(button("Katkesta"));
    expect(panel()).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(veel());
  });

  test("Esc closes only the question (a drawer around it stays open)", async () => {
    await show();
    await choose("Lõpeta ligipääs");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await act(async () => void panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    document.removeEventListener("keydown", outer);
    expect(panel()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(veel());
  });

  test("„Jah, lõpeta“ sends the student and the access; once the page comes back with the access ended, the focus goes to the card's state line", async () => {
    revoke.mockResolvedValue({ ok: true });
    await show();
    await choose("Lõpeta ligipääs");
    await click(button("Jah, lõpeta"));
    expect(revoke).toHaveBeenCalledTimes(1);
    const sent = revoke.mock.calls[0][1];
    expect([sent.get("clientId"), sent.get("accessId")]).toEqual(["3", "41"]);
    await show({ state: "revoked" }); // the page's refresh
    expect(container.querySelector("button, a")).toBeNull();
    expect(document.activeElement).toBe($("#access-41-state"));
  });

  test("not ok: the question stays with the error", async () => {
    revoke.mockResolvedValue({ ok: false, error: "server" });
    await show();
    await choose("Lõpeta ligipääs");
    await click(button("Jah, lõpeta"));
    expect($("[data-revoke-panel] [role='alert']")!.textContent).toBe(adminEt.common.saveError);
    expect(panel()).not.toBeNull();
  });
});
