// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CAMPAIGN_LIMITS } from "@/domain/newsletter-campaign";

// Maria's campaign editor on the „Kampaaniad“ tab (newsletter campaigns, Task 4; spec D4, D5; the 20.10 design §3) in a browser-like document
// (happy-dom), with the server actions and the preview route answered here: a draft with its fields, limits and counters, the live preview of both
// languages in an <iframe srcdoc sandbox> fed by the preview route, the save (pasted control characters cleaned first, a refused field named in
// words, a new one opening at its own address) and its two sends („Saada proov“, and „Saada kõigile“ with its confirmation and its result line); a
// campaign going out, with its progress line, the failed and unknown counts when they are not 0, the refused line and „Peata saatmine“ (which asks
// first); and a sent one, read-only, with „Saadetud {date} · {n} tellijale“ and „Kopeeri“. The state is the campaign's `status`: what an action
// returns is only the line right after a press.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  saveCampaignAction: vi.fn(),
  copyCampaignAction: vi.fn(),
  prepareSendAction: vi.fn(),
  startSendAction: vi.fn(),
  stopSendAction: vi.fn(),
  sendTestAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-newsletter", () => actions);
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NewsletterCampaignEditor, type CampaignEditorView, type TestTarget } from "@/components/admin/NewsletterCampaignEditor";
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
const DRAFT: CampaignEditorView = { id: 7, status: "draft", values: VALUES, sentAt: null, updatedAt: "2026-10-19T09:00:00.000Z", recipients: null, progress: null, refused: false };
const SENT: CampaignEditorView = { ...DRAFT, status: "sent", sentAt: "2026-10-19T09:05:00.000Z", recipients: { et: 40, ru: 12 }, progress: { ...NONE, total: 52, sent: 52 } };
/** A campaign going out: 12 subscribers, 5 mails went, 7 wait. */
const GOING: CampaignEditorView = { ...DRAFT, status: "sending", sentAt: null, recipients: { et: 9, ru: 3 }, progress: { ...NONE, total: 12, sent: 5, waiting: 7 } };
const TARGETS: TestTarget[] = [
  { key: "maria", address: "maria@example.com" },
  { key: "me", address: "admin@example.test" },
];

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
const show = async (campaign: CampaignEditorView | null, testTargets: TestTarget[] = TARGETS, gated = false) => {
  await act(async () => root.render(createElement(NewsletterCampaignEditor, { campaign, links: ["/koolitused"], testTargets, gated })));
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

});

// ---------- the sends of a draft ----------

/** What the confirmation shows (actions/admin-newsletter.ts prepareSendAction): 9 Estonian and 3 Russian subscribers, the Russian text missing. */
const PLAN = { ok: true, et: 9, ru: 3, ruFallsBack: true, updatedAt: "2026-10-19T09:00:00.000Z" };
/** The press's answer when every mail went in its first batch. */
const ALL_WENT = { ok: true, progress: { ...NONE, total: 12, sent: 12 }, stopped: null };
/** An action that is still working: `release` lets it answer. */
function pending<T>() {
  let release!: (value: T) => void;
  const answer = new Promise<T>((resolve) => (release = resolve));
  return { answer, release };
}
const confirmOpen = () => $("[data-send-confirm]");
const sendLine = () => text("[data-send-status]");

