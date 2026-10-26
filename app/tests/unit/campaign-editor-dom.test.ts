// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import { CAMPAIGN_LIMITS } from "@/domain/newsletter-campaign";

// Maria's letter editor on the „Kirjad“ tab (newsletter campaigns, Task 4; spec D4, D5; the 20.10 design §3; admin UX pass piece 3b, Task 6: README B5,
// B9, B17, spec C4, rulings R-g, R-h, the Part 3 frame „B5 Uudiskiri“ and the Part 4 „B5 Kirjad“, piece3-texts S3-P3-f, S3-P3-h, S3-P3-l, P-12, P-13) in
// a browser-like document (happy-dom), with the server actions, the autosave route and the preview route answered here:
// - a draft: its fields, limits and counters, autosaved on api/admin/kiri/<id> under one SaveStatus (no „Salvesta“); the live preview of the real mail in
//   the language of the page's ET | RU switch (no switch of its own); „Kustuta mustand“ behind its ConfirmPanel; the phone's „Muuda | Eelvaade“;
// - its sends: the select „{address} · {eesti|vene keeles}“ and „Saada proov“; „Saada kõigile ({n})“ with the render's count (sample addresses left
//   out), its ConfirmPanel of P-13 („Jah, saada {n} tellijale“), and both sends flushing first: when the letter cannot be saved the two buttons give way
//   to „Saatmiseks peab kiri olema salvestatud.“ and the reason (S3-P3-l); the sends' own rules (R-g: the subject and the text) said in the fields;
// - a letter going out: its progress line, the failed and unknown counts, the refused line and „Peata saatmine“ (its ConfirmPanel); a sent one,
//   read-only, with „Saadetud {date} · {n} tellijale“ and „Kopeeri“; „Uus kiri +“ and the list's „Mustand kustutatud.“.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  createDraftAction: vi.fn(),
  deleteDraftAction: vi.fn(),
  copyCampaignAction: vi.fn(),
  prepareSendAction: vi.fn(),
  startSendAction: vi.fn(),
  stopSendAction: vi.fn(),
  sendTestAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-newsletter", () => actions);
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { EditLangProvider, LangSwitch } from "@/components/admin/EditLang";
import { DeletedNotice, NewLetterButton, NewsletterCampaignEditor, type Audience, type CampaignEditorView, type TestTarget } from "@/components/admin/NewsletterCampaignEditor";
import type { Progress } from "@/server/newsletter-campaigns";

const VALUES = {
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "−15% kõigile koolitustele", ru: "" },
  imageKey: "img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
  body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац." },
  code: "SUGIS15",
  buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
  buttonHref: "/koolitused",
};
const NONE: Progress = { total: 0, sent: 0, waiting: 0, failed: 0, unknown: 0, skipped: 0 };
const DRAFT: CampaignEditorView = {
  id: 7,
  status: "draft",
  values: VALUES,
  version: "k:v1",
  sentAt: null,
  updatedAt: "2026-10-19T09:00:00.000Z",
  recipients: null,
  progress: null,
  refused: false,
};
const SENT: CampaignEditorView = { ...DRAFT, status: "sent", sentAt: "2026-10-19T09:05:00.000Z", recipients: { et: 40, ru: 12 }, progress: { ...NONE, total: 52, sent: 52 } };
/** A letter going out: 12 subscribers, 5 mails went, 7 wait. */
const GOING: CampaignEditorView = { ...DRAFT, status: "sending", sentAt: null, recipients: { et: 9, ru: 3 }, progress: { ...NONE, total: 12, sent: 5, waiting: 7 } };
const TARGETS: TestTarget[] = [
  { key: "maria", address: "maria@example.test" },
  { key: "me", address: "admin@example.test" },
];
/** The render's count (B9, R-h): 2 Estonian and 1 Russian confirmed subscribers, and a sample address left out. */
const AUDIENCE: Audience = { et: 2, ru: 1, samples: 1 };
const LIST = "/admin/uudiskiri?vaade=kampaaniad";

let container: HTMLDivElement;
let root: Root;
let previews: { url: string; body: { draft: Record<string, unknown> } }[];
/** The autosave route's saves (api/admin/kiri/7), and its answer to the next one (the route's own, unless told). */
let saves: { version: string; patch: Record<string, unknown> }[];
let answer: (() => Response | Promise<Response> | null) | null;
let version = "k:v1";
/** The order of what went out: the saves and the actions. */
let order: string[];
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<E>(selector)];
const text = (selector: string) => $(selector)?.textContent ?? null;
const words = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** Lets the preview's pause pass (the editor waits a moment after the last key before it asks again). */
const later = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 450));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
type Shown = { testTargets?: TestTarget[]; gated?: boolean; audience?: Audience };
// (the page's ET | RU switch is in the page's heading, not in the editor: the test puts it beside it, under the panel's provider; the editor is keyed by
// the letter as CampaignsPanel keys it)
const tree = (campaign: CampaignEditorView | null, o: Shown = {}) =>
  createElement(
    EditLangProvider,
    null,
    createElement(LangSwitch),
    createElement(DeletedNotice, { selected: campaign?.id ?? null }),
    campaign &&
      createElement(NewsletterCampaignEditor, {
        key: campaign.id,
        campaign,
        links: ["/koolitused"],
        testTargets: o.testTargets ?? TARGETS,
        gated: o.gated ?? false,
        audience: o.audience ?? AUDIENCE,
      }),
  );
