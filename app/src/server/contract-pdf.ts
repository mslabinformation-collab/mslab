import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import type { Contract } from "@/db/schema";
import { tallinnFormParts } from "@/domain/calendar";
import { paragraphs } from "@/domain/catalogue";
import { tallinnDateText } from "@/domain/certificate";
import type { AcceptedVia } from "@/domain/contract";
import { drawLogo } from "./pdf-logo";
import { clean, wrap } from "./pdf-text";

// The contract as a PDF (contracts, Task 2, spec §5, D3, D6): drawn on every download from the contract's frozen row and the sans (Jost, the
// same committed font as the certificate's and the invoice's: no new font), with pdf-lib and its fontkit. A4 portrait, a white page and black
// text, printable: on the first page the logo (server/pdf-logo.ts), the title, and under it „Asendatud {date}“ when a newer contract replaced
// this one; then the blocks of spec §5 in order: „Pooled“ (the school and the student), „Koolitus“ (the course, the session, the price and the
// payment choice), the text's paragraphs, and the closing line „Kinnitatud elektrooniliselt {date time}, {name} ({e-mail})“ with the way. The
// labels are in the contract's own language (D6: the one the student read); the text is Maria's, as it was frozen. Every position below is in
// PDF points from the bottom left corner.
// Pages. The text is a flow: the paragraphs wrap at the page's width and break across pages, a paragraph never leaves one line alone at the foot
// of a page or at the top of the next one, the closing line stays whole, and every page after the first carries the title small at its top;
// every page carries „{n} / {total}“ at its foot. A page after the first starts when the line to come would pass the foot.
// Fitting. As the invoice's, every text is cleaned (white space is one space, a no-break space stays; a character Jost lacks is "?", never a
// missing-glyph box) and wrapped at its box, a word wider than the box broken at the box; the fields of the head are cut with "…" past the lines
// their box allows (the head, with its caps, always fits the first page), the paragraphs and the closing line are not.
// Jost is embedded as a subset; a page is a few KB. The output is deterministic: the same row gives the same bytes (the PDF's dates are the
// acceptance's).

/** A4 portrait, in PDF points. */
export const CONTRACT_PAGE = { width: 595, height: 842 } as const;

/** What the PDF prints: the contract's frozen row. */
export type ContractContent = Pick<Contract, "title" | "body" | "fields" | "acceptedAt" | "acceptedVia" | "locale" | "supersededAt">;

/** The PDF's own words in a contract's language (D6); the title and the text are the contract's own. All Draft, for Dim's wording sheet. */
type Words = {
  /** The title of a contract whose title is empty. */
  title: string;
  superseded: string;
  parties: string;
  school: string;
  student: string;
  registryCode: string;
  course: string;
  session: string;
  price: string;
  payment: string;
  accepted: string;
  way: string;
  via: Record<AcceptedVia, string>;
};

const WORDS: Record<"et" | "ru", Words> = {
  et: {
    title: "Leping",
    superseded: "Asendatud",
    parties: "Pooled",
    school: "Koolituskeskus",
    student: "Õpilane",
    registryCode: "Registrikood",
    course: "Koolitus",
    session: "Toimumine",
    price: "Hind",
    payment: "Makse",
    accepted: "Kinnitatud elektrooniliselt",
    way: "Kinnitamise viis",
    via: { form: "registreerimisvorm", purchase: "e-koolituse ost", account: "õpilase konto", terms: "e-koolituse tingimuste kinnitamine" },
  },
  ru: {
    title: "Договор",
    superseded: "Заменён",
    parties: "Стороны",
    school: "Учебный центр",
    student: "Ученик",
    registryCode: "Регистрационный код",
    course: "Обучение",
    session: "Дата и место",
    price: "Цена",
    payment: "Оплата",
    accepted: "Подтверждено в электронном виде",
    way: "Способ подтверждения",
    via: { form: "форма регистрации", purchase: "покупка онлайн-курса", account: "личный кабинет", terms: "подтверждение условий онлайн-курса" },
  },
};

