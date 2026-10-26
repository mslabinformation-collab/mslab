import { describe, expect, test } from "vitest";
import { missingCase, missingLabels, sameSiteValue, siteChangeLabels, siteFieldLabel } from "@/domain/site-changes";
import { newSlideDraft, type FaqDraft, type PackageDraft, type SlideDraft, type TrainerDraft } from "@/domain/site-editor";
import type { HomePartValues, SiteEntity, TrainerPartValues } from "@/domain/site-entities";

// The site editors' field labels (admin UX pass piece 4a; piece4-texts S4-1, S4-2, S4-12, S4-17, S4-34; ruling R-i): each field's label, „Puudub: …“'s
// casing, and the row-by-row differ of a draft against live that names the PublishBar's changes (Task 2) and a publish's parts changed meanwhile
// (server/site-drafts.ts): a row by its place in the draft from 1, `(RU)` when only a text's Russian side differs, a list's rows added, removed or
// moved by the list's card title, in the cards' order.

describe("siteFieldLabel: S4-1's label of a field, by its path in the part's editor value", () => {
  test("Avaleht (S4-12): a slide's fields by its place from 1, its focal points as its picture; the FAQ's rows; the lists and the texts by their card", () => {
    const home = (part: string, path: string) => siteFieldLabel("home", part, path);
    expect(home("slides", "slides.2.imageKey")).toBe("Slaid 3 pilt");
    expect(home("slides", "slides.0.imagePos")).toBe("Slaid 1 pilt");
    expect(home("slides", "slides.0.imagePosMobile")).toBe("Slaid 1 pilt");
    expect(["kicker", "title", "text", "ctaLabel", "ctaHref", "tone", "active"].map((f) => home("slides", `slides.1.${f}`))).toEqual([
      "Slaid 2 väike pealkiri",
      "Slaid 2 pealkiri",
      "Slaid 2 alapealkiri",
      "Slaid 2 nupu tekst",
      "Slaid 2 nupp viib",
      "Slaid 2 toon",
      "Slaid 2 näidatakse avalehel",
    ]);
    expect(home("slides", "slides")).toBe("Slaidid");
    expect(home("slides", "slides.2")).toBe("Slaidid");
    expect(home("statement", "body")).toBe("MS LABi lause");
    expect(home("teaser", "body")).toBe("Koolitaja kaart");
    expect(home("faq", "faq.3.q")).toBe("KKK küsimus 4");
    expect(home("faq", "faq.5.a")).toBe("KKK vastus 6");
    expect(home("faq", "faq")).toBe("KKK");
  });

  test("Koolitaja (S4-17): the portrait with its focal point, name, role, every stat as „Numbrid“; the bio, the gallery and the stories by their names", () => {
    const trainer = (part: string, path: string) => siteFieldLabel("trainer", part, path);
    expect(["portraitKey", "portraitPos", "name", "role", "stats", "stats.1.label"].map((f) => trainer("trainer", f))).toEqual(["Portree", "Portree", "Nimi", "Amet", "Numbrid", "Numbrid"]);
    expect(trainer("bio", "body")).toBe("Tutvustus");
    expect(trainer("works", "works.4.key")).toBe("Galerii");
    expect(trainer("works", "works")).toBe("Galerii");
    expect(trainer("center_story", "title")).toBe("Koolituskeskuse lugu");
    expect(trainer("trainer_journey", "body")).toBe("Koolitaja teekond");
  });

  test("Praktika (S4-34): the package's code before each field; a point by its place from 1; the points as a whole", () => {
    expect(["name", "tagline", "models", "durationLabel", "price"].map((f) => siteFieldLabel("practice", "MAXI", f))).toEqual(["MAXI nimi", "MAXI lühitekst", "MAXI modelle", "MAXI kestus", "MAXI hind"]);
    expect(siteFieldLabel("practice", "MAXI", "items.3")).toBe("MAXI punkt 4");
    expect(siteFieldLabel("practice", "MINI", "items")).toBe("MINI punktid");
  });
});

describe("missingCase: S4-2's casing for „Puudub: …“", () => {
  test("the first letter in lower case, except a first word in capitals (KKK, MINI, MAXI, MS LAB)", () => {
    expect(["Slaid 3 pilt", "KKK vastus 6", "MAXI hind", "MINI punkt 2", "Nimi", "MS LABi lause", "Koolitaja kaart", "Portree"].map(missingCase)).toEqual([
      "slaid 3 pilt",
      "KKK vastus 6",
      "MAXI hind",
      "MINI punkt 2",
      "nimi",
      "MS LABi lause",
      "koolitaja kaart",
      "portree",
    ]);
  });
});

