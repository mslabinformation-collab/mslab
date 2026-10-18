import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFName } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";
import type { AcceptedVia, ContractFields } from "@/domain/contract";
import { CERT_FONT_DIR, CERT_FONTS } from "@/server/certificate-pdf";
import { CONTRACT_PAGE, renderContract, type ContractContent } from "@/server/contract-pdf";
import { family, rawStream, readPdf, type Run } from "../pdf-read";

// The contract's PDF (contracts, Task 2, spec §5, D3, D6): rendered from fixtures and read back the way a PDF reader reads it
// (tests/pdf-read.ts: the text of every run with its font, size and place, in PDF points from the bottom left of the 595 × 842 page, page by
// page). The layout is the builder's (spec §9); what is held here is what the PDF must say and in which order, that it says it in black Jost
// on A4 pages, that a long text runs over onto more pages without losing a word, that nothing leaves the page or runs into anything else,
// and that the same row gives the same file.

// Several tests render dozens of multi-page PDFs and read each back page by page: a second or two alone, more when the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000 });

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.sans)));
const jost = fontkit.create(SANS);
const ASSETS = { sans: SANS };
const NBSP = "\xa0";
/** The page's printable margin: the least that any ink keeps from every edge. */
const MARGIN = 36;

const FIELDS: ContractFields = {
  school: { company: "Näidis Akadeemia OÜ", registryCode: "12345678", address: "Pärnu mnt 12, 10148 Tallinn" },
  student: { name: "Kertu Õunapuu", email: "kertu@example.test" },
  course: "Kulmude kujundamise koolitus",
  session: "14.11.2026, Tallinn",
  price: `350,00${NBSP}€`,
  payment: "50% registreerimisel + 50% koolituspäeval",
};
/** 14:32 in Tallinn (summer time until 25.10.2026). */
const ACCEPTED = new Date("2026-10-17T11:32:00Z");
const CLOSING = "Kinnitatud elektrooniliselt 17.10.2026 14:32, Kertu Õunapuu (kertu@example.test)";

/** A paragraph that begins with its own marker ("P07 …") and then words no other has, so it is told apart wherever it falls. */
const para = (n: number, words: number) => `P${String(n).padStart(2, "0")} ${Array.from({ length: words }, (_, i) => `sõna${n}_${i}`).join(" ")}`;
/** 30 paragraphs of 1 to 4 lines each, as Maria's long contract text would be. */
const PARAS = Array.from({ length: 30 }, (_, i) => para(i + 1, 20 + (i % 5) * 10));

const CONTACT: ContractContent = {
  title: "Kontaktkoolituse leping",
  body: PARAS.join("\n\n"),
  fields: FIELDS,
  acceptedAt: ACCEPTED,
  acceptedVia: "form",
  locale: "et",
  supersededAt: null,
};
/** The same in Russian, with Russian typography (no-break spaces). */
const RU: ContractContent = {
  title: "Договор об обучении",
  body: `Первый абзац договора.\n\nВторой абзац: ${`350${NBSP}€`} в${NBSP}день обучения.`,
  fields: {
    school: { company: "Näidis Akadeemia OÜ", registryCode: "12345678", address: "Pärnu mnt 12, 10148 Tallinn" },
    student: { name: "Ирина Петрова", email: "irina@example.test" },
    course: "Курс оформления бровей",
    session: "14.11.2026, Таллин",
    price: `350,00${NBSP}€`,
    payment: "50% при регистрации + 50% в день обучения",
  },
  acceptedAt: ACCEPTED,
  acceptedVia: "account",
  locale: "ru",
  supersededAt: null,
};
/** A short contract: one page. */
const SHORT: ContractContent = { ...CONTACT, body: "Esimene lõik.\n\nTeine lõik." };

type Page = Awaited<ReturnType<typeof readPdf>>;

