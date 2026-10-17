import { beforeEach, describe, expect, test, vi } from "vitest";
import { adminEt } from "@/i18n/dict/admin";

// Maria's contract actions (server/actions/admin-contracts.ts, contracts Task 5; spec D2, D4, D7, rulings R1 and R9): the work is in
// server/contracts.ts (tests/db/contracts.test.ts, tests/db/admin-contracts-actions.test.ts). Here: what each action passes on (the ids and the texts as
// typed), what it answers, that every refusal comes back in an Estonian text of `adminEt.contracts.errors` and never as a code alone, that every success
// refreshes the page (and a saved text revalidates the course pages), that the ask's mail is best effort, and that a throw is logged by its id and the
// error's class only.

const work = vi.hoisted(() => ({
  saveContractTexts: vi.fn(),
  contractCard: vi.fn(),
  requestContract: vi.fn(),
  mailContractRequest: vi.fn(),
  contractForAdmin: vi.fn(),
  contractOwner: vi.fn(),
  contractPdf: vi.fn(),
  mailContract: vi.fn(),
}));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
const deps = vi.hoisted(() => ({ adminSendDeps: vi.fn() }));
vi.mock("@/server/contracts", () => work);
vi.mock("next/cache", () => cache);
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/send-deps", () => deps);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({ marker: "db" }) }));

const actions = await import("@/server/actions/admin-contracts");
const E = adminEt.contracts.errors;

const SENDING = { db: {}, env: {}, siteUrl: "https://mslab.example", now: new Date("2026-10-17T09:00:00Z"), later: vi.fn() };
const TEXTS = { title: { et: "Kontaktkoolituse leping", ru: "Договор" }, body: { et: "Tekst.", ru: "Текст." } };

