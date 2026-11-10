// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PracticeRequest, type PracticeRequestTexts } from "@/components/site/PracticeRequest";

// The practice request form (/praktika): the package group, then „Linn“ (Pärnu / Tallinn, nothing preselected, required), name, e-mail, phone, times.
// Without a city the form says „Vali linn.“ and focus goes to the first city radio; the action is stood in for here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ submitPractice: vi.fn<(fd: FormData) => Promise<unknown>>() }));
vi.mock("@/server/actions/public", () => ({ submitPractice: mocks.submitPractice }));
vi.mock("@/lib/url-query", () => ({ useUrlQuery: () => [new URLSearchParams(""), vi.fn()] }));

const t: PracticeRequestTexts = {
  selectedPackage: "Valitud pakett: {name}",
  packageLabel: "Praktikapakett",
  packageRequired: "Vali praktikapakett.",
  durationLabel: "Umbkaudne kestus",
  cityLabel: "Linn",
  cityRequired: "Vali linn.",
  cities: { Pärnu: "Pärnu", Tallinn: "Tallinn" },
  name: "Nimi",
  email: "E-post",
  phone: "Telefon",
  completedCourse: "Läbitud koolitus või kogemus",
  optional: "valikuline",
  preferredTimes: "Millised ajad sulle sobivad?",
  preferredTimesPlaceholder: "Näiteks tööpäeva õhtud",
  note: "See on aja kokkuleppimise taotlus.",
  submit: "Saada taotlus",
  sending: "Saadan…",
  sent: "Taotlus on saadetud.",
  sentText: "Maria võtab sinuga ühendust.",
  errorRequired: "See väli on kohustuslik.",
  errorEmail: "Sisesta korrektne e-posti aadress.",
  errorTooMany: "Liiga palju katseid.",
  errorGeneric: "Midagi läks valesti.",
};
const packages = [{ code: "MINI", name: "MINI", duration: "4 ak", price: "150 €" }];

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(s: string) => container.querySelector<E>(s);
const $$ = <E extends Element = HTMLElement>(s: string) => [...container.querySelectorAll<E>(s)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-practice-form]")!.requestSubmit());
  await settle();
};
const fillText = async (selector: string, value: string) => {
  const input = $<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pick = async (name: string, value: string) => {
  await act(async () => $<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!.click());
};
const fillRest = async () => {
  await pick("package", "MINI");
  await fillText('input[name="name"]', "Liis Lepp");
  await fillText('input[name="email"]', "liis@example.test");
  await fillText('input[name="phone"]', "+372 5555 0103");
  await fillText('textarea[name="times"]', "Õhtuti");
};

beforeEach(() => {
  mocks.submitPractice.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const draw = async () => {
  await act(async () => root.render(createElement(PracticeRequest, { packages, locale: "et", t })));
};

describe("the city of the practice request", () => {
  test("a required radio group „Linn“ right after the packages, Pärnu and Tallinn, nothing preselected", async () => {
    await draw();
    const groups = $$("[role=radiogroup]");
    expect(groups).toHaveLength(2);
    const city = groups[1];
    expect(city.getAttribute("aria-required")).toBe("true");
    expect(document.getElementById(city.getAttribute("aria-labelledby")!)?.textContent).toBe("Linn");
    expect($$<HTMLInputElement>('input[name="city"]').map((i) => i.value)).toEqual(["Pärnu", "Tallinn"]);
    expect($$<HTMLInputElement>('input[name="city"]').some((i) => i.checked)).toBe(false);
    expect(city.textContent).toContain("Tallinn");
    // the group comes straight after the package group and before the name
    expect(groups[0].nextElementSibling).toBe(city);
  });

  test("without a city: „Vali linn.“ under the group, the group is invalid and the first radio has focus", async () => {
    await draw();
    await pick("package", "MINI");
    await fillText('input[name="name"]', "Liis Lepp");
    await fillText('input[name="email"]', "liis@example.test");
    await fillText('input[name="phone"]', "+372 5555 0103");
    await fillText('textarea[name="times"]', "Õhtuti");
    mocks.submitPractice.mockResolvedValue({ ok: false, errors: { city: "required" } });
    await submit();
    const group = $$("[role=radiogroup]")[1];
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.textContent).toContain("Vali linn.");
    expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toBe("Vali linn.");
    expect(document.activeElement).toBe($('input[name="city"]'));
  });

  test("the picked city goes with the request; the error goes once one is picked", async () => {
    await draw();
    await fillRest();
    mocks.submitPractice.mockResolvedValue({ ok: true });
    await pick("city", "Tallinn");
    await submit();
    const fd = mocks.submitPractice.mock.calls[0][0];
    expect(fd.get("city")).toBe("Tallinn");
    expect($("[data-practice-sent]")).not.toBeNull();
  });
});