/** The PDF read back page by page. */
async function read(c: ContractContent) {
  const bytes = await renderContract(c, ASSETS);
  const first = await readPdf(bytes, 0);
  const rest = await Promise.all(first.pages.slice(1).map((_, i) => readPdf(bytes, i + 1)));
  return { bytes, doc: first.doc, pages: [first, ...rest] as Page[] };
}

/** A run's width as pdf-lib measured it when it laid the page out: the glyphs' advances (no kerning) plus the spacing between them. */
function widthOf(run: Run): number {
  const glyphs = jost.layout(run.text).glyphs;
  return (glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / jost.unitsPerEm) * run.size + run.spacing * run.size * Math.max(0, glyphs.length - 1);
}
/** The box a run's ink lies in: from a little under its baseline to the top of its accents (Õ), across its width. */
const boxOf = (r: Run) => ({ left: r.x, right: r.x + widthOf(r), bottom: r.y - 0.25 * r.size, top: r.y + 0.9 * r.size });

/** The runs that are neither a running title nor a page number: the first page's head and the text, in the order they were drawn (reading order). */
const body = (page: Page) => page.runs.filter((r) => r.y > 60 && r.y < 770);
const find = (runs: Run[], text: string): Run => {
  const found = runs.filter((r) => r.text === text);
  expect(found.map((r) => r.text), text).toEqual([text]);
  return found[0];
};
const textOf = (runs: Run[]) => runs.map((r) => r.text).join("\n");
const pageText = (page: Page) => textOf(page.runs);

/** Every page's runs lie inside the margins, and no two runs of a page touch: the offenders, to be none. */
function misfits(pages: Page[]): string[] {
  const bad: string[] = [];
  pages.forEach((p, n) => {
    const boxes = p.runs.map((r) => ({ r, b: boxOf(r) }));
    for (const { r, b } of boxes) {
      if (b.left < MARGIN - 0.01 || b.right > CONTRACT_PAGE.width - MARGIN + 0.01 || b.bottom < MARGIN - 0.01 || b.top > CONTRACT_PAGE.height - MARGIN + 0.01)
        bad.push(`page ${n + 1}: "${r.text.slice(0, 30)}" leaves the margins`);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i].b, boxes[j].b];
        const apart = a.right <= b.left + 0.01 || b.right <= a.left + 0.01 || a.top <= b.bottom + 0.01 || b.top <= a.bottom + 0.01;
        if (!apart) bad.push(`page ${n + 1}: "${boxes[i].r.text.slice(0, 30)}" and "${boxes[j].r.text.slice(0, 30)}" overlap`);
      }
  });
  return bad;
}

