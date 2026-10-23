import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { ScreenData } from "@/db/queries/protocols";
import { MAIL_GAP_MS } from "@/server/protocols";

// The page that hosts „Saada kõigile“ (spec §4, §8). The bulk send answers once its transactions are done, and its mails go out
// afterwards as ONE task of after(), one after another MAIL_GAP_MS apart (server/protocols.ts mailProtocols); that task runs under the host
// page's time limit (maxDuration), which the page must set itself: a task cut short loses the mails of the students it did not reach, and a
// mail cannot be sent again for its version. The action takes at most 100 protocols (actions/admin-protocols.ts), so the limit must hold 100
// mails with a request's time each; 300 s is the longest a function may run on Vercel Hobby.

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn() }));
// the screen's data and the assessment's client part are stand-ins: what the page asks for, and what it hands over, is what is checked
const seen = vi.hoisted(() => ({ screen: null as unknown, targets: [] as unknown[], views: [] as unknown[], props: [] as { course?: string; expired?: string }[] }));
vi.mock("@/db/queries/protocols", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/queries/protocols")>()),
  protocolScreen: async (_db: unknown, target: unknown) => {
    seen.targets.push(target);
    return seen.screen;
  },
}));
vi.mock("@/components/admin/AssessmentScreen", () => ({
  AssessmentScreen: (props: { view: unknown; course?: string; expired?: string }) => {
    seen.views.push(props.view);
    seen.props.push({ course: props.course, expired: props.expired });
    return null;
  },
}));
vi.mock("@/components/admin/ProtocolScreen", () => ({ ProtocolScreen: () => null }));

import * as page from "@/app/admin/(panel)/protokollid/page";

test("the protocol screen's page lets the bulk send's mail task run for the longest bulk: 300 s", () => {
  expect(page.maxDuration).toBe(300);
  const longestBulkSeconds = (100 * (MAIL_GAP_MS + 200)) / 1000; // a gap and about 200 ms for each mail's own request
  expect(page.maxDuration).toBeGreaterThan(longestBulkSeconds);
});

// ---------- ?ligipaas=: one e-course access (phase e-course completion, spec §5.3) ----------

const render = async (search: Record<string, string>) => renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(search) }));
const accessScreen = (over: Partial<NonNullable<ScreenData["assessment"]>> = {}): ScreenData => ({
  kind: "access",
  course: { id: 3, title: { et: "Kulmude e-kursus", ru: "Брови онлайн" } },
  session: null,
  students: [
    {
      registrationId: 4,
      name: "Kati Kask",
      status: "confirmed",
      state: "draft",
      protocol: { id: 9, version: 2, stages: [{ title: "Ettevalmistus", note: "" }], generalNote: "", sentVersion: null, sentAt: null, updatedAt: new Date("2026-11-10T10:00:00Z") },
    },
  ],
  hidden: 0,
  assessment: {
    accessId: 4,
    clientId: 2,
    email: "kati@example.com",
    status: "review",
    round: 2,
    submittedAt: new Date("2026-11-10T09:00:00Z"),
    verdicts: [null],
    sentVerdicts: ["fix"],
    photos: [[{ id: 21, round: 2, width: 1600, height: 1200 }]],
    locked: false,
    expiresAt: new Date("2099-05-10T10:00:00Z"),
    ...over,
  },
});
const reset = (screen: ScreenData | null) => {
  seen.screen = screen;
  seen.targets.length = 0;
  seen.views.length = 0;
  seen.props.length = 0;
};

test("?ligipaas=<id>: the way back is „← Hindamine“ above the screen, which has the header itself (the student is its H1, the course in its meta line; the round follows its reads) and is the access's", async () => {
  reset(accessScreen());
  const html = await render({ ligipaas: "4" });
  expect(seen.targets).toEqual([{ accessId: 4 }]);
  expect(backLink(html)?.slice(1)).toEqual(["/admin/hindamine", "← Hindamine"]);
  expect(html).not.toContain("<h1"); // AssessmentScreen's (tests/unit/assessment-screen-dom.test.ts)
  expect(html).not.toContain("data-assess-round");
  expect(seen.props).toEqual([{ course: "Kulmude e-kursus", expired: undefined }]);
  expect(seen.views).toEqual([expect.objectContaining({ single: true, owner: "access", source: { ligipaas: 4 } })]);
  const [view] = seen.views as { students: { registrationId: number; assessment?: { submittedAt: string; expiresAt: string } }[] }[];
  expect(view.students.map((s) => [s.registrationId, s.assessment?.submittedAt])).toEqual([[4, "2026-11-10T09:00:00.000Z"]]);
});

test("an ended access says Maria can still assess (the line is handed to the screen, which shows it under its header)", async () => {
  reset(accessScreen({ expiresAt: new Date("2026-01-01T00:00:00Z") }));
  await render({ ligipaas: "4" });
  expect(seen.props[0].expired).toContain("Ligipääs lõppes 01.01.2026. Hinnata ja saata saad ikka");
});

test("?sessioon= and ?registreering= come before ?ligipaas= (the course day's addresses keep their screens); an access that is not there: the not-found card, back to Hindamine", async () => {
  reset(null);
  await render({ sessioon: "5", ligipaas: "4" });
  await render({ registreering: "7", ligipaas: "4" });
  expect(seen.targets).toEqual([{ sessionId: 5 }, { registrationId: 7 }]);
  const html = await render({ ligipaas: "4" });
  expect(html).toContain("Sellist e-kursuse ligipääsu ei leitud, või see on tühistatud.");
  expect(backLink(html)?.slice(1)).toEqual(["/admin/hindamine", "← Hindamine"]);
  expect(seen.views).toEqual([]);
});

// ---------- the course day's screens: the way back (admin UX pass, README A3) ----------

const sessionScreen = (kind: "session" | "registration"): ScreenData => ({
  kind,
  course: { id: 3, title: { et: "Kulmumeistri baaskoolitus", ru: "Брови" } },
  session: kind === "session" ? { id: 5, startsAt: new Date("2026-10-20T07:00:00Z"), city: "Pärnu", venue: "MS LAB stuudio", cancelled: false } : null,
  students: [
    {
      registrationId: 7,
      name: "Kati Kask",
      status: "confirmed",
      state: "draft",
      protocol: { id: 9, version: 1, stages: [{ title: "Ettevalmistus", note: "Valmis" }], generalNote: "", sentVersion: null, sentAt: null, updatedAt: new Date("2026-10-20T10:00:00Z") },
    },
  ],
  hidden: 0,
  assessment: null,
});
const backLink = (html: string) => html.match(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/);

test("a session's screen and a registration's lead back to the index: „← Protokollid“; so does the not-found card of the course day's addresses", async () => {
  reset(sessionScreen("session"));
  expect(backLink(await render({ sessioon: "5" }))?.slice(1)).toEqual(["/admin/protokollid", "← Protokollid"]);
  reset(sessionScreen("registration"));
  expect(backLink(await render({ registreering: "7" }))?.slice(1)).toEqual(["/admin/protokollid", "← Protokollid"]);
  reset(null);
  const missing = await render({ sessioon: "5" });
  expect(missing).toContain("Seda toimumist või registreeringut ei leitud, või pole see kontaktkoolitus.");
  expect(backLink(missing)?.slice(1)).toEqual(["/admin/protokollid", "← Protokollid"]);
  expect(missing).not.toContain("Kalendrisse");
});