beforeEach(() => {
  for (const fn of [...Object.values(work), cache.refresh, pub.revalidatePublic, deps.adminSendDeps]) fn.mockReset();
  deps.adminSendDeps.mockResolvedValue(SENDING);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const refreshed = (times = 1) => expect(cache.refresh).toHaveBeenCalledTimes(times);
const logged = () => vi.mocked(console.error).mock.calls.flat().join("\n");

describe("saveContractTextsAction: Seaded → Lepingud → „Salvesta lepingud“", () => {
  test("the texts as typed go on; saved: the card as stored comes back, the course pages are revalidated through the settings' path, the page refreshes", async () => {
    const card = { title: { et: "Kontaktkoolituse leping", ru: "Договор" }, body: { et: "Tekst.", ru: "Текст." } };
    work.saveContractTexts.mockResolvedValue({ ok: true });
    work.contractCard.mockResolvedValue(card);
    expect(await actions.saveContractTextsAction(TEXTS)).toEqual({ ok: true, card });
    const [db, raw, now] = work.saveContractTexts.mock.calls[0];
    expect([db, raw]).toEqual([{ marker: "db" }, TEXTS]);
    expect(now).toBeInstanceOf(Date);
    // the part is named: server/cache-targets.ts maps "contract_contact" to the course pages (the form refuses a stale version and refreshes)
    expect(pub.revalidatePublic).toHaveBeenCalledTimes(1);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "settings", parts: ["contract_contact"] });
    refreshed();
  });

  test("a refused field comes back by name, nothing is revalidated and the page is not refreshed", async () => {
    work.saveContractTexts.mockResolvedValue({ ok: false, fields: { title: "required", body: "tooLong" } });
    expect(await actions.saveContractTextsAction(TEXTS)).toEqual({ ok: false, fields: { title: "required", body: "tooLong" } });
    expect(work.contractCard).not.toHaveBeenCalled();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("anything that is not the card's shape is the work's `form: invalid`, passed on as it is", async () => {
    work.saveContractTexts.mockResolvedValue({ ok: false, fields: { form: "invalid" } });
    expect(await actions.saveContractTextsAction("not an object")).toEqual({ ok: false, fields: { form: "invalid" } });
    expect(work.saveContractTexts.mock.calls[0][1]).toBe("not an object");
  });

  test("a throw is `server`, logged by its label and the class only (never a text), and nothing is revalidated", async () => {
    work.saveContractTexts.mockRejectedValue(new TypeError("boom: Tere, kati@example.test"));
    expect(await actions.saveContractTextsAction(TEXTS)).toEqual({ ok: false, error: "server" });
    expect(logged()).toContain("[contracts] the texts' save failed: TypeError");
    expect(logged()).not.toContain("kati");
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("requestContractAction: „Saada leping kinnitamiseks“", () => {
  test("the registration goes on; asked: the student is mailed (ruling R9) and the answer says so; the page refreshes", async () => {
    work.requestContract.mockResolvedValue({ ok: true });
    work.mailContractRequest.mockResolvedValue(true);
    expect(await actions.requestContractAction({ registrationId: 7 })).toEqual({ ok: true, mailed: true });
    const [db, id, now] = work.requestContract.mock.calls[0];
    expect([db, id]).toEqual([{ marker: "db" }, 7]);
    expect(now).toBeInstanceOf(Date);
    expect(deps.adminSendDeps).toHaveBeenCalledWith("[contracts]");
    expect(work.mailContractRequest).toHaveBeenCalledWith(SENDING, 7);
    refreshed();
  });

  test("the mail is sent only after the ask is recorded", async () => {
    const order: string[] = [];
    work.requestContract.mockImplementation(async () => (order.push("record"), { ok: true }));
    work.mailContractRequest.mockImplementation(async () => (order.push("mail"), true));
    await actions.requestContractAction({ registrationId: 7 });
    expect(order).toEqual(["record", "mail"]);
  });

  test("the mail did not go (not set up, a sample address, refused): the action still succeeds, `mailed: false`", async () => {
    work.requestContract.mockResolvedValue({ ok: true });
    work.mailContractRequest.mockResolvedValue(false);
    expect(await actions.requestContractAction({ registrationId: 7 })).toEqual({ ok: true, mailed: false });
    refreshed();
  });

  test("best effort: a throw in the mail's part (its deps, the mail) never fails the action; it is logged by the registration's id and the class", async () => {
    work.requestContract.mockResolvedValue({ ok: true });
    deps.adminSendDeps.mockRejectedValue(new TypeError("boom: kati@example.test"));
    expect(await actions.requestContractAction({ registrationId: 7 })).toEqual({ ok: true, mailed: false });
    expect(work.mailContractRequest).not.toHaveBeenCalled();
    expect(logged()).toContain("[contracts] registration 7: the ask's mail failed: TypeError");
    expect(logged()).not.toContain("kati");
    refreshed();
    deps.adminSendDeps.mockResolvedValue(SENDING);
    work.mailContractRequest.mockRejectedValue(new RangeError("boom"));
    expect(await actions.requestContractAction({ registrationId: 7 })).toEqual({ ok: true, mailed: false });
  });

  test.each([
    ["notFound", E.notFound],
    ["noAccount", "Õpilasel pole kontot — lisa ta Õpilased lehel."],
    ["cancelled", E.cancelled],
  ] as const)("%s comes back in words; nothing is mailed and the page is not refreshed", async (error, text) => {
    work.requestContract.mockResolvedValue({ ok: false, error });
    expect(await actions.requestContractAction({ registrationId: 7 })).toEqual({ ok: false, error, text });
    expect(text).toBe(E[error]);
    expect(work.mailContractRequest).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a registration id the form never sends (zero, a string, past the integer column, nothing) is `notFound` without a read", async () => {
    for (const bad of [{ registrationId: 0 }, { registrationId: "7" }, { registrationId: 2_147_483_648 }, { registrationId: 1.5 }, {}, null, undefined])
      expect(await actions.requestContractAction(bad as never), JSON.stringify(bad)).toEqual({ ok: false, error: "notFound", text: E.notFound });
    expect(work.requestContract).not.toHaveBeenCalled();
  });

  test("a throw of the work is `server`, logged by the registration's id and the class only; no mail", async () => {
    work.requestContract.mockRejectedValue(new TypeError("boom: Kati Kask"));
    expect(await actions.requestContractAction({ registrationId: 7 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[contracts] registration 7: the ask failed: TypeError");
    expect(logged()).not.toContain("Kati");
    expect(work.mailContractRequest).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("sendContractCopyAction: „Saada koopia õpilasele“", () => {
  const CONTRACT = { id: 5, clientId: null };
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  beforeEach(() => {
    work.contractPdf.mockResolvedValue(PDF);
    work.contractOwner.mockResolvedValue(3);
  });

  test("the contract goes by mail with the send deps (ruling R1: mailContract), with the PDF drawn for it (R15); sent: the page refreshes", async () => {
    work.contractForAdmin.mockResolvedValue(CONTRACT);
    work.mailContract.mockResolvedValue(true);
    expect(await actions.sendContractCopyAction({ id: 5 })).toEqual({ ok: true });
    expect(work.contractForAdmin).toHaveBeenCalledWith({ marker: "db" }, 5);
    expect(work.contractPdf).toHaveBeenCalledWith(CONTRACT);
    expect(deps.adminSendDeps).toHaveBeenCalledWith("[contracts]");
    expect(work.mailContract).toHaveBeenCalledWith(SENDING, CONTRACT, { noAccount: false, pdf: PDF });
    refreshed();
  });

  test("ruling R14: whether the student has an account is the contract's owner NOW, not the client it froze — a contract frozen with none, whose registration was linked since, still gets the button", async () => {
    work.contractForAdmin.mockResolvedValue(CONTRACT); // clientId null
    work.contractOwner.mockResolvedValue(3);
    work.mailContract.mockResolvedValue(true);
    await actions.sendContractCopyAction({ id: 5 });
    expect(work.contractOwner).toHaveBeenCalledWith({ marker: "db" }, 5);
    expect(work.mailContract.mock.calls[0][2]).toMatchObject({ noAccount: false });
  });

  test("a contract with no account behind it (the registration was never linked) goes without the link to an account", async () => {
    work.contractForAdmin.mockResolvedValue({ id: 5, clientId: 3 });
    work.contractOwner.mockResolvedValue(null);
    work.mailContract.mockResolvedValue(true);
    await actions.sendContractCopyAction({ id: 5 });
    expect(work.mailContract.mock.calls[0][2]).toMatchObject({ noAccount: true });
  });

  test("ruling R15: a PDF that cannot be drawn sends nothing — `pdfFailed` in words, logged by the id and the class only, the page not refreshed", async () => {
    work.contractForAdmin.mockResolvedValue(CONTRACT);
    work.contractPdf.mockRejectedValue(new TypeError("boom: Kati Kask"));
    expect(await actions.sendContractCopyAction({ id: 5 })).toEqual({ ok: false, error: "pdfFailed", text: E.pdfFailed });
    expect(E.pdfFailed).toBe("Lepingu PDF-i ei õnnestunud koostada — proovi uuesti.");
    expect(work.mailContract).not.toHaveBeenCalled();
    expect(deps.adminSendDeps).not.toHaveBeenCalled();
    expect(logged()).toContain("[contracts] contract 5: the copy's PDF could not be drawn: TypeError");
    expect(logged()).not.toContain("Kati");
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a mail that did not go (Resend is not set up, a sample address, refused) is `mailFailed` in words; the page is not refreshed", async () => {
    work.contractForAdmin.mockResolvedValue(CONTRACT);
    work.mailContract.mockResolvedValue(false);
    expect(await actions.sendContractCopyAction({ id: 5 })).toEqual({ ok: false, error: "mailFailed", text: E.mailFailed });
    expect(E.mailFailed).toBe("Kirja ei saadetud. Proovi uuesti.");
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("an unknown contract, and an id the form never sends, are `contractNotFound` in words, nothing mailed", async () => {
    work.contractForAdmin.mockResolvedValue(null);
    expect(await actions.sendContractCopyAction({ id: 999 })).toEqual({ ok: false, error: "contractNotFound", text: E.contractNotFound });
    for (const bad of [{ id: 0 }, { id: "5" }, { id: 2_147_483_648 }, {}, null])
      expect(await actions.sendContractCopyAction(bad as never), JSON.stringify(bad)).toEqual({ ok: false, error: "contractNotFound", text: E.contractNotFound });
    expect(work.contractForAdmin).toHaveBeenCalledTimes(1);
    expect(work.mailContract).not.toHaveBeenCalled();
  });

  test("a throw is `server`, logged by the contract's id and the class only (never the address)", async () => {
    work.contractForAdmin.mockResolvedValue(CONTRACT);
    work.mailContract.mockRejectedValue(new TypeError("boom: kati@example.test"));
    expect(await actions.sendContractCopyAction({ id: 5 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[contracts] contract 5: the copy failed: TypeError");
    expect(logged()).not.toContain("kati");
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("the words", () => {
  test("every refusal the work can answer has Estonian words of its own, and no text is a code", () => {
    for (const code of ["notFound", "contractNotFound", "noAccount", "cancelled", "mailFailed", "pdfFailed", "server"] as const) {
      expect(E[code], code).toMatch(/\S/);
      expect(E[code], code).not.toBe(code);
    }
    // the no-account refusal says what the drawer says (the spec's words)
    expect(E.noAccount).toBe(adminEt.contracts.block.noAccount);
  });
});