describe("missingLabels: „Puudub: …“'s list (S4-2), built on missingCase", () => {
  test("the labels joined with „, “, each first letter in lower case except a first word in capitals", () => {
    expect(missingLabels(["Slaid 3 pilt", "KKK vastus 2"])).toBe("slaid 3 pilt, KKK vastus 2");
    expect(missingLabels(["MAXI hind", "MINI punkt 2", "Portree", "Nimi"])).toBe("MAXI hind, MINI punkt 2, portree, nimi");
    expect(missingLabels([])).toBe("");
  });

  test("„MS LABi lause“ keeps its capitals (never „mS LABi lause“)", () => {
    expect(missingLabels(["MS LABi lause"])).toBe("MS LABi lause");
    expect(missingLabels(["Koolitaja kaart", "MS LABi lause"])).toBe("koolitaja kaart, MS LABi lause");
  });
});

describe("sameSiteValue", () => {
  test("a text with no Russian side and one with it empty are the same; any other difference is not", () => {
    expect(sameSiteValue({ name: { et: "MINI" } }, { name: { et: "MINI", ru: "" } })).toBe(true);
    expect(sameSiteValue({ faq: [{ uid: "f1", q: { et: "A" } }] }, { faq: [{ uid: "f1", q: { et: "A", ru: "" } }] })).toBe(true);
    expect(sameSiteValue({ name: { et: "MINI" } }, { name: { et: "MINI", ru: " " } })).toBe(false);
    expect(sameSiteValue({ name: { et: "MINI" } }, { name: { et: "MAXI" } })).toBe(false);
    expect(sameSiteValue({ price: "100" }, { price: "100", models: "2" })).toBe(false);
  });
});

// ---------- siteChangeLabels: the PublishBar's labels, row by row (S4-1, R-i) ----------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const labels = (entity: SiteEntity, parts: { part: string; live: unknown; draft: unknown }[]) => siteChangeLabels(entity, parts);
/** One part changed: its live value, and the draft that `change` makes of a copy of it. */
function one<V>(entity: SiteEntity, part: string, live: V, change: (draft: V) => void): string[] {
  const draft = clone(live);
  change(draft);
  return labels(entity, [{ part, live, draft }]);
}

const pkg = (code: string, items: string[]): PackageDraft => ({
  name: { et: code, ru: code },
  tagline: { et: "Lühike tekst", ru: "Коротко" },
  models: "2",
  durationLabel: { et: "1 päev", ru: "1 день" },
  price: "100",
  items: items.map((et) => ({ et, ru: `${et} (ru)` })),
});
const MINI = pkg("MINI", ["2 modelli", "Tagasiside", "Töövahendid"]);
const MAXI = pkg("MAXI", ["4 modelli", "Tagasiside", "Fotod", "Järelkonsultatsioon"]);
const practice = (mini: PackageDraft, maxi: PackageDraft) => [
  { part: "MINI", live: MINI, draft: mini },
  { part: "MAXI", live: MAXI, draft: maxi },
];

describe("siteChangeLabels: Praktika (S4-34)", () => {
  test("a price change gives „MAXI hind“; nothing changed gives none", () => {
    expect(labels("practice", practice(MINI, { ...MAXI, price: "155" }))).toEqual(["MAXI hind"]);
    expect(labels("practice", practice(clone(MINI), clone(MAXI)))).toEqual([]);
  });

  test("the 4th point changed gives „MAXI punkt 4“; only its Russian side, „MAXI punkt 4 (RU)“", () => {
    expect(one("practice", "MAXI", MAXI, (d) => (d.items[3] = { ...d.items[3], et: "Järelkonsultatsioon 30 min" }))).toEqual(["MAXI punkt 4"]);
    expect(one("practice", "MAXI", MAXI, (d) => (d.items[3] = { ...d.items[3], ru: "Консультация" }))).toEqual(["MAXI punkt 4 (RU)"]);
  });

  test("points added, removed or moved: „MAXI punktid“ (S4-1: the list as a whole)", () => {
    expect(one("practice", "MAXI", MAXI, (d) => void d.items.push({ et: "Uus" }))).toEqual(["MAXI punktid"]);
    expect(one("practice", "MAXI", MAXI, (d) => void d.items.splice(1, 1))).toEqual(["MAXI punktid"]);
    expect(one("practice", "MAXI", MAXI, (d) => void d.items.reverse())).toEqual(["MAXI punktid"]);
  });

  test("in the card's order — name, tagline, then price, models and duration, then the points — package after package; each once", () => {
    const maxi = clone(MAXI);
    maxi.items[0] = { et: "5 modelli" };
    maxi.durationLabel = { et: "2 päeva", ru: "1 день" };
    maxi.price = "210";
    maxi.models = "4";
    maxi.name = { et: "MAXI+", ru: "MAXI" };
    const mini = { ...MINI, tagline: { et: "Lühike tekst", ru: "Кратко" } };
    expect(labels("practice", practice(mini, maxi))).toEqual(["MINI lühitekst (RU)", "MAXI nimi", "MAXI hind", "MAXI modelle", "MAXI kestus", "MAXI punkt 1"]);
  });

  test("a Russian text typed and emptied again is no change", () => {
    expect(one<PackageDraft>("practice", "MINI", { ...MINI, tagline: { et: "Lühike tekst" } }, (d) => void (d.tagline = { et: "Lühike tekst", ru: "" }))).toEqual([]);
  });
});