// ---------- the layout (595 × 842 pt) ----------

const BLACK = rgb(0, 0, 0);
/** The ink's edges: 48 pt in from the left and right and the first page's top; the body ends 72 pt up from the bottom, above the foot. */
const EDGE = { left: 48, right: CONTRACT_PAGE.width - 48, top: CONTRACT_PAGE.height - 48, bottom: 72 } as const;
const WIDTH = EDGE.right - EDGE.left;
/** The logo's box at the top left of the first page (drawn as designed, 3 : 1), as the invoice's. */
const LOGO = { x: EDGE.left, y: EDGE.top - 40, width: 120, height: 40 } as const;
/** Font sizes; the lines' thickness. */
const SIZE = { title: 20, superseded: 11, section: 11, name: 12, body: 10, small: 9.5, label: 8, running: 8, foot: 8 } as const;
const RULE = 0.5;
/** The distance between two baselines, in sizes: the head's lines, and the text's paragraphs (airier, to read). */
const LEADING = { head: 1.3, title: 1.2, text: 1.45 } as const;
/** The gap between two paragraphs. */
const PARAGRAPH_GAP = 7;
/** Where the first page's title starts (under the logo), and where a later page's text starts (under its running title and rule). */
const FIRST_TOP = LOGO.y - 30;
const NEXT_TOP = EDGE.top - 34;
/** The running title of a later page (its baseline) and the page number's baseline. */
const RUNNING_BASE = EDGE.top - 8;
const FOOT_BASE = 40;
/** The parties side by side, and the course block's labels and values. */
const PARTIES = { width: 235, rightX: EDGE.right - 235 } as const;
const ROWS = { value: EDGE.left + 82, valueWidth: WIDTH - 82 } as const;
/** The lines the head's fields may take before they are cut: with these the head is at most 530 pt of the first page's 650, so it always fits. */
const MAX = { title: 4, party: 3, partyShort: 2, course: 3, row: 3, statement: 6, way: 2 } as const;

type Op = { text: string; x: number; y: number; size: number } | { x1: number; x2: number; y: number; thickness: number };
/** One field of a column: its text, its size, the most lines it takes and the gap under it. */
type Row = { s: string; size: number; max: number; after?: number };

const isString = (v: unknown): v is string => typeof v === "string";
/** "17.10.2026 14:32": the Tallinn date and time of a moment. */
const dateTimeText = (d: Date): string => `${tallinnDateText(d)} ${tallinnFormParts(d).time}`;

/**
 * The pages as drawing operations: for each page the text with its left end and its baseline, and the rules. The head first (the title, the
 * parties, the course), then the paragraphs flowing from page to page, then the closing line; the running titles and the page numbers last.
 */
