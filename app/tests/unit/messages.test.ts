import { describe, expect, test } from "vitest";
import { changeRequestSummary, registrationSummary } from "@/server/messages";

// Maria's message about a student's wish to cancel or move a registration (written in Estonian, never shown to visitors).

const ADMIN = "https://mslab.example/admin";
const who = { name: "Kati Tamm", email: "kati@example.test", phone: "+3725551234", locale: "ru" as const };
const session = { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu", venue: "Salong" };

describe("registrationSummary: how she pays, in Maria's words", () => {
  const registration = { ...who, course: "Kulmude lamineerimine", startsAt: session.startsAt, city: session.city, venue: session.venue, wantsModelHelp: false, wantsAccount: false, message: "" };
  test.each([
    ["full", "100% kohe"],
    ["half", "50% registreerimisel + 50% koolituspäeval"],
    ["financing", "Järelmaks (Inbank)"],
  ] as const)("%s is %s", (paymentChoice, words) => {
    const s = registrationSummary({ ...registration, paymentChoice }, ADMIN);
    expect(s.text).toContain(`Tasumine: ${words}`);
    expect(s.short).toContain(`Tasumine: ${words}`);
  });
});

describe("changeRequestSummary", () => {
  test("a cancellation: the course, date and place, the registration number, who asks, the message, and that nothing was changed", () => {
    const s = changeRequestSummary({ ...who, registrationId: 12, course: "Kulmude lamineerimine", session, kind: "cancel", message: "Haigestusin.\nPalun tühistada." }, ADMIN);
    expect(s.subject).toBe("Soov registreering tühistada: Kulmude lamineerimine, 14.11.2026 kell 10:00, Pärnu — Kati Tamm");
    expect(s.text).toBe(
      [
        "Soov registreering tühistada", "",
        "Koolitus: Kulmude lamineerimine", "Kuupäev: 14.11.2026 kell 10:00", "Koht: Pärnu, Salong",
        "Registreeringu number: 12", "Nimi: Kati Tamm", "E-post: kati@example.test", "Telefon: +3725551234", "Suhtluskeel: vene",
        "", "Sõnum:", "Haigestusin.\nPalun tühistada.",
        "", "Registreeringut ei ole muudetud. Võta õpilasega ühendust ja muuda registreering vajadusel adminis.",
        "", `Admin: ${ADMIN}`, "",
      ].join("\n"),
    );
    expect(s.short).toBe("Soov registreering tühistada\nKulmude lamineerimine · 14.11.2026 kell 10:00 · Pärnu\nKati Tamm · kati@example.test · +3725551234\nHaigestusin.\nPalun tühistada.");
  });

  test("a date change has its own title; an empty message leaves out the message block and the Telegram line", () => {
    const s = changeRequestSummary({ ...who, registrationId: 3, course: "Kulmude lamineerimine", session, kind: "change", message: "" }, ADMIN);
    expect(s.subject).toMatch(/^Soov registreeringu aega muuta: /);
    expect(s.text).not.toContain("Sõnum");
    expect(s.short.split("\n")).toEqual(["Soov registreeringu aega muuta", "Kulmude lamineerimine · 14.11.2026 kell 10:00 · Pärnu", "Kati Tamm · kati@example.test · +3725551234"]);
  });

  test("a registration without a date names the course only", () => {
    const s = changeRequestSummary({ ...who, registrationId: 4, course: "Kulmude lamineerimine", session: null, kind: "cancel", message: "x" }, ADMIN);
    expect(s.subject).toBe("Soov registreering tühistada: Kulmude lamineerimine — Kati Tamm");
    expect(s.text).toContain("Koolitus: Kulmude lamineerimine");
    expect(s.text).not.toMatch(/Kuupäev|Koht/);
    expect(s.short.split("\n")[1]).toBe("Kulmude lamineerimine");
  });

  test("the Telegram line holds at most 280 characters of the message", () => {
    const s = changeRequestSummary({ ...who, registrationId: 4, course: "K", session: null, kind: "cancel", message: "m".repeat(900) }, ADMIN);
    expect(s.short.split("\n").pop()).toHaveLength(280);
  });
});
