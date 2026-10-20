// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CAMPAIGN_LIMITS } from "@/domain/newsletter-campaign";

// Maria's campaign editor on the „Kampaaniad“ tab (newsletter campaigns, Task 4; spec D4, D5) in a browser-like document (happy-dom), with the
// server actions and the preview route answered here: a draft with its fields, limits and counters, the live preview of both languages in an
// <iframe srcdoc sandbox> fed by the preview route, the save (pasted control characters cleaned first, a refused field named in words, a new one
// opening at its own address), and a campaign that is no draft read-only with „Saadetud {date} · {n} tellijale“ and „Kopeeri“. The sends („Saada
// proov“, „Saada kõigile“) are the 20.10 design's and are not on the editor yet.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  saveCampaignAction: vi.fn(),
  copyCampaignAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-newsletter", () => actions);
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NewsletterCampaignEditor, type CampaignEditorView } from "@/components/admin/NewsletterCampaignEditor";

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
const DRAFT: CampaignEditorView = { id: 7, status: "draft", values: VALUES, sentAt: null, updatedAt: "2026-10-19T09:00:00.000Z", recipients: null };
const SENT: CampaignEditorView = { ...DRAFT, status: "sent", sentAt: "2026-10-19T09:05:00.000Z", recipients: { et: 40, ru: 12 } };