const slide = (n: number, title: string): SlideDraft => ({ ...newSlideDraft(`s${n}`), id: n, imageKey: `/seed/slide-${n}.jpg`, title: { et: title, ru: `${title} (ru)` }, kicker: { et: "MS LAB" } });
const SLIDES = [slide(1, "Esimene"), slide(2, "Teine"), slide(3, "Kolmas")];
const faqRow = (n: number): FaqDraft => ({ uid: `f${n}`, id: n, q: { et: `Küsimus ${n}`, ru: `Вопрос ${n}` }, a: { et: `Vastus ${n}`, ru: `Ответ ${n}` } });
const FAQ = [1, 2, 3, 4, 5].map(faqRow);
const HOME: HomePartValues = { slides: { slides: SLIDES }, statement: { body: { et: "Täpsus." } }, teaser: { body: { et: "Maria." } }, faq: { faq: FAQ } };
type HomePart = keyof typeof HOME;
const home = (draft: Partial<typeof HOME>, order: HomePart[] = ["slides", "statement", "teaser", "faq"]) =>
  labels("home", order.map((part) => ({ part, live: HOME[part], draft: draft[part] ?? HOME[part] })));

describe("siteChangeLabels: Avaleht (S4-12)", () => {
  test("a changed slide 2 title gives „Slaid 2 pealkiri“; only its Russian side, „Slaid 2 pealkiri (RU)“", () => {
    const et = clone(SLIDES);
    et[1].title = { et: "Täpsusest sünnib enesekindlus.", ru: "Teine (ru)" };
    expect(home({ slides: { slides: et } })).toEqual(["Slaid 2 pealkiri"]);
    const ru = clone(SLIDES);
    ru[1].title = { et: "Teine", ru: "Точность" };
    expect(home({ slides: { slides: ru } })).toEqual(["Slaid 2 pealkiri (RU)"]);
  });

  test("a slide's picture and its focal points are one „Slaid {n} pilt“; its fields in S4-12's order", () => {
    const d = clone(SLIDES);
    d[0] = { ...d[0], active: false, tone: "dark", ctaHref: "/praktika", imagePosMobile: "30% 40%", imageKey: "img/uus.jpg", text: { et: "Alapealkiri" } };
    expect(home({ slides: { slides: d } })).toEqual(["Slaid 1 pilt", "Slaid 1 alapealkiri", "Slaid 1 nupp viib", "Slaid 1 toon", "Slaid 1 näidatakse avalehel"]);
  });

  test("slides added, removed or moved: „Slaidid“; a moved slide's own change is numbered by its place in the draft", () => {
    expect(home({ slides: { slides: [...clone(SLIDES), newSlideDraft("new-1")] } })).toEqual(["Slaidid"]);
    expect(home({ slides: { slides: clone(SLIDES).slice(1) } })).toEqual(["Slaidid"]);
    const moved = clone(SLIDES);
    moved[2].title = { et: "Kolmas, nüüd esimene", ru: "Kolmas (ru)" };
    expect(home({ slides: { slides: [moved[2], moved[0], moved[1]] } })).toEqual(["Slaidid", "Slaid 1 pealkiri"]);
  });

  test("FAQ question 4 gives „KKK küsimus 4“; an answer's Russian side, „KKK vastus 2 (RU)“; rows added or moved, „KKK“", () => {
    const q = clone(FAQ);
    q[3].q = { et: "Kas saan maksta osadena?", ru: "Вопрос 4" };
    expect(home({ faq: { faq: q } })).toEqual(["KKK küsimus 4"]);
    const a = clone(FAQ);
    a[1].a = { et: "Vastus 2", ru: "Новый ответ" };
    expect(home({ faq: { faq: a } })).toEqual(["KKK vastus 2 (RU)"]);
    expect(home({ faq: { faq: [faqRow(9), ...clone(FAQ)] } })).toEqual(["KKK"]);
    expect(home({ faq: { faq: clone(FAQ).reverse() } })).toEqual(["KKK"]);
  });

  test("the cards' order — Slaidid, MS LABi lause, Koolitaja kaart, KKK — whatever order the parts come in", () => {
    const s = clone(SLIDES);
    s[0].title = { et: "Uus", ru: "Esimene (ru)" };
    const f = clone(FAQ);
    f[0].a = { et: "Uus vastus", ru: "Ответ 1" };
    expect(
      home({ faq: { faq: f }, teaser: { body: { et: "Maria.", ru: "Мария" } }, statement: { body: { et: "Täpsus!" } }, slides: { slides: s } }, ["faq", "teaser", "statement", "slides"]),
    ).toEqual(["Slaid 1 pealkiri", "MS LABi lause", "Koolitaja kaart (RU)", "KKK vastus 1"]);
  });
});

