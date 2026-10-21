// @vitest-environment happy-dom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditLangProvider, LangSwitch } from "@/components/admin/EditLang";
import { FaqEditor } from "@/components/admin/FaqEditor";
import { I18nInput, PreviewLangSwitch } from "@/components/admin/I18nInput";
import { ListEditor } from "@/components/admin/ListEditor";
import { SlidesEditor } from "@/components/admin/SlidesEditor";
import { newSlideDraft, type FaqDraft, type SlideDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import type { I18n } from "@/i18n/field";
import { Check } from "@/server/edit-check";

// The page-level ET | RU switch (admin UX pass, README §1.9; analysis screens.md §2.6, decisions Q4 and D23): one „Sisu keel“ control in the page header
// sets the language of every I18nInput on the page through context; the choice is kept per device (localStorage `mslab-edit-lang`). In RU mode each
// field shows its Estonian text above the input (13 px, with an „ET“ tag), keeps „tõlge tulekul“ on an empty RU, and offers „Kopeeri eesti
// keelest“; the switch counts the fields still to translate („RU puudub 2 väljal“) and „Järgmine →“ goes to the next of them. The rules are unchanged.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "mslab-edit-lang";

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<E>(selector)];
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
};
const type = async (el: Element | null, value: string) => {
  if (!el) throw new Error("no field");
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const seg = (lang: "et" | "ru") => $<HTMLButtonElement>(`[data-edit-lang-switch] [data-edit-lang="${lang}"]`);
const field = (name: string) => $<HTMLInputElement | HTMLTextAreaElement>(`[data-i18n="${name}"]`)!;
const box = (name: string) => field(name).closest<HTMLElement>("[data-i18n-box]")!;
const missingLine = () => $("[data-ru-missing]");
const nextButton = () => $<HTMLButtonElement>("[data-ru-next]");

type Values = Record<"title" | "short" | "intro", I18n>;
const START: Values = {
  title: { et: "Kulmude lamineerimine", ru: "" },
  short: { et: "Lühikirjeldus", ru: "Краткое описание" },
  intro: { et: "Sissejuhatus", ru: "" },
};
/** A page with three bilingual fields and a „Salvesta“ that checks them the way the server does (server/edit-check.ts). */
function Form({ initial = START }: { initial?: Values }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof Values) => (v: I18n) => setValues((x) => ({ ...x, [key]: v }));
  const save = () => {
    const check = new Check();
    for (const key of Object.keys(values) as (keyof Values)[]) check.text(key, values[key], 200, { required: true });
    setErrors(Object.fromEntries(Object.entries(check.errors).map(([k, code]) => [k, adminEt.courseEditor.errors[code as "required"]])));
  };
  return createElement(
    "div",
    null,
    createElement(I18nInput, { label: "Koolituse nimi", name: "title", value: values.title, onChange: set("title"), error: errors.title }),
    createElement(I18nInput, { label: "Lühikirjeldus", name: "short", value: values.short, onChange: set("short"), error: errors.short }),
    createElement(I18nInput, { label: "Sissejuhatus", name: "intro", value: values.intro, onChange: set("intro"), multiline: true, error: errors.intro }),
    createElement("button", { type: "button", "data-save": "", onClick: save }, "Salvesta"),
  );
}
const page = (body: ReactNode) => createElement(EditLangProvider, null, createElement(LangSwitch), body);
const show = async (body: ReactNode = createElement(Form)) => act(async () => root.render(page(body)));

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("the switch", () => {
  test("one „ET“ | „RU“ switch sets every field on the page; the choice is kept in mslab-edit-lang", async () => {
    await show();
    // one control, in Estonian, ET first; the fields no longer carry pills of their own
    expect($$("[data-edit-lang-switch]")).toHaveLength(1);
    expect($("[data-edit-lang-bar]")!.textContent).toContain("Sisu keel");
    expect($$("[data-edit-lang-switch] button").map((b) => b.textContent)).toEqual(["ET", "RU"]);
    expect($$("[data-lang-switch]")).toHaveLength(0);
    expect(seg("et")!.getAttribute("aria-pressed")).toBe("true");
    expect($$("[data-lang-field]").map((f) => f.getAttribute("data-lang-field"))).toEqual(["et", "et", "et"]);
    expect(field("title").value).toBe("Kulmude lamineerimine");

    await click(seg("ru"));
    expect(seg("ru")!.getAttribute("aria-pressed")).toBe("true");
    expect(seg("et")!.getAttribute("aria-pressed")).toBe("false");
    expect($$("[data-lang-field]").map((f) => f.getAttribute("data-lang-field"))).toEqual(["ru", "ru", "ru"]);
    expect(field("short").value).toBe("Краткое описание");
    expect(field("title").getAttribute("lang")).toBe("ru");
    expect(localStorage.getItem(KEY)).toBe("ru");

    // a new page load on this device: the stored choice
    await act(async () => root.unmount());
    root = createRoot(container);
    await show();
    expect($$("[data-lang-field]").map((f) => f.getAttribute("data-lang-field"))).toEqual(["ru", "ru", "ru"]);
    expect(seg("ru")!.getAttribute("aria-pressed")).toBe("true");

    await click(seg("et"));
    expect(localStorage.getItem(KEY)).toBe("et");
    expect(field("title").value).toBe("Kulmude lamineerimine");
  });

  test("the server and the first render show ET whatever is stored; the stored choice applies once the page has taken over", async () => {
    localStorage.setItem(KEY, "ru");
    const html = renderToString(page(createElement(Form)));
    expect(html).toContain('data-lang-field="et"');
    expect(html).not.toContain('data-lang-field="ru"');
  });

  test("a browser that refuses its storage still switches (until the page is closed), and a stranger's value is ignored", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await show();
    expect(field("title").getAttribute("data-lang-field")).toBe("et");
    await click(seg("ru"));
    expect(field("title").getAttribute("data-lang-field")).toBe("ru");
    expect(seg("ru")!.getAttribute("aria-pressed")).toBe("true");
    vi.restoreAllMocks();
    await click(seg("et"));
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.setItem(KEY, "de");
    await show();
    expect(field("title").getAttribute("data-lang-field")).toBe("et");
  });

  test("the segments are buttons of 38 px in a 44 px track, ET and RU, named for a screen reader as the content language", async () => {
    await show();
    const group = $("[data-edit-lang-switch]")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Sisu keel");
    expect($$("[data-edit-lang-switch] button").every((b) => b.getAttribute("type") === "button")).toBe(true);
  });
});