function compose(c: ContractContent, measure: (text: string, size: number) => number, chars: ReadonlySet<number>): Op[][] {
  const w = WORDS[c.locale === "ru" ? "ru" : "et"];
  const f = c.fields;
  const pages: Op[][] = [[]];
  let top = FIRST_TOP;

  const clear = (s: unknown) => clean(isString(s) ? s : "", chars, true);
  const wrapped = (s: unknown, size: number, width: number, max: number) => wrap(clear(s), (t) => measure(t, size) <= width, max);
  const labelled = (label: string, value: unknown) => (clear(value) ? `${label} ${isString(value) ? value : ""}` : "");
  const add = (op: Op) => pages[pages.length - 1].push(op);
  const text = (s: string, x: number, y: number, size: number) => add({ text: s, x, y, size });
  const rule = (y: number) => add({ x1: EDGE.left, x2: EDGE.right, y, thickness: RULE });
  const put = (ls: string[], x: number, at: number, size: number, leading: number) => ls.forEach((l, i) => text(l, x, at - size - i * size * leading, size));

  const title = clear(c.title) || w.title;
  /** A new page, with the title small at its top over a rule. */
  const newPage = () => {
    pages.push([]);
    text(wrapped(title, SIZE.running, WIDTH, 1)[0], EDGE.left, RUNNING_BASE, SIZE.running);
    rule(RUNNING_BASE - 10);
    top = NEXT_TOP;
  };
  /** Room for a block `height` high: else the next page (a block taller than a page stays where it is, so nothing loops). */
  const ensure = (height: number) => {
    if (top - height < EDGE.bottom && top < NEXT_TOP) newPage();
  };
  /** A column of fields laid out from its top: each line's text and size, and its baseline's distance under the top; the column's height. */
  const column = (rows: Row[], width: number) => {
    const lines: { s: string; size: number; down: number }[] = [];
    let height = 0;
    for (const r of rows) {
      const ls = wrapped(r.s, r.size, width, r.max);
      ls.forEach((s, i) => lines.push({ s, size: r.size, down: height + r.size + i * r.size * LEADING.head }));
      height += ls.length * r.size * LEADING.head + (ls.length > 0 ? (r.after ?? 0) : 0);
    }
    return { lines, height };
  };
  /** A block's heading („Pooled“, „Koolitus“). */
  const heading = (s: string) => {
    text(s, EDGE.left, top - SIZE.section, SIZE.section);
    top -= SIZE.section * LEADING.head + 8;
  };
  const headingHeight = SIZE.section * LEADING.head + 8;

  // the title, and under it when a newer contract replaced this one
  const titleLines = wrapped(title, SIZE.title, WIDTH, MAX.title);
  put(titleLines, EDGE.left, top, SIZE.title, LEADING.title);
  top -= titleLines.length * SIZE.title * LEADING.title;
  if (c.supersededAt) {
    top -= 6;
    const said = wrapped(`${w.superseded} ${tallinnDateText(c.supersededAt)}`, SIZE.superseded, WIDTH, 1);
    put(said, EDGE.left, top, SIZE.superseded, LEADING.head);
    top -= said.length * SIZE.superseded * LEADING.head;
  }
  top -= 12;
  rule(top);
  top -= 18;

  // the parties, side by side under their roles: the school (an empty name is the brand, the contract says nothing false) and the student
  heading(w.parties);
  const school = column(
    [
      { s: w.school, size: SIZE.label, max: 1, after: 3 },
      { s: clear(f?.school?.company) ? f.school.company : "MS LAB", size: SIZE.name, max: MAX.party },
      { s: labelled(w.registryCode, f?.school?.registryCode), size: SIZE.body, max: MAX.partyShort },
      { s: f?.school?.address, size: SIZE.body, max: MAX.party },
    ],
    PARTIES.width,
  );
  const student = column(
    [
      { s: w.student, size: SIZE.label, max: 1, after: 3 },
      { s: f?.student?.name, size: SIZE.name, max: MAX.party },
      { s: f?.student?.email, size: SIZE.body, max: MAX.partyShort },
    ],
    PARTIES.width,
  );
  const partiesHeight = Math.max(school.height, student.height);
  ensure(partiesHeight);
  for (const l of school.lines) text(l.s, EDGE.left, top - l.down, l.size);
  for (const l of student.lines) text(l.s, PARTIES.rightX, top - l.down, l.size);
  top -= partiesHeight + 20;

  // the course: its name, then the session, the price and the payment choice that there are
  ensure(headingHeight + SIZE.name * LEADING.head);
  heading(w.course);
  const course = wrapped(f?.course, SIZE.name, WIDTH, MAX.course);
  put(course, EDGE.left, top, SIZE.name, LEADING.head);
  top -= course.length * SIZE.name * LEADING.head + 4;
  for (const [name, value] of [[w.session, f?.session], [w.price, f?.price], [w.payment, f?.payment]] as const) {
    const ls = wrapped(value, SIZE.body, ROWS.valueWidth, MAX.row);
    if (ls.length === 0) continue;
    const height = ls.length * SIZE.body * LEADING.head;
    ensure(height);
    text(name, EDGE.left, top - SIZE.body, SIZE.body);
    put(ls, ROWS.value, top, SIZE.body, LEADING.head);
    top -= height + 2;
  }
  top -= 12;
  rule(top);
  top -= 18;

  // the text: paragraphs (split on blank lines, as the site shows them), broken across pages line by line, but never leaving a single line of a
  // paragraph alone at the foot of a page or at the top of the next
  const lineHeight = SIZE.body * LEADING.text;
  for (const p of paragraphs(c.body)) {
    const ls = wrapped(p, SIZE.body, WIDTH, Number.POSITIVE_INFINITY);
    for (let i = 0; i < ls.length; ) {
      const left = ls.length - i;
      let take = Math.min(left, Math.floor((top - EDGE.bottom) / lineHeight + 1e-9));
      if (take < left && left - take < 2) take = left - 2;
      if (take < Math.min(2, left) && top < NEXT_TOP) {
        newPage();
        continue;
      }
      take = Math.max(take, 1);
      put(ls.slice(i, i + take), EDGE.left, top, SIZE.body, LEADING.text);
      top -= take * lineHeight;
      i += take;
      if (i < ls.length) newPage();
    }
    if (ls.length > 0) top -= PARAGRAPH_GAP;
  }

  // the closing line, whole, under a rule: when and by whom it was accepted, and the way
  const who = [clear(f?.student?.name) ? `, ${clear(f.student.name)}` : "", clear(f?.student?.email) ? ` (${clear(f.student.email)})` : ""].join("");
  const statement = wrapped(`${w.accepted} ${dateTimeText(c.acceptedAt)}${who}`, SIZE.body, WIDTH, MAX.statement);
  const via = w.via[c.acceptedVia] ?? "";
  const way = via ? wrapped(`${w.way}: ${via}`, SIZE.small, WIDTH, MAX.way) : [];
  const statementHeight = statement.length * SIZE.body * LEADING.head;
  const wayHeight = way.length * SIZE.small * LEADING.head;
  ensure(8 + 14 + statementHeight + (way.length > 0 ? 4 : 0) + wayHeight);
  top -= 8;
  rule(top);
  top -= 14;
  put(statement, EDGE.left, top, SIZE.body, LEADING.head);
  top -= statementHeight + 4;
  put(way, EDGE.left, top, SIZE.small, LEADING.head);

  // the foot of every page: „{n} / {total}“, centred
  pages.forEach((ops, i) => {
    const s = `${i + 1} / ${pages.length}`;
    ops.push({ text: s, x: (CONTRACT_PAGE.width - measure(s, SIZE.foot)) / 2, y: FOOT_BASE, size: SIZE.foot });
  });
  return pages;
}