describe("renderContract: the pages", () => {
  test("A4 portrait pages (595 × 842), white with black text, only Jost (one subset for all of them), no image, neutral metadata dated by the acceptance, under 100 KB", async () => {
    const { bytes, doc, pages } = await read(CONTACT);
    expect(bytes.length).toBeLessThan(100 * 1024);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(CONTRACT_PAGE).toEqual({ width: 595, height: 842 });
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) {
      expect(p.page.getSize()).toEqual({ width: 595, height: 842 });
      expect(p.fontNames.map(family)).toEqual([family(jost.postscriptName)]);
      // black on white: the page is not painted, nothing is drawn in white or in a colour but black (the text, the logo's lines, the rules)
      expect(p.ops).not.toMatch(/ re\n/);
      const colours = [...p.ops.matchAll(/^([-\d. ]+) (rg|RG)$/gm)].map((m) => m[1]);
      expect(new Set(colours).size, "one colour").toBe(1);
      expect(colours[0]).toBe("0 0 0");
      const xobjects = p.page.node.Resources()!.lookup(PDFName.of("XObject"));
      expect(xobjects instanceof PDFDict ? xobjects.keys() : []).toEqual([]);
    }
    // the font is one subset, much smaller than the font
    const fontDicts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0" ? [o] : []));
    expect(fontDicts).toHaveLength(1);
    const cid = doc.context.lookup(fontDicts[0].lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
    const file = cid.lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"));
    expect(decodePDFRawStream(rawStream(file)).decode().length).toBeLessThan(SANS.length / 2);
    expect([doc.getTitle(), doc.getAuthor(), doc.getProducer(), doc.getCreator()]).toEqual(["Kontaktkoolituse leping", "MS LAB", "MS LAB", "MS LAB"]);
    expect(doc.getCreationDate()).toEqual(ACCEPTED);
    expect(doc.getModificationDate()).toEqual(ACCEPTED);
  });

  test("the logo is on the first page only; the later pages carry the title small at the top instead", async () => {
    const { pages } = await read(CONTACT);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0].runs.map((r) => r.text)).toEqual(expect.arrayContaining(["MS LAB", "KOOLITUSKESKUS"]));
    for (const p of pages.slice(1)) {
      expect(p.runs.map((r) => r.text)).not.toContain("KOOLITUSKESKUS");
      const running = p.runs.filter((r) => r.text === "Kontaktkoolituse leping");
      expect(running).toHaveLength(1);
      expect(running[0].size).toBeLessThan(10);
      expect(running[0].y).toBeGreaterThan(770);
    }
    expect(pages[0].runs.find((r) => r.text === "Kontaktkoolituse leping")!.size).toBe(20); // the first page has the title itself
  });

  test("every page ends in „{n} / {total}“, centred", async () => {
    for (const c of [SHORT, CONTACT]) {
      const { pages } = await read(c);
      pages.forEach((p, i) => {
        const foot = p.runs.filter((r) => /^\d+ \/ \d+$/.test(r.text));
        expect(foot.map((r) => r.text)).toEqual([`${i + 1} / ${pages.length}`]);
        expect(boxOf(foot[0]).left + widthOf(foot[0]) / 2).toBeCloseTo(CONTRACT_PAGE.width / 2, 0);
        expect(foot[0].y).toBeLessThan(60);
      });
    }
    expect((await read(SHORT)).pages).toHaveLength(1);
    expect(pageText((await read(SHORT)).pages[0])).toContain("1 / 1");
  });
});