let container: HTMLDivElement;
let root: Root;
let previews: { url: string; body: { draft: Record<string, unknown> } }[];
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<E>(selector)];
const text = (selector: string) => $(selector)?.textContent ?? null;
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** Lets the preview's pause pass (the editor waits a moment after the last key before it asks again). */
const later = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 450));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (campaign: CampaignEditorView | null) => {
  await act(async () => root.render(createElement(NewsletterCampaignEditor, { campaign, links: ["/koolitused"] })));
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
const submit = async () => {
  await act(async () => {
    $<HTMLFormElement>("[data-campaign-form]")!.requestSubmit();
  });
  await settle();
};
const frame = () => $<HTMLIFrameElement>("[data-campaign-preview-frame]");

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
  previews = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("a draft", () => {
  test("its fields as stored, each with its limit and a counter; the button's address suggests the site's pages", async () => {
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
  });

  test("the live preview: the preview route's mail in an <iframe srcdoc sandbox>, Estonian first, then Russian; it follows the typing", async () => {
    await show(DRAFT);
    expect(previews.length).toBeGreaterThanOrEqual(1);
    expect(previews.at(-1)!.url).toBe("/api/admin/kampaania-eelvaade");
    expect(previews.at(-1)!.body.draft).toMatchObject({ name: "Oktoobri pakkumine", subject: VALUES.subject });
    const f = frame()!;
    expect(f.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(f.getAttribute("srcdoc")).toBe("<!doctype html><p>ET Esimene lõik.\n\nTeine lõik.</p>");
    expect(text("[data-campaign-preview-subject]")).toBe("Sügispakkumine");
    await click($('[data-campaign-preview] [data-lang="ru"]'));
    expect(frame()!.getAttribute("srcdoc")).toBe("<!doctype html><p>RU Первый абзац.</p>");
    expect(text("[data-campaign-preview-subject]")).toBe("Осеннее предложение");
    expect($("[data-campaign-preview-fallback]")).toBeNull();
    // the text field's own switch to Russian, and the Russian text emptied: the Russian subscribers get the Estonian mail
    await click($('[data-i18n="body"]')!.parentElement!.querySelector('[data-lang="ru"]'));
    expect($('[data-i18n="body"]')!.getAttribute("data-lang-field")).toBe("ru");
    await type($('[data-i18n="body"]'), "");
    await later();
    expect(previews.at(-1)!.body.draft).toMatchObject({ body: { et: VALUES.body.et, ru: "" } });
    expect(text("[data-campaign-preview-fallback]")).toBe("Vene keeles tellijad saavad eestikeelse kirja.");
    expect(frame()!.getAttribute("srcdoc")).toContain("RU Esimene lõik.");
  });

  test("„Salvesta“: the fields cleaned of pasted control characters, then the action", async () => {
    actions.saveCampaignAction.mockResolvedValue({ ok: true, id: 7 });
    await show(DRAFT);
    await type($('[data-field="name"]'), "Nimi\u000b\u0007 kopeeritud");
    await submit();
    expect(actions.saveCampaignAction).toHaveBeenCalledTimes(1);
    const sent = actions.saveCampaignAction.mock.calls[0][0] as { id: number; draft: typeof VALUES };
    expect(sent.id).toBe(7);
    // Word's line break and the bell went before the rules' check, which makes a one-line text of the name
    expect(sent.draft.name).toBe("Nimi kopeeritud");
    expect(sent.draft.subject).toEqual(VALUES.subject);
    expect(text("[data-save-status]")).toBe("Salvestatud.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("a refused field is named in words under it (the Russian button label of ruling R2 too), and nothing is saved by the editor itself", async () => {
    actions.saveCampaignAction.mockResolvedValue({ ok: false, fields: { "buttonLabel.ru": "ruLabel" } });
    await show(DRAFT);
    await type($('[data-field="name"]'), "");
    await submit();
    expect(actions.saveCampaignAction).not.toHaveBeenCalled(); // refused here first: the name is required
    expect(container.textContent).toContain("Täida see väli.");
    await type($('[data-field="name"]'), "Nimi");
    await submit();
    expect(actions.saveCampaignAction).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Lisa nupu tekst ka vene keeles.");
    expect(text("[data-save-status]")).toBe("Kontrolli märgitud välju.");
  });

  test("a new campaign opens at its own address once it is saved", async () => {
    actions.saveCampaignAction.mockResolvedValue({ ok: true, id: 12 });
    await show(null);
    expect($<HTMLFormElement>("[data-campaign-form]")!.getAttribute("data-campaign-form")).toBe("new");
    await type($('[data-field="name"]'), "Uus");
    await type($('[data-i18n="subject"]'), "Teema");
    await type($('[data-i18n="body"]'), "Tekst.");
    await submit();
    expect(actions.saveCampaignAction.mock.calls[0][0]).toMatchObject({ id: null, draft: { name: "Uus", subject: { et: "Teema", ru: "" }, body: { et: "Tekst.", ru: "" } } });
    expect(router.replace).toHaveBeenCalledWith("/admin/uudiskiri?vaade=kampaaniad&kampaania=12");
    // the page comes back at that address with the campaign just saved: the fields and „Salvestatud.“ stay, and the next save is of campaign 12
    const values = { ...VALUES, name: "Uus", subject: { et: "Teema", ru: "" }, body: { et: "Tekst.", ru: "" }, preheader: { et: "", ru: "" }, imageKey: "", code: "", buttonLabel: { et: "", ru: "" }, buttonHref: "" };
    await show({ ...DRAFT, id: 12, values });
    expect($("[data-campaign-form]")!.getAttribute("data-campaign-form")).toBe("12");
    expect(text("[data-save-status]")).toBe("Salvestatud.");
    expect($<HTMLInputElement>('[data-field="name"]')!.value).toBe("Uus");
    await submit();
    expect(actions.saveCampaignAction.mock.calls[1][0]).toMatchObject({ id: 12 });
  });

  test("another campaign chosen in the list: its own fields, nothing of the one before", async () => {
    await show(DRAFT);
    await type($('[data-field="name"]'), "Pooleli");
    await show({ ...DRAFT, id: 8, values: { ...VALUES, name: "Teine kampaania" } });
    expect($("[data-campaign-form]")!.getAttribute("data-campaign-form")).toBe("8");
    expect($<HTMLInputElement>('[data-field="name"]')!.value).toBe("Teine kampaania");
    expect(text("[data-save-status]")).toBe("");
    await show(null);
    expect($("[data-campaign-form]")!.getAttribute("data-campaign-form")).toBe("new");
    expect($<HTMLInputElement>('[data-field="name"]')!.value).toBe("");
  });

  test("no sending on the editor yet: no „Saada proov“, no „Saada kõigile“, no address to send a test to (the sends are the 20.10 design's)", async () => {
    await show(DRAFT);
    for (const hook of ["data-campaign-send", "data-test-send", "data-test-to", "data-send-all", "data-send-missing", "data-mark-not-sent"]) expect($(`[${hook}]`), hook).toBeNull();
    expect(container.textContent).not.toContain("Saada proov");
    expect(container.textContent).not.toContain("Saada kõigile");
    expect(container.textContent).not.toMatch(/Resend/);
    expect($('[data-field="name"]')).not.toBeNull();
    expect(frame()).not.toBeNull();
  });
});

describe("a campaign that is no draft", () => {
  test("read-only: „Saadetud {date} · {n} tellijale“, the preview, „Kopeeri“, and no field or send", async () => {
    await show(SENT);
    expect(text("[data-campaign-sent-line]")).toBe("Saadetud 19.10.2026 12:05 · 52 tellijale");
    expect(text("[data-campaign-read-only]")).toBe("Saadetud kampaaniat ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.");
    expect(frame()).not.toBeNull();
    expect(all("input, textarea")).toEqual([]);
    expect($("[data-save-bar]")).toBeNull();
    expect($("[data-test-send]")).toBeNull();
    expect($("[data-send-all]")).toBeNull();
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
    expect(container.textContent).not.toMatch(/Resend/);
  });

  test("one going out (`sending`) reads the same, without the sent line: nothing on it can be changed", async () => {
    await show({ ...SENT, status: "sending", sentAt: null, recipients: { et: 40, ru: 12 } });
    expect($("[data-campaign-sent]")!.getAttribute("data-campaign-sent")).toBe("sending");
    expect($("[data-campaign-sent-line]")).toBeNull();
    expect($("[data-campaign-read-only]")).not.toBeNull();
    expect(all("input, textarea")).toEqual([]);
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
  });

  test("„Kopeeri“ makes the new draft and opens it", async () => {
    actions.copyCampaignAction.mockResolvedValue({ ok: true, id: 21 });
    await show(SENT);
    await click($("[data-campaign-copy]"));
    expect(actions.copyCampaignAction).toHaveBeenCalledWith({ id: 7 });
    expect(router.push).toHaveBeenCalledWith("/admin/uudiskiri?vaade=kampaaniad&kampaania=21");
  });

  test("„Kopeeri“ refused is said in words", async () => {
    actions.copyCampaignAction.mockResolvedValue({ ok: false, error: "notFound" });
    await show(SENT);
    await click($("[data-campaign-copy]"));
    expect(text("[data-campaign-copy-status]")).toBe("Seda kampaaniat enam pole.");
    expect(router.push).not.toHaveBeenCalled();
  });
});