describe("a draft: „Saada proov“ and „Saada kõigile“", () => {
  test("both are there once the draft is saved, with the choices of the test; none of the old half-sent or Resend UI", async () => {
    await show(DRAFT);
    expect(text("[data-campaign-send] h2")).toBe("Saatmine");
    expect(text("[data-test-send]")).toBe("Saada proov");
    expect(text("[data-send-all]")).toBe("Saada kõigile");
    expect($("[data-test-send]")!.getAttribute("aria-disabled")).toBeNull();
    expect($("[data-send-all]")!.getAttribute("aria-disabled")).toBeNull();
    expect($("[data-campaign-save-first]")).toBeNull();
    expect(all("[data-test-to]").map((r) => r.getAttribute("data-test-to"))).toEqual(["maria", "me"]);
    expect(all("[data-test-to]").map((r) => r.closest("label")!.textContent)).toEqual(["Maria: maria@example.com", "Mina: admin@example.test"]);
    expect(all("[data-test-locale]").map((r) => r.closest("label")!.textContent)).toEqual(["Eesti keeles", "Vene keeles"]);
    expect($<HTMLInputElement>('[data-test-to="maria"]')!.checked).toBe(true);
    expect($<HTMLInputElement>('[data-test-locale="et"]')!.checked).toBe(true);
    for (const hook of ["data-mark-not-sent", "data-send-missing", "data-send-confirm", "data-campaign-stop"]) expect($(`[${hook}]`), hook).toBeNull();
    for (const gone of ["Märgi saatmata", "Saada puuduv keel", "Resend", "Sünkrooni"]) expect(container.textContent, gone).not.toContain(gone);
  });

  test("a new campaign, and a draft with unsaved changes, say „Salvesta muudatused enne saatmist.“ and press nothing", async () => {
    await show(null);
    expect(text("[data-campaign-save-first]")).toBe("Salvesta muudatused enne saatmist.");
    expect($("[data-send-all]")!.getAttribute("aria-disabled")).toBe("true");
    expect($("[data-test-send]")!.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-send-all]"));
    await click($("[data-test-send]"));
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
    expect(actions.sendTestAction).not.toHaveBeenCalled();
    await show(DRAFT);
    expect($("[data-campaign-save-first]")).toBeNull();
    await type($('[data-field="name"]'), "Muudetud");
    expect(text("[data-campaign-save-first]")).toBe("Salvesta muudatused enne saatmist.");
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
  });

  test("„Saada proov“: to Maria in Estonian unless chosen otherwise; the call carries the campaign, the address and the language; the line names the address", async () => {
    actions.sendTestAction.mockResolvedValue({ ok: true });
    await show(DRAFT);
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenLastCalledWith({ id: 7, to: "maria", locale: "et" });
    expect(text("[data-test-status]")).toBe("Proov läks aadressile maria@example.com. Kiri jõuab mõne minuti jooksul.");
    await click($('[data-test-to="me"]'));
    await click($('[data-test-locale="ru"]'));
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenLastCalledWith({ id: 7, to: "me", locale: "ru" });
    expect(text("[data-test-status]")).toBe("Proov läks aadressile admin@example.test. Kiri jõuab mõne minuti jooksul.");
    // a test is no press: no confirmation, nothing prepared
    expect(actions.prepareSendAction).not.toHaveBeenCalled();
    expect(confirmOpen()).toBeNull();
  });

  test("„Saada proov“ refused is said in words: ten an hour, it did not go, no such address, a lost connection", async () => {
    await show(DRAFT);
    const said: [unknown, string][] = [
      [{ ok: false, error: "limited" }, "Selle tunni 10 proovi on saadetud. Proovi tunni pärast uuesti."],
      [{ ok: false, error: "mail" }, "Proovi ei saanud saata. Proovi uuesti."],
      [{ ok: false, error: "address" }, "Sellele aadressile ei saa proovi saata."],
      [{ ok: false, error: "notFound" }, "Seda kampaaniat enam pole."],
    ];
    for (const [answer, words] of said) {
      actions.sendTestAction.mockResolvedValueOnce(answer);
      await click($("[data-test-send]"));
      expect(text("[data-test-status]"), words).toBe(words);
    }
    actions.sendTestAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-test-send]"));
    expect(text("[data-test-status]")).toBe("Ei õnnestunud. Proovi uuesti.");
  });

  test("without Maria's address only the signed-in admin's is offered, and it is the one chosen", async () => {
    actions.sendTestAction.mockResolvedValue({ ok: true });
    await show(DRAFT, [{ key: "me", address: "admin@example.test" }]);
    expect(all("[data-test-to]").map((r) => r.getAttribute("data-test-to"))).toEqual(["me"]);
    await click($("[data-test-send]"));
    expect(actions.sendTestAction).toHaveBeenCalledWith({ id: 7, to: "me", locale: "et" });
  });

  test("„Saada kõigile“ asks first: the counts of the confirmation, the Russian note; „Tühista“ closes it and nothing is pressed", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect(actions.prepareSendAction).toHaveBeenCalledWith({ id: 7 });
    expect(text("[data-send-confirm-text]")).toBe("Saadad kampaania 12 tellijale (eesti keeles 9, vene keeles 3). Kas saadame?");
    expect(text("[data-send-fallback]")).toBe("Vene keeles tellijad saavad eestikeelse kirja.");
    expect(text("[data-send-yes]")).toBe("Saada");
    expect(text("[data-send-no]")).toBe("Tühista");
    expect($("[data-send-all]")).toBeNull(); // (the confirmation is in its place)
    await click($("[data-send-no]"));
    expect(confirmOpen()).toBeNull();
    expect(text("[data-send-all]")).toBe("Saada kõigile");
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });

  // The coming-soon gate (final review I1, ruling R9; Draft): while SITE_GATE is on, the mail's links and its button open the „Tulekul“ page. The page
  // passes the flag (the editor never reads the environment); the line is a notice under the confirmation and under the test's result, never a block.
  const GATE_LINE = "Koduleht pole veel avatud — kirja lingid ja nupp viivad „Tulekul“ lehele.";

  test("gate on: the confirmation of „Saada kõigile“ carries the gate notice, and „Saada“ still sends (a notice, not a block)", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    actions.startSendAction.mockResolvedValue({ ok: true, stopped: null, progress: { ...NONE, total: 12, sent: 12 } });
    await show(DRAFT, TARGETS, true);
    expect($("[data-gate-notice]")).toBeNull(); // (nothing before the question: the notice belongs to the confirmation)
    await click($("[data-send-all]"));
    expect(confirmOpen()).not.toBeNull();
    expect(all("[data-gate-notice]")).toHaveLength(1);
    expect(text("[data-send-confirm] [data-gate-notice]")).toBe(GATE_LINE);
    expect($("[data-send-yes]")!.getAttribute("aria-disabled")).toBeNull();
    await click($("[data-send-yes]"));
    expect(actions.startSendAction).toHaveBeenCalledWith({ id: 7, et: 9, ru: 3, updatedAt: "2026-10-19T09:00:00.000Z" });
    expect(text("[data-send-status]")).toBe("Kampaania on saadetud.");
  });

  test("gate on: the result of „Saada proov“ carries the same line; not before the test went, not after a refusal", async () => {
    await show(DRAFT, TARGETS, true);
    expect($("[data-campaign-test] [data-gate-notice]")).toBeNull();
    actions.sendTestAction.mockResolvedValueOnce({ ok: false, error: "mail" });
    await click($("[data-test-send]"));
    expect($("[data-campaign-test] [data-gate-notice]")).toBeNull(); // (the mail did not go: nothing to open)
    actions.sendTestAction.mockResolvedValueOnce({ ok: true });
    await click($("[data-test-send]"));
    expect(text("[data-test-status]")).toBe("Proov läks aadressile maria@example.com. Kiri jõuab mõne minuti jooksul.");
    expect(text("[data-campaign-test] [data-gate-notice]")).toBe(GATE_LINE);
    expect($("[data-send-confirm]")).toBeNull(); // (a test is no press: the confirmation is not opened by it)
  });

  test("gate off: neither the confirmation nor the test's result says anything about the gate", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    actions.sendTestAction.mockResolvedValue({ ok: true });
    await show(DRAFT, TARGETS, false);
    await click($("[data-test-send]"));
    await click($("[data-send-all]"));
    expect(confirmOpen()).not.toBeNull();
    expect($("[data-gate-notice]")).toBeNull();
    expect(container.textContent).not.toContain("Tulekul");
    expect($("[data-campaign-send]")!.hasAttribute("data-gated")).toBe(false);
  });

  test("the confirmation takes the focus (the button that was pressed is gone), as the stop question and the other admin confirms do", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    await show(DRAFT);
    $<HTMLButtonElement>("[data-send-all]")!.focus();
    expect(document.activeElement).toBe($("[data-send-all]"));
    await click($("[data-send-all]"));
    expect(document.activeElement).toBe($("[data-send-confirm-text]"));
    expect($("[data-send-confirm-text]")!.getAttribute("tabindex")).toBe("-1");
    // a refusal opens no confirmation and steals no focus from the page
    await click($("[data-send-no]"));
    actions.prepareSendAction.mockResolvedValueOnce({ ok: false, error: "busy" });
    await click($("[data-send-all]"));
    expect(confirmOpen()).toBeNull();
    expect(document.activeElement).not.toBe($("[data-send-confirm-text]"));
  });

  test("a long address in the choice of the test wraps instead of widening the screen: its pill has the wrapping class, and the rule is in the stylesheet", async () => {
    await show(DRAFT, [
      { key: "maria", address: "maria.sosnina.kooli.uudiskirja.proovid.tahtis.lihtsalt.pikk@aadress-on-ulipikk.example.com" },
      { key: "me", address: "admin@example.test" },
    ]);
    const pills = all("[data-test-to]").map((r) => r.closest("label")!);
    expect(pills).toHaveLength(2);
    const [first] = pills;
    // (the class names are the stylesheet's own: the pill carries one more than the shared `choice`, which the language pills do not)
    const language = $("[data-test-locale]")!.closest("label")!;
    expect(first.className.split(" ").length).toBe(language.className.split(" ").length + 1);
    const css = readFileSync("src/components/admin/CampaignsPanel.module.css", "utf8");
    expect(css).toMatch(/\.address\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.address\s*\{[^}]*max-width:\s*100%/);
  });

  test("the Russian note only when the Russian subscribers get the Estonian text and there are some", async () => {
    await show(DRAFT);
    actions.prepareSendAction.mockResolvedValueOnce({ ...PLAN, ruFallsBack: false });
    await click($("[data-send-all]"));
    expect(confirmOpen()).not.toBeNull();
    expect($("[data-send-fallback]")).toBeNull();
    await click($("[data-send-no]"));
    actions.prepareSendAction.mockResolvedValueOnce({ ...PLAN, ru: 0 });
    await click($("[data-send-all]"));
    expect(text("[data-send-confirm-text]")).toBe("Saadad kampaania 9 tellijale (eesti keeles 9, vene keeles 0). Kas saadame?");
    expect($("[data-send-fallback]")).toBeNull();
  });

  test("„Saada“ presses what the confirmation showed; every mail went in the first batch: „Kampaania on saadetud.“", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    actions.startSendAction.mockResolvedValue(ALL_WENT);
    await show(DRAFT);
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(actions.startSendAction).toHaveBeenCalledTimes(1);
    expect(actions.startSendAction).toHaveBeenCalledWith({ id: 7, et: 9, ru: 3, updatedAt: "2026-10-19T09:00:00.000Z" });
    expect(sendLine()).toBe("Kampaania on saadetud.");
    expect(confirmOpen()).toBeNull();
  });

  test("the first batch stopped at the day's room or its time: the line is the progress line (from the answer), whatever `stopped` says", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    await show(DRAFT);
    const partial = { ...NONE, total: 12, sent: 8, waiting: 4 };
    for (const stopped of ["room", "time", null]) {
      // (null with rows still waiting: another runner holds them — the batch is not done, so the line is the progress and not „saadetud“)
      actions.startSendAction.mockResolvedValueOnce({ ok: true, progress: partial, stopped });
      await click($("[data-send-all]"));
      await click($("[data-send-yes]"));
      expect(sendLine(), String(stopped)).toBe("Saadetud 8 / 12 — ülejäänud 4 lähevad järgmisel päeval.");
    }
    // the editor itself follows the campaign's status, which only a new page can change: it is still the draft's form
    expect($("[data-campaign-form]")).not.toBeNull();
  });

  test("Resend refused the first batch: „Saatmine peatus: Resend keeldus. Kirjuta Dimile.“", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    actions.startSendAction.mockResolvedValue({ ok: true, progress: { ...NONE, total: 12, waiting: 12 }, stopped: "refused" });
    await show(DRAFT);
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(sendLine()).toBe("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
  });

  test("another campaign is going out: „Saada kõigile“ answers with the one-at-a-time text instead of the confirmation", async () => {
    actions.prepareSendAction.mockResolvedValue({ ok: false, error: "busy" });
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect(confirmOpen()).toBeNull();
    expect(sendLine()).toBe("Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud.");
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });

  test("every other refusal of the press is said in words and the confirmation is closed: nothing was sent", async () => {
    await show(DRAFT);
    const prepare: [unknown, string][] = [
      [{ ok: false, error: "empty" }, "Kinnitatud tellijaid pole: kirja pole kellelegi saata."],
      [{ ok: false, error: "sent" }, "See kampaania on juba saadetud."],
      [{ ok: false, error: "notFound" }, "Seda kampaaniat enam pole."],
      [{ ok: false, error: "server" }, "Ei õnnestunud. Proovi uuesti."],
    ];
    for (const [answer, words] of prepare) {
      actions.prepareSendAction.mockResolvedValueOnce(answer);
      await click($("[data-send-all]"));
      expect(confirmOpen()).toBeNull();
      expect(sendLine(), words).toBe(words);
    }
    actions.prepareSendAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-send-all]"));
    expect(sendLine()).toBe("Ei õnnestunud. Proovi uuesti.");
    // the press itself
    actions.prepareSendAction.mockResolvedValue(PLAN);
    const press: [unknown, string][] = [
      [{ ok: false, error: "changed" }, "Kampaaniat või tellijate arvu muudeti vahepeal. Midagi ei saadetud: laadi leht uuesti, vaata kampaania üle ja vajuta uuesti „Saada kõigile“."],
      [{ ok: false, error: "busy" }, "Eelmine kampaania on veel pooleli — see läheb välja, kui eelmine on saadetud."],
      [{ ok: false, error: "sent" }, "See kampaania on juba saadetud."],
      [{ ok: false, error: "empty" }, "Kinnitatud tellijaid pole: kirja pole kellelegi saata."],
    ];
    for (const [answer, words] of press) {
      actions.startSendAction.mockResolvedValueOnce(answer);
      await click($("[data-send-all]"));
      await click($("[data-send-yes]"));
      expect(confirmOpen(), words).toBeNull();
      expect(sendLine(), words).toBe(words);
    }
    actions.startSendAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(sendLine()).toBe("Ei õnnestunud. Proovi uuesti.");
  });

  test("while the press works „Saada“ is pressed once: a second press does nothing", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    const working = pending<unknown>();
    actions.startSendAction.mockReturnValue(working.answer);
    await show(DRAFT);
    await click($("[data-send-all]"));
    await click($("[data-send-yes]"));
    expect(text("[data-send-yes]")).toBe("Saadan…");
    expect($("[data-send-yes]")!.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-send-yes]"));
    expect(actions.startSendAction).toHaveBeenCalledTimes(1);
    await act(async () => working.release(ALL_WENT));
    await settle();
    expect(sendLine()).toBe("Kampaania on saadetud.");
  });

  test("a field changed while the confirmation is open closes it: „Saada“ never sends what was not confirmed", async () => {
    actions.prepareSendAction.mockResolvedValue(PLAN);
    await show(DRAFT);
    await click($("[data-send-all]"));
    expect(confirmOpen()).not.toBeNull();
    await type($('[data-field="name"]'), "Muudetud nimi");
    expect(confirmOpen()).toBeNull();
    expect(actions.startSendAction).not.toHaveBeenCalled();
  });
});