describe("renderContract: the text", () => {
  test("30 paragraphs read back every one, whole and in order, over two or more pages", async () => {
    const { pages } = await read(CONTACT);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    // the lines of the text in the order they were drawn (the foot and the running titles left out), joined as they were broken
    const all = pages.flatMap((p) => body(p).map((r) => r.text)).join(" ");
    let at = 0;
    for (const p of PARAS) {
      const found = all.indexOf(p, at);
      expect(found, p.slice(0, 12)).toBeGreaterThanOrEqual(at);
      at = found + p.length;
    }
    // ...and each is on pages in order: the first paragraph on the first page, the last on the last
    expect(pageText(pages[0])).toContain("P01 ");
    expect(pageText(pages[pages.length - 1])).toContain("P30 ");
  });

  test("a paragraph that runs over a page keeps at least two lines on each side, whatever the lengths (no orphan, no widow)", async () => {
    let broken = 0;
    for (let shape = 1; shape <= 10; shape++) {
      const paras = Array.from({ length: 40 }, (_, i) => para(i + 1, 4 + ((i * shape + shape) % 9) * 14));
      const { pages } = await read({ ...CONTACT, body: paras.join("\n\n") });
      // the pages each paragraph's lines are on: its lines run from the one that opens with its marker to the one before the next marker
      const lineOn = new Map<string, number[]>();
      let current = "";
      pages.forEach((p, n) => {
        for (const r of body(p)) {
          const marker = /^P(\d\d) /.exec(r.text);
          if (marker) current = marker[1];
          else if (r.text.startsWith("Kinnita")) current = ""; // the closing line is not the last paragraph's
          if (current) lineOn.set(current, [...(lineOn.get(current) ?? []), n]);
        }
      });
      for (const [marker, ns] of lineOn) {
        if (new Set(ns).size < 2) continue;
        broken++;
        const [first, last] = [Math.min(...ns), Math.max(...ns)];
        expect(last - first, `P${marker} runs over two pages, no more`).toBe(1);
        expect(ns.filter((n) => n === first).length, `P${marker}: lines at the foot of page ${first + 1}`).toBeGreaterThanOrEqual(2);
        expect(ns.filter((n) => n === last).length, `P${marker}: lines at the top of page ${last + 1}`).toBeGreaterThanOrEqual(2);
      }
    }
    expect(broken, "the shapes do make paragraphs run over pages").toBeGreaterThan(3);
  });

  test("the paragraphs are split on blank lines as the site shows them; a single line break is a space; Windows line ends and blank-looking lines too", async () => {
    const { pages } = await read({ ...SHORT, body: "Esimene\nlõik.\r\n\r\nTeine lõik.\n  \nKolmas lõik.\n\n\n\n\nNeljas." });
    const lines = body(pages[0]).map((r) => r.text);
    for (const p of ["Esimene lõik.", "Teine lõik.", "Kolmas lõik.", "Neljas."]) expect(lines, p).toContain(p);
    // each paragraph starts on its own line, with a gap between: 4 lines, the gaps wider than the leading
    const ys = ["Esimene lõik.", "Teine lõik.", "Kolmas lõik.", "Neljas."].map((t) => find(body(pages[0]), t).y);
    for (let i = 1; i < ys.length; i++) expect(ys[i - 1] - ys[i]).toBeGreaterThan(10 * 1.45 + 3);
  });

  test("a text with no paragraphs still gives the contract: the head and the closing line, one page", async () => {
    for (const empty of ["", "  \n\n \n"]) {
      const { pages } = await read({ ...CONTACT, body: empty });
      expect(pages).toHaveLength(1);
      expect(pageText(pages[0])).toContain(CLOSING);
      expect(pageText(pages[0])).toContain("Pooled");
    }
  });

  test("a character Jost lacks is a \"?\", a no-break space stays one; control characters are gone", async () => {
    const { pages } = await read({ ...SHORT, body: `Hind 350${NBSP}€, tore \u{1F600} sõna, 日本, null\u0000byte, ZW\u{200b}SP.` });
    const lines = body(pages[0]).map((r) => r.text);
    expect(lines).toContain(`Hind 350${NBSP}€, tore ? sõna, ??, nullbyte, ZWSP.`);
  });

  test("a word wider than the page is broken at the page's edge, nothing lost, nothing outside", async () => {
    const word = "A".repeat(400);
    const { pages } = await read({ ...SHORT, body: `enne ${word} pärast` });
    const lines = body(pages[0]).map((r) => r.text);
    expect(lines.join("").replace(/ /g, "")).toContain(`enne${word}pärast`.replace(/ /g, ""));
    expect(misfits(pages)).toEqual([]);
  });
});