const show = async (campaign: CampaignEditorView | null, o: Shown = {}) => {
  await act(async () => root.render(tree(campaign, o)));
  await later();
};
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};
const type = async (el: HTMLElement | null, value: string) => {
  if (!el) throw new Error("no field");
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const choose = async (el: HTMLSelectElement | null, value: string) => {
  if (!el) throw new Error("no select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};
/** A field left: the form saves at once. */
const leave = async (el: Element | null) => {
  await act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
};
const frame = () => $<HTMLIFrameElement>("[data-campaign-preview-frame]");
const chip = () => $("[data-campaign-form] [data-save-status]");
const buttonNamed = (name: string) => all<HTMLButtonElement>("button").find((b) => words(b) === name) ?? null;
const panelOf = (scope: string) => $(`${scope} [data-confirm-panel]`);
const panelText = (scope: string) => {
  const p = panelOf(scope);
  if (!p) return null;
  return { question: words(p.querySelector("p")), lines: [...p.querySelectorAll("li")].map(words), buttons: [...p.querySelectorAll("button")].map(words) };
};

beforeEach(() => {
  localStorage.clear(); // (the language is kept per device, and the autosave's copies)
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
  previews = [];
  saves = [];
  answer = null;
  version = "k:v1";
  order = [];
  for (const [name, fn] of Object.entries(actions)) fn.mockImplementation(async () => void order.push(name));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/admin/kiri/7") {
        const body = JSON.parse(String(init.body)) as { version: string; patch: Record<string, unknown> };
        saves.push(body);
        order.push("save");
        const told = answer;
        answer = null;
        if (told) {
          const r = await told();
          if (r === null) throw new TypeError("Failed to fetch");
          return r;
        }
        version = `k:v${saves.length + 1}`;
        return Response.json({ ok: true, version, savedAt: "2026-10-19T09:30:00.000Z" });
      }
      const body = JSON.parse(String(init.body)) as { draft: Record<string, unknown> };
      previews.push({ url, body });
      const d = body.draft as { subject: { et: string; ru: string }; body: { et: string; ru: string } };
      const fallsBack = !d.subject.ru || !d.body.ru;
      return Response.json({
        ok: true,
        ruFallsBack: fallsBack,
        et: { subject: d.subject.et, preheader: "", html: `<!doctype html><p>ET ${d.body.et}</p>` },
        ru: { subject: fallsBack ? d.subject.et : d.subject.ru, preheader: "", html: `<!doctype html><p>RU ${fallsBack ? d.body.et : d.body.ru}</p>` },
      });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a draft: its fields autosave", () => {
  test("its fields as stored, each with its limit and a counter; the button's address suggests the site's pages; no „Salvesta“", async () => {
    await show(DRAFT);
    expect($<HTMLInputElement>('[data-field="name"]')!.value).toBe("Oktoobri pakkumine");
    expect($<HTMLInputElement>('[data-field="name"]')!.maxLength).toBe(CAMPAIGN_LIMITS.name);
    expect($<HTMLInputElement>('[data-i18n="subject"]')!.value).toBe("Sügispakkumine");
    expect($<HTMLInputElement>('[data-i18n="subject"]')!.maxLength).toBe(CAMPAIGN_LIMITS.subject);
    expect($<HTMLTextAreaElement>('[data-i18n="body"]')!.maxLength).toBe(CAMPAIGN_LIMITS.body);
    expect($<HTMLInputElement>('[data-i18n="buttonLabel"]')!.maxLength).toBe(CAMPAIGN_LIMITS.buttonLabel);
    expect($<HTMLInputElement>('[data-field="buttonHref"]')!.maxLength).toBe(CAMPAIGN_LIMITS.href);
    expect($<HTMLInputElement>('[data-field="code"]')!.value).toBe("SUGIS15");
    expect(text('[data-campaign-count="name"]')).toBe(`18 / ${CAMPAIGN_LIMITS.name}`);
    expect(text('[data-campaign-count="subject"]')).toBe(`ET 14 / ${CAMPAIGN_LIMITS.subject} · RU 19 / ${CAMPAIGN_LIMITS.subject}`);
    await type($('[data-field="name"]'), "Uus nimi");
    expect(text('[data-campaign-count="name"]')).toBe(`8 / ${CAMPAIGN_LIMITS.name}`);
    expect($('[data-single-image="campaign-image"] img')!.getAttribute("src")).toBe("/media/img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg");
    expect(container.textContent).toContain("Tühi rida alustab uut lõiku.");
    expect(all("datalist option").map((o) => o.getAttribute("value"))).toEqual(["/koolitused"]);
    // the card's head: the letter's name and the one SaveStatus (the Part 3 frame); nothing to press to save
    expect(text("[data-campaign-title]")).toBe("Uus nimi");
    expect(chip()).not.toBeNull();
    for (const gone of ["Salvesta", "Salvesta muudatused enne saatmist."]) expect(buttonNamed(gone), gone).toBeNull();
    expect(container.textContent).not.toContain("Salvesta muudatused enne saatmist.");
    expect($("[data-save-bar]")).toBeNull();
  });

  test("typed text goes to the letter's route 1.5 s after the last key, only the field changed, from the version the page read; the chip follows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await show(DRAFT);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    await type($('[data-i18n="subject"]'), "Talvepakkumine");
    expect(chip()!.getAttribute("data-save-kind")).toBe("dirty");
    expect(saves).toEqual([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50)));
    await settle();
    expect(saves).toEqual([{ version: "k:v1", patch: { subject: { et: "Talvepakkumine", ru: "Осеннее предложение" } } }]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    // a field the list does not show: the page is not read again (review M6: no page read every 1.5 s of typing)
    expect(router.refresh).not.toHaveBeenCalled();
    // a field left saves at once, from the version the last save answered; the name is the list's row: the page is read again
    await type($('[data-field="name"]'), "Talv");
    await leave($('[data-field="name"]'));
    expect(saves.at(-1)).toEqual({ version: "k:v2", patch: { name: "Talv" } });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  test("an empty subject and text save (ruling R-g); an empty name is held back in its field and said there, the others still save", async () => {
    await show(DRAFT);
    await type($('[data-i18n="subject"]'), "");
    await leave($('[data-i18n="subject"]'));
    expect(saves.at(-1)?.patch).toEqual({ subject: { et: "", ru: "Осеннее предложение" } });
    await type($('[data-field="name"]'), "");
    await type($('[data-i18n="preheader"]'), "Rida");
    await leave($('[data-field="name"]'));
    expect(saves.at(-1)?.patch).toEqual({ preheader: { et: "Rida", ru: "" } });
    expect(saves.some((s) => "name" in s.patch)).toBe(false);
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
    expect(container.textContent).toContain("Täida see väli.");
  });

  test("the route refuses a field (the server's rule): it is said in the field, as the Russian button label of ruling R2", async () => {
    await show(DRAFT);
    answer = () => Response.json({ ok: false, error: "invalid", fields: { buttonLabel: "ruLabel" } }, { status: 400 });
    await type($('[data-i18n="buttonLabel"]'), "Vaata kõiki");
    await leave($('[data-i18n="buttonLabel"]'));
    expect(container.textContent).toContain("Lisa nupu tekst ka vene keeles.");
    expect(chip()!.getAttribute("data-save-kind")).toBe("invalid");
  });

  test("the live preview: the preview route's mail in an <iframe srcdoc sandbox>, in the language of the page's ET | RU switch (no switch of its own)", async () => {
    await show(DRAFT);
    expect(previews.at(-1)!.url).toBe("/api/admin/kampaania-eelvaade");
    expect(previews.at(-1)!.body.draft).toMatchObject({ name: "Oktoobri pakkumine", subject: VALUES.subject });
    const f = frame()!;
    expect(f.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(f.getAttribute("data-campaign-preview-frame")).toBe("et");
    expect(f.getAttribute("srcdoc")).toBe("<!doctype html><p>ET Esimene lõik.\n\nTeine lõik.</p>");
    expect(text("[data-campaign-preview-subject]")).toBe("Sügispakkumine");
    // the preview's own ET | RU pills are gone (ledger L152): the page's switch sets the fields and the preview together
    expect($("[data-campaign-preview] [data-lang]")).toBeNull();
    expect($("[data-campaign-preview] [data-lang-switch]")).toBeNull();
    await click($('[data-edit-lang-switch] [data-edit-lang="ru"]'));
    expect(frame()!.getAttribute("data-campaign-preview-frame")).toBe("ru");
    expect(frame()!.getAttribute("srcdoc")).toBe("<!doctype html><p>RU Первый абзац.</p>");
    expect(text("[data-campaign-preview-subject]")).toBe("Осеннее предложение");
    expect($('[data-i18n="body"]')!.getAttribute("data-lang-field")).toBe("ru");
    expect($("[data-campaign-preview-fallback]")).toBeNull();
    // the Russian text emptied: the Russian subscribers get the Estonian mail, and the preview says so
    await type($('[data-i18n="body"]'), "");
    await later();
    expect(previews.at(-1)!.body.draft).toMatchObject({ body: { et: VALUES.body.et, ru: "" } });
    expect(text("[data-campaign-preview-fallback]")).toBe("Vene keeles tellijad saavad eestikeelse kirja.");
    expect(frame()!.getAttribute("srcdoc")).toContain("RU Esimene lõik.");
    await click($('[data-edit-lang-switch] [data-edit-lang="et"]'));
    expect(frame()!.getAttribute("data-campaign-preview-frame")).toBe("et");
  });

  test("the phone's „Muuda | Eelvaade“ (Part 4): two pressed-state buttons over the letter, „← Kirjad“ back to the list", async () => {
    await show(DRAFT);
    const panes = all("[data-campaign-panes] button");
    expect(panes.map(words)).toEqual(["Muuda", "Eelvaade"]);
    expect(panes.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect($("[data-campaign-form]")!.getAttribute("data-pane")).toBe("edit");
    await click(panes[1]);
    expect($("[data-campaign-form]")!.getAttribute("data-pane")).toBe("preview");
    expect(all("[data-campaign-panes] button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    const back = $<HTMLAnchorElement>("[data-campaign-back]")!;
    expect(words(back)).toBe("← Kirjad");
    expect(back.getAttribute("href")).toBe(LIST);
    // the panes are the stylesheet's below 900 px; the sends' buttons stand at the foot there, above the 💬 bubble
    const css = readFileSync("src/components/admin/CampaignsPanel.module.css", "utf8");
    expect(css).toMatch(/\[data-pane="edit"\][^{]*\[data-pane-part="preview"\]/);
    expect(css).toMatch(/\[data-pane="preview"\][^{]*\[data-pane-part="edit"\]/);
    expect($("[data-send-buttons]")!.hasAttribute("data-fab-avoid")).toBe(true);
  });
});

describe("„Kustuta mustand“ (B17, S3-P3-f)", () => {
  test("its ConfirmPanel in the button's place: the question with the name, „Seda ei saa tagasi võtta.“, „Jah, kustuta“ / „Katkesta“", async () => {
    await show(DRAFT);
    const button = $<HTMLButtonElement>("[data-campaign-delete]")!;
    expect(words(button)).toBe("Kustuta mustand");
    await click(button);
    expect($("[data-campaign-delete]")).toBeNull();
    expect(panelText("[data-campaign-delete-part]")).toEqual({
      question: "Kas kustutan mustandi „Oktoobri pakkumine“?",
      lines: ["Seda ei saa tagasi võtta."],
      buttons: ["Jah, kustuta", "Katkesta"],
    });
    expect(document.activeElement).toBe(panelOf("[data-campaign-delete-part]"));
    await click(buttonNamed("Katkesta"));
    expect(panelOf("[data-campaign-delete-part]")).toBeNull();
    expect(document.activeElement).toBe($("[data-campaign-delete]"));
    expect(actions.deleteDraftAction).not.toHaveBeenCalled();
  });

  test("„Jah, kustuta“: the draft is gone, its copy in this browser too, and the list says „Mustand kustutatud.“", async () => {
    actions.deleteDraftAction.mockResolvedValue({ ok: true });
    await show(DRAFT);
    await type($('[data-field="name"]'), "Pooleli nimi"); // (typed, not saved yet: nothing of it is kept or sent after the delete)
    await click($("[data-campaign-delete]"));
    await click(buttonNamed("Jah, kustuta"));
    expect(actions.deleteDraftAction).toHaveBeenCalledWith({ id: 7 });
    expect(router.replace).toHaveBeenCalledWith(LIST);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("mslab-draft:kiri:7:"))).toEqual([]);
    // the page comes back without the letter: the list's line
    await show(null);
    expect(text("[data-campaign-deleted]")).toBe("Mustand kustutatud.");
    expect(saves).toEqual([]);
    // another letter opened: the line is gone
    await show({ ...DRAFT, id: 8 });
    expect($("[data-campaign-deleted]")).toBeNull();
  });

  test("a letter sent meanwhile (another tab): „See kiri on juba saadetud.“ (the action reads the page again); nothing is deleted", async () => {
    actions.deleteDraftAction.mockResolvedValue({ ok: false, error: "sent" });
    await show(DRAFT);
    await click($("[data-campaign-delete]"));
    await click(buttonNamed("Jah, kustuta"));
    expect(text("[data-campaign-notice]")).toBe("See kiri on juba saadetud.");
    expect(router.replace).not.toHaveBeenCalled();
    expect(panelOf("[data-campaign-delete-part]")).toBeNull();
    // the page's read: the letter is sent, read-only, and the line stays above it
    await show({ ...SENT });
    expect($("[data-campaign-sent]")).not.toBeNull();
    expect(text("[data-campaign-notice]")).toBe("See kiri on juba saadetud.");
  });

  test("a sent or going letter has no „Kustuta mustand“", async () => {
    await show(SENT);
    expect($("[data-campaign-delete]")).toBeNull();
    await show(GOING);
    expect($("[data-campaign-delete]")).toBeNull();
    expect(container.textContent).not.toContain("Kustuta mustand");
  });
});

describe("„Uus kiri +“ (S3-P3-h)", () => {
  test("makes the draft at once and opens it; the cursor is in „Nimi“", async () => {
    actions.createDraftAction.mockResolvedValue({ ok: true, id: 12 });
    await act(async () => root.render(createElement(Fragment, null, createElement(NewLetterButton))));
    const button = $("[data-campaign-new]")!;
    expect(words(button)).toBe("Uus kiri +");
    await click(button);
    expect(actions.createDraftAction).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(`${LIST}&kampaania=12`);
    // the page opens the new draft
    await show({ ...DRAFT, id: 12, values: { ...VALUES, name: "Uus kiri" } });
    expect(document.activeElement).toBe($('[data-field="name"]'));
    // another letter opened later takes no focus
    await show({ ...DRAFT, id: 13 });
    expect(document.activeElement).not.toBe($('[data-field="name"]'));
  });

  test("refused or lost: the words under the button, nothing opened", async () => {
    actions.createDraftAction.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(createElement(NewLetterButton)));
    await click($("[data-campaign-new]"));
    expect(text("[data-campaign-new-status]")).toBe("Ei õnnestunud. Proovi uuesti.");
    expect(router.push).not.toHaveBeenCalled();
  });
});

// ---------- the sends of a draft ----------

/** What the ConfirmPanel is given (actions/admin-newsletter.ts prepareSendAction): the render's 3 — 2 Estonian, 1 Russian, a sample left out. */
const PLAN = { ok: true, et: 2, ru: 1, samples: 1, ruFallsBack: false, updatedAt: "2026-10-19T09:00:00.000Z" };
/** The press's answer when every mail went in its first batch. */
const ALL_WENT = { ok: true, progress: { ...NONE, total: 3, sent: 3 }, stopped: null };
/** An action that is still working: `release` lets it answer. */
function pending<T>() {
  let release!: (value: T) => void;
  const answer = new Promise<T>((resolve) => (release = resolve));
  return { answer, release };
}
const sendLine = () => text("[data-send-status]");
const sendPanel = () => panelText("[data-send-confirm]");

describe("a draft's sends: the select, „Saada proov“, „Saada kõigile ({n})“", () => {
  test("as drawn: the select „{address} · {eesti|vene keeles}“, „Saada proov“, „Saada kõigile (3)“ and the hint; none of the old radios or „Tühista“", async () => {
    await show(DRAFT);
    expect(text("[data-campaign-send] h2")).toBe("Saatmine");
    const select = $<HTMLSelectElement>("[data-test-target]")!;
    expect([...select.options].map((o) => [o.value, words(o)])).toEqual([
      ["maria:et", "maria@example.test · eesti keeles"],
      ["maria:ru", "maria@example.test · vene keeles"],
      ["me:et", "admin@example.test · eesti keeles"],
      ["me:ru", "admin@example.test · vene keeles"],
    ]);
    expect(select.value).toBe("maria:et");
    expect(words($("[data-test-send] [data-label-wide]"))).toBe("Saada proov");
    // the phone's button carries the choice (Part 4): „Saada proov · maria@… · ET“
    expect(words($("[data-test-send] [data-label-phone]"))).toBe("Saada proov · maria@… · ET");
    expect(text("[data-send-all]")).toBe("Saada kõigile (3)");
    expect(text("[data-send-hint]")).toBe("2 eesti, 1 vene keeles · näidisaadressidele ei saadeta");
    for (const hook of ["data-test-to", "data-test-locale", "data-campaign-save-first", "data-mark-not-sent", "data-send-missing", "data-campaign-stop"]) expect($(`[${hook}]`), hook).toBeNull();
    for (const gone of ["Märgi saatmata", "Saada puuduv keel", "Resend", "Sünkrooni", "Kellele"]) expect(words(container).includes(gone) && gone !== "Kellele", gone).toBe(false);
    expect($("[data-send-confirm]")).toBeNull();
  });

  test("the hint without its zero part, and without the sample part when no sample is among the confirmed; n = 0 replaces the button with the existing words", async () => {
    await show(DRAFT, { audience: { et: 4, ru: 0, samples: 0 } });
    expect(text("[data-send-all]")).toBe("Saada kõigile (4)");
    expect(text("[data-send-hint]")).toBe("4 eesti keeles");
    await show({ ...DRAFT, id: 8 }, { audience: { et: 0, ru: 2, samples: 3 } });
    expect(text("[data-send-hint]")).toBe("2 vene keeles · näidisaadressidele ei saadeta");
    await show({ ...DRAFT, id: 9 }, { audience: { et: 0, ru: 0, samples: 2 } });
    expect($("[data-send-all]")).toBeNull();
    expect(text("[data-send-empty]")).toBe("Kinnitatud tellijaid pole: kirja pole kellelegi saata.");
    expect($("[data-test-send]")).not.toBeNull(); // (a test still goes)
  });

  test("„Saada proov“: the address and the language the select holds; the line names the address; a test is no press", async () => {
    await show(DRAFT);
    actions.sendTestAction.mockResolvedValue({ ok: true });
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenLastCalledWith({ id: 7, to: "maria", locale: "et" });
    expect(text("[data-test-status]")).toBe("Proov läks aadressile maria@example.test. Kiri jõuab mõne minuti jooksul.");
    await choose($("[data-test-target]"), "me:ru");
    expect(words($("[data-test-send] [data-label-phone]"))).toBe("Saada proov · admin@… · RU");
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenLastCalledWith({ id: 7, to: "me", locale: "ru" });
    expect(text("[data-test-status]")).toBe("Proov läks aadressile admin@example.test. Kiri jõuab mõne minuti jooksul.");
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
    expect($("[data-send-confirm]")).toBeNull();
  });

  test("while the test goes both labels say „Saadan proovi…“; the results stand in the buttons' bar (on a phone, at the foot of the screen where she pressed)", async () => {
    const working = pending<unknown>();
    actions.sendTestAction.mockReturnValueOnce(working.answer);
    await show(DRAFT);
    await click($("[data-test-send]"));
    expect(words($("[data-test-send] [data-label-wide]"))).toBe("Saadan proovi…");
    expect(words($("[data-test-send] [data-label-phone]"))).toBe("Saadan proovi…");
    await act(async () => working.release({ ok: true }));
    await settle();
    expect(words($("[data-test-send] [data-label-phone]"))).toBe("Saada proov · maria@… · ET");
    const bar = $("[data-send-buttons]")!;
    expect(bar.querySelector("[data-test-status]")).not.toBeNull();
    expect(bar.querySelector("[data-send-status]")).not.toBeNull();
    actions.prepareSendAction.mockResolvedValueOnce({ ok: false, error: "busy" });
    await click($("[data-send-all]"));
    expect(words(bar.querySelector("[data-send-status]"))).toBe("Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.");
  });

  test("without Maria's address only the signed-in admin's is offered, and it is the one chosen", async () => {
    actions.sendTestAction.mockResolvedValue({ ok: true });
    await show(DRAFT, { testTargets: [{ key: "me", address: "admin@example.test" }] });
    expect([...$<HTMLSelectElement>("[data-test-target]")!.options].map((o) => o.value)).toEqual(["me:et", "me:ru"]);
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenCalledWith({ id: 7, to: "me", locale: "et" });
  });

  test("„Saada proov“ refused is said in words: ten an hour, it did not go, no such address, a lost connection", async () => {
    await show(DRAFT);
    const said: [unknown, string][] = [
      [{ ok: false, error: "limited" }, "Selle tunni 10 proovi on saadetud. Proovi tunni pärast uuesti."],
      [{ ok: false, error: "mail" }, "Proovi ei saanud saata. Proovi uuesti."],
      [{ ok: false, error: "address" }, "Sellele aadressile ei saa proovi saata."],
      [{ ok: false, error: "notFound" }, "Seda kirja enam pole."],
    ];
    for (const [answer, line] of said) {
      actions.sendTestAction.mockResolvedValueOnce(answer);
      await click($("[data-test-send]"));
      expect(text("[data-test-status]"), line).toBe(line);
    }
    actions.sendTestAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-test-send]"));
    expect(text("[data-test-status]")).toBe("Ei õnnestunud. Proovi uuesti.");
  });

  test("B9: „Saada kõigile (3)“ opens the ConfirmPanel of P-13 with „Jah, saada 3 tellijale“, and „Jah“ presses what it showed", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    actions.startSendAction.mockResolvedValue(ALL_WENT);
    await show(DRAFT);
    $<HTMLButtonElement>("[data-send-all]")!.focus();
    await click($("[data-send-all]"));
    // the screen's version goes with the panel's read (review I2): nothing typed, so the page's own
    expect(actions.prepareSendAction).toHaveBeenCalledWith({ id: 7, version: "k:v1" });
    expect(sendPanel()).toEqual({
      question: "Kas saadan kirja „Oktoobri pakkumine“?",
      lines: ["3 kinnitatud tellijat: 2 eesti, 1 vene keeles.", "Näidisaadressidele (@example.test) ei saadeta.", "Saadetud kirja ei saa tagasi võtta ega muuta."],
      buttons: ["Jah, saada 3 tellijale", "Katkesta"],
    });
    expect($("[data-send-all]")).toBeNull(); // (the panel is in its place)
    expect(document.activeElement).toBe(panelOf("[data-send-confirm]"));
    await click(buttonNamed("Jah, saada 3 tellijale"));
    expect(actions.startSendAction).toHaveBeenCalledTimes(1);
    expect(actions.startSendAction).toHaveBeenCalledWith({ id: 7, et: 2, ru: 1, updatedAt: "2026-10-19T09:00:00.000Z" });
    expect(sendLine()).toBe("Kiri on saadetud.");
    expect($("[data-send-confirm]")).toBeNull();
  });

  test("P-13's variants: one language; no sample line without a sample; the day's room line above 70; the Russian note and the gate notice under the panel", async () => {
    await show(DRAFT, { audience: { et: 3, ru: 0, samples: 0 } });
    actions.prepareSendAction.mockResolvedValueOnce({ ...PLAN, et: 3, ru: 0, samples: 0 });
    await click($("[data-send-all]"));
    expect(sendPanel()!.lines).toEqual(["3 kinnitatud tellijat: 3 eesti keeles.", "Saadetud kirja ei saa tagasi võtta ega muuta."]);
    expect($("[data-send-fallback]")).toBeNull();
    await click(buttonNamed("Katkesta"));
    expect(document.activeElement).toBe($("[data-send-all]"));
    await show({ ...DRAFT, id: 8 }, { audience: { et: 60, ru: 15, samples: 0 }, gated: true });
    actions.prepareSendAction.mockResolvedValueOnce({ ...PLAN, et: 60, ru: 15, samples: 0, ruFallsBack: true });
    await click($("[data-send-all]"));
    expect(sendPanel()!.lines).toEqual([
      "75 kinnitatud tellijat: 60 eesti, 15 vene keeles.",
      "Päevas läheb välja nii palju kirju, kui mahub; ülejäänud lähevad järgmisel päeval.",
      "Saadetud kirja ei saa tagasi võtta ega muuta.",
    ]);
    expect(sendPanel()!.buttons[0]).toBe("Jah, saada 75 tellijale");
    expect(text("[data-send-confirm] [data-send-fallback]")).toBe("Vene keeles tellijad saavad eestikeelse kirja.");
    expect(text("[data-send-confirm] [data-gate-notice]")).toBe("Koduleht pole veel avatud — kirja lingid ja nupp viivad „Tulekul“ lehele.");
    await click(buttonNamed("Katkesta"));
    await show({ ...DRAFT, id: 9 }, { audience: { et: 0, ru: 2, samples: 0 } });
    actions.prepareSendAction.mockResolvedValueOnce({ ...PLAN, et: 0, ru: 2, samples: 0 });
    await click($("[data-send-all]"));
    expect(sendPanel()!.lines[0]).toBe("2 kinnitatud tellijat: 2 vene keeles.");
  });

  test("R-h: a count that moved between the render and the panel's read under the lock is the existing `changed` answer: no panel, the page read again", async () => {
    actions.prepareSendAction.mockResolvedValue({ ...PLAN, et: 3 }); // (4 now, the button said 3)
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect($("[data-send-confirm]")).toBeNull();
    expect(sendLine()).toBe("Kirja või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada kõigile“.");
    expect(router.refresh).toHaveBeenCalled();
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });

  test("C4: both sends flush first — what was typed is saved before the panel's read and before the test, never after", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    actions.prepareSendAction.mockImplementation(async () => {
      order.push("prepareSendAction");
      return PLAN;
    });
    actions.sendTestAction.mockImplementation(async () => {
      order.push("sendTestAction");
      return { ok: true };
    });
    await show(DRAFT);
    await type($('[data-i18n="preheader"]'), "Viimane rida");
    await click($("[data-send-all]"));
    expect(order).toEqual(["save", "prepareSendAction"]);
    expect(saves[0].patch).toEqual({ preheader: { et: "Viimane rida", ru: "" } });
    // the version the flush's save answered goes with the panel's read: the press is for the very text on the screen (review I2)
    expect(actions.prepareSendAction).toHaveBeenLastCalledWith({ id: 7, version: "k:v2" });
    await click(buttonNamed("Katkesta"));
    await type($('[data-i18n="preheader"]'), "Veel üks rida");
    await click($("[data-test-send]"));
    expect(order).toEqual(["save", "prepareSendAction", "save", "sendTestAction"]);
    // nothing typed: nothing to save, the action at once
    await click($("[data-test-send]"));
    expect(order.at(-1)).toBe("sendTestAction");
    expect(saves).toHaveLength(2);
  });

  test("S3-P3-l: the flush cannot go through — the two buttons give way to „Saatmiseks peab kiri olema salvestatud.“ and the reason; nothing is sent", async () => {
    const reasons: [() => Response | null, string][] = [
      [() => Response.json({ ok: false, error: "server" }, { status: 500 }), "Salvestamine ei õnnestunud."],
      [() => null, "Ühendus puudub. Proovin uuesti, kuni jääd siia."],
      [() => new Response("", { status: 401 }), "Logi uuesti sisse."],
    ];
    for (const [i, [give, reason]] of reasons.entries()) {
      await show({ ...DRAFT, id: 7, version: `k:v1` });
      await type($('[data-i18n="preheader"]'), `Rida ${i}`);
      answer = give;
      await click($("[data-send-all]"));
      expect(actions.prepareSendAction, reason).not.toHaveBeenCalled();
      expect($("[data-send-all]"), reason).toBeNull();
      expect($("[data-test-send]"), reason).toBeNull();
      expect(words($("[data-send-blocked]")), reason).toBe(`Saatmiseks peab kiri olema salvestatud. ${reason}`);
      await act(async () => root.unmount());
      root = createRoot(container);
      localStorage.clear();
    }
  });

  test("S3-P3-l on a conflict (another tab saved first) and on a letter deleted meanwhile (gone): the general reason, nothing asked", async () => {
    const cases: [() => Response, string][] = [
      [() => Response.json({ ok: false, error: "conflict", version: "k:other", value: { ...VALUES, preheader: { et: "Teise vahekaardi rida", ru: "" } } }, { status: 409 }), "conflict"],
      [() => Response.json({ ok: false, error: "notFound" }, { status: 404 }), "gone"],
    ];
    for (const [give, kind] of cases) {
      await show({ ...DRAFT });
      await type($('[data-i18n="preheader"]'), `Rida ${kind}`);
      answer = give;
      await click($("[data-send-all]"));
      expect(chip()!.getAttribute("data-save-kind"), kind).toBe(kind);
      expect(actions.prepareSendAction, kind).not.toHaveBeenCalled();
      expect($("[data-send-all]"), kind).toBeNull();
      expect($("[data-test-send]"), kind).toBeNull();
      expect(words($("[data-send-blocked]")), kind).toBe("Saatmiseks peab kiri olema salvestatud. Salvestamine ei õnnestunud.");
      await act(async () => root.unmount());
      root = createRoot(container);
      localStorage.clear();
    }
  });

  test("typed while the flush or the panel's count read is on its way: no panel opens, nothing more is asked", async () => {
    // the flush: its save held until she has typed again
    await show(DRAFT);
    let releaseSave!: () => void;
    answer = () =>
      new Promise<Response>((resolve) => {
        releaseSave = () => resolve(Response.json({ ok: true, version: "k:v2", savedAt: "2026-10-19T09:30:00.000Z" }));
      });
    await type($('[data-i18n="preheader"]'), "Esimene rida");
    await click($("[data-send-all]"));
    await type($('[data-i18n="preheader"]'), "Esimene rida ja veel");
    await act(async () => releaseSave());
    await settle();
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
    expect($("[data-send-confirm]")).toBeNull();
    expect(text("[data-send-status]")).toBe("");
    // the count read: answered after she typed
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.clear();
    await show({ ...DRAFT, id: 8 });
    const read = pending<unknown>();
    actions.prepareSendAction.mockReturnValueOnce(read.answer);
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).toHaveBeenCalledTimes(1);
    await type($('[data-field="name"]'), "Uus nimi vahepeal");
    await act(async () => read.release(PLAN));
    await settle();
    expect($("[data-send-confirm]")).toBeNull();
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });

  test("S3-P3-l, a field held back: „Üks väli vajab parandamist.“ stands in the buttons' place until the field is right; then they are back", async () => {
    await show(DRAFT);
    await type($('[data-field="name"]'), "");
    await leave($('[data-field="name"]'));
    expect(words($("[data-send-blocked]"))).toBe("Saatmiseks peab kiri olema salvestatud. Üks väli vajab parandamist.");
    expect($("[data-send-all]")).toBeNull();
    expect($("[data-test-send]")).toBeNull();
    await type($('[data-field="name"]'), "Nimi tagasi");
    await leave($('[data-field="name"]'));
    expect($("[data-send-blocked]")).toBeNull();
    expect(text("[data-send-all]")).toBe("Saada kõigile (3)");
  });

  test("R-g: the sends' own rules — an empty subject or text is said in the field with the existing words; nothing is asked or sent", async () => {
    await show(DRAFT);
    await type($('[data-i18n="subject"]'), "");
    await type($('[data-i18n="body"]'), "");
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
    expect(all("[data-campaign-form] [aria-invalid='true']").length).toBeGreaterThanOrEqual(2);
    expect(words(container)).toContain("Täida see väli.");
    expect(sendLine()).toBe("Kontrolli märgitud välju.");
    expect(document.activeElement).toBe($('[data-i18n="subject"]'));
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).not.toHaveBeenCalled();
    expect(text("[data-test-status]")).toBe("Kontrolli märgitud välju.");
    // the server's own word (a stored letter the browser did not see): the fields by key
    await type($('[data-i18n="subject"]'), "Teema");
    await type($('[data-i18n="body"]'), "Tekst.");
    actions.prepareSendAction.mockResolvedValueOnce({ ok: false, error: "invalid", fields: { buttonHref: "required" } });
    await click($("[data-send-all]"));
    expect(sendLine()).toBe("Kontrolli märgitud välju.");
    expect($('[data-field="buttonHref"]')!.getAttribute("aria-invalid")).toBe("true");
  });

  test("another letter is going out: the one-at-a-time text instead of the panel (README B5)", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: false, error: "busy" });
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect($("[data-send-confirm]")).toBeNull();
    expect(sendLine()).toBe("Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud.");
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });

  test("every other refusal of the press is said in words and the panel is closed: nothing was sent", async () => {
    await show(DRAFT);
    const prepare: [unknown, string][] = [
      [{ ok: false, error: "empty" }, "Kinnitatud tellijaid pole: kirja pole kellelegi saata."],
      [{ ok: false, error: "sent" }, "See kiri on juba saadetud."],
      [{ ok: false, error: "notFound" }, "Seda kirja enam pole."],
      [{ ok: false, error: "server" }, "Ei õnnestunud. Proovi uuesti."],
      // (review I2: the letter saved elsewhere since the screen's version)
      [{ ok: false, error: "changed" }, "Kirja või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada kõigile“."],
    ];
    for (const [answer, line] of prepare) {
      actions.prepareSendAction.mockResolvedValueOnce(answer);
      await click($("[data-send-all]"));
      expect($("[data-send-confirm]")).toBeNull();
      expect(sendLine(), line).toBe(line);
    }
    actions.prepareSendAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-send-all]"));
    expect(sendLine()).toBe("Ei õnnestunud. Proovi uuesti.");
    actions.prepareSendAction.mockResolvedValue(PLAN);
    const press: [unknown, string][] = [
      [{ ok: false, error: "changed" }, "Kirja või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kiri üle ja vajuta uuesti „Saada kõigile“."],
      [{ ok: false, error: "busy" }, "Eelmine kiri on veel saatmisel. Saada see, kui see on lõppenud."],
      [{ ok: false, error: "sent" }, "See kiri on juba saadetud."],
      [{ ok: false, error: "empty" }, "Kinnitatud tellijaid pole: kirja pole kellelegi saata."],
    ];
    for (const [answer, line] of press) {
      actions.startSendAction.mockResolvedValueOnce(answer);
      await click($("[data-send-all]"));
      await click(buttonNamed("Jah, saada 3 tellijale"));
      expect($("[data-send-confirm]"), line).toBeNull();
      expect(sendLine(), line).toBe(line);
    }
    actions.startSendAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-send-all]"));
    await click(buttonNamed("Jah, saada 3 tellijale"));
    expect(sendLine()).toBe("Ei õnnestunud. Proovi uuesti.");
  });

  test("the first batch stopped at the day's room or its time: the progress line; Resend refused: its line", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    await show(DRAFT);
    actions.startSendAction.mockResolvedValueOnce({ ok: true, progress: { ...NONE, total: 3, sent: 2, waiting: 1 }, stopped: "room" });
    await click($("[data-send-all]"));
    await click(buttonNamed("Jah, saada 3 tellijale"));
    expect(sendLine()).toBe("Saadetud 2 / 3 — ülejäänud 1 lähevad järgmisel päeval.");
    actions.startSendAction.mockResolvedValueOnce({ ok: true, progress: { ...NONE, total: 3, waiting: 3 }, stopped: "refused" });
    await click($("[data-send-all]"));
    await click(buttonNamed("Jah, saada 3 tellijale"));
    expect(sendLine()).toBe("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
  });

  test("while the press works „Jah“ is pressed once and „Katkesta“ does nothing", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    const working = pending<unknown>();
    actions.startSendAction.mockReturnValue(working.answer);
    await show(DRAFT);
    await click($("[data-send-all]"));
    await click(buttonNamed("Jah, saada 3 tellijale"));
    const yes = panelOf("[data-send-confirm]")!.querySelector("button")!;
    expect(words(yes)).toBe("Saadan…");
    expect(yes.getAttribute("aria-disabled")).toBe("true");
    await click(yes);
    await click(buttonNamed("Katkesta"));
    expect(actions.startSendAction).toHaveBeenCalledTimes(1);
    expect($("[data-send-confirm]")).not.toBeNull();
    await act(async () => working.release(ALL_WENT));
    await settle();
    expect(sendLine()).toBe("Kiri on saadetud.");
  });

  test("a field changed while the panel is open closes it: „Jah“ never sends what was not confirmed", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect($("[data-send-confirm]")).not.toBeNull();
    await type($('[data-field="name"]'), "Muudetud nimi");
    expect($("[data-send-confirm]")).toBeNull();
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });

  test("gate on: the result of „Saada proov“ carries the gate line; not before the test went, not after a refusal; gate off: never", async () => {
    const GATE_LINE = "Koduleht pole veel avatud — kirja lingid ja nupp viivad „Tulekul“ lehele.";
    await show(DRAFT, { gated: true });
    expect($("[data-campaign-send]")!.hasAttribute("data-gated")).toBe(true);
    expect($("[data-gate-notice]")).toBeNull();
    actions.sendTestAction.mockResolvedValueOnce({ ok: false, error: "mail" });
    await click($("[data-test-send]"));
    expect($("[data-gate-notice]")).toBeNull();
    actions.sendTestAction.mockResolvedValueOnce({ ok: true });
    await click($("[data-test-send]"));
    expect(text("[data-campaign-send] [data-gate-notice]")).toBe(GATE_LINE);
    await show({ ...DRAFT, id: 8 }, { gated: false });
    actions.sendTestAction.mockResolvedValueOnce({ ok: true });
    await click($("[data-test-send]"));
    expect($("[data-gate-notice]")).toBeNull();
    expect($("[data-campaign-send]")!.hasAttribute("data-gated")).toBe(false);
  });

  test("a long address in the select wraps instead of widening the screen: the rule is in the stylesheet", () => {
    const css = readFileSync("src/components/admin/CampaignsPanel.module.css", "utf8");
    expect(css).toMatch(/\.target\s*\{[^}]*max-width:\s*100%/);
  });
});