describe("RU mode", () => {
  test("the ET text shows above the input with an „ET“ tag; „tõlge tulekul“ stays on an empty RU", async () => {
    await show();
    await click(seg("ru"));
    const ref = box("title").querySelector("[data-et-ref]")!;
    expect(ref.textContent).toBe("ETKulmude lamineerimine");
    expect(ref.querySelector("[data-et-tag]")!.textContent).toBe("ET");
    expect(ref.getAttribute("lang")).toBe("et");
    // above the input, and the input still shows the ET text as its placeholder (what the Russian page shows meanwhile)
    expect(ref.compareDocumentPosition(field("title")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field("title").placeholder).toBe("Kulmude lamineerimine");
    expect(field("title").value).toBe("");
    expect(box("title").querySelector("[data-ru-pending]")!.textContent).toBe("tõlge tulekul");
    // a field with its Russian text has neither the tag nor the copy link, but still its Estonian reference
    expect(box("short").querySelector("[data-ru-pending]")).toBeNull();
    expect(box("short").querySelector("[data-copy-et]")).toBeNull();
    expect(box("short").querySelector("[data-et-ref]")!.textContent).toBe("ETLühikirjeldus");
    // in ET mode there is no reference (the field is the Estonian text), and the tag still says what is missing
    await click(seg("et"));
    expect(box("title").querySelector("[data-et-ref]")).toBeNull();
    expect(box("title").querySelector("[data-ru-pending]")!.textContent).toBe("tõlge tulekul");
    expect(box("short").querySelector("[data-ru-pending]")).toBeNull();
  });

  test("the reference follows the Estonian text and is left out of an empty one", async () => {
    await show(createElement(Form, { initial: { ...START, intro: { et: "", ru: "" } } }));
    await click(seg("ru"));
    expect(box("intro").querySelector("[data-et-ref]")).toBeNull();
    expect(box("intro").querySelector("[data-ru-pending]")).toBeNull(); // nothing to translate yet
    await click(seg("et"));
    await type(field("intro"), "Uus tekst");
    await click(seg("ru"));
    expect(box("intro").querySelector("[data-et-ref]")!.textContent).toBe("ETUus tekst");
  });

  test("an empty RU field offers „Kopeeri eesti keelest“, which copies the ET text into it and leaves the cursor there", async () => {
    await show();
    await click(seg("ru"));
    const copy = box("title").querySelector<HTMLButtonElement>("[data-copy-et]")!;
    expect(copy.textContent).toBe("Kopeeri eesti keelest");
    expect(copy.getAttribute("type")).toBe("button");
    await click(copy);
    expect(field("title").value).toBe("Kulmude lamineerimine");
    expect(box("title").querySelector("[data-copy-et]")).toBeNull();
    expect(box("title").querySelector("[data-ru-pending]")).toBeNull();
    expect(document.activeElement).toBe(field("title"));
    // the Estonian text is untouched
    await click(seg("et"));
    expect(field("title").value).toBe("Kulmude lamineerimine");
  });

  test("a Russian text typed in is the field's value (the Estonian one stays as it was)", async () => {
    await show();
    await click(seg("ru"));
    await type(field("title"), "Ламинирование бровей");
    expect(field("title").value).toBe("Ламинирование бровей");
    expect(box("title").querySelector("[data-copy-et]")).toBeNull();
    await click(seg("et"));
    expect(field("title").value).toBe("Kulmude lamineerimine");
  });
});

describe("what is missing", () => {
  test("„RU puudub 2 väljal“ + „Järgmine →“ focuses the next empty RU field, in page order, and goes round", async () => {
    await show();
    // (the line is for RU mode: in ET mode the field tags say it)
    expect(missingLine()).toBeNull();
    await click(seg("ru"));
    expect(missingLine()!.textContent).toBe("RU puudub 2 väljal" + "Järgmine →");
    expect(nextButton()!.textContent).toBe("Järgmine →");
    await click(nextButton());
    expect(document.activeElement).toBe(field("title"));
    await click(nextButton());
    expect(document.activeElement).toBe(field("intro"));
    await click(nextButton());
    expect(document.activeElement).toBe(field("title"));

    // one of them written: the count goes down and the one left is where it goes
    await type(field("title"), "Ламинирование");
    expect(missingLine()!.textContent).toContain("RU puudub 1 väljal");
    await click(nextButton());
    expect(document.activeElement).toBe(field("intro"));
    await type(field("intro"), "Введение");
    expect(missingLine()).toBeNull();
  });

  test("a field that becomes empty later is found in its place on the page, not last", async () => {
    await show();
    await click(seg("ru"));
    await type(field("short"), ""); // the second field is now missing too; it registered after the third was
    expect(missingLine()!.textContent).toContain("RU puudub 3 väljal");
    const seen: Element[] = [];
    for (let i = 0; i < 3; i++) {
      await click(nextButton());
      seen.push(document.activeElement!);
    }
    expect(seen).toEqual([field("title"), field("short"), field("intro")]);
  });

  test("a field with no Estonian text yet is not counted, and one whose Estonian text is cleared stops being", async () => {
    await show(createElement(Form, { initial: { ...START, intro: { et: "", ru: "" } } }));
    await click(seg("ru"));
    expect(missingLine()!.textContent).toContain("RU puudub 1 väljal");
    await click(seg("et"));
    await type(field("title"), "");
    await click(seg("ru"));
    expect(missingLine()).toBeNull();
  });

  test("a field that leaves the page is no longer counted", async () => {
    function Toggle() {
      const [on, setOn] = useState(true);
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", "data-toggle": "", onClick: () => setOn(false) }, "x"),
        on ? createElement(Form) : null,
      );
    }
    await show(createElement(Toggle));
    await click(seg("ru"));
    expect(missingLine()!.textContent).toContain("RU puudub 2 väljal");
    await click($("[data-toggle]"));
    expect(missingLine()).toBeNull();
  });
});

