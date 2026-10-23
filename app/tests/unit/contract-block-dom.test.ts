// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The registration drawer's „Leping“ (contracts Task 5, spec §4, D4, D7, rulings R1 and R9) in a browser-like document (happy-dom), with the server
// actions answered here: the block in each state — none, current, superseded, pending, no account, cancelled — with the actions each allows (and no
// other), „Saada leping kinnitamiseks“ and „Saada koopia õpilasele“ with what they answer in words, and that a press is taken once.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ requestContractAction: vi.fn(), sendContractCopyAction: vi.fn(), saveContractTextsAction: vi.fn() }));
vi.mock("@/server/actions/admin-contracts", () => actions);

import { ContractBlock } from "@/components/admin/ContractBlock";
import type { ContractView } from "@/components/admin/contract-view";

const view = (over: Partial<ContractView> = {}): ContractView => ({
  id: 7,
  kind: "contact",
  title: "Kontaktkoolituse leping",
  locale: "et",
  acceptedAt: "2026-10-17T09:00:00.000Z",
  acceptedVia: "form",
  supersededAt: null,
  sentAt: null,
  registrationId: 3,
  ...over,
});
const CURRENT = view();
const OLD = view({ id: 5, acceptedAt: "2026-10-10T09:00:00.000Z", supersededAt: "2026-10-17T09:00:00.000Z" });
const OLDER = view({ id: 4, acceptedAt: "2026-10-05T09:00:00.000Z", acceptedVia: "account", supersededAt: "2026-10-10T09:00:00.000Z" });

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
type Props = Partial<Parameters<typeof ContractBlock>[0]>;
const show = async (props: Props = {}) => {
  await act(async () => root.render(createElement(ContractBlock, { registrationId: 3, contracts: [], requestedAt: null, linked: true, cancelled: false, ...props })));
  await settle();
};
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const rowOf = (id: number) => $(`[data-contract="${id}"]`)!;
/** The names of the buttons and links in a row, in order. */
const actionsOf = (id: number) => all("button, a", rowOf(id)).map((el) => el.textContent);
const requestButton = () => $<HTMLButtonElement>("[data-contract-request]");
const status = () => $('[role="status"]')!.textContent;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("what the block shows", () => {
  test("a folded row „Leping“; with no contract the block says so and still offers „Saada leping kinnitamiseks“ (D4: any linked, not cancelled group registration)", async () => {
    await show();
    expect($("details[data-fold] > summary")!.textContent).toContain("Leping");
    expect($("details[data-fold]")!.contains($("[data-registration-contracts]"))).toBe(true);
    expect($("[data-registration-contracts]")!.getAttribute("aria-label")).toBe("Leping");
    expect($("[data-contracts-none]")!.textContent).toBe("Sellele registreeringule pole lepingut.");
    expect($("[data-contract-list]")).toBeNull();
    expect(requestButton()!.textContent).toBe("Saada leping kinnitamiseks");
    expect($("[data-contract-pending]")).toBeNull();
    expect($("[data-contract-no-account]")).toBeNull();
  });

  test("the current contract: its title, the day it was accepted and the way, „Saada koopia õpilasele“ and „Laadi alla (PDF)“ — Maria's route, by the contract's id", async () => {
    await show({ contracts: [CURRENT] });
    expect($("[data-contracts-none]")).toBeNull();
    expect($("strong", rowOf(7))!.textContent).toBe("Kontaktkoolituse leping");
    expect($("[data-contract-facts]", rowOf(7))!.textContent).toBe("Kinnitatud 17.10.2026 · Registreerimisvorm");
    expect(actionsOf(7)).toEqual(["Saada koopia õpilasele", "Laadi alla (PDF)"]);
    const link = $<HTMLAnchorElement>("[data-contract-download]", rowOf(7))!;
    expect(link.getAttribute("href")).toBe("/api/admin/leping/7");
    expect(link.getAttribute("aria-label")).toBe("Laadi alla (PDF): leping 7");
    expect(rowOf(7).getAttribute("data-contract-state")).toBe("current");
    expect($("[data-contract-sent]", rowOf(7))).toBeNull(); // not sent yet
    // the ask stays offered beside it
    expect(requestButton()).not.toBeNull();
  });

  test("the way it was accepted, in words: the form, an e-course purchase, the student's account, the terms gate", async () => {
    await show({ contracts: [view({ id: 1, acceptedVia: "form" }), view({ id: 2, acceptedVia: "purchase" }), view({ id: 3, acceptedVia: "account" }), view({ id: 4, acceptedVia: "terms" })] });
    const ways = [1, 2, 3, 4].map((id) => $("[data-contract-facts]", rowOf(id))!.textContent!.split(" · ")[1]);
    expect(ways).toEqual(["Registreerimisvorm", "E-koolituse ost", "Õpilase konto", "E-koolituse tingimuste kinnitus"]);
  });

  test("the last copy sent: when; none yet shows nothing", async () => {
    await show({ contracts: [view({ sentAt: "2026-10-18T07:00:00.000Z" })] });
    expect($("[data-contract-sent]", rowOf(7))!.textContent).toBe("Saadetud õpilasele 18.10.2026");
  });

  test("superseded contracts follow the current one, each marked „Asendatud {date}“, with the PDF and nothing to send", async () => {
    await show({ contracts: [CURRENT, OLD, OLDER] });
    expect(all("[data-contract]").map((li) => li.getAttribute("data-contract"))).toEqual(["7", "5", "4"]);
    expect(all("[data-contract]").map((li) => li.getAttribute("data-contract-state"))).toEqual(["current", "superseded", "superseded"]);
    expect($("[data-contract-superseded]", rowOf(5))!.textContent).toBe("Asendatud 17.10.2026");
    expect($("[data-contract-superseded]", rowOf(4))!.textContent).toBe("Asendatud 10.10.2026");
    expect($("[data-contract-superseded]", rowOf(7))).toBeNull();
    expect(actionsOf(5)).toEqual(["Laadi alla (PDF)"]);
    expect(actionsOf(4)).toEqual(["Laadi alla (PDF)"]);
    expect($("[data-contract-facts]", rowOf(4))!.textContent).toBe("Kinnitatud 05.10.2026 · Õpilase konto");
    // (a contract with no title is named after the block)
    await show({ contracts: [view({ title: "" })] });
    expect($("strong", rowOf(7))!.textContent).toBe("Leping");
  });
});

