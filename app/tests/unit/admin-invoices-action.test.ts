import { beforeEach, describe, expect, test, vi } from "vitest";
import { adminEt } from "@/i18n/dict/admin";

// Maria's invoice actions (server/actions/admin-invoices.ts, invoices Task 5; spec §5, D5–D9, rulings R1, R10): the work is in
// server/invoices.ts and server/invoice-send.ts (tests/db/invoices.test.ts, tests/db/invoice-send.test.ts). Here: what each action passes on
// (the day she gave as an instant, the ids and the fields as typed), what it answers (the number made, the status an undo left, the
// field errors), that every refusal comes back in an Estonian text of `adminEt.invoices.errors` and never as a code alone, that every
// success refreshes the page (the seats too when a registration's paid sum changed), and that a throw is logged by its id and the error's
// class only.

const work = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  markInvoicePaid: vi.fn(),
  undoInvoicePaid: vi.fn(),
  cancelInvoice: vi.fn(),
  updateInvoiceBuyer: vi.fn(),
  catchUpInvoice: vi.fn(),
  createInvoicesForUnbilled: vi.fn(),
}));
const send = vi.hoisted(() => ({ sendInvoice: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
const deps = vi.hoisted(() => ({ adminSendDeps: vi.fn() }));
vi.mock("@/server/invoices", () => work);
vi.mock("@/server/invoice-send", () => send);
vi.mock("next/cache", () => cache);
vi.mock("@/server/public-cache", () => pub);
vi.mock("@/server/send-deps", () => deps);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({ marker: "db" }) }));

const actions = await import("@/server/actions/admin-invoices");
const E = adminEt.invoices.errors;

const SENDING = { db: {}, env: {}, siteUrl: "https://mslab.example", now: new Date("2026-10-16T09:00:00Z"), later: vi.fn() };