describe("a campaign going out (`status` sending)", () => {
  test("the progress line, „Peata saatmine“, „Kopeeri“ and the preview; nothing to change, no send, no sent line", async () => {
    await show(GOING);
    expect($("[data-campaign-sent]")!.getAttribute("data-campaign-sent")).toBe("sending");
    expect(text("[data-campaign-progress]")).toBe("Saadetud 5 / 12 — ülejäänud 7 lähevad järgmisel päeval.");
    expect($("[data-campaign-sent-line]")).toBeNull();
    expect(text("[data-campaign-stop]")).toBe("Peata saatmine");
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
    expect(text("[data-campaign-read-only]")).toBe("Pooleli kampaaniat ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.");
    expect(frame()).not.toBeNull();
    expect(all("input, textarea")).toEqual([]);
    for (const hook of ["data-campaign-send", "data-test-send", "data-send-all", "data-campaign-form", "data-save-bar", "data-campaign-refused"]) expect($(`[${hook}]`), hook).toBeNull();
    for (const gone of ["Märgi saatmata", "Saada puuduv keel", "Resend", "katkes"]) expect(container.textContent, gone).not.toContain(gone);
  });

  test("the failed and unknown counts are lines only when they are not 0", async () => {
    await show(GOING);
    expect($("[data-campaign-failed]")).toBeNull();
    expect($("[data-campaign-unknown]")).toBeNull();
    await show({ ...GOING, progress: { ...NONE, total: 12, sent: 5, waiting: 4, failed: 1, unknown: 2 } });
    expect(text("[data-campaign-progress]")).toBe("Saadetud 5 / 12 — ülejäänud 4 lähevad järgmisel päeval.");
    expect(text("[data-campaign-failed]")).toBe("Kiri ei läinud 1 aadressile: aadress ei sobinud.");
    expect(text("[data-campaign-unknown]")).toBe("2 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
    await show({ ...GOING, progress: { ...NONE, total: 12, sent: 5, waiting: 6, unknown: 1 } });
    expect($("[data-campaign-failed]")).toBeNull();
    expect(text("[data-campaign-unknown]")).toBe("1 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
  });

  test("the batch stopped because Resend refused: the line says so; not otherwise", async () => {
    await show({ ...GOING, refused: true });
    expect(text("[data-campaign-refused]")).toBe("Saatmine peatus: Resend keeldus. Kirjuta Dimile.");
    expect(text("[data-campaign-progress]")).toBe("Saadetud 5 / 12 — ülejäänud 7 lähevad järgmisel päeval.");
    expect(text("[data-campaign-stop]")).toBe("Peata saatmine"); // (she can still stop it)
    await show(GOING);
    expect($("[data-campaign-refused]")).toBeNull();
  });

  test("the state is the campaign's status, not its numbers: `sending` with nothing waiting (the last mail is on its way) is still going out", async () => {
    await show({ ...GOING, progress: { ...NONE, total: 12, sent: 11, waiting: 0, skipped: 1 } });
    expect($("[data-campaign-sent]")!.getAttribute("data-campaign-sent")).toBe("sending");
    expect(text("[data-campaign-progress]")).toBe("Saadetud 11 / 12 — ülejäänud 0 lähevad järgmisel päeval.");
    expect($("[data-campaign-sent-line]")).toBeNull();
    expect($("[data-campaign-stop]")).not.toBeNull();
  });

  test("„Peata saatmine“ asks first, with the number that will not go; „Ei“ closes it and nothing is stopped", async () => {
    await show(GOING);
    await click($("[data-campaign-stop]"));
    expect(text("[data-stop-confirm-text]")).toBe("Kas peatan saatmise? Veel saatmata 7 kirja ei lähe välja. Seda ei saa tagasi võtta.");
    expect(text("[data-stop-yes]")).toBe("Jah, peata");
    expect(text("[data-stop-no]")).toBe("Ei");
    expect(actions.stopSendAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe($("[data-stop-confirm-text]")); // (the question takes the focus, as the site editors' deletes do)
    await click($("[data-stop-no]"));
    expect($("[data-stop-confirm]")).toBeNull();
    expect(text("[data-campaign-stop]")).toBe("Peata saatmine");
    expect(actions.stopSendAction).not.toHaveBeenCalled();
  });

  test("„Jah, peata“ stops it, once; the page is refreshed by the action and shows the sent campaign", async () => {
    const working = pending<unknown>();
    actions.stopSendAction.mockReturnValue(working.answer);
    await show(GOING);
    await click($("[data-campaign-stop]"));
    await click($("[data-stop-yes]"));
    expect(actions.stopSendAction).toHaveBeenCalledWith({ id: 7 });
    expect(text("[data-stop-yes]")).toBe("Peatan…");
    expect($("[data-stop-yes]")!.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-stop-yes]"));
    expect(actions.stopSendAction).toHaveBeenCalledTimes(1);
    await act(async () => working.release({ ok: true, progress: { ...NONE, total: 12, sent: 5, skipped: 7 } }));
    await settle();
    expect(text("[data-stop-status]")).toBe("Saatmine peatatud.");
    expect($("[data-stop-confirm]")).toBeNull();
  });

  test("„Peata saatmine“ refused is said in words and the question is closed", async () => {
    await show(GOING);
    const said: [unknown, string][] = [
      [{ ok: false, error: "notSending" }, "Selle kampaania saatmine ei ole pooleli."],
      [{ ok: false, error: "notFound" }, "Seda kampaaniat enam pole."],
      [{ ok: false, error: "server" }, "Ei õnnestunud. Proovi uuesti."],
    ];
    for (const [answer, words] of said) {
      actions.stopSendAction.mockResolvedValueOnce(answer);
      await click($("[data-campaign-stop]"));
      await click($("[data-stop-yes]"));
      expect($("[data-stop-confirm]"), words).toBeNull();
      expect(text("[data-stop-status]"), words).toBe(words);
    }
    actions.stopSendAction.mockRejectedValueOnce(new Error("offline"));
    await click($("[data-campaign-stop]"));
    await click($("[data-stop-yes]"));
    expect(text("[data-stop-status]")).toBe("Ei õnnestunud. Proovi uuesti.");
  });
});

describe("a sent campaign", () => {
  test("read-only: „Saadetud {date} · {n} tellijale“, the preview, „Kopeeri“, and no field, send or stop", async () => {
    await show(SENT);
    expect(text("[data-campaign-sent-line]")).toBe("Saadetud 19.10.2026 12:05 · 52 tellijale");
    expect(text("[data-campaign-read-only]")).toBe("Saadetud kampaaniat ei saa muuta. „Kopeeri“ teeb sellest uue mustandi.");
    expect(frame()).not.toBeNull();
    expect(all("input, textarea")).toEqual([]);
    for (const hook of ["data-save-bar", "data-test-send", "data-send-all", "data-campaign-stop", "data-campaign-progress", "data-campaign-failed", "data-campaign-unknown", "data-campaign-refused"]) {
      expect($(`[${hook}]`), hook).toBeNull();
    }
    expect(text("[data-campaign-copy]")).toBe("Kopeeri");
    expect(container.textContent).not.toMatch(/Resend/);
  });

  test("a failure count is added when there were any (spec §3), and the mails with no answer; nothing for 0", async () => {
    await show({ ...SENT, progress: { ...NONE, total: 55, sent: 52, failed: 2, unknown: 1 } });
    expect(text("[data-campaign-sent-line]")).toBe("Saadetud 19.10.2026 12:05 · 52 tellijale");
    expect(text("[data-campaign-failed]")).toBe("Kiri ei läinud 2 aadressile: aadress ei sobinud.");
    expect(text("[data-campaign-unknown]")).toBe("1 kirja kohta pole teada, kas see läks. Neid ei saadeta uuesti.");
    await show({ ...SENT, progress: { ...NONE, total: 55, sent: 52, skipped: 3 } });
    expect($("[data-campaign-failed]")).toBeNull();
    expect($("[data-campaign-unknown]")).toBeNull();
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