describe("the folded row's summary (README A2 drawer 5, P-3): the block's own state line", () => {
  const fold = () => $("details[data-fold]")!;
  const summary = () => $("[data-fold-summary]", fold())!.textContent;
  const short = () => $("[data-fold-summary-short]", fold())?.textContent ?? null;

  test("closed to begin with, and the block is inside it", async () => {
    await show({ contracts: [CURRENT] });
    expect((fold() as HTMLDetailsElement).open).toBe(false);
    expect(fold().contains($("[data-contract-list]"))).toBe(true);
  });

  test("no contract: „Sellele registreeringule pole lepingut“, and on a phone „puudub“", async () => {
    await show();
    expect(summary()).toBe("Sellele registreeringule pole lepingut");
    expect(short()).toBe("puudub");
  });

  test("the current contract: „Kinnitatud {date}“ (the other states have no phone words of their own)", async () => {
    await show({ contracts: [CURRENT, OLD] });
    expect(summary()).toBe("Kinnitatud 17.10.2026");
    expect(short()).toBeNull();
  });

  test("asked and not yet accepted: „Kinnitamist ootab (saadetud {date})“, whether or not there is a contract", async () => {
    await show({ contracts: [CURRENT], requestedAt: "2026-10-18T07:00:00.000Z" });
    expect(summary()).toBe("Kinnitamist ootab (saadetud 18.10.2026)");
    await show({ contracts: [], requestedAt: "2026-10-18T07:00:00.000Z" });
    expect(summary()).toBe("Kinnitamist ootab (saadetud 18.10.2026)");
    expect(short()).toBeNull();
  });

  test("cancelled: no ask is shown as pending (cancelling never clears it) — the contract's own state, or none", async () => {
    await show({ contracts: [CURRENT], cancelled: true, requestedAt: "2026-10-18T07:00:00.000Z" });
    expect(summary()).toBe("Kinnitatud 17.10.2026");
    await show({ contracts: [], cancelled: true, requestedAt: "2026-10-18T07:00:00.000Z" });
    expect(summary()).toBe("Sellele registreeringule pole lepingut");
  });

  test("only superseded contracts: „Asendatud {date}“ of the newest", async () => {
    await show({ contracts: [OLD, OLDER] });
    expect(summary()).toBe("Asendatud 17.10.2026");
  });
});