describe("the rules are unchanged", () => {
  test("RU filled with ET empty → „Täida see väli (eesti keeles).“ under the field; nothing is filled in for her", async () => {
    await show(createElement(Form, { initial: { ...START, title: { et: "", ru: "Ламинирование" } } }));
    // the check the server runs
    const check = new Check();
    check.text("title", { et: "", ru: "Ламинирование" }, 200, { required: true });
    expect(check.errors).toEqual({ title: "required" });
    expect(adminEt.courseEditor.errors.required).toBe("Täida see väli (eesti keeles).");

    await click(seg("ru"));
    await click($("[data-save]"));
    // the error is under the Russian field too (it names the Estonian text), and the field is marked
    const err = box("title").querySelector("p[id$='-error']")!;
    expect(err.textContent).toBe("Täida see väli (eesti keeles).");
    expect(field("title").getAttribute("aria-invalid")).toBe("true");
    expect(field("title").getAttribute("aria-describedby")).toContain(err.id);
    expect(field("title").value).toBe("Ламинирование");
    await click(seg("et"));
    expect(field("title").value).toBe("");
    expect(box("title").querySelector("p[id$='-error']")!.textContent).toBe("Täida see väli (eesti keeles).");
  });
});

describe("lists and the FAQ follow the page", () => {
  const FAQ: FaqDraft[] = [
    { uid: "a", id: 1, q: { et: "Küsimus 1", ru: "" }, a: { et: "Vastus 1", ru: "Ответ 1" } },
    { uid: "b", id: 2, q: { et: "Küsimus 2", ru: "Вопрос 2" }, a: { et: "Vastus 2", ru: "" } },
  ];
  function Lists() {
    const [items, setItems] = useState<I18n[]>([{ et: "Esimene", ru: "" }, { et: "Teine", ru: "Второй" }]);
    const [faq, setFaq] = useState(FAQ);
    return createElement(
      "div",
      null,
      createElement(ListEditor, { title: "Õpiväljundid", itemLabel: "Õpiväljund", items, onChange: setItems, name: "outcomes" }),
      createElement(FaqEditor, { items: faq, onChange: setFaq, err: () => undefined }),
    );
  }

  test("ListEditor and FaqEditor rows have no switch of their own and take the page's language", async () => {
    await show(createElement(Lists));
    expect($$("[data-lang-switch]")).toHaveLength(0);
    expect($$("[data-lang-field]").map((f) => f.getAttribute("data-lang-field"))).toEqual(["et", "et", "et", "et", "et", "et"]);
    expect($$("[data-lang-field]").map((f) => (f as HTMLInputElement).value)).toEqual(["Esimene", "Teine", "Küsimus 1", "Vastus 1", "Küsimus 2", "Vastus 2"]);
    await click(seg("ru"));
    expect($$("[data-lang-field]").map((f) => (f as HTMLInputElement).value)).toEqual(["", "Второй", "", "Ответ 1", "Вопрос 2", ""]);
    // three of the six still lack Russian (a list row, an answer, a question)
    expect(missingLine()!.textContent).toContain("RU puudub 3 väljal");
    await click(nextButton());
    expect(document.activeElement).toBe($$("[data-lang-field]")[0]);
    await click(nextButton());
    expect(document.activeElement).toBe($$("[data-lang-field]")[2]);
    await click(nextButton());
    expect(document.activeElement).toBe($$("[data-lang-field]")[5]);
  });

  test("a list row's reference and copy link work as a field's do", async () => {
    await show(createElement(Lists));
    await click(seg("ru"));
    const row = $<HTMLElement>('[data-list-editor="outcomes"] [data-row="0"]')!;
    expect(row.querySelector("[data-et-ref]")!.textContent).toBe("ETEsimene");
    await click(row.querySelector("[data-copy-et]"));
    expect(row.querySelector<HTMLInputElement>("[data-lang-field]")!.value).toBe("Esimene");
  });
});

