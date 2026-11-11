// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import type { CodeCourse, CodeUse, CodeValue } from "@/server/discount-code-admin";
import { stubFetch } from "../fakes";

// The Sooduskoodid drawer (F1 Task 13; spec §4.10 and §5; Dim's canvas „Haldus-paneel“; R16–R20). A stored code's drawer: the code with the switch „Aktiivne“
// (instant, the UndoBar „Sooduskood peatatud.“), the fields autosaved on api/admin/sooduskood/<id>, the value's Protsent | Eurod (R17: the field is emptied, nothing is
// sent until a valid value; R18's ceiling), „Kasutused ({n}) · Soodustust kokku: {amount}“ (R20), „Kustuta sooduskood“ behind a ConfirmPanel only without uses,
// else the line (R19's own when no use counts). A new code (?kood=uus, ?kood=tervituskood): the one explicit „Lisa sooduskood“.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ createCodeAction: vi.fn(), setCodeActiveAction: vi.fn(), deleteCodeAction: vi.fn() }));
vi.mock("@/server/actions/admin-discounts", () => actions);
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { Drawer } from "@/components/admin/Drawer";
import { DiscountCodeDrawer, NewDiscountCode } from "@/components/admin/DiscountCodeDrawer";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { UndoProvider } from "@/components/admin/UndoBar";

const ID = 7;
const COURSES: CodeCourse[] = [
  { id: 3, title: "Kulmumeistri baaskoolitus", type: "contact", published: true, listCents: 35_000 },
  { id: 5, title: "Kulmude e-koolitus", type: "e_learning", published: true, listCents: 9_500 },
];
const VALUE: CodeValue = {
  code: "E-ESMASPAEV",
  kind: "percent",
  percent: "10",
  amount: "",
  scope: "ecourse",
  courseIds: [],
  startsOn: "",
  endsOn: "",
  maxUses: "",
  audience: "all",
  oncePerPerson: true,
  daysAfterSignup: "",
  note: "Instagrami kampaania, november",
  welcome: false,
  active: true,
  used: false,
};
const use = (id: number, over: Partial<CodeUse> = {}): CodeUse => ({
  id,
  at: new Date("2026-11-09T10:00:00Z"),
  name: "Kati Kask (näidis)",
  course: "Kulmude laminatsioon",
  cents: 1_900,
  via: "form",
  mark: "counts",
  href: `/admin/registreerimised?id=${id}`,
  ...over,
});
type DrawerProps = Parameters<typeof DiscountCodeDrawer>[0];
const props = (over: Partial<Omit<DrawerProps, "value">> & { value?: Partial<CodeValue> } = {}): DrawerProps => ({
  id: ID,
  version: "k:v1",
  courses: COURSES,
  uses: [],
  listHref: "/admin/sooduskoodid",
  ...over,
  value: { ...VALUE, ...over.value },
});

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
/** The route's version: a save of it is stored and moves it. `refuse`: the route's 400 for the next save. */
let current = "k:v1";
let saves = 0;
let refuse: Record<string, string> | null = null;
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url !== `/api/admin/sooduskood/${ID}`) return Response.json({ ok: false }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string };
  if (refuse) {
    const fields = refuse;
    refuse = null;
    return Response.json({ ok: false, error: "invalid", fields }, { status: 400 });
  }
  if (body.version !== current) return Response.json({ ok: false, error: "conflict", version: current, value: VALUE }, { status: 409 });
  current = `k:v${2 + saves++}`;
  return Response.json({ ok: true, version: current, savedAt: "2026-11-11T11:03:00.000Z" });
};

/** The page round the drawer as the (panel) layout has it: the guard, the UndoBar, the row link the focus goes back to, the drawer. */
const page = (content: React.ReactNode, label = "Sooduskood E-ESMASPAEV") =>
  createElement(
    LeaveGuardProvider,
    null,
    createElement(
      UndoProvider,
      null,
      createElement("a", { id: `code-${ID}`, href: `/admin/sooduskoodid?kood=${ID}` }, "E-ESMASPAEV"),
      createElement(Drawer, { label, closeHref: "/admin/sooduskoodid", closeLabel: "Sulge", returnFocus: `code-${ID}` } as Parameters<typeof Drawer>[0], content),
    ),
  );
