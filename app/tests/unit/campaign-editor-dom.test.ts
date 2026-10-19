// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CAMPAIGN_LIMITS } from "@/domain/newsletter-campaign";

// Maria's campaign editor on the „Kampaaniad“ tab (newsletter campaigns, Task 4; spec D4–D6, §5; rulings R4, R5, R7) in a browser-like document
// (happy-dom), with the server actions and the preview route answered here: a draft with its fields, limits and counters, the live preview of both
// languages in an <iframe srcdoc sandbox> fed by the preview route, the save (pasted control characters cleaned first, a refused field named in
// words, a new one opening at its own address), „Saada proov“ (the address of the two, the warning for a subscriber's address, the answer),
// „Saada kõigile“ (the sync, the spec's confirmation with the Russian fall-back and the plan's limit, „Saada“, the refusals); a sent campaign
// read-only with „Saadetud {date} · {n} tellijale“, its links to Resend and „Kopeeri“; and without the newsletter's key the editor and preview with
// the not-set-up text for the two sends.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  fullSyncAction: vi.fn(),
  saveCampaignAction: vi.fn(),
  copyCampaignAction: vi.fn(),
  sendTestAction: vi.fn(),
  prepareSendAction: vi.fn(),
  sendCampaignAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-newsletter", () => actions);
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NewsletterCampaignEditor, type CampaignEditorView, type TestTarget } from "@/components/admin/NewsletterCampaignEditor";

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
const DRAFT: CampaignEditorView = { id: 7, status: "draft", values: VALUES, sentAt: null, recipients: null, broadcasts: null };
const SENT: CampaignEditorView = { ...DRAFT, status: "sent", sentAt: "2026-10-19T09:05:00.000Z", recipients: { et: 40, ru: 12 }, broadcasts: { et: "bc-et", ru: "bc-ru" } };
const TARGETS: TestTarget[] = [
  { key: "maria", address: "maria@example.com", subscriber: false },
  { key: "me", address: "dim@example.com", subscriber: true },
];
const PLAN = { et: 40, ru: 12, ruFallsBack: false, left: 0, report: { contacts: 52, added: 0, updated: 0, removed: 0, unsubscribedPulled: 0, suppressed: 0, unsynced: 0, failed: 0, limitReached: false, finished: true } };

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
const show = async (campaign: CampaignEditorView | null, over: { configured?: boolean; testTargets?: TestTarget[] } = {}) => {
  await act(async () => root.render(createElement(NewsletterCampaignEditor, { campaign, configured: over.configured ?? true, testTargets: over.testTargets ?? TARGETS, links: ["/koolitused"] })));
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

  test("„Salvesta“: the fields cleaned of pasted control characters, then the action; saved, the sends are open again", async () => {
    actions.saveCampaignAction.mockResolvedValue({ ok: true, id: 7 });
    await show(DRAFT);
    await type($('[data-field="name"]'), "Nimi\u000b\u0007 kopeeritud");
    expect($("[data-campaign-save-first]")).not.toBeNull();
    expect($("[data-test-send]")!.getAttribute("aria-disabled")).toBe("true");
    await submit();
    expect(actions.saveCampaignAction).toHaveBeenCalledTimes(1);
    const sent = actions.saveCampaignAction.mock.calls[0][0] as { id: number; draft: typeof VALUES };
    expect(sent.id).toBe(7);
    // Word's line break and the bell went before the rules' check, which makes a one-line text of the name
    expect(sent.draft.name).toBe("Nimi kopeeritud");
    expect(sent.draft.subject).toEqual(VALUES.subject);
    expect(text("[data-save-status]")).toBe("Salvestatud.");
    expect($("[data-campaign-save-first]")).toBeNull();
    expect($("[data-test-send]")!.getAttribute("aria-disabled")).toBeNull();
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
    expect($("[data-campaign-save-first]")).not.toBeNull();
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

  test("„Saada proov“: Maria's address or the signed-in admin's; a subscriber's address is warned of (ruling R7); the answer says where it went", async () => {
    actions.sendTestAction.mockResolvedValue({ ok: true, realLink: true });
    await show(DRAFT);
    const choices = all<HTMLInputElement>("[data-test-to]");
    expect(choices.map((c) => c.getAttribute("data-test-to"))).toEqual(["maria", "me"]);
    expect(choices[0].checked).toBe(true);
    expect(container.textContent).toContain("maria@example.com");
    expect($("[data-test-real-link]")).toBeNull();
    await click(choices[1]);
    expect(text("[data-test-real-link]")).toBe("Proov läheb tellija-aadressile — selle loobumislink on päris.");
    await click($('[data-test-locale="ru"]'));
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenCalledWith({ id: 7, to: "me", locale: "ru" });
    expect(text("[data-test-status]")).toContain("dim@example.com");
  });

  test("„Saada proov“ refused: the limit, another sync running, Resend down, each in words", async () => {
    await show(DRAFT);
    for (const [error, words] of [
      ["limited", "Proovikirju saab saata kuni 10 tunnis."],
      ["busy", "Sünkroonimine juba käib — proovi hetke pärast uuesti."],
      ["unavailable", "Resendiga ei saanud ühendust — proovi hiljem uuesti."],
    ] as const) {
      actions.sendTestAction.mockResolvedValueOnce({ ok: false, error });
      await click($("[data-test-send]"));
      expect(text("[data-test-status]"), error).toContain(words);
    }
  });

  test("„Saada kõigile“: the sync first, then the spec's confirmation with the counts; „Saada“ sends, and the page is refreshed", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: PLAN });
    actions.sendCampaignAction.mockResolvedValue({ ok: true, recipients: { et: 40, ru: 12 }, missing: [], left: 0 });
    await show(DRAFT);
    expect(text("[data-send-all]")).toBe("Saada kõigile");
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).toHaveBeenCalledWith({ id: 7, scope: "all" });
    expect(actions.sendCampaignAction).not.toHaveBeenCalled();
    expect(text("[data-send-confirm-text]")).toBe("Saadad kampaania 52 tellijale (eesti keeles 40, vene keeles 12). Kas saadame?");
    expect($("[data-send-fallback]")).toBeNull();
    expect($("[data-send-left]")).toBeNull();
    expect(text("[data-send-yes]")).toBe("Saada");
    await click($("[data-send-yes]"));
    expect(actions.sendCampaignAction).toHaveBeenCalledWith({ id: 7, et: 40, ru: 12, scope: "all" });
    expect(text("[data-send-status]")).toBe("Kampaania on saadetud.");
  });

  test("the confirmation says when the Russian subscribers get the Estonian mail, and how many are not in Resend (ruling R5)", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: { ...PLAN, ruFallsBack: true, left: 3 } });
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect(text("[data-send-fallback]")).toBe("Vene keeles tellijad saavad eestikeelse kirja.");
    expect(text("[data-send-left]")).toBe("3 tellijat ei ole Resendis — kontaktide piir on täis.");
  });

  test("the counts changed since the confirmation (ruling R14): nothing went, the new counts with the line that says so; „Saada“ then sends with those", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: PLAN });
    actions.sendCampaignAction.mockResolvedValueOnce({ ok: false, error: "changed", plan: { ...PLAN, et: 41 } });
    actions.sendCampaignAction.mockResolvedValueOnce({ ok: true, recipients: { et: 41, ru: 12 }, missing: [], left: 0 });
    await show(DRAFT);
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(text("[data-send-changed]")).toBe("Tellijate arv muutus vahepeal — vaata üle ja kinnita uuesti.");
    expect(text("[data-send-confirm-text]")).toBe("Saadad kampaania 53 tellijale (eesti keeles 41, vene keeles 12). Kas saadame?");
    await click($("[data-send-yes]"));
    expect(actions.sendCampaignAction).toHaveBeenLastCalledWith({ id: 7, et: 41, ru: 12, scope: "all" });
    expect(text("[data-send-status]")).toBe("Kampaania on saadetud.");
    expect($("[data-send-changed]")).toBeNull();
  });

  test("the open confirmation closes when a field changes or a save lands: „Saada“ then needs a new count (review M5)", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: PLAN });
    actions.saveCampaignAction.mockResolvedValue({ ok: true, id: 7 });
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect($("[data-send-confirm]")).not.toBeNull();
    // a field changed: the confirmation is gone, and the send waits for the save
    await type($('[data-field="name"]'), "Uus nimi");
    expect($("[data-send-confirm]")).toBeNull();
    expect($("[data-send-all]")!.getAttribute("aria-disabled")).toBe("true");
    // the field back as it was: still no confirmation (it was for the campaign before the change)
    await type($('[data-field="name"]'), VALUES.name);
    expect($("[data-send-confirm]")).toBeNull();
    // a save that lands closes one too, even with the fields as they were
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).toHaveBeenCalledTimes(2);
    expect($("[data-send-confirm]")).not.toBeNull();
    await submit();
    expect(actions.saveCampaignAction).toHaveBeenCalledTimes(1);
    expect($("[data-send-confirm]")).toBeNull();
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).toHaveBeenCalledTimes(3);
    expect(actions.sendCampaignAction).not.toHaveBeenCalled();
  });

  test("„Tühista“ closes the confirmation and sends nothing", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: PLAN });
    await show(DRAFT);
    await click($("[data-send-all]"));
    await click($("[data-send-no]"));
    expect($("[data-send-confirm]")).toBeNull();
    expect(actions.sendCampaignAction).not.toHaveBeenCalled();
  });

  test("refusals of the send in words: not synced, Resend down, already sent; the Russian broadcast that did not go", async () => {
    await show(DRAFT);
    actions.prepareSendAction.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    await click($("[data-send-all]"));
    expect(text("[data-send-status]")).toBe("Resendiga ei saanud ühendust — proovi hiljem uuesti.");
    actions.prepareSendAction.mockResolvedValueOnce({ ok: false, error: "unsynced" });
    await click($("[data-send-all]"));
    expect(text("[data-send-status]")).toContain("Resendiga sünkroonida");
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: PLAN });
    actions.sendCampaignAction.mockResolvedValueOnce({ ok: false, error: "sent" });
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(text("[data-send-status]")).toBe("See kampaania on juba saadetud.");
    actions.sendCampaignAction.mockResolvedValueOnce({ ok: true, recipients: { et: 40, ru: 0 }, missing: ["ru"], left: 0 });
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(text("[data-send-status]")).toContain("Venekeelne kiri jäi saatmata — saada see nupuga „Saada puuduv keel“.");
  });
});

