import { beforeEach, expect, test, vi } from "vitest";

// Seaded's "Salvesta tunnistuse andmed" (server/actions/admin-certificates.ts, phase 3d, spec §6, §4): the card's fields go on as they came
// (server/certificates.ts saveCertificateSettings checks them; tests/db/certificates.test.ts); saved, the browser gets the settings as stored
// and the saved year's last number; a refusal's field errors as they came; a throw is { ok: false, error: "server" }.

const work = vi.hoisted(() => ({ saveCertificateSettings: vi.fn(), lastIssued: vi.fn(), reissueCertificate: vi.fn() }));
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/server/certificates", () => work);
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: unknown, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

const { saveCertificateSettingsAction } = await import("@/server/actions/admin-certificates");

const RAW = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: "2026", nextSeq: "15" };
const STORED = { place: "Tallinn", registryCode: "16346048", practicalLine: "Praktiline töö fotodel", trainerName: "Maria Sosnina", nextYear: 2026, nextSeq: 15 };

beforeEach(() => {
  work.saveCertificateSettings.mockReset();
  work.lastIssued.mockReset();
  work.reissueCertificate.mockReset();
  cache.refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("the card's fields go on as they came; saved: the settings as stored, and the saved year's last number", async () => {
  work.saveCertificateSettings.mockResolvedValue({ ok: true, settings: STORED });
  work.lastIssued.mockResolvedValue("MS LAB 2026-14");
  const result = await saveCertificateSettingsAction(RAW);
  expect(result).toEqual({ ok: true, settings: STORED, last: "MS LAB 2026-14" });
  expect(work.saveCertificateSettings.mock.calls[0][1]).toBe(RAW);
  expect(work.lastIssued.mock.calls[0][1]).toBe(2026);
  expect(cache.refresh).not.toHaveBeenCalled(); // the card keeps its own state
});

test("refused: the field errors as they came (a trainer's name in Cyrillic is 'letters'), nothing else read", async () => {
  work.saveCertificateSettings.mockResolvedValue({ ok: false, fields: { nextSeq: "taken", place: "required", trainerName: "letters" } });
  expect(await saveCertificateSettingsAction({ ...RAW, trainerName: "Мария Соснина" })).toEqual({ ok: false, fields: { nextSeq: "taken", place: "required", trainerName: "letters" } });
  expect(work.lastIssued).not.toHaveBeenCalled();
});

test("a throw is { ok: false, error: 'server' }, logged by its label only", async () => {
  work.saveCertificateSettings.mockRejectedValue(new TypeError("boom: Tallinn"));
  expect(await saveCertificateSettingsAction(RAW)).toEqual({ ok: false, error: "server" });
  const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(logged).toContain("[certificate] the settings save failed: TypeError");
  expect(logged).not.toContain("Tallinn");
});
