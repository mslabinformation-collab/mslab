import { describe, expect, test } from "vitest";
import {
  isSpam,
  parseContact,
  parseEcoursePurchase,
  parseGroupRegistration,
  parseIndividual,
  parsePractice,
  parsePurchaseInterest,
  parseSubscribe,
  parseWaitlist,
  registrationSchema,
} from "@/server/forms";

// Task 10 brief test (verbatim), then the forms' error-code contract (moved here from the Task 8/9 placeholder tests:
// the actions now need the server env, the parsing they start with does not).

test("registration requires terms and a session for group", () => {
  const base = { courseId: 1, kind: "group", name: "A B", email: "a@example.ee", phone: "+372 5555", paymentChoice: "half", terms: "on" };
  expect(registrationSchema.safeParse({ ...base, courseSessionId: 3 }).success).toBe(true);
  expect(registrationSchema.safeParse(base).success).toBe(false);
  expect(registrationSchema.safeParse({ ...base, courseSessionId: 3, terms: undefined }).success).toBe(false);
  expect(registrationSchema.safeParse({ ...base, kind: "individual", preferredPeriod: "november" }).success).toBe(true);
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const errors = (r: { ok: boolean; errors?: Record<string, string> }) => (r.ok ? null : r.errors);
const base = { course: "kulmumeistri-baaskoolitus", name: "Test Õpilane", email: "test@example.com", phone: "+372 5555 5555", payment: "half", terms: "on", locale: "et" };

describe("group registration form", () => {
  test("accepts a complete registration and maps the form names to the stored fields", () => {
    const r = parseGroupRegistration(form({ ...base, session: "12", modelHelp: "on" }));
    expect(r).toEqual({
      ok: true,
      data: {
        course: "kulmumeistri-baaskoolitus",
        courseSessionId: 12,
        name: "Test Õpilane",
        email: "test@example.com",
        phone: "+372 5555 5555",
        paymentChoice: "half",
        wantsModelHelp: true,
        wantsAccount: false,
        wantsNewsletter: false,
        terms: "on",
        message: "",
        locale: "et",
      },
    });
  });
  test("needs a session, contact details, a payment choice and the terms", () => {
    expect(errors(parseGroupRegistration(form({ course: "x", email: "nope", phone: "abc", payment: "all" })))).toEqual({
      session: "required",
      name: "required",
      email: "invalid",
      phone: "required",
      payment: "required",
      terms: "required",
    });
  });
  test("instalment is not a payment choice yet (P14: shown disabled; a forged form is refused)", () => {
    expect(errors(parseGroupRegistration(form({ ...base, session: "3", payment: "instalment" })))).toEqual({ payment: "required" });
  });
  test("phone is required", () => {
    expect(errors(parseGroupRegistration(form({ ...base, session: "3", phone: "" })))).toEqual({ phone: "required" });
  });
  test("a course slug is required (the visitor cannot see it: form error)", () => {
    expect(errors(parseGroupRegistration(form({ ...base, course: "", session: "1" })))).toEqual({ form: "invalid" });
    expect(errors(parseGroupRegistration(form({ ...base, course: "../admin", session: "1" })))).toEqual({ form: "invalid" });
  });
  test("session ids must be positive integers", () => {
    for (const session of ["0", "-1", "1.5", "abc", "99999999999"])
      expect(errors(parseGroupRegistration(form({ ...base, session }))), session).toEqual({ session: "required" });
  });
});

describe("individual request", () => {
  test("accepts a request with the preferred period; payment is agreed later, not chosen", () => {
    const r = parseIndividual(form({ ...base, period: "Detsembri teine pool" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).not.toHaveProperty("paymentChoice");
    const { payment: _payment, ...noPayment } = base;
    void _payment;
    expect(parseIndividual(form({ ...noPayment, period: "12.12" })).ok).toBe(true);
  });
  test("the preferred period is required, the message is limited", () => {
    expect(errors(parseIndividual(form({ ...base, message: "x".repeat(2001) })))).toEqual({ period: "required", message: "required" });
  });
});

describe("contact, newsletter, cart, practice, waitlist", () => {
  test("contact: name, e-mail and message", () => {
    expect(parseContact(form({ name: "Test", email: "test@example.com", message: "Tere!\nKüsimus.", locale: "ru" }))).toEqual({
      ok: true,
      data: { name: "Test", email: "test@example.com", message: "Tere!\nKüsimus.", locale: "ru" },
    });
    expect(errors(parseContact(form({ name: " ", email: "x@", message: "" })))).toEqual({ name: "required", email: "invalid", message: "required" });
    expect(errors(parseContact(form({ name: "x".repeat(121), email: "a@example.ee", message: "x".repeat(2001) })))).toEqual({ name: "required", message: "required" });
  });
  test("newsletter: the e-mail alone is a sign-up (sending the form is the consent, there is no consent field)", () => {
    expect(parseSubscribe(form({ email: "a@example.ee" }))).toEqual({ ok: true, data: { email: "a@example.ee", locale: "et" } });
    expect(parseSubscribe(form({ email: " A@Example.ee ", locale: "ru" }))).toEqual({ ok: true, data: { email: "a@example.ee", locale: "ru" } });
    // an older page may still send the box: it is not read, and ticked or not it makes no difference
    expect(parseSubscribe(form({ email: "a@example.ee", consent: "on" }))).toEqual({ ok: true, data: { email: "a@example.ee", locale: "et" } });
    expect(parseSubscribe(form({ email: "a@example.ee" })).ok).toBe(true);
    expect(errors(parseSubscribe(form({ email: "nope" })))).toEqual({ email: "invalid" });
    expect(errors(parseSubscribe(form({})))).toEqual({ email: "invalid" });
  });
  test("cart interest: e-mail and course", () => {
    expect(parsePurchaseInterest(form({ course: "kulmumeistri-e-koolitus", email: "test@example.com" })).ok).toBe(true);
    expect(errors(parsePurchaseInterest(form({ course: "", email: "x" })))).toEqual({ email: "invalid", form: "invalid" });
  });
  test("practice: package, contact details and preferred times; the completed course is optional", () => {
    const practice = { package: "MINI", name: "Test Õpilane", email: "test@example.com", phone: "+372 5555 5555", times: "Tööpäeva õhtud", locale: "et" };
    expect(parsePractice(form(practice))).toEqual({ ok: true, data: { ...practice, course: "" } });
    expect(parsePractice(form({ ...practice, course: "Kulmumeistri baaskoolitus" })).ok).toBe(true);
    expect(errors(parsePractice(form({ email: "x", course: "y".repeat(201) })))).toEqual({
      package: "required",
      name: "required",
      email: "invalid",
      phone: "required",
      course: "required",
      times: "required",
    });
    expect(errors(parsePractice(form({ ...practice, package: "<script>" })))).toEqual({ package: "required" });
  });
  test("waitlist: name, e-mail and the session", () => {
    expect(parseWaitlist(form({ session: "12", name: "Test", email: "test@example.com" }))).toEqual({
      ok: true,
      data: { session: 12, name: "Test", email: "test@example.com", locale: "et", wantsNewsletter: false },
    });
    expect(errors(parseWaitlist(form({ session: "abc", name: "", email: "nope" })))).toEqual({ form: "invalid", name: "required", email: "invalid" });
  });
});

describe("normalisation", () => {
  test("e-mail is trimmed and lowercased; one-line fields collapse whitespace (they go into e-mail subjects)", () => {
    const r = parseWaitlist(form({ session: "1", name: "  Mari \n\t Maasikas ", email: "  Mari.Maasikas+Kursus@Example.COM " }));
    expect(r.ok && r.data).toMatchObject({ name: "Mari Maasikas", email: "mari.maasikas+kursus@example.com" });
  });
  test("an unknown locale falls back to Estonian", () => {
    const r = parseContact(form({ name: "A", email: "a@example.ee", message: "m", locale: "de" }));
    expect(r.ok && r.data.locale).toBe("et");
  });
  test("checkboxes: only 'on' ticks", () => {
    const r = parseGroupRegistration(form({ ...base, session: "1", modelHelp: "on", account: "" }));
    expect(r.ok && [r.data.wantsModelHelp, r.data.wantsAccount]).toEqual([true, false]);
  });
});

test("honeypot: anything in `website` is spam", () => {
  expect(isSpam(form({ website: "" }))).toBe(false);
  expect(isSpam(form({}))).toBe(false);
  expect(isSpam(form({ website: "http://spam.example" }))).toBe(true);
});

describe("the newsletter consent and the group form's message (phase 2c)", () => {
  const fd = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const group = { course: "kulmud", session: "4", name: "Kati", email: "kati@example.com", phone: "+372 5555 5555", payment: "full", terms: "on", locale: "et" };

  test("'newsletter' ticked is wantsNewsletter true; absent false — on the group, individual, purchase and waitlist forms", () => {
    const g = parseGroupRegistration(fd({ ...group, newsletter: "on" }));
    expect(g.ok && g.data.wantsNewsletter).toBe(true);
    const g2 = parseGroupRegistration(fd(group));
    expect(g2.ok && g2.data.wantsNewsletter).toBe(false);
    const i = parseIndividual(fd({ course: "kulmud", name: "Kati", email: "kati@example.com", phone: "+372 5555 5555", period: "detsember", terms: "on", locale: "et", newsletter: "on" }));
    expect(i.ok && i.data.wantsNewsletter).toBe(true);
    const p = parsePurchaseInterest(fd({ course: "e-kulmud", email: "kati@example.com", locale: "ru", newsletter: "on" }));
    expect(p.ok && p.data.wantsNewsletter).toBe(true);
    const w = parseWaitlist(fd({ session: "4", name: "Kati", email: "kati@example.com", locale: "et" }));
    expect(w.ok && w.data.wantsNewsletter).toBe(false);
  });

  test("only 'on' ticks the box: '', 'off' and 'true' are false, on all four forms", () => {
    const individual = { course: "kulmud", name: "Kati", email: "kati@example.com", phone: "+372 5555 5555", period: "detsember", terms: "on", locale: "et" };
    const forms = [
      (n: string) => parseGroupRegistration(fd({ ...group, newsletter: n })),
      (n: string) => parseIndividual(fd({ ...individual, newsletter: n })),
      (n: string) => parsePurchaseInterest(fd({ course: "e-kulmud", email: "kati@example.com", locale: "ru", newsletter: n })),
      (n: string) => parseWaitlist(fd({ session: "4", name: "Kati", email: "kati@example.com", locale: "et", newsletter: n })),
    ];
    for (const parse of forms)
      for (const value of ["", "off", "true", "ON", "1", "yes"]) {
        const r = parse(value);
        expect(r.ok && r.data.wantsNewsletter, `"${value}"`).toBe(false);
      }
    for (const parse of forms) {
      const r = parse("on");
      expect(r.ok && r.data.wantsNewsletter).toBe(true);
    }
  });

  test("the group form's optional message: trimmed, at most 2000", () => {
    const g = parseGroupRegistration(fd({ ...group, message: "  Kood TERE10  " }));
    expect(g.ok && g.data.message).toBe("Kood TERE10");
    const none = parseGroupRegistration(fd(group));
    expect(none.ok && none.data.message).toBe("");
    expect(parseGroupRegistration(fd({ ...group, message: "x".repeat(2001) })).ok).toBe(false);
  });
});

describe("the e-course purchase (phase 2b, D3)", () => {
  const fd = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  test("name, e-mail, the terms box (required) and the newsletter box; the course is a slug", () => {
    expect(parseEcoursePurchase(fd({ course: "kulmumeistri-e-koolitus", name: "  Kati   Tamm ", email: " Kati@Example.com ", terms: "on", newsletter: "on", locale: "ru" }))).toEqual({
      ok: true,
      data: { course: "kulmumeistri-e-koolitus", name: "Kati Tamm", email: "kati@example.com", terms: "on", wantsNewsletter: true, locale: "ru" },
    });
    const missing = parseEcoursePurchase(fd({ course: "Not a slug", name: "", email: "x" }));
    expect(missing).toEqual({ ok: false, errors: { form: "invalid", name: "required", email: "invalid", terms: "required" } });
    expect(parseEcoursePurchase(fd({ course: "k", name: "K", email: "k@example.com", terms: "on" }))).toMatchObject({ ok: true, data: { wantsNewsletter: false, locale: "et" } });
  });

  test("the terms box is 'on' or nothing; the newsletter box only 'on'; a name longer than a client keeps is refused", () => {
    const ok = { course: "k", name: "K", email: "k@example.com", terms: "on" };
    for (const terms of ["", "off", "true", "ON", "1"]) expect(parseEcoursePurchase(fd({ ...ok, terms })), terms).toEqual({ ok: false, errors: { terms: "required" } });
    for (const newsletter of ["", "off", "true", "ON", "1"]) expect(parseEcoursePurchase(fd({ ...ok, newsletter })), newsletter).toMatchObject({ ok: true, data: { wantsNewsletter: false } });
    expect(parseEcoursePurchase(fd({ ...ok, name: "x".repeat(121) }))).toEqual({ ok: false, errors: { name: "required" } });
    expect(parseEcoursePurchase(fd({ ...ok, name: "x".repeat(120) })).ok).toBe(true);
  });
});