/** A4 portrait (595 × 842), as many pages as the text takes, white with black text, laid out as spec §5 (the constants above). */
export async function renderContract(c: ContractContent, assets: { sans: Uint8Array }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // neutral metadata; the dates are the acceptance's, so the same row gives the same file
  doc.setTitle(c.title.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim() || WORDS[c.locale === "ru" ? "ru" : "et"].title);
  doc.setAuthor("MS LAB");
  doc.setCreator("MS LAB");
  doc.setProducer("MS LAB");
  doc.setCreationDate(c.acceptedAt);
  doc.setModificationDate(c.acceptedAt);
  const sans = await doc.embedFont(assets.sans, { subset: true });
  const chars = new Set(sans.getCharacterSet());
  const measure = (t: string, size: number) => sans.widthOfTextAtSize(t, size);

  compose(c, measure, chars).forEach((ops, i) => {
    const page = doc.addPage([CONTRACT_PAGE.width, CONTRACT_PAGE.height]);
    if (i === 0) drawLogo(page, sans, LOGO, BLACK);
    for (const op of ops) {
      if ("text" in op) page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: sans, color: BLACK });
      else page.drawLine({ start: { x: op.x1, y: op.y }, end: { x: op.x2, y: op.y }, thickness: op.thickness, color: BLACK });
    }
  });
  return doc.save();
}