describe("a letter going out (`status` sending)", () => {
  test("the progress line, „Peata saatmine“, „Kopeeri“ and the preview; nothing to change, no send, no sent line", async () => {
    await show(GOING);
    expect($("[data-campaign-sent]")!.getAttribute("data-campaign-sent")).toBe("sending");
    expect(text("[data-campaign-progress]")).toBe("Saadetud 5 / 12 — ülejäänud 7 lähevad järgmisel päeval.");
    expect($("[data-campaign-sent-line]")).toBeNull();
    expect(text("[data-campaign-stop]")).toBe("Peata saatmine");
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
    expect(text("[data-campaign-read-only]")).toBe("Pooleli kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.");
    expect(frame()).not.toBeNull();
    expect(all("input, textarea, select")).toEqual([]);
    for (const hook of ["data-campaign-send", "data-test-send", "data-send-all", "data-campaign-form", "data-save-bar", "data-campaign-refused"]) expect($(`[${hook}]`), hook).toBeNull();
  });

  test("the failed and unknown counts are lines only when they are not 0; the refused line only when Resend refused", async () => {
    await show({ ...GOING, progress: { ...NONE, total: 12, sent: 5, waiting: 4, failed: 1, unknown: 2 }, refused: true });
    expect(text("[data-campaign-failed]")).toBe("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
    expect(text("[data-campaign-unknown]")).toBe("2 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
    expect(text("[data-campaign-refused]")).toBe("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
    await show({ ...GOING, id: 8 });
    expect($("[data-campaign-failed]")).toBeNull();
    expect($("[data-campaign-unknown]")).toBeNull();
    expect($("[data-campaign-refused]")).toBeNull();
  });

  test("„Peata saatmine“ asks first in its ConfirmPanel (P-13's split); „Katkesta“ closes it and nothing is stopped", async () => {
    await show(GOING);
    await click($("[data-campaign-stop]"));
    expect(panelText("[data-stop-confirm]")).toEqual({
      question: "Kas peatan saatmise?",
      lines: ["Veel saatmata 7 kirja ei lähe välja.", "Seda ei saa tagasi võtta."],
      buttons: ["Jah, peata", "Katkesta"],
    });
    expect(document.activeElement).toBe(panelOf("[data-stop-confirm]"));
    await click(buttonNamed("Katkesta"));
    expect($("[data-stop-confirm] [data-confirm-panel]")).toBeNull();
    expect(document.activeElement).toBe($("[data-campaign-stop]"));
    expect(actions.stopSendAction).not.toHaveBeenCalled();
  });

  test("„Jah, peata“ stops it, once; refused is said in words", async () => {
    const working = pending<unknown>();
    actions.stopSendAction.mockReturnValue(working.answer);
    await show(GOING);
    await click($("[data-campaign-stop]"));
    await click(buttonNamed("Jah, peata"));
    expect(actions.stopSendAction).toHaveBeenCalledWith({ id: 7 });
    const yes = panelOf("[data-stop-confirm]")!.querySelector("button")!;
    expect(words(yes)).toBe("Peatan…");
    await click(yes);
    expect(actions.stopSendAction).toHaveBeenCalledTimes(1);
    await act(async () => working.release({ ok: true, progress: { ...NONE, total: 12, sent: 5, skipped: 7 } }));
    await settle();
    expect(text("[data-stop-status]")).toBe("Saatmine peatatud.");
    for (const [answer, line] of [
      [{ ok: false, error: "notSending" }, "Selle kirja saatmine ei ole pooleli."],
      [{ ok: false, error: "notFound" }, "Seda kirja enam pole."],
    ] as const) {
      actions.stopSendAction.mockResolvedValueOnce(answer);
      await click($("[data-campaign-stop]"));
      await click(buttonNamed("Jah, peata"));
      expect(text("[data-stop-status]"), line).toBe(line);
    }
  });
});

describe("a sent letter", () => {
  test("read-only: „Saadetud {date} · {n} tellijale“, the preview, „Kopeeri“, and no field, send or stop", async () => {
    await show(SENT);
    expect(text("[data-campaign-sent-line]")).toBe("Saadetud 19.10.2026 12:05 · 52 tellijale");
    expect(text("[data-campaign-read-only]")).toBe("Saadetud kirja ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.");
    expect(frame()).not.toBeNull();
    expect(all("input, textarea, select")).toEqual([]);
    for (const hook of ["data-save-bar", "data-test-send", "data-send-all", "data-campaign-stop", "data-campaign-progress"]) expect($(`[${hook}]`), hook).toBeNull();
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
  });

  test("„Kopeeri“ makes the new draft and opens it; refused is said in words", async () => {
    actions.copyCampaignAction.mockResolvedValueOnce({ ok: true, id: 21 });
    await show(SENT);
    await click($("[data-campaign-copy]"));
    expect(actions.copyCampaignAction).toHaveBeenCalledWith({ id: 7 });
    expect(router.push).toHaveBeenCalledWith(`${LIST}&kampaania=21`);
    actions.copyCampaignAction.mockResolvedValueOnce({ ok: false, error: "notFound" });
    await click($("[data-campaign-copy]"));
    expect(text("[data-campaign-copy-status]")).toBe("Seda kirja enam pole.");
  });
});
