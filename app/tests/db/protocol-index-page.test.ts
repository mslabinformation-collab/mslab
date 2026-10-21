import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseSessions, protocols } from "@/db/schema";
import { protocolCourse, student } from "./protocols-fixtures";
import { makeTestDb } from "./helpers";

// The Protokollid index as Maria sees it (B8): /admin/protokollid with none of the three parameters, rendered from a real (PGlite) database to HTML.
// The screens behind ?sessioon=, ?registreering= and ?ligipaas= are the other protocol tests'; one thing is checked here: a parameter that is
// there but is no number is still the "not found", not the index.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn() }));

import ProtocolsPage from "@/app/admin/(panel)/protokollid/page";

const render = async (search: Record<string, string> = {}) => renderToStaticMarkup(await ProtocolsPage({ searchParams: Promise.resolve(search) }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** The HTML of one row (an <li> without another inside it). */
const part = (html: string, attribute: string, value: number) => {
  const at = html.indexOf(`${attribute}="${value}"`);
  expect(at, `${attribute}=${value}`).toBeGreaterThan(-1);
  const from = html.lastIndexOf("<li ", at);
  return html.slice(from, html.indexOf("</li>", at) + 5);
};

let db: Db;

beforeAll(() => {
  // Wednesday 21.10.2026, 12:00 in Tallinn
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
});
afterAll(() => vi.useRealTimers());

test("an empty index: the note, the empty sentence and the way to Kalender", async () => {
  db = await makeTestDb();
  state.db = db;
  const html = await render();
  expect(text(html)).toContain("Koolituspäev Protokollid Täna ja viimased 14 päeva. Vanemad leiad Kalendrist.");
  expect(text(html)).toContain("Viimase 14 päeva jooksul koolituspäevi polnud.");
  expect(html).toMatch(/<a[^>]*href="\/admin\/kalender"[^>]*>← Kalender<\/a>/);
  expect(html).not.toContain("data-index-individual");
  expect(html).not.toContain("<ul");
});

test("rows: „Täna“ with its weekday and the ink „Ava“, the earlier day by its date; counts, or all sent in green; the individual section below", async () => {
  db = await makeTestDb();
  state.db = db;
  const { course, session: past } = await protocolCourse(db); // 12.10 10:00: Monday, 9 days back
  const [today] = await db.insert(courseSessions).values({ courseId: course.id, startsAt: new Date("2026-10-21T07:00:00Z"), city: "Tartu", venue: "Lõunakeskus" }).returning();
  const [mari, anu] = [await student(db, course, today, "Mari Maasikas"), await student(db, course, today, "Anu Aas")];
  await student(db, course, today, "Kati Kask");
  await db.insert(protocols).values([
    { registrationId: mari.id, stages: [], version: 1, sent: { stages: [], generalNote: "" }, sentAt: new Date("2026-10-21T08:00:00Z"), sentVersion: 1 },
    { registrationId: anu.id, stages: [], version: 1 },
  ]);
  const eve = await student(db, course, past, "Eve Esi");
  await db.insert(protocols).values({ registrationId: eve.id, stages: [], version: 1, sent: { stages: [], generalNote: "" }, sentAt: new Date("2026-10-12T12:00:00Z"), sentVersion: 1 });
  const piret = await student(db, course, null, "Piret Kalda");
  const liis = await student(db, course, null, "Liis Lepik");
  await db.insert(protocols).values({ registrationId: liis.id, stages: [], version: 1 });

  const html = await render();
  const row = (id: number) => part(html, "data-index-session", id);
  // today: Täna over "kolmapäev, 21.10", the course over "10:00 · Tartu, Lõunakeskus", the counts, and an „Ava“ to the session
  expect(text(row(today.id))).toBe("Täna kolmapäev, 21.10 Kulmude lamineerimine 10:00 · Tartu, Lõunakeskus 3 õpilast · 1 saadetud · 1 mustand Ava");
  expect(row(today.id)).toContain("data-today");
  expect(row(today.id)).toMatch(/<a class="[^"]*"[^>]*href="\/admin\/protokollid\?sessioon=\d+"/);
  expect(row(today.id)).not.toContain("secondary");
  // the earlier day: its date over its weekday, everything sent, an outline „Ava“
  expect(text(row(past.id))).toBe("12.10 esmaspäev Kulmude lamineerimine 10:00 · Pärnu, MS LAB stuudio ✓ Kõik 1 saadetud Ava");
  expect(row(past.id)).toContain('data-index-counts="done"');
  expect(row(past.id)).not.toContain("data-today");
  expect(row(past.id)).toContain("secondary");
  expect(row(past.id)).toContain(`href="/admin/protokollid?sessioon=${past.id}"`);
  // today above the earlier day
  expect(html.indexOf(`data-index-session="${today.id}"`)).toBeLessThan(html.indexOf(`data-index-session="${past.id}"`));
  // the open individual registrations, newest first, each to its own screen
  const section = html.slice(html.indexOf("data-index-individual"));
  expect(text(section)).toContain("Individuaalkoolitused");
  expect(text(part(html, "data-index-registration", piret.id))).toBe("Aeg kokkuleppel Piret Kalda Kulmude lamineerimine Alustamata Ava");
  expect(text(part(html, "data-index-registration", liis.id))).toBe("Aeg kokkuleppel Liis Lepik Kulmude lamineerimine Mustand Ava");
  expect(part(html, "data-index-registration", liis.id)).toContain(`href="/admin/protokollid?registreering=${liis.id}"`);
  expect(section.indexOf(`data-index-registration="${liis.id}"`)).toBeLessThan(section.indexOf(`data-index-registration="${piret.id}"`));
  expect(html).not.toContain("Viimase 14 päeva jooksul");
});

test("a session without students says 0, not „all sent“; an empty session list still shows the individual section", async () => {
  db = await makeTestDb();
  state.db = db;
  const { course, session } = await protocolCourse(db);
  expect(text(part(await render(), "data-index-session", session.id))).toContain("0 õpilast · 0 saadetud · 0 mustand");
  // two weeks on: the session is out, and one individual registration stays
  vi.setSystemTime(new Date("2026-11-30T09:00:00Z"));
  try {
    const piret = await student(db, course, null, "Piret Kalda");
    const html = await render();
    expect(html).not.toContain("data-index-session");
    expect(text(html)).toContain("Viimase 14 päeva jooksul koolituspäevi polnud.");
    expect(text(part(html, "data-index-registration", piret.id))).toContain("Piret Kalda");
  } finally {
    vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
  }
});

test("a parameter that is there but names nothing is the old „not found“, not the index", async () => {
  db = await makeTestDb();
  state.db = db;
  for (const search of [{ sessioon: "abc" }, { sessioon: "" }, { registreering: "999" }, { sessioon: "999" }] as Record<string, string>[]) {
    const html = await render(search);
    expect(text(html), JSON.stringify(search)).toContain("Seda toimumist või registreeringut ei leitud, või pole see kontaktkoolitus.");
    expect(html).not.toContain("data-protocol-index");
  }
});