describe("a sent campaign", () => {
  test("read-only: „Saadetud {date} · {n} tellijale“, a link to each broadcast in Resend, the preview, „Kopeeri“, and no field or send", async () => {
    await show(SENT);
    expect(text("[data-campaign-sent-line]")).toBe("Saadetud 19.10.2026 12:05 · 52 tellijale");
    expect(all<HTMLAnchorElement>("[data-campaign-broadcast]").map((a) => [a.dataset.campaignBroadcast, a.getAttribute("href"), a.getAttribute("target")])).toEqual([
      ["et", "https://resend.com/broadcasts/bc-et", "_blank"],
      ["ru", "https://resend.com/broadcasts/bc-ru", "_blank"],
    ]);
    expect(frame()).not.toBeNull();
    expect(all("input, textarea")).toEqual([]);
    expect($("[data-save-bar]")).toBeNull();
    expect($("[data-test-send]")).toBeNull();
    expect($("[data-send-all]")).toBeNull();
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
  });

  test("a language whose broadcast did not go is said so, and is not counted", async () => {
    await show({ ...SENT, broadcasts: { et: "bc-et" } });
    expect(text("[data-campaign-sent-line]")).toBe("Saadetud 19.10.2026 12:05 · 40 tellijale");
    expect(text('[data-campaign-missing="ru"]')).toBe("Venekeelne kiri jäi saatmata — saada see nupuga „Saada puuduv keel“.");
    expect(all("[data-campaign-broadcast]")).toHaveLength(1);
  });

  test("a send left half way (`sending`): Maria is told to look in Resend, with its list of broadcasts and any recorded; no send again; „Kopeeri“ with the warning (review M1)", async () => {
    await show({ ...SENT, status: "sending", sentAt: null, broadcasts: { et: "bc-et" } });
    expect($("[data-campaign-sent-line]")).toBeNull();
    expect(text("[data-campaign-sending]")).toContain("Vaata Resendist");
    expect(all("[data-campaign-broadcast]")).toHaveLength(1);
    expect($("[data-send-all]")).toBeNull();
    expect($("[data-send-missing]")).toBeNull();
    expect($("[data-campaign-copy]")).not.toBeNull();
    expect(text("[data-campaign-sending-check]")).toBe("Ära kopeeri enne, kui oled Resendis kontrollinud.");
    const list = $<HTMLAnchorElement>("[data-campaign-broadcasts-list]")!;
    expect([list.getAttribute("href"), list.getAttribute("target"), list.textContent]).toEqual(["https://resend.com/broadcasts", "_blank", "Ava Resendi kampaaniate loend"]);
    // the first broadcast without an answer: nothing recorded, the list is still there
    await show({ ...SENT, id: 9, status: "sending", sentAt: null, broadcasts: {} });
    expect(all("[data-campaign-broadcast]")).toHaveLength(0);
    expect($("[data-campaign-broadcasts-list]")).not.toBeNull();
  });

  test("„Saada puuduv keel“ (ruling R12): a campaign sent in one language only offers it; the plan, the confirmation, and the send of the missing language alone", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: true, plan: { ...PLAN, et: 0, ru: 12 } });
    actions.sendCampaignAction.mockResolvedValue({ ok: true, recipients: { et: 0, ru: 12 }, missing: [], left: 0 });
    await show({ ...SENT, broadcasts: { et: "bc-et" } });
    expect($("[data-send-all]")).toBeNull();
    expect(text("[data-send-missing]")).toBe("Saada puuduv keel");
    await click($("[data-send-missing]"));
    expect(actions.prepareSendAction).toHaveBeenCalledWith({ id: 7, scope: "missing" });
    expect(text("[data-send-confirm-text]")).toBe("Saadad kampaania 12 tellijale (eesti keeles 0, vene keeles 12). Kas saadame?");
    await click($("[data-send-yes]"));
    expect(actions.sendCampaignAction).toHaveBeenCalledWith({ id: 7, et: 0, ru: 12, scope: "missing" });
    expect(text("[data-send-status]")).toBe("Kampaania on saadetud.");
  });

  test("a campaign sent whole, or without the key, offers no „Saada puuduv keel“", async () => {
    await show(SENT);
    expect($("[data-send-missing]")).toBeNull();
    await show({ ...SENT, id: 9, broadcasts: { et: "bc-et" } }, { configured: false });
    expect($('[data-campaign-missing="ru"]')).not.toBeNull();
    expect($("[data-send-missing]")).toBeNull();
  });

  test("„Kopeeri“ makes the new draft and opens it", async () => {
    actions.copyCampaignAction.mockResolvedValue({ ok: true, id: 21 });
    await show(SENT);
    await click($("[data-campaign-copy]"));
    expect(actions.copyCampaignAction).toHaveBeenCalledWith({ id: 7 });
    expect(router.push).toHaveBeenCalledWith("/admin/uudiskiri?vaade=kampaaniad&kampaania=21");
  });
});

describe("without the newsletter's key", () => {
  test("the editor and the preview as ever; the two sends say that sending is not set up, and send nothing", async () => {
    await show(DRAFT, { configured: false });
    expect($('[data-field="name"]')).not.toBeNull();
    expect(frame()).not.toBeNull();
    expect(text("[data-campaign-send-off]")).toBe("Resendi uudiskirja saatmine pole veel seadistatud.");
    expect($("[data-test-send]")!.getAttribute("aria-disabled")).toBe("true");
    expect($("[data-send-all]")!.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-test-send]"));
    await click($("[data-send-all]"));
    expect(actions.sendTestAction).not.toHaveBeenCalled();
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
    expect($("[data-test-to]")).toBeNull();
  });
});