describe("renderContract: the blocks", () => {
  test("the title, then „Pooled“ (the school and the student), „Koolitus“ (the course, the session, the price and the payment choice), the text, and the closing line", async () => {
    const { pages } = await read(SHORT);
    const runs = pages[0].runs;
    const text = textOf(runs);
    for (const t of [
      "Kontaktkoolituse leping",
      "Pooled",
      "Koolituskeskus",
      "Näidis Akadeemia OÜ",
      "Registrikood 12345678",
      "Pärnu mnt 12, 10148 Tallinn",
      "Õpilane",
      "Kertu Õunapuu",
      "kertu@example.test",
      "Koolitus",
      "Kulmude kujundamise koolitus",
      "Toimumine",
      "14.11.2026, Tallinn",
      "Hind",
      `350,00${NBSP}€`,
      "Makse",
      "50% registreerimisel + 50% koolituspäeval",
      "Esimene lõik.",
      "Teine lõik.",
      CLOSING,
      "Kinnitamise viis: registreerimisvorm",
    ])
      expect(text, t).toContain(t);
    // from the top down
    const ys = ["Kontaktkoolituse leping", "Pooled", "Näidis Akadeemia OÜ", "Koolitus", "Kulmude kujundamise koolitus", "Toimumine", "Esimene lõik.", "Teine lõik.", CLOSING, "Kinnitamise viis: registreerimisvorm"].map(
      (t) => find(runs, t).y,
    );
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expect(new Set(ys).size).toBe(ys.length);
    // the school at the left and the student at the right, side by side
    expect(find(runs, "Näidis Akadeemia OÜ").x).toBeLessThan(find(runs, "Kertu Õunapuu").x);
    expect(find(runs, "Näidis Akadeemia OÜ").y).toBe(find(runs, "Kertu Õunapuu").y);
  });

  test("the closing line is the acceptance's Tallinn date and time, the name and the e-mail, and the way, whichever of the four", async () => {
    const ways: [AcceptedVia, string][] = [
      ["form", "registreerimisvorm"],
      ["purchase", "e-koolituse ost"],
      ["account", "õpilase konto"],
      ["terms", "e-koolituse tingimuste kinnitamine"],
    ];
    for (const [acceptedVia, way] of ways) {
      const { pages } = await read({ ...SHORT, acceptedVia });
      const text = pageText(pages[0]);
      expect(text, acceptedVia).toContain(CLOSING);
      expect(text, acceptedVia).toContain(`Kinnitamise viis: ${way}`);
    }
    // the date is Tallinn's, not UTC's: 31.12 22:30 UTC is already 01.01 in Tallinn
    const { pages } = await read({ ...SHORT, acceptedAt: new Date("2026-12-31T22:30:00Z") });
    expect(pageText(pages[0])).toContain("Kinnitatud elektrooniliselt 01.01.2027 00:30, Kertu Õunapuu");
  });

  test("the closing line stays whole and after the last paragraph on the last page; when it does not fit under the text it moves to a page of its own, with its way", async () => {
    let alone = 0;
    for (let n = 44; n <= 54; n++) {
      const { pages } = await read({ ...CONTACT, body: Array.from({ length: n }, (_, i) => para(i + 1, 3)).join("\n\n") });
      const at = pages.findIndex((p) => pageText(p).includes(CLOSING));
      expect(at, `n=${n}`).toBe(pages.length - 1);
      const runs = pages[at].runs;
      expect(find(runs, "Kinnitamise viis: registreerimisvorm").y, `n=${n}`).toBeLessThan(find(runs, CLOSING).y);
      if (!pageText(pages[at]).includes(`P${String(n).padStart(2, "0")} `)) alone++;
    }
    expect(alone, "some length leaves no room for the closing line under the last paragraph").toBeGreaterThanOrEqual(1);
  });

  test("an e-course contract has no session, no payment choice, and a free grant no price: their labels are not printed", async () => {
    const { pages } = await read({ ...SHORT, fields: { ...FIELDS, session: "", payment: "", price: "" }, acceptedVia: "terms" });
    const lines = pages[0].runs.map((r) => r.text);
    for (const label of ["Toimumine", "Makse", "Hind"]) expect(lines, label).not.toContain(label);
    expect(lines).toContain("Kulmude kujundamise koolitus");
    expect(lines).toContain("Koolitus");
    const priced = await read({ ...SHORT, fields: { ...FIELDS, session: "", payment: "" }, acceptedVia: "purchase" });
    expect(priced.pages[0].runs.map((r) => r.text)).toEqual(expect.arrayContaining(["Hind", `350,00${NBSP}€`]));
  });

  test("a school with no registry code or address prints neither label nor line; a school with no name is MS LAB; the PDF says nothing it was not given", async () => {
    const { pages } = await read({ ...SHORT, fields: { ...FIELDS, school: { company: "", registryCode: "", address: "" } } });
    const lines = pages[0].runs.map((r) => r.text);
    expect(lines).toContain("MS LAB");
    expect(lines.some((t) => t.startsWith("Registrikood"))).toBe(false);
    expect(lines).not.toContain("Pärnu mnt 12, 10148 Tallinn");
  });

  test("a contract with a blank title is the language's „Leping“ / «Договор»", async () => {
    for (const [c, title] of [[SHORT, "Leping"], [{ ...RU, title: " \n " }, "Договор"]] as const) {
      const { doc, pages } = await read({ ...c, title: " \n " });
      expect(pages[0].runs.map((r) => r.text)).toContain(title);
      expect(doc.getTitle()).toBe(title);
    }
  });
});