describe("the ask: „Saada leping kinnitamiseks“ and its pending state", () => {
  test("once asked, the block says „Kinnitamist ootab (saadetud {date})“ — the page's contract_requested_at — and the ask stays offered (asking again moves the day)", async () => {
    await show({ contracts: [CURRENT], requestedAt: "2026-10-18T07:00:00.000Z" });
    expect($("[data-contract-pending]")!.textContent).toBe("Kinnitamist ootab (saadetud 18.10.2026)");
    expect(requestButton()).not.toBeNull();
    await show({ contracts: [], requestedAt: "2026-10-18T07:00:00.000Z" });
    expect($("[data-contract-pending]")!.textContent).toBe("Kinnitamist ootab (saadetud 18.10.2026)");
  });

  test("not linked to an account: the spec's no-account words, and no button", async () => {
    await show({ contracts: [CURRENT], linked: false });
    expect($("[data-contract-no-account]")!.textContent).toBe("Õpilasel pole kontot — lisa ta Õpilased lehel.");
    expect(requestButton()).toBeNull();
    expect(all("button").map((b) => b.textContent)).toEqual(["Saada koopia õpilasele"]); // the copy goes to the address on the contract: no account needed
    await show({ contracts: [], linked: false });
    expect($("[data-contract-no-account]")!.textContent).toBe("Õpilasel pole kontot — lisa ta Õpilased lehel.");
    expect(requestButton()).toBeNull();
  });

  test("cancelled: the contracts are shown (the PDF, the copy), nothing is asked, nothing is said about an account, and no ask is shown as pending (cancelling never clears it)", async () => {
    await show({ contracts: [CURRENT, OLD], cancelled: true, requestedAt: "2026-10-18T07:00:00.000Z" });
    expect(requestButton()).toBeNull();
    expect($("[data-contract-no-account]")).toBeNull();
    expect(actionsOf(7)).toEqual(["Saada koopia õpilasele", "Laadi alla (PDF)"]);
    expect(actionsOf(5)).toEqual(["Laadi alla (PDF)"]);
    expect($("[data-contract-pending]")).toBeNull();
    expect(container.textContent).not.toContain("Kinnitamist ootab");
    // (the same registration not cancelled still shows it)
    await show({ contracts: [CURRENT], cancelled: false, requestedAt: "2026-10-18T07:00:00.000Z" });
    expect($("[data-contract-pending]")).not.toBeNull();
    await show({ contracts: [CURRENT, OLD], cancelled: true, requestedAt: "2026-10-18T07:00:00.000Z" });
    await show({ contracts: [CURRENT], cancelled: true, linked: false });
    expect(requestButton()).toBeNull();
    expect($("[data-contract-no-account]")).toBeNull();
  });

  test("the press asks for this registration; the answer says the student was mailed", async () => {
    actions.requestContractAction.mockResolvedValue({ ok: true, mailed: true });
    await show();
    await click(requestButton());
    expect(actions.requestContractAction).toHaveBeenCalledTimes(1);
    expect(actions.requestContractAction).toHaveBeenCalledWith({ registrationId: 3 });
    expect(status()).toBe("Palve on õpilasele saadetud.");
    expect($('[role="status"]')!.className).toContain("success");
  });

  test("the ask recorded but the mail not sent (not set up here, a sample address): it says so, and that the student sees it in her account anyway", async () => {
    actions.requestContractAction.mockResolvedValue({ ok: true, mailed: false });
    await show();
    await click(requestButton());
    expect(status()).toBe("Palve on märgitud, aga kirja ei saadetud. Õpilane näeb seda oma kontol ka ilma kirjata.");
  });

  test("a refusal comes back in the action's own Estonian words, in the error tone", async () => {
    actions.requestContractAction.mockResolvedValue({ ok: false, error: "cancelled", text: "Tühistatud registreeringu lepingut ei saa kinnitamiseks saata." });
    await show();
    await click(requestButton());
    expect(status()).toBe("Tühistatud registreeringu lepingut ei saa kinnitamiseks saata.");
    expect($('[role="status"]')!.className).toContain("error");
  });

  test("a press is taken once while it is on its way: the second tap is ignored, the button is aria-disabled and the line says it is working", async () => {
    let finish!: (v: unknown) => void;
    actions.requestContractAction.mockReturnValue(new Promise((r) => (finish = r)));
    await show();
    await click(requestButton());
    expect(status()).toBe("Saadan…");
    expect(requestButton()!.getAttribute("aria-disabled")).toBe("true");
    await click(requestButton());
    expect(actions.requestContractAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, mailed: true }));
    await settle();
    expect(status()).toBe("Palve on õpilasele saadetud.");
    expect(requestButton()!.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("„Saada koopia õpilasele“", () => {
  test("the press sends the copy of that contract; the answer says it went", async () => {
    actions.sendContractCopyAction.mockResolvedValue({ ok: true });
    await show({ contracts: [CURRENT, OLD] });
    await click($("[data-contract-send-copy]", rowOf(7)));
    expect(actions.sendContractCopyAction).toHaveBeenCalledTimes(1);
    expect(actions.sendContractCopyAction).toHaveBeenCalledWith({ id: 7 });
    expect(status()).toBe("Koopia on õpilasele saadetud.");
    expect(actions.requestContractAction).not.toHaveBeenCalled();
  });

  test("a copy that did not go: the action's Estonian words, in the error tone", async () => {
    actions.sendContractCopyAction.mockResolvedValue({ ok: false, error: "mailFailed", text: "Kirja ei saadetud. Proovi uuesti." });
    await show({ contracts: [CURRENT] });
    await click($("[data-contract-send-copy]", rowOf(7)));
    expect(status()).toBe("Kirja ei saadetud. Proovi uuesti.");
    expect($('[role="status"]')!.className).toContain("error");
  });

  test("a copy is taken once while it is on its way", async () => {
    let finish!: (v: unknown) => void;
    actions.sendContractCopyAction.mockReturnValue(new Promise((r) => (finish = r)));
    await show({ contracts: [CURRENT] });
    await click($("[data-contract-send-copy]", rowOf(7)));
    await click($("[data-contract-send-copy]", rowOf(7)));
    expect(actions.sendContractCopyAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    await settle();
    expect(status()).toBe("Koopia on õpilasele saadetud.");
  });
});
