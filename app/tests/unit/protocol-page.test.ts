import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { ScreenData } from "@/db/queries/protocols";
import { MAIL_GAP_MS } from "@/server/protocols";

// The page that hosts "Lukusta ja saada kõik" (spec §4, §8). The bulk send answers once its transactions are done, and its mails go out
// afterwards as ONE task of after(), one after another MAIL_GAP_MS apart (server/protocols.ts mailProtocols); that task runs under the host
// page's time limit (maxDuration), which the page must set itself: a task cut short loses the mails of the students it did not reach, and a
// mail cannot be sent again for its version. The action takes at most 100 protocols (actions/admin-protocols.ts), so the limit must hold 100
// mails with a request's time each; 300 s is the longest a function may run on Vercel Hobby.

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth", () => ({ requireAdmin: async () => "maria@example.test" }));
vi.mock("@/components/admin/Shell", async () => {
  const { createElement } = await import("react");
  return { Shell: ({ active, children }: { active: string; children: React.ReactNode }) => createElement("div", { "data-shell-active": active }, children) };
});
vi.mock("@/server/actions/admin-protocols", () => ({ sendProtocolAction: vi.fn(), sendProtocolsAction: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn() }));
// the screen's data and the assessment's client part are stand-ins: what the page asks for, and what it hands over, is what is checked
const seen = vi.hoisted(() => ({ screen: null as unknown, targets: [] as unknown[], views: [] as unknown[] }));
vi.mock("@/db/queries/protocols", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/queries/protocols")>()),
  protocolScreen: async (_db: unknown, target: unknown) => {
    seen.targets.push(target);
    return seen.screen;
  },
}));
vi.mock("@/components/admin/AssessmentScreen", () => ({
  AssessmentScreen: ({ view }: { view: unknown }) => {
    seen.views.push(view);
    return null;
  },
}));

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
};

test("?ligipaas=<id>: the header names the course and the student and the round, the way back is Hindamine, the menu marks Hindamine, and the screen is the access's", async () => {
  reset(accessScreen());
  const html = await render({ ligipaas: "4" });
  expect(seen.targets).toEqual([{ accessId: 4 }]);
  expect(html).toContain('data-shell-active="assessment"');
  expect(html).toMatch(/data-protocol-course="">Kulmude e-kursus · Kati Kask</);
  expect(html).toMatch(/data-assess-round="">Praktiline töö, 2\. kord</);
  expect(html).toContain('href="/admin/hindamine"');
  expect(html).not.toContain("data-access-expired");
  expect(seen.views).toEqual([expect.objectContaining({ single: true, owner: "access", source: { ligipaas: 4 } })]);
  const [view] = seen.views as { students: { registrationId: number; assessment?: { submittedAt: string; expiresAt: string } }[] }[];
  expect(view.students.map((s) => [s.registrationId, s.assessment?.submittedAt])).toEqual([[4, "2026-11-10T09:00:00.000Z"]]);
});

test("nothing submitted yet, and the notes-only protocol of an e-course without points, say so in the header; an ended access says Maria can still assess", async () => {
  reset(accessScreen({ round: 0, status: "open", submittedAt: null }));
  expect(await render({ ligipaas: "4" })).toContain("Praktiline töö: õpilane ei ole veel saatnud");
  const notesOnly = accessScreen({ round: 0, status: "open", submittedAt: null, verdicts: [], photos: [] });
  notesOnly.students[0].protocol.stages = [];
  reset(notesOnly);
  expect(await render({ ligipaas: "4" })).toMatch(/data-assess-round="">Protokoll</);
  reset(accessScreen({ expiresAt: new Date("2026-01-01T00:00:00Z") }));
  const ended = await render({ ligipaas: "4" });
  expect(ended).toContain("data-access-expired");
  expect(ended).toContain("Ligipääs lõppes 01.01.2026.");
});

test("?sessioon= and ?registreering= come before ?ligipaas= (the course day's addresses keep their screens); an access that is not there: the not-found card, back to Hindamine", async () => {
  reset(null);
  await render({ sessioon: "5", ligipaas: "4" });
  await render({ registreering: "7", ligipaas: "4" });
  expect(seen.targets).toEqual([{ sessionId: 5 }, { registrationId: 7 }]);
  const html = await render({ ligipaas: "4" });
  expect(html).toContain("Sellist e-kursuse ligipääsu ei leitud, või see on tühistatud.");
  expect(html).toContain('href="/admin/hindamine"');
  expect(html).toContain('data-shell-active="assessment"');
  expect(seen.views).toEqual([]);
});