const TRAINER: TrainerDraft = {
  portraitKey: "/seed/maria.jpg",
  portraitPos: "50% 30%",
  name: { et: "Maria", ru: "Мария" },
  role: { et: "Koolitaja", ru: "Тренер" },
  stats: [
    { uid: "t0", value: "12", label: { et: "aastat", ru: "лет" } },
    { uid: "t1", value: "900", label: { et: "õpilast", ru: "учениц" } },
  ],
};
const PAGE = { title: { et: "Lugu", ru: "История" }, body: { et: "Tekst", ru: "Текст" } };
const TRAINER_LIVE: TrainerPartValues = {
  trainer: TRAINER,
  bio: { body: { et: "Tutvustus", ru: "О себе" } },
  works: { works: [{ key: "img/a.jpg", alt: { et: "Kulm", ru: "Бровь" } }] },
  center_story: PAGE,
  trainer_journey: PAGE,
};
type TrainerPart = keyof typeof TRAINER_LIVE;
const trainer = (draft: Partial<typeof TRAINER_LIVE>) =>
  labels("trainer", (Object.keys(TRAINER_LIVE) as TrainerPart[]).map((part) => ({ part, live: TRAINER_LIVE[part], draft: draft[part] ?? TRAINER_LIVE[part] })));

describe("siteChangeLabels: Koolitaja (S4-17)", () => {
  test("the trainer portrait and focal give „Portree“, once", () => {
    expect(trainer({ trainer: { ...TRAINER, portraitKey: "img/uus.jpg", portraitPos: "40% 20%" } })).toEqual(["Portree"]);
    expect(trainer({ trainer: { ...TRAINER, portraitPos: "40% 20%" } })).toEqual(["Portree"]);
    expect(trainer({ trainer: { ...TRAINER, role: { et: "Koolitaja", ru: "Тренер" } } })).toEqual([]);
  });

  test("the cards' order: „Portree ja tutvustus“ (Portree, Nimi, Amet, Tutvustus), then Numbrid, Galerii and the stories", () => {
    const stats = clone(TRAINER.stats);
    stats[1].value = "1000";
    expect(
      trainer({
        trainer: { ...TRAINER, stats, role: { et: "Koolitaja ja meister", ru: "Тренер" } },
        bio: { body: { et: "Uus tutvustus", ru: "О себе" } },
        trainer_journey: { ...PAGE, body: { et: "Uus", ru: "Текст" } },
        works: { works: [] },
      }),
    ).toEqual(["Amet", "Tutvustus", "Numbrid", "Galerii", "Koolitaja teekond"]);
    expect(trainer({ bio: { body: { et: "Uus", ru: "О себе" } }, trainer: { ...TRAINER, name: { et: "Maria S.", ru: "Мария" } } })).toEqual(["Nimi", "Tutvustus"]);
  });

  test("„(RU)“ when every change under a label is on the Russian side; one Estonian change under it drops it", () => {
    const ruOnly = clone(TRAINER.stats);
    ruOnly[0].label = { et: "aastat", ru: "года" };
    expect(trainer({ trainer: { ...TRAINER, stats: ruOnly } })).toEqual(["Numbrid (RU)"]);
    const mixed = clone(ruOnly);
    mixed[1].value = "950";
    expect(trainer({ trainer: { ...TRAINER, stats: mixed } })).toEqual(["Numbrid"]);
    expect(trainer({ center_story: { ...PAGE, title: { et: "Lugu", ru: "Рассказ" } } })).toEqual(["Koolituskeskuse lugu (RU)"]);
    expect(trainer({ center_story: { title: { et: "Lugu", ru: "Рассказ" }, body: { et: "Uus tekst", ru: "Текст" } } })).toEqual(["Koolituskeskuse lugu"]);
    expect(trainer({ works: { works: [{ key: "img/a.jpg", alt: { et: "Kulm", ru: "Брови" } }] } })).toEqual(["Galerii (RU)"]);
  });
});