describe("a collapsed slide", () => {
  // The home page's slides start folded, and a slide's fields are only on the page once it is opened: the folded ones still count, and „Järgmine →“ opens one.
  const slide = (uid: string, patch: Partial<SlideDraft>): SlideDraft => ({ ...newSlideDraft(uid), ...patch });
  const SLIDES: SlideDraft[] = [
    slide("s1", { kicker: { et: "Lisa 1", ru: "Доп 1" }, title: { et: "Pealkiri 1", ru: "" }, text: { et: "Tekst 1", ru: "Текст 1" }, ctaLabel: { et: "Vaata", ru: "Смотреть" } }),
    slide("s2", { kicker: { et: "Lisa 2", ru: "Доп 2" }, title: { et: "Pealkiri 2", ru: "Заголовок 2" }, text: { et: "Tekst 2", ru: "Текст 2" }, ctaLabel: { et: "Vaata", ru: "Смотреть" } }),
    slide("s3", { kicker: { et: "Lisa 3", ru: "" }, title: { et: "Pealkiri 3", ru: "Заголовок 3" }, text: { et: "Tekst 3", ru: "" }, ctaLabel: { et: "", ru: "" } }),
  ];
  function Slides({ initial = SLIDES }: { initial?: SlideDraft[] }) {
    const [slides, setSlides] = useState(initial);
    return createElement(
      "div",
      null,
      createElement(SlidesEditor, { slides, update: (fn: (s: SlideDraft[]) => SlideDraft[]) => setSlides(fn), err: () => undefined, hasErrors: () => false, links: [] }),
      createElement(I18nInput, { label: "Lause", name: "statement", value: { et: "Lause", ru: "" }, onChange: () => {} }),
    );
  }
  const toggle = (uid: string) => $<HTMLButtonElement>(`[data-slide="${uid}"] [data-tool="toggle"]`)!;

  test("the fields of folded slides are counted: ET text and no RU, wherever they stand", async () => {
    await show(createElement(Slides));
    expect($$("[data-slide] [data-lang-field]")).toHaveLength(0); // all three are folded: none of their fields is on the page
    expect(missingLine()).toBeNull(); // (ET mode)
    await click(seg("ru"));
    // slide 1's title, slide 3's kicker and text, and the field under the slides
    expect(missingLine()!.textContent).toBe("RU puudub 4 väljal" + "Järgmine →");
  });

  test("„Järgmine →“ opens the slide and puts the cursor in its Russian field, slide by slide, in page order, and on round the page", async () => {
    await show(createElement(Slides));
    await click(seg("ru"));
    await click(nextButton());
    expect(toggle("s1").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("s2").getAttribute("aria-expanded")).toBe("false");
    let active = document.activeElement as HTMLInputElement;
    expect(active.getAttribute("data-i18n")).toBe("slides.0.title");
    expect(active.getAttribute("data-lang-field")).toBe("ru");
    expect(active.value).toBe("");
    expect(active.placeholder).toBe("Pealkiri 1");
    expect(missingLine()!.textContent).toContain("RU puudub 4 väljal"); // the opened slide's field is counted once, not twice

    await click(nextButton());
    expect(toggle("s3").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("s2").getAttribute("aria-expanded")).toBe("false"); // the slide with nothing missing stays folded
    active = document.activeElement as HTMLInputElement;
    expect(active.getAttribute("data-i18n")).toBe("slides.2.kicker");
    await click(nextButton());
    expect((document.activeElement as HTMLElement).getAttribute("data-i18n")).toBe("slides.2.text");
    await click(nextButton());
    expect((document.activeElement as HTMLElement).getAttribute("data-i18n")).toBe("statement");
    await click(nextButton());
    expect((document.activeElement as HTMLElement).getAttribute("data-i18n")).toBe("slides.0.title"); // round: slide 1 is open already
  });

  test("a field written in an opened slide is no longer counted; a slide folded again counts what it still lacks", async () => {
    await show(createElement(Slides));
    await click(seg("ru"));
    await click(nextButton());
    await type(document.activeElement, "Заголовок 1");
    expect(missingLine()!.textContent).toContain("RU puudub 3 väljal");
    await click(toggle("s3"));
    await click(toggle("s3")); // opened and folded again: its two fields are counted by the folded slide now
    expect(missingLine()!.textContent).toContain("RU puudub 3 väljal");
    await click(toggle("s1")); // folded: its title is written, so it adds nothing
    expect(missingLine()!.textContent).toContain("RU puudub 3 väljal");
    await click(seg("et"));
    expect(missingLine()).toBeNull();
  });
});

describe("the previews keep their own switch", () => {
  test("PreviewLangSwitch is the old two-pill control for a preview, labelled for it, and does not touch the page's language", async () => {
    function Preview() {
      const [lang, setLang] = useState<"et" | "ru">("et");
      return createElement(PreviewLangSwitch, { lang, onChange: setLang, label: "Eelvaade", missingRu: false });
    }
    await show(createElement("div", null, createElement(Preview), createElement(Form)));
    const group = $("[data-lang-switch]")!;
    expect(group.getAttribute("aria-label")).toBe("Keel: Eelvaade");
    await click(group.querySelector('[data-lang="ru"]'));
    expect(group.querySelector('[data-lang="ru"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(field("title").getAttribute("data-lang-field")).toBe("et");
    expect(seg("et")!.getAttribute("aria-pressed")).toBe("true");
  });
});