describe("renderContract: the language (D6)", () => {
  test("a Russian contract has the Russian labels, the Russian closing line and way, and none of the Estonian ones", async () => {
    const { pages } = await read(RU);
    expect(pages).toHaveLength(1);
    const text = pageText(pages[0]);
    for (const t of [
      "Договор об обучении",
      "Стороны",
      "Учебный центр",
      "Ученик",
      "Ирина Петрова",
      "Регистрационный код 12345678",
      "Обучение",
      "Курс оформления бровей",
      "Дата и место",
      "14.11.2026, Таллин",
      "Цена",
      "Оплата",
      "50% при регистрации + 50% в день обучения",
      "Первый абзац договора.",
      "Подтверждено в электронном виде 17.10.2026 14:32, Ирина Петрова (irina@example.test)",
      "Способ подтверждения: личный кабинет",
    ])
      expect(text, t).toContain(t);
    for (const et of ["Pooled", "Koolitus", "Koolituskeskus", "Õpilane", "Registrikood", "Toimumine", "Kinnitatud", "Kinnitamise viis", "Asendatud"]) expect(text, et).not.toContain(et);
    expect(pageText(pages[0])).not.toContain("?"); // Jost has Cyrillic: nothing is replaced
  });

  test("the Russian typography is kept: a no-break space stays one, so \"350 €\" is never split from its sign", async () => {
    const { pages } = await read(RU);
    const lines = pages[0].runs.map((r) => r.text);
    expect(lines).toContain(`Второй абзац: 350${NBSP}€ в${NBSP}день обучения.`);
    expect(lines).toContain(`350,00${NBSP}€`);
  });

  test("a Russian contract broken over pages is whole and in order", async () => {
    const paras = Array.from({ length: 24 }, (_, i) => `П${String(i + 1).padStart(2, "0")} ` + Array.from({ length: 30 + (i % 4) * 10 }, (_, k) => `слово${i}_${k}`).join(" "));
    const { pages } = await read({ ...RU, body: paras.join("\n\n") });
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const all = pages.flatMap((p) => body(p).map((r) => r.text)).join(" ");
    let at = 0;
    for (const p of paras) {
      const found = all.indexOf(p, at);
      expect(found, p.slice(0, 8)).toBeGreaterThanOrEqual(at);
      at = found + p.length;
    }
    expect(pageText(pages[pages.length - 1])).toContain("Подтверждено в электронном виде 17.10.2026 14:32");
    expect(misfits(pages)).toEqual([]);
  });
});