const show = (over: Parameters<typeof props>[0] = {}) => act(async () => root.render(page(createElement(DiscountCodeDrawer, props(over)))));
const showNew = (welcome = false) => act(async () => root.render(page(createElement(NewDiscountCode, { welcome, courses: COURSES }), "Uus sooduskood")));

const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-drawer]")!;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const $$ = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const buttonNamed = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => text(b) === name || b.getAttribute("aria-label") === name) ?? null;
const field = (name: string) => dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[name="${name}"], textarea[name="${name}"]`)!;
const labelOf = (el: Element) => text(document.querySelector(`label[for="${el.id}"]`));
const radio = (group: string, value: string) => dialog().querySelector<HTMLInputElement>(`[data-field="${group}"] input[type=radio][value="${value}"]`)!;
const type = async (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const leave = (el: Element | null) => act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const chip = () => $("[data-code-head] [data-save-status]");
const errorOf = (name: string) => text($(`[data-field-error="${name}"]`));
const sw = () => dialog().querySelector<HTMLInputElement>("input[data-code-switch]")!;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
  current = "k:v1";
  saves = 0;
  refuse = null;
  localStorage.clear();
  history.replaceState({ __NA: true }, "", `/admin/sooduskoodid?kood=${ID}`);
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  fetched.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a stored code's drawer", () => {
  it("the chip left of ✕ „Sulge“, the code as the title, the switch „Aktiivne“ on, the fields in the canvas's order with their hints", async () => {
    await show();
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(buttonNamed("Sulge", dialog())).not.toBeNull();
    expect(text($("[data-code-title]"))).toBe("E-ESMASPAEV");
    expect(sw().checked).toBe(true);
    expect(text(document.querySelector("label[data-switch-row]"))).toBe("Aktiivne");
    const names = ["code", "percent", "startsOn", "endsOn", "maxUses", "note"];
    expect(names.map((n) => labelOf(field(n)))).toEqual(["Kood", "Soodustus (%)", "Algab", "Lõpeb", "Kasutuskordi kokku", "Märkus"]);
    expect(field("code").value).toBe("E-ESMASPAEV");
    expect(field("percent").value).toBe("10");
    expect(field("note").value).toBe("Instagrami kampaania, november");
    const body = text(dialog());
    for (const hint of [
      "Tähed A–Z, numbrid ja sidekriips, kuni 30 märki. Õpilane võib kirjutada ka väikeste tähtedega.",
      "Tühjaks jättes kehtib kohe ja tähtajatult. Lõpu päev on kaasa arvatud.",
      "Tühjaks jättes piiranguta. Kasutuseks ei loe tühistatud registreeringut ega üle ööpäeva vana maksmata registreeringut.",
      "Inimene on tema e-posti aadress.",
      "Näeb ainult haldus.",
    ])
      expect(body).toContain(hint);
    // the pills: Soodustus, Kehtib, Kellele
    expect($$("[data-field='kind'] [data-pill-choice] label").map(text)).toEqual(["Protsent", "Eurod"]);
    expect($$("[data-field='scope'] label").map(text)).toEqual(["Kõigile koolitustele", "Kõigile e-koolitustele", "Kõigile kontaktkoolitustele", "Valitud koolitustele"]);
    expect($$("[data-field='audience'] label").map(text)).toEqual(["Kõigile", "Ainult esimesel koolitusel", "Ainult varasematele õpilastele"]);
    expect(radio("scope", "ecourse").checked).toBe(true);
    expect(text($("[data-field='oncePerPerson']"))).toContain("Üks kord inimese kohta");
    // not the welcome row: no days field, no fixed rules
    expect($("[data-welcome-rules]")).toBeNull();
    expect(dialog().querySelector("input[name='daysAfterSignup']")).toBeNull();
  });

  it("Protsent and Eurod switch the field", async () => {
    await show();
    expect(labelOf(field("percent"))).toBe("Soodustus (%)");
    expect(text(dialog())).not.toContain("Tasuda jääb alati vähemalt 1 €.");
    await click(radio("kind", "euro"));
    expect(labelOf(field("amount"))).toBe("Soodustus (€)");
    expect(dialog().querySelector("input[name='percent']")).toBeNull();
    expect(text(dialog())).toContain("Tasuda jääb alati vähemalt 1 €.");
    await click(radio("kind", "percent"));
    expect(labelOf(field("percent"))).toBe("Soodustus (%)");
    expect(field("percent").value).toBe("10"); // (back on the stored kind: its stored value)
  });

  it("Valitud koolitustele shows the course checklist; choosing a course saves the scope and the course together", async () => {
    await show();
    expect($("[data-code-courses]")).toBeNull();
    await click(radio("scope", "courses"));
    const list = $("[data-code-courses]")!;
    expect($$("[data-code-courses] label").map(text)).toEqual(["Kulmumeistri baaskoolitus", "Kulmude e-koolitus"]);
    // none chosen: the scope waits with its courses, and says so; nothing is sent
    await leave(radio("scope", "courses"));
    await settle();
    expect(fetched.calls).toHaveLength(0);
    expect(errorOf("courseIds")).toBe("Vali vähemalt üks koolitus.");
    await click(list.querySelector("input[type=checkbox]"));
    await leave(list);
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "k:v1", patch: { scope: "courses", courseIds: [3] } }]);
    // switching away from the courses forgets them
    await click(radio("scope", "all"));
    await settle();
    expect(fetched.calls.at(-1)!.body).toEqual({ version: "k:v2", patch: { scope: "all", courseIds: [] } });
  });

  it("the welcome row shows its days field and the fixed rules text, and not Kellele nor „Üks kord inimese kohta“", async () => {
    await show({ value: { welcome: true, code: "TERE10", audience: "first", daysAfterSignup: "30", scope: "all" } });
    expect(text($("[data-code-title]"))).toBe("TERE10");
    expect(text($("[data-welcome-tag]") ?? $("[data-code-head]"))).toContain("Tervituskood");
    expect(labelOf(field("daysAfterSignup"))).toBe("Kehtib pärast liitumist (päeva)");
    expect(field("daysAfterSignup").value).toBe("30");
    expect(text(dialog())).toContain("Tervituskiri ütleb selle õpilasele. Tühjaks jättes tähtajatu.");
    expect(text($("[data-welcome-rules]"))).toBe("Tervituskood kehtib uudiskirjaga liitunud aadressil, esimesel koolitusel ja üks kord.");
    expect($("[data-field='audience']")).toBeNull();
    expect($("[data-field='oncePerPerson']")).toBeNull();
    expect(text($("[data-code-hint]"))).toContain("Juba saadetud tervituskirjades on vana kood.");
  });
});

describe("the fields autosave", () => {
  it("a note typed saves on the code's route from the version the page read; the chip says it; the page is read again", async () => {
    await show();
    await type(field("note"), "Uus märkus");
    await leave(field("note"));
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url, c.body])).toEqual([["POST", `/api/admin/sooduskood/${ID}`, { version: "k:v1", patch: { note: "Uus märkus" } }]]);
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("R17: switching Protsent to Eurod empties the value and sends nothing until a valid amount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await show();
    await click(radio("kind", "euro"));
    expect(field("amount").value).toBe("");
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 500)));
    await leave(field("amount"));
    await settle();
    expect(fetched.calls).toHaveLength(0);
    // an amount that is not one: still nothing
    await type(field("amount"), "abc");
    await leave(field("amount"));
    await settle();
    expect(fetched.calls).toHaveLength(0);
    expect(errorOf("amount")).toBe("Sisesta summa eurodes.");
    // a valid one saves the kind with it
    await type(field("amount"), "25,50");
    await leave(field("amount"));
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "k:v1", patch: { kind: "euro", amount: "25,50" } }]);
  });

  it("a refused value (100 %) shows the error and sends no request", async () => {
    await show();
    await type(field("percent"), "100");
    await leave(field("percent"));
    await settle();
    expect(fetched.calls).toHaveLength(0);
    expect(errorOf("percent")).toBe("Soodustus peab olema 1–99%.");
    expect(field("percent").getAttribute("aria-invalid")).toBe("true");
    await type(field("percent"), "7,5");
    await leave(field("percent"));
    await settle();
    expect(errorOf("percent")).toBe("Sisesta täisarv.");
    expect(fetched.calls).toHaveLength(0);
  });

  it("R18: a euro amount above the highest list price in scope is refused in the field (no request); it is re-checked when the scope narrows", async () => {
    await show({ value: { kind: "euro", amount: "300", percent: "", scope: "all" } });
    await type(field("amount"), "400");
    await leave(field("amount"));
    await settle();
    expect(errorOf("amount")).toBe("Soodustus on suurem kui koolituse hind.");
    expect(fetched.calls).toHaveLength(0);
    await type(field("amount"), "300");
    await leave(field("amount"));
    await settle();
    expect(errorOf("amount")).toBe("");
    await click(radio("scope", "ecourse")); // (the e-course's price is 95 €)
    await settle();
    expect(errorOf("amount")).toBe("Soodustus on suurem kui koolituse hind.");
    expect(fetched.calls).toHaveLength(0);
  });

  it("dates in the wrong order: Lõpp ei saa olla enne algust", async () => {
    await show();
    await type(field("startsOn"), "2026-12-10");
    await type(field("endsOn"), "2026-12-01");
    await leave(field("endsOn"));
    await settle();
    expect(errorOf("endsOn")).toBe("Lõpp ei saa olla enne algust.");
    expect(fetched.calls).toHaveLength(0);
  });

  it("codeTaken shows Ava see kood linking to the existing code", async () => {
    await show();
    refuse = { code: "codeTaken:12" };
    await type(field("code"), "SUVI10");
    await leave(field("code"));
    await settle();
    expect(errorOf("code")).toContain("Selline kood on juba olemas.");
    const link = $<HTMLAnchorElement>("[data-field-error='code'] a[data-open-taken]")!;
    expect(text(link)).toBe("Ava see kood");
    expect(link.getAttribute("href")).toBe("/admin/sooduskoodid?kood=12");
    // typed again: the refusal goes
    await type(field("code"), "SUVI11");
    expect($("[data-open-taken]")).toBeNull();
  });
});

describe("„Aktiivne“ (the switch, instant)", () => {
  it("Aktiivne flips at once and rolls back when the server refuses", async () => {
    let answer!: (r: unknown) => void;
    actions.setCodeActiveAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await show();
    await click(sw());
    expect(sw().checked).toBe(false); // (at once, before the server has answered)
    expect(actions.setCodeActiveAction).toHaveBeenCalledWith({ id: ID, active: false, version: "k:v1" });
    await act(async () => answer({ ok: false, error: "server" }));
    await settle();
    expect(sw().checked).toBe(true);
    expect(text($("[data-switch-error]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-undo-bar]")).toBeNull();
  });

  it("Aktiivne off shows Sooduskood peatatud. with Võta tagasi, which switches it on again from the version the pause left", async () => {
    actions.setCodeActiveAction.mockResolvedValueOnce({ ok: true, version: "k:v2" }).mockResolvedValueOnce({ ok: true, version: "k:v3" });
    await show();
    await click(sw());
    await settle();
    expect(sw().checked).toBe(false);
    const bar = $("[data-undo-bar]")!;
    expect(text(bar.querySelector("p"))).toBe("Sooduskood peatatud.");
    const undo = buttonNamed("Võta tagasi", bar)!;
    expect(undo).not.toBeNull();
    await click(undo);
    await settle();
    expect(actions.setCodeActiveAction).toHaveBeenLastCalledWith({ id: ID, active: true, version: "k:v2" });
  });

  it("stale (another tab saved first): it rolls back and the chip says it was changed elsewhere", async () => {
    actions.setCodeActiveAction.mockResolvedValue({ ok: false, error: "stale" });
    await show();
    await click(sw());
    await settle();
    expect(sw().checked).toBe(true);
    expect(chip()!.getAttribute("data-save-kind")).toBe("conflict");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a paused code starts off; switching it on puts up no bar", async () => {
    actions.setCodeActiveAction.mockResolvedValue({ ok: true, version: "k:v2" });
    await show({ value: { active: false } });
    expect(sw().checked).toBe(false);
    await click(sw());
    await settle();
    expect(actions.setCodeActiveAction).toHaveBeenCalledWith({ id: ID, active: true, version: "k:v1" });
    expect($("[data-undo-bar]")).toBeNull();
  });
});

describe("the uses and the delete", () => {
  it("Kasutused ({n}) · Soodustust kokku: the sum of the uses that count only (R20), each with its marks and its link", async () => {
    const uses = [
      use(3, { at: new Date("2026-11-09T10:00:00Z") }),
      use(2, { at: new Date("2026-11-04T10:00:00Z") }),
      use(1, { at: new Date("2026-11-02T10:00:00Z"), name: "Mari Mets (näidis)", course: "Ripsmete lifting", cents: 1_700, mark: "failed", href: "/admin/maksed?otsi=MSLAB-M5", via: "cart" }),
      use(4, { mark: "cancelled", via: "admin", cents: 900 }),
    ];
    await show({ value: { used: true }, uses });
    expect(text($("[data-code-uses] h3"))).toBe("Kasutused (4) · Soodustust kokku: 38 €");
    const rows = $$("[data-code-use]");
    expect(rows).toHaveLength(4);
    // (the day, the name over the course, the sum with its marks: the three blocks of a row)
    const parts = (row: HTMLElement) => [text(row.children[0]), Array.from(row.children[1].children).map(text).join(" / "), Array.from(row.children[2].children).map(text).join(" ")];
    expect(parts(rows[0])).toEqual(["09.11.2026", "Kati Kask (näidis) / Kulmude laminatsioon", "−19 €"]);
    expect(rows[0].querySelector("a")!.getAttribute("href")).toBe("/admin/registreerimised?id=3");
    expect(parts(rows[2])).toEqual(["02.11.2026", "Mari Mets (näidis) / Ripsmete lifting", "−17 € makse ebaõnnestus"]);
    expect(rows[2].querySelector("a")!.getAttribute("href")).toBe("/admin/maksed?otsi=MSLAB-M5");
    expect(text(rows[3])).toContain("tühistatud");
    expect(text(rows[3])).toContain("lisas haldus");
  });

  it("a used code shows no delete and the pause line; its text cannot change, and a changed value says it applies to new bookings", async () => {
    await show({ value: { used: true }, uses: [use(1)] });
    expect(buttonNamed("Kustuta sooduskood", dialog())).toBeNull();
    expect(text($("[data-delete-refusal]"))).toBe("Koodi on kasutatud — kustutada ei saa. Peata see.");
    expect(field("code").disabled).toBe(true);
    expect(text($("[data-code-hint]"))).toBe("Kasutatud koodi ei saa muuta: loo uus kood.");
    expect(text(dialog())).toContain("Muudatus kehtib uutele registreeringutele ja ostudele.");
  });

  it("R19: a code whose only uses are cancelled or abandoned refuses delete with its own line", async () => {
    await show({ value: { used: true }, uses: [use(1, { mark: "cancelled" }), use(2, { mark: "unpaid" })] });
    expect(text($("[data-delete-refusal]"))).toBe("Koodi on kasutatud tühistatud või pooleli jäänud tellimustel, seega ei saa seda kustutada. Peata see.");
    expect(text($("[data-code-uses] h3"))).toBe("Kasutused (2) · Soodustust kokku: 0 €");
  });

  it("an unused code: „Kustuta sooduskood“ asks „Kas kustutan sooduskoodi E-ESMASPAEV?“, „Katkesta“ gives the button back, „Jah, kustuta“ deletes and goes to the list", async () => {
    actions.deleteCodeAction.mockResolvedValue({ ok: true });
    await show();
    expect(text($("[data-code-uses] h3"))).toBe("Kasutused (0)");
    await click(buttonNamed("Kustuta sooduskood", dialog()));
    const panel = $("[data-code-delete] [data-confirm-panel]")!;
    expect(text(panel)).toContain("Kas kustutan sooduskoodi E-ESMASPAEV?");
    await click(buttonNamed("Katkesta", panel));
    expect($("[data-confirm-panel]")).toBeNull();
    expect(buttonNamed("Kustuta sooduskood", dialog())).not.toBeNull();
    await click(buttonNamed("Kustuta sooduskood", dialog()));
    await click(buttonNamed("Jah, kustuta", $("[data-code-delete]")!));
    await settle();
    expect(actions.deleteCodeAction).toHaveBeenCalledWith({ id: ID });
    expect(router.replace).toHaveBeenCalledWith("/admin/sooduskoodid?kustutatud=1", { scroll: false });
  });

  it("a booking that came meanwhile (used): the refusal line, and the page is read again", async () => {
    actions.deleteCodeAction.mockResolvedValue({ ok: false, error: "used" });
    await show();
    await click(buttonNamed("Kustuta sooduskood", dialog()));
    await click(buttonNamed("Jah, kustuta", $("[data-code-delete]")!));
    await settle();
    expect(text($("[data-delete-refusal]"))).toContain("Koodi on kasutatud");
    expect(router.refresh).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("a new code", () => {
  it("Uus sooduskood + opens a drawer with Lisa sooduskood", async () => {
    await showNew();
    expect(text($("[data-new-code-line]"))).toBe("Täida kohustuslikud väljad");
    expect(text($("[data-new-code] h2"))).toBe("Uus sooduskood");
    expect(buttonNamed("Lisa sooduskood", dialog())).not.toBeNull();
    expect(dialog().querySelector("input[data-code-switch]")).toBeNull(); // (a new code has no switch, no uses, no delete)
    expect($("[data-code-uses]")).toBeNull();
    expect(field("percent").value).toBe("");
    expect(radio("scope", "all").checked).toBe(true);
  });

  it("pressing it with nothing typed marks the fields and creates nothing; with a code and a value it creates and the drawer goes on at ?kood=<n>", async () => {
    actions.createCodeAction.mockResolvedValue({ ok: true, id: 9, version: "k:n1" });
    await showNew();
    await click(buttonNamed("Lisa sooduskood", dialog()));
    expect(errorOf("code")).toBe("Kirjuta kood.");
    expect(errorOf("percent")).toBe("Sisesta täisarv.");
    expect(actions.createCodeAction).not.toHaveBeenCalled();
    await type(field("code"), "tere 10");
    await type(field("percent"), "15");
    expect(text($("[data-new-code-line]"))).toBe("Vajuta „Lisa sooduskood“.");
    await click(buttonNamed("Lisa sooduskood", dialog()));
    await settle();
    expect(actions.createCodeAction).toHaveBeenCalledTimes(1);
    expect(actions.createCodeAction.mock.calls[0][0]).toMatchObject({ welcome: false, fields: { code: "tere 10", kind: "percent", percent: "15", scope: "all", audience: "all", oncePerPerson: true } });
    expect(router.replace).toHaveBeenCalledWith("/admin/sooduskoodid?kood=9&lisatud=9", { scroll: false });
  });

  it("the server's refusal (codeTaken) is shown at the field with Ava see kood", async () => {
    actions.createCodeAction.mockResolvedValue({ ok: false, error: "invalid", fields: { code: "codeTaken:4" } });
    await showNew();
    await type(field("code"), "suvi10");
    await type(field("percent"), "15");
    await click(buttonNamed("Lisa sooduskood", dialog()));
    await settle();
    expect(errorOf("code")).toContain("Selline kood on juba olemas.");
    expect($<HTMLAnchorElement>("[data-open-taken]")!.getAttribute("href")).toBe("/admin/sooduskoodid?kood=4");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("switching to Eurod empties the value here too; a euro amount over the ceiling is refused before sending", async () => {
    await showNew();
    await type(field("percent"), "15");
    await click(radio("kind", "euro"));
    expect(labelOf(field("amount"))).toBe("Soodustus (€)");
    expect(field("amount").value).toBe("");
    await type(field("code"), "SUVI10");
    await type(field("amount"), "999");
    await click(buttonNamed("Lisa sooduskood", dialog()));
    expect(errorOf("amount")).toBe("Soodustus on suurem kui koolituse hind.");
    expect(actions.createCodeAction).not.toHaveBeenCalled();
  });

  it("the welcome code: ?kood=tervituskood opens „Uus tervituskood“ with its days and the fixed rules, 10 % for the first training", async () => {
    await showNew(true);
    expect(text($("[data-new-code] h2"))).toBe("Uus tervituskood");
    expect(field("percent").value).toBe("10");
    expect(dialog().querySelector("input[name='daysAfterSignup']")).not.toBeNull();
    expect($("[data-welcome-rules]")).not.toBeNull();
    actions.createCodeAction.mockResolvedValue({ ok: true, id: 2, version: "k:n1" });
    await type(field("code"), "TERE10");
    await click(buttonNamed("Lisa sooduskood", dialog()));
    await settle();
    expect(actions.createCodeAction.mock.calls[0][0]).toMatchObject({ welcome: true, fields: { code: "TERE10", percent: "10" } });
  });
});

describe("fix round 1", () => {
  it("I-1: 10 % → Eurod 25 (saved) → Protsent 10 sends {kind: percent, percent: 10} and shows no error", async () => {
    await show();
    await click(radio("kind", "euro"));
    await type(field("amount"), "25");
    await leave(field("amount"));
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "k:v1", patch: { kind: "euro", amount: "25" } }]);
    // the page is read again: the stored code is a euro one now (the server cleared its percent)
    await show({ version: "k:v2", value: { kind: "euro", percent: "", amount: "25" } });
    await click(radio("kind", "percent"));
    await type(field("percent"), "10");
    await leave(field("percent"));
    await settle();
    expect(fetched.calls).toHaveLength(2);
    expect(fetched.calls[1].body).toEqual({ version: "k:v2", patch: { kind: "percent", percent: "10" } });
    expect(errorOf("percent")).toBe("");
    expect(chip()!.getAttribute("data-save-kind")).toBe("saved");
  });

  it("I-1 mirror: € 25 → Protsent 10 (saved) → Eurod 25 sends {kind: euro, amount: 25} and shows no error", async () => {
    await show({ value: { kind: "euro", percent: "", amount: "25" } });
    await click(radio("kind", "percent"));
    await type(field("percent"), "10");
    await leave(field("percent"));
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "k:v1", patch: { kind: "percent", percent: "10" } }]);
    await show({ version: "k:v2", value: { kind: "percent", percent: "10", amount: "" } });
    await click(radio("kind", "euro"));
    await type(field("amount"), "25");
    await leave(field("amount"));
    await settle();
    expect(fetched.calls[1].body).toEqual({ version: "k:v2", patch: { kind: "euro", amount: "25" } });
    expect(errorOf("amount")).toBe("");
  });

  it("M-3: after a save the field shows the server's normalised text (a trimmed note, suvi 10 as SUVI10)", async () => {
    await show();
    await type(field("note"), "  Märkus  ");
    await leave(field("note"));
    await settle();
    expect(field("note").value).toBe("Märkus");
    await type(field("code"), "suvi 10");
    await leave(field("code"));
    await settle();
    expect(field("code").value).toBe("SUVI10");
  });

  it("M-7a: choosing a kind empties a field that held a typed, unsaved value", async () => {
    await show();
    await click(radio("kind", "euro"));
    await type(field("amount"), "25"); // (typed, not saved: the 1.5 s have not passed)
    expect(field("amount").value).toBe("25");
    await click(radio("kind", "percent"));
    await click(radio("kind", "euro"));
    expect(field("amount").value).toBe("");
  });

  it("T13-3: a used welcome code's text field stays editable with the old-code hint; a used normal code's is disabled", async () => {
    await show({ value: { welcome: true, code: "TERE10", audience: "first", used: true }, uses: [use(1)] });
    expect(field("code").disabled).toBe(false);
    expect(text($("[data-code-hint]"))).toContain("Juba saadetud tervituskirjades on vana kood.");
    expect(text($("[data-code-hint]"))).not.toContain("Kasutatud koodi ei saa muuta");
    await show({ value: { used: true }, uses: [use(1)] });
    expect(field("code").disabled).toBe(true);
  });
});