beforeEach(() => {
  for (const fn of [...Object.values(work), ...Object.values(send), cache.refresh, pub.revalidatePublic, deps.adminSendDeps]) fn.mockReset();
  deps.adminSendDeps.mockResolvedValue(SENDING);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const refreshed = (times = 1) => expect(cache.refresh).toHaveBeenCalledTimes(times);
const logged = () => vi.mocked(console.error).mock.calls.flat().join("\n");

describe("createInvoiceAction: „Koosta arve“", () => {
  test("a request to pay: the registration and the kind go on; the number made comes back; the page refreshes", async () => {
    work.createInvoice.mockResolvedValue({ ok: true, invoice: { number: "MSL2026-001" } });
    expect(await actions.createInvoiceAction({ registrationId: 7, kind: "prepayment", mode: "request" })).toEqual({ ok: true, number: "MSL2026-001" });
    const [db, id, input, now] = work.createInvoice.mock.calls[0];
    expect([db, id, input]).toEqual([{ marker: "db" }, 7, { kind: "prepayment", mode: "request" }]);
    expect(now).toBeInstanceOf(Date);
    refreshed();
    expect(pub.revalidatePublic).not.toHaveBeenCalled(); // the paid sum is not touched
  });

  test("a receipt: the day she gave becomes an instant (today is now, another day noon in Tallinn), and the way goes on", async () => {
    work.createInvoice.mockResolvedValue({ ok: true, invoice: { number: "MSL2026-002" } });
    await actions.createInvoiceAction({ registrationId: 7, kind: "balance", mode: "receipt", paidAt: "2026-10-12", method: "cash" });
    expect(work.createInvoice.mock.calls[0][2]).toEqual({ kind: "balance", mode: "receipt", paidAt: new Date("2026-10-12T09:00:00.000Z"), method: "cash" });
  });

  test.each([
    ["notFound", E.notFound],
    ["sellerMissing", E.sellerMissing],
    ["bankMissing", "Täida enne Seaded → „Maksmine“ (saaja ja IBAN)."],
    ["notOpen", E.notOpen],
    ["invalid", E.invalid],
  ] as const)("%s comes back in words, and the page is not refreshed", async (error, text) => {
    work.createInvoice.mockResolvedValue({ ok: false, error });
    expect(await actions.createInvoiceAction({ registrationId: 7, kind: "full", mode: "request" })).toEqual({ ok: false, error, text });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("input the form never sends (an unknown kind or mode, a date that is no date, a way Montonio owns, a bad id) is `invalid`, nothing read", async () => {
    const good = { registrationId: 7, kind: "full", mode: "receipt", paidAt: "2026-10-12", method: "bank" };
    for (const bad of [
      { ...good, kind: "gift" }, { ...good, mode: "free" }, { ...good, paidAt: "2026-02-30" }, { ...good, paidAt: undefined }, { ...good, method: "montonio" },
      { ...good, registrationId: 0 }, { ...good, registrationId: "7" }, { ...good, registrationId: 2_147_483_648 }, null, undefined,
    ])
      expect(await actions.createInvoiceAction(bad as never), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid", text: E.invalid });
    expect(work.createInvoice).not.toHaveBeenCalled();
  });

  test("a throw is `server`, logged by the registration's id and the class only", async () => {
    work.createInvoice.mockRejectedValue(new TypeError("boom: Kati Kask"));
    expect(await actions.createInvoiceAction({ registrationId: 7, kind: "full", mode: "request" })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] registration 7: the invoice failed: TypeError");
    expect(logged()).not.toContain("Kati");
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("sendInvoiceAction: „Saada õpilasele“", () => {
  test("the send deps, the invoice and the second address as typed go on; sent: the page refreshes", async () => {
    send.sendInvoice.mockResolvedValue({ ok: true });
    expect(await actions.sendInvoiceAction({ id: 5, also: " raamatupidaja@example.test " })).toEqual({ ok: true });
    expect(deps.adminSendDeps).toHaveBeenCalledWith("[invoices]");
    expect(send.sendInvoice).toHaveBeenCalledWith(SENDING, 5, " raamatupidaja@example.test ");
    refreshed();
  });

  test("the second address failing is told on, the first having gone", async () => {
    send.sendInvoice.mockResolvedValue({ ok: true, secondFailed: true });
    expect(await actions.sendInvoiceAction({ id: 5, also: "a@example.test" })).toEqual({ ok: true, secondFailed: true });
    refreshed();
  });

  test.each([["notFound", E.notFound], ["cancelled", E.cancelled], ["email", E.email], ["mailFailed", E.mailFailed]] as const)("%s in words", async (error, text) => {
    send.sendInvoice.mockResolvedValue({ ok: false, error });
    expect(await actions.sendInvoiceAction({ id: 5 })).toEqual({ ok: false, error, text });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a bad id is notFound without a send; a throw is `server`, logged by the id and the class only (never the address)", async () => {
    expect(await actions.sendInvoiceAction({ id: 0 } as never)).toEqual({ ok: false, error: "notFound", text: E.notFound });
    expect(send.sendInvoice).not.toHaveBeenCalled();
    send.sendInvoice.mockRejectedValue(new TypeError("boom: kati@example.test"));
    expect(await actions.sendInvoiceAction({ id: 5, also: "kati@example.test" })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] invoice 5: the send failed: TypeError");
    expect(logged()).not.toContain("kati@");
  });
});

describe("markInvoicePaidAction: „Märgi tasutuks“", () => {
  test("the day becomes an instant, the way goes on; paid: the seats are revalidated (the paid sum changed) and the page refreshes", async () => {
    work.markInvoicePaid.mockResolvedValue({ ok: true, invoice: { number: "MSL2026-001" } });
    expect(await actions.markInvoicePaidAction({ id: 5, paidAt: "2026-10-12", method: "bank" })).toEqual({ ok: true, full: false });
    expect(work.markInvoicePaid.mock.calls[0].slice(1, 3)).toEqual([5, { paidAt: new Date("2026-10-12T09:00:00.000Z"), method: "bank" }]);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "seats" });
    refreshed();
  });

  test("the session being full is told on (the place stays unconfirmed)", async () => {
    work.markInvoicePaid.mockResolvedValue({ ok: true, invoice: {}, full: true });
    expect(await actions.markInvoicePaidAction({ id: 5, paidAt: "2026-10-12", method: "card" })).toEqual({ ok: true, full: true });
  });

  test.each([["notFound", E.notFound], ["notUnpaid", E.notUnpaid], ["paidOnline", "See arve on juba veebis tasutud — koosta arve „Arveta maksed“ alt."], ["invalid", E.invalid]] as const)(
    "%s in words, nothing revalidated or refreshed",
    async (error, text) => {
      work.markInvoicePaid.mockResolvedValue({ ok: false, error });
      expect(await actions.markInvoicePaidAction({ id: 5, paidAt: "2026-10-12", method: "cash" })).toEqual({ ok: false, error, text });
      expect(cache.refresh).not.toHaveBeenCalled();
      expect(pub.revalidatePublic).not.toHaveBeenCalled();
    },
  );

  test("a day that is no day, or a way that is not Maria's, is `invalid` without a call", async () => {
    for (const bad of [{ id: 5, paidAt: "12.10.2026", method: "bank" }, { id: 5, paidAt: "2026-10-12", method: "montonio" }, { id: 5, method: "bank" }, { id: 5, paidAt: "2026-10-12" }])
      expect(await actions.markInvoicePaidAction(bad as never)).toEqual({ ok: false, error: "invalid", text: E.invalid });
    expect(work.markInvoicePaid).not.toHaveBeenCalled();
  });

  test("a throw is `server`, logged by the id", async () => {
    work.markInvoicePaid.mockRejectedValue(new TypeError("boom"));
    expect(await actions.markInvoicePaidAction({ id: 5, paidAt: "2026-10-12", method: "bank" })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] invoice 5: marking it paid failed: TypeError");
  });
});

describe("undoInvoicePaidAction: „Võta tasumine tagasi“ (R10)", () => {
  test("a request set back to unpaid: the status comes back `unpaid`; seats revalidated, page refreshed", async () => {
    work.undoInvoicePaid.mockResolvedValue({ ok: true, invoice: { status: "unpaid" } });
    expect(await actions.undoInvoicePaidAction({ id: 5 })).toEqual({ ok: true, status: "unpaid" });
    expect(work.undoInvoicePaid.mock.calls[0][1]).toBe(5);
    expect(pub.revalidatePublic).toHaveBeenCalledWith({ kind: "seats" });
    refreshed();
  });

  test("a receipt is cancelled: the status comes back `cancelled`, so the screen says so", async () => {
    work.undoInvoicePaid.mockResolvedValue({ ok: true, invoice: { status: "cancelled" } });
    expect(await actions.undoInvoicePaidAction({ id: 6 })).toEqual({ ok: true, status: "cancelled" });
  });

  test.each([["notFound", E.notFound], ["notPaid", E.notPaid], ["notManual", E.notManual]] as const)("%s in words", async (error, text) => {
    work.undoInvoicePaid.mockResolvedValue({ ok: false, error });
    expect(await actions.undoInvoicePaidAction({ id: 5 })).toEqual({ ok: false, error, text });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a bad id is notFound; a throw is `server`", async () => {
    expect(await actions.undoInvoicePaidAction({ id: -1 })).toEqual({ ok: false, error: "notFound", text: E.notFound });
    work.undoInvoicePaid.mockRejectedValue(new TypeError("boom"));
    expect(await actions.undoInvoicePaidAction({ id: 5 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] invoice 5: undoing the paid mark failed: TypeError");
  });
});

describe("cancelInvoiceAction: „Tühista arve“", () => {
  test("cancelled: the page refreshes; nothing about the seats (the paid sum is not touched)", async () => {
    work.cancelInvoice.mockResolvedValue({ ok: true });
    expect(await actions.cancelInvoiceAction({ id: 5 })).toEqual({ ok: true });
    expect(work.cancelInvoice.mock.calls[0][1]).toBe(5);
    refreshed();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
  });

  test.each([["notFound", E.notFound], ["notUnpaid", E.notUnpaid]] as const)("%s in words", async (error, text) => {
    work.cancelInvoice.mockResolvedValue({ ok: false, error });
    expect(await actions.cancelInvoiceAction({ id: 5 })).toEqual({ ok: false, error, text });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a throw is `server`", async () => {
    work.cancelInvoice.mockRejectedValue(new TypeError("boom"));
    expect(await actions.cancelInvoiceAction({ id: 5 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] invoice 5: the cancel failed: TypeError");
  });
});

describe("updateInvoiceBuyerAction: „Muuda saajat“", () => {
  const FIELDS = { id: 5, name: "Kati Kask", address: "", company: "Kask OÜ", companyCode: "12345678", companyAddress: "Pärnu" };

  test("the fields go on as typed; saved: the page refreshes", async () => {
    work.updateInvoiceBuyer.mockResolvedValue({ ok: true, invoice: {} });
    expect(await actions.updateInvoiceBuyerAction(FIELDS)).toEqual({ ok: true });
    expect(work.updateInvoiceBuyer.mock.calls[0][1]).toBe(5);
    expect(work.updateInvoiceBuyer.mock.calls[0][2]).toBe(FIELDS);
    refreshed();
  });

  test("a refused field comes back by name, with the words for the whole form", async () => {
    work.updateInvoiceBuyer.mockResolvedValue({ ok: false, error: "invalid", fields: { name: "required", company: "tooLong" } });
    expect(await actions.updateInvoiceBuyerAction({ ...FIELDS, name: "" })).toEqual({ ok: false, error: "invalid", fields: { name: "required", company: "tooLong" }, text: E.invalid });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test.each([["notFound", E.notFound], ["notUnpaid", E.notUnpaid]] as const)("%s in words", async (error, text) => {
    work.updateInvoiceBuyer.mockResolvedValue({ ok: false, error });
    expect(await actions.updateInvoiceBuyerAction(FIELDS)).toEqual({ ok: false, error, text });
  });

  test("a bad id is notFound; a throw is `server`, logged by the id only (never a name)", async () => {
    expect(await actions.updateInvoiceBuyerAction({ ...FIELDS, id: 0 })).toEqual({ ok: false, error: "notFound", text: E.notFound });
    expect(work.updateInvoiceBuyer).not.toHaveBeenCalled();
    work.updateInvoiceBuyer.mockRejectedValue(new TypeError("boom: Kati Kask"));
    expect(await actions.updateInvoiceBuyerAction(FIELDS)).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] invoice 5: the buyer change failed: TypeError");
    expect(logged()).not.toContain("Kati");
  });
});

describe("catchUpInvoiceAction: „Arveta maksed“ → „Koosta arve“", () => {
  test("the payment goes on; the number comes back; the page refreshes", async () => {
    work.catchUpInvoice.mockResolvedValue({ ok: true, invoice: { number: "MSL2026-003" } });
    expect(await actions.catchUpInvoiceAction({ paymentId: 9 })).toEqual({ ok: true, number: "MSL2026-003" });
    expect(work.catchUpInvoice.mock.calls[0][1]).toBe(9);
    refreshed();
  });

  test.each([["notFound", E.notPayment], ["notPaid", E.paymentNotPaid], ["already", E.already], ["sellerMissing", E.sellerMissing]] as const)("%s in words", async (error, text) => {
    work.catchUpInvoice.mockResolvedValue({ ok: false, error });
    expect(await actions.catchUpInvoiceAction({ paymentId: 9 })).toEqual({ ok: false, error, text });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a bad id is notPayment; a throw is `server`, logged by the payment's id", async () => {
    expect(await actions.catchUpInvoiceAction({ paymentId: 1.5 })).toEqual({ ok: false, error: "notFound", text: E.notPayment });
    work.catchUpInvoice.mockRejectedValue(new TypeError("boom"));
    expect(await actions.catchUpInvoiceAction({ paymentId: 9 })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] payment 9: the catch-up failed: TypeError");
  });
});

describe("createInvoicesForUnbilledAction: „Arveta maksed“ → „Koosta {n} arvet“ (B11)", () => {
  const DONE = { made: ["MSL2026-004", "MSL2026-005"], already: 1, failed: ["Mari Kask"], sellerMissing: false, linked: 1 };

  test("the list the panel showed goes on; what was made, what was already billed and what failed comes back as it is; the page refreshes", async () => {
    work.createInvoicesForUnbilled.mockResolvedValue(DONE);
    expect(await actions.createInvoicesForUnbilledAction({ ids: [4, 5, 6] })).toEqual({ ok: true, ...DONE });
    const [db, ids, now] = work.createInvoicesForUnbilled.mock.calls[0];
    expect([db, ids]).toEqual([{ marker: "db" }, [4, 5, 6]]);
    expect(now).toBeInstanceOf(Date);
    refreshed();
    expect(pub.revalidatePublic).not.toHaveBeenCalled(); // (a payment's invoice moves no paid sum)
  });

  test("everything was billed meanwhile: the page still refreshes, it has moved; so it does when the seller card is empty, to swap its stale button for the link", async () => {
    work.createInvoicesForUnbilled.mockResolvedValue({ made: [], already: 3, failed: [], sellerMissing: false, linked: 0 });
    expect(await actions.createInvoicesForUnbilledAction({ ids: [4, 5, 6] })).toEqual({ ok: true, made: [], already: 3, failed: [], sellerMissing: false, linked: 0 });
    refreshed();
    cache.refresh.mockClear();
    work.createInvoicesForUnbilled.mockResolvedValue({ made: [], already: 0, failed: [], sellerMissing: true, linked: 0 });
    expect(await actions.createInvoicesForUnbilledAction({ ids: [4] })).toEqual({ ok: true, made: [], already: 0, failed: [], sellerMissing: true, linked: 0 });
    refreshed(); // (the page then draws the link in place of its stale button)
  });

  test("a list the page never sends (none, a thousand, not ids) is notPayment in words, nothing read", async () => {
    for (const bad of [{ ids: [] }, { ids: [0] }, { ids: [1.5] }, { ids: ["4"] }, { ids: 4 }, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }, {}, null, undefined]) {
      expect(await actions.createInvoicesForUnbilledAction(bad as never), JSON.stringify(bad)?.slice(0, 40)).toEqual({ ok: false, error: "notFound", text: E.notPayment });
    }
    expect(work.createInvoicesForUnbilled).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  test("a throw is `server`, logged by the class only", async () => {
    work.createInvoicesForUnbilled.mockRejectedValue(new TypeError("boom: Kati Tamm"));
    expect(await actions.createInvoicesForUnbilledAction({ ids: [4] })).toEqual({ ok: false, error: "server", text: E.server });
    expect(logged()).toContain("[invoices] the batch of unbilled payments failed: TypeError");
    expect(logged()).not.toContain("Kati");
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});