describe("renderContract: a superseded contract", () => {
  test("it says „Asendatud {date}“ right under the title, with the Tallinn date; a current one says nothing of the kind", async () => {
    const { pages } = await read({ ...SHORT, supersededAt: new Date("2026-12-31T22:30:00Z") });
    const runs = pages[0].runs;
    const said = find(runs, "Asendatud 01.01.2027");
    expect(said.y).toBeLessThan(find(runs, "Kontaktkoolituse leping").y);
    expect(said.y).toBeGreaterThan(find(runs, "Pooled").y);
    expect(pageText(pages[0])).toContain(CLOSING); // the rest is as it was accepted

    const current = await read(SHORT);
    expect(pageText(current.pages[0])).not.toContain("Asendatud");
  });

  test("a Russian one says «Заменён {date}»; only the superseded mark differs from the current contract's text", async () => {
    const { pages } = await read({ ...RU, supersededAt: new Date("2026-11-02T10:00:00Z") });
    expect(pageText(pages[0])).toContain("Заменён 02.11.2026");
    const current = (await read(RU)).pages[0].runs.map((r) => r.text);
    const superseded = pages[0].runs.map((r) => r.text).filter((t) => t !== "Заменён 02.11.2026");
    expect(superseded).toEqual(current);
  });
});

describe("renderContract: the same file", () => {
  test("the same contract gives the same file on every download, the long one and the short one, Estonian and Russian", async () => {
    for (const c of [CONTACT, SHORT, RU, { ...CONTACT, supersededAt: new Date("2026-11-02T10:00:00Z") }])
      expect(Buffer.from(await renderContract(c, ASSETS)).equals(Buffer.from(await renderContract(c, ASSETS)))).toBe(true);
  });

  test("the file is dated by the acceptance and by nothing else: another instant gives another file", async () => {
    const a = await renderContract({ ...SHORT, acceptedAt: new Date("2026-10-17T11:32:00Z") }, ASSETS);
    const b = await renderContract({ ...SHORT, acceptedAt: new Date("2026-10-17T11:32:01Z") }, ASSETS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(await renderContract({ ...SHORT, acceptedAt: new Date("2026-10-17T11:32:00Z") }, ASSETS)))).toBe(true);
  });
});

describe("renderContract: everything fits", () => {
  test("the ordinary contract: nothing outside the margins, nothing running into anything else, on any page", async () => {
    for (const c of [SHORT, CONTACT, RU, { ...CONTACT, supersededAt: new Date("2026-11-02T10:00:00Z") }]) expect(misfits((await read(c)).pages)).toEqual([]);
  });

  test("whatever the texts: very long titles, names, addresses and fields, an unbroken word, 150 paragraphs, many controls", async () => {
    const long = "Pikk sõna ".repeat(200);
    const stress: ContractContent = {
      title: long,
      body: [...Array.from({ length: 150 }, (_, i) => para(i + 1, 5 + ((i * 7) % 60))), "Z".repeat(2000), long].join("\n\n"),
      fields: {
        school: { company: long, registryCode: long, address: long },
        student: { name: long, email: "e".repeat(300) + "@example.test" },
        course: long,
        session: long,
        price: long,
        payment: long,
      },
      acceptedAt: ACCEPTED,
      acceptedVia: "terms",
      locale: "et",
      supersededAt: ACCEPTED,
    };
    const { pages } = await read(stress);
    expect(pages.length).toBeGreaterThan(5);
    expect(misfits(pages)).toEqual([]);
    // the closing line is the last thing, on the last page, however long the name: only the 6 lines the box allows, the e-mail broken at the edge
    expect(pageText(pages[pages.length - 1])).toContain("Kinnitatud elektrooniliselt 17.10.2026 14:32");
    // the head never takes more than the first page
    expect(pageText(pages[0])).toContain("Pooled");
    expect(pageText(pages[0])).toContain("Koolitus");
  });

  test("a contract with a head at its longest still has its first paragraph on the first page or the next, never lost", async () => {
    const long = "Pikk sõna ".repeat(200);
    const { pages } = await read({ ...CONTACT, title: long, fields: { ...FIELDS, school: { company: long, registryCode: long, address: long }, course: long, session: long, price: long, payment: long } });
    const all = pages.flatMap((p) => body(p).map((r) => r.text)).join(" ");
    for (const p of PARAS) expect(all, p.slice(0, 5)).toContain(p);
  });
});
