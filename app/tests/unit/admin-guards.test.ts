import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Static check: every admin entry point goes through the guard, so a route, page or server action added later cannot
// forget it. It reads the source files (no Next.js needed) and fails with the file and the rule that is broken.
//
//  - route handlers under app/api/admin/** and app/admin/**: each HTTP method is `export const GET = withAdmin(…)`,
//    never a bare `export function GET`;
//  - pages under app/admin/**: call requireAdmin() (a layout does not run again when the visitor moves between pages),
//    except the login page, which is public by design;
//  - layouts under app/admin/**: the (panel) layout calls requireAdmin(); the root admin layout and nothing else is public;
//  - server action files server/actions/admin*.ts (admin.ts, admin-content.ts, adminX.ts …, and server/actions/admin/**):
//    "use server", every export is
//    `export const name = adminAction(…)` (types excepted).
//
// Not covered, on purpose: app/api/auth/** (request, verify and logout are the sign-in itself; logout must also work with
// an expired session, see its comment).

const SRC = join(process.cwd(), "src");
const METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";
/** Public admin pages: signing in happens there. */
const PUBLIC_PAGES = ["app/admin/login/page.tsx"];
/** The root layout of the admin area is public (it only provides <html>); the guard is in (panel). */
const PUBLIC_LAYOUTS = ["app/admin/layout.tsx"];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const rel = (path: string) => relative(SRC, path).replace(/\\/g, "/");
const files = () => walk(SRC).map((p) => ({ path: rel(p), source: readFileSync(p, "utf8") }));
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments cannot satisfy a rule

/** The broken rules of one source file (empty = fine). */
export function violations(path: string, raw: string): string[] {
  const source = strip(raw);
  const out: string[] = [];
  const isRoute = /^app\/(api\/)?admin\/(.*\/)?route\.tsx?$/.test(path);
  const isAdminPage = /^app\/admin\/(.*\/)?page\.tsx$/.test(path) && !PUBLIC_PAGES.includes(path);
  const isAdminLayout = /^app\/admin\/(.*\/)?layout\.tsx$/.test(path) && !PUBLIC_LAYOUTS.includes(path);
  const isActions = /^server\/actions\/admin/.test(path);

  if (isRoute) {
    if (new RegExp(`export\\s+(async\\s+)?function\\s+(${METHODS})\\b`).test(source)) out.push("a route handler is exported without withAdmin(): use `export const POST = withAdmin(…)`");
    for (const m of source.matchAll(new RegExp(`export\\s+const\\s+(${METHODS})\\s*=\\s*([A-Za-z_$][\\w$]*)?`, "g"))) if (m[2] !== "withAdmin") out.push(`${m[1]} is not wrapped in withAdmin()`);
    if (!/export\s+const\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s*=\s*withAdmin\s*[(<]/.test(source)) out.push("no withAdmin()-wrapped handler found");
    if (/export\s*\{/.test(source) || /export\s+default/.test(source)) out.push("re-exports / default exports in a route file hide the handlers from this check");
  }
  if (isAdminPage && !/\brequireAdmin\s*\(/.test(source)) out.push("an admin page must call requireAdmin()");
  if (isAdminLayout && !/\brequireAdmin\s*\(/.test(source)) out.push("an admin layout must call requireAdmin()");
  if (isActions) {
    if (!/^\s*["']use server["']/.test(raw.replace(/^(\s*\/\/.*\n|\s*\/\*[\s\S]*?\*\/\s*)+/, ""))) out.push('a server action file must start with "use server"');
    if (/export\s+(async\s+)?function\b/.test(source) || /export\s+default\b/.test(source) || /export\s*\{/.test(source)) out.push("server actions must be `export const name = adminAction(…)`");
    for (const m of source.matchAll(/export\s+const\s+(\w+)\s*=\s*([A-Za-z_$][\w$]*)?/g)) if (m[2] !== "adminAction") out.push(`${m[1]} is not wrapped in adminAction()`);
  }
  return out;
}

describe("admin guards are inherited by every admin entry point", () => {
  test("the admin tree is found (the check is not vacuous) and every file in it passes", () => {
    const all = files();
    const admin = all.filter((f) => f.path.startsWith("app/admin/"));
    expect(admin.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "app/admin/(panel)/layout.tsx",
        "app/admin/(panel)/page.tsx",
        "app/admin/login/page.tsx",
        "app/admin/layout.tsx",
        // Task 12: the inboxes; Task 13: every content section of the menu; phase 2b Task 9: Maksed
        ...["registreerimised", "hindamine", "maksed", "protokollid", "tagasiside", "paringud", "uudiskiri", "koolitused", "kalender", "praktika", "avaleht", "koolitaja", "uudised", "kampaania", "seaded"].map(
          (dir) => `app/admin/(panel)/${dir}/page.tsx`,
        ),
      ]),
    );
    expect(all.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "app/api/admin/subscribers.csv/route.ts",
        "server/actions/admin.ts",
        // Task 13: the course editor page, the image upload and the content editors' actions
        "app/admin/(panel)/koolitused/[id]/page.tsx",
        "app/api/admin/upload/route.ts",
        "app/api/admin/lesson-file/route.ts",
        "server/actions/admin-content.ts",
        // Task 13B: the post editor and the site content editors' actions
        "app/admin/(panel)/uudised/[id]/page.tsx",
        "server/actions/admin-site.ts",
        // phase 2a Task 9: Õpilased, the read-only "view as client", and their actions
        "app/admin/(panel)/opilased/page.tsx",
        "app/admin/(panel)/opilased/[id]/vaade/page.tsx",
        "app/admin/(panel)/opilased/[id]/vaade/[slug]/page.tsx",
        "server/actions/admin-clients.ts",
        // phase 3a Task 5: "Moodulid ja õppetunnid"
        "server/actions/admin-lessons.ts",
        // protocols: the autosave
        "app/api/admin/protokoll/route.ts",
        "server/actions/admin-protocols.ts",
        // e-course completion: Hindamine's test review
        "app/admin/(panel)/hindamine/test/page.tsx",
        // e-course completion: Maria's verdict taps and "Saada hinnang"
        "app/api/admin/hinnang/route.ts",
        "server/actions/admin-assessment.ts",
        // phase 3d: Maria's certificate download and the certificate's actions
        "app/api/admin/tunnistus/[id]/route.ts",
        "server/actions/admin-certificates.ts",
        // phase 3d, Task 6: the certificate register (from Hindamine)
        "app/admin/(panel)/tunnistused/page.tsx",
        // invoices, Task 5: Maria's invoice list, the PDF, the month's CSV, the sample and the invoice actions
        "app/admin/(panel)/arved/page.tsx",
        "app/api/admin/arve/[id]/route.ts",
        "app/api/admin/arved/route.ts",
        "app/api/admin/naidisarve/route.ts",
        "server/actions/admin-invoices.ts",
        // admin UX pass piece 3b, Task 4: every Seaded card autosaves on its part's route (the financing toggle's action is gone with its „Salvesta“)
        "app/api/admin/seaded/[part]/route.ts",
        // piece 3b, Task 5: a legal text's draft autosave and its „Avalda uus leping“ / „Avalda uus tekst“
        "app/api/admin/oigustekst/[key]/route.ts",
        "app/api/admin/oigustekst/[key]/avalda/route.ts",
        // piece 3b, Task 6: a newsletter letter's autosave
        "app/api/admin/kiri/[id]/route.ts",
      ]),
    );
    const broken = all.flatMap((f) => violations(f.path, f.source).map((v) => `${f.path}: ${v}`));
    expect(broken).toEqual([]);
  });

  test("the panel page and layout really call requireAdmin, and the login page stays public", () => {
    const get = (path: string) => files().find((f) => f.path === path)!.source;
    expect(strip(get("app/admin/(panel)/layout.tsx"))).toMatch(/requireAdmin\(\)/);
    expect(strip(get("app/admin/(panel)/page.tsx"))).toMatch(/requireAdmin\(\)/);
    expect(strip(get("app/admin/login/page.tsx"))).not.toMatch(/requireAdmin\(/); // would redirect to itself forever
  });

  test("every route under app/api/admin and app/admin is wrapped (the CSV export, and the future ones)", () => {
    const routes = files().filter((f) => /^app\/(api\/)?admin\/(.*\/)?route\.tsx?$/.test(f.path));
    expect(routes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "app/api/admin/subscribers.csv/route.ts", "app/api/admin/upload/route.ts", "app/api/admin/lesson-file/route.ts", "app/api/admin/protokoll/route.ts", "app/api/admin/foto/[id]/route.ts", "app/api/admin/hinnang/route.ts", "app/api/admin/tunnistus/[id]/route.ts",
        // admin UX pass piece 3a, Task 4: a course part's autosave, „Avalda muudatused“ and „Loobu muudatustest“
        "app/api/admin/koolitus/[id]/osa/[part]/route.ts", "app/api/admin/koolitus/[id]/avalda/route.ts", "app/api/admin/koolitus/[id]/loobu/route.ts",
        // Task 5 review I-1: a module's name and a lesson's name and short text, autosaved row by row
        "app/api/admin/moodul/[id]/route.ts", "app/api/admin/oppetund/[id]/route.ts",
        // piece 3b, Task 4: a Seaded card's autosave
        "app/api/admin/seaded/[part]/route.ts",
        // piece 3b, Task 5: a legal text's draft and its publish
        "app/api/admin/oigustekst/[key]/route.ts", "app/api/admin/oigustekst/[key]/avalda/route.ts",
        // piece 3b, Task 6: a newsletter letter's autosave
        "app/api/admin/kiri/[id]/route.ts",
        // piece 4a, Task 1: a site content part's autosave (Avaleht, Koolitaja, Praktika), „Avalda muudatused“ and „Loobu muudatustest“
        "app/api/admin/sisu/[entity]/[id]/osa/[part]/route.ts", "app/api/admin/sisu/[entity]/[id]/avalda/route.ts", "app/api/admin/sisu/[entity]/[id]/loobu/route.ts",
        // piece 4b, Task 1: „Lisa postitus +“ (a post made at once), a post's instant „Avaldatud“ and „Kustuta postitus“ (its drafts with it)
        "app/api/admin/uudised/uus/route.ts", "app/api/admin/uudised/[id]/avaldatud/route.ts", "app/api/admin/uudised/[id]/kustuta/route.ts",
      ]),
    );
    for (const r of routes) expect(violations(r.path, r.source), r.path).toEqual([]);
  });

  test("every admin page calls requireAdmin() itself and every admin action is wrapped", () => {
    const pages = files().filter((f) => /^app\/admin\/\(panel\)\/(.*\/)?page\.tsx$/.test(f.path));
    expect(pages.length).toBeGreaterThanOrEqual(23);
    for (const p of pages) expect(strip(p.source), p.path).toMatch(/await requireAdmin\(\)/);
    const actions = files().find((f) => f.path === "server/actions/admin.ts")!;
    const exported = [...strip(actions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(exported).toEqual(["addManualPaymentAction", "saveRegistrationStatus", "cancelRegistration", "toggleRequestHandled"]);
    expect(violations(actions.path, actions.source)).toEqual([]);
    const content = files().find((f) => f.path === "server/actions/admin-content.ts")!;
    const contentExports = [...strip(content.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    // admin UX pass piece 3a, Task 4: the editor's instant switches „Avaldatud“ (R-d) and „Näidissisu“; piece 3b, Task 2: the Kalender drawer's explicit
    // „Lisa toimumine“ (answers the id: the drawer stays open and autosaves, api/admin/toimumine/<id>) and its instant status („Tühistatud“ / „Toimub“);
    // piece 3b, Task 3: the old whole-form „Salvesta toimumine“ (saveSession) is gone with the old drawer
    expect(contentExports).toEqual(["createCourse", "moveCourseToAction", "setCoursePublished", "setCourseSample", "createSessionAction", "setSessionStatusAction", "deleteSession"]);
    expect(violations(content.path, content.source)).toEqual([]);
    const site = files().find((f) => f.path === "server/actions/admin-site.ts")!;
    const siteExports = [...strip(site.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    // admin UX pass piece 3b, Task 5: Seaded's legal texts' „Salvesta“ (saveSettings) is gone: they type into drafts (api/admin/oigustekst/<key>);
    // piece 4a, Task 4: Praktika's „Salvesta“ (savePractice) is gone: its packages type into drafts (api/admin/sisu/practice/0/osa/<code>)
    // piece 4a, Task 5: Koolitaja's „Salvesta“ (saveTrainer) is gone: its parts type into drafts (api/admin/sisu/trainer/0/osa/<part>)
    // piece 4a, Task 6: Avaleht's „Salvesta“ (saveHome) is gone: its parts type into drafts (api/admin/sisu/home/0/osa/<part>)
    expect(siteExports).toEqual(["saveCampaign", "savePost", "deletePost"]);
    expect(violations(site.path, site.source)).toEqual([]);
    // the contracts' actions: the contact text's „Salvesta lepingud“ (saveContractTextsAction) is gone with it (its draft is published on its route)
    const contractActions = files().find((f) => f.path === "server/actions/admin-contracts.ts")!;
    const contractExports = [...strip(contractActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(contractExports).toEqual(["requestContractAction", "sendContractCopyAction"]);
    expect(violations(contractActions.path, contractActions.source)).toEqual([]);
    expect([...strip(contractActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(contractExports);
    const clients = files().find((f) => f.path === "server/actions/admin-clients.ts")!;
    const clientExports = [...strip(clients.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(clientExports).toEqual(["addStudent", "grantCourseAccess", "revokeCourseAccess", "unlockNextLesson", "extendAccessAction"]);
    expect(violations(clients.path, clients.source)).toEqual([]);
    // every export of the file is one of these (no unguarded helper next to them)
    expect([...strip(clients.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(clientExports);
    const lessonActions = files().find((f) => f.path === "server/actions/admin-lessons.ts")!;
    const lessonExports = [...strip(lessonActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    // admin UX pass piece 3a, Task 10: the drawer's name and short text autosave on their route (api/admin/oppetund/<id>), so „saveLesson“ is gone; a file's
    // „Eemalda“ only marks it (removeLessonFile) and „Võta tagasi“ clears the mark (undoRemoveLessonFile)
    expect(lessonExports).toEqual(["addModule", "moveModuleTo", "deleteModule", "addLesson", "moveLessonInList", "setLessonHidden", "setLessonKind", "deleteLesson", "removeLessonFile", "undoRemoveLessonFile", "createLessonVideo", "checkLessonVideo"]);
    expect(violations(lessonActions.path, lessonActions.source)).toEqual([]);
    expect([...strip(lessonActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(lessonExports);
    const protocolActions = files().find((f) => f.path === "server/actions/admin-protocols.ts")!;
    const protocolExports = [...strip(protocolActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(protocolExports).toEqual(["sendProtocolAction", "sendProtocolsAction"]);
    expect(violations(protocolActions.path, protocolActions.source)).toEqual([]);
    expect([...strip(protocolActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(protocolExports);
    const assessmentActions = files().find((f) => f.path === "server/actions/admin-assessment.ts")!;
    const assessmentExports = [...strip(assessmentActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(assessmentExports).toEqual(["sendAssessmentAction", "reviewAttemptAction", "reopenTestAction"]);
    expect(violations(assessmentActions.path, assessmentActions.source)).toEqual([]);
    expect([...strip(assessmentActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(assessmentExports);
    const certificateActions = files().find((f) => f.path === "server/actions/admin-certificates.ts")!;
    const certificateExports = [...strip(certificateActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    // admin UX pass piece 3b, Task 4: Seaded's "Tunnistus" card autosaves on api/admin/seaded/certificate, so „Salvesta tunnistuse andmed“ is gone
    expect(certificateExports).toEqual(["reissueCertificateAction"]);
    expect(violations(certificateActions.path, certificateActions.source)).toEqual([]);
    expect([...strip(certificateActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(certificateExports);
    // student reviews, Task 4: Maria's „Avalda“ / „Peida“, „Avalehel“, „Lisa arvustus“ / „Muuda“ and „Kustuta“
    const reviewActions = files().find((f) => f.path === "server/actions/admin-reviews.ts")!;
    const reviewExports = [...strip(reviewActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(reviewExports).toEqual(["decideReviewAction", "setFeaturedAction", "saveManualReviewAction", "deleteManualReviewAction"]);
    expect(violations(reviewActions.path, reviewActions.source)).toEqual([]);
    expect([...strip(reviewActions.source).matchAll(/export\s+(?:const|let|var|async\s+function|function|class|default)\s*(\w*)/g)].map((m) => m[1])).toEqual(reviewExports);
    // instalments, Task 5: Seaded's „Järelmaks (Inbank)“ toggle had an action; since piece 3b, Task 4 it autosaves on api/admin/seaded/financing
    expect(files().some((f) => f.path === "server/actions/admin-financing.ts")).toBe(false);
    // the invoice actions: Seaded's „Salvesta arve andmed“ is gone (the „Maksmine“ card autosaves on api/admin/seaded/invoice)
    const invoiceActions = files().find((f) => f.path === "server/actions/admin-invoices.ts")!;
    const invoiceExports = [...strip(invoiceActions.source).matchAll(/export\s+const\s+(\w+)\s*=\s*adminAction\(/g)].map((m) => m[1]);
    expect(invoiceExports).toEqual(["createInvoiceAction", "sendInvoiceAction", "markInvoicePaidAction", "undoInvoicePaidAction", "cancelInvoiceAction", "updateInvoiceBuyerAction", "catchUpInvoiceAction", "createInvoicesForUnbilledAction"]);
    expect(violations(invoiceActions.path, invoiceActions.source)).toEqual([]);
    // It reads and scans every admin source file: about 2 s alone, but well past the 20 s default while the full run keeps every core
    // busy (seen at 38 s); the limit is for the machine's load, not for this test's work.
  }, 120_000);

  test("the image and lesson file uploads are admin routes; /media only reads (anyone may see a published image)", () => {
    const upload = files().find((f) => f.path === "app/api/admin/upload/route.ts")!;
    expect(strip(upload.source)).toMatch(/export\s+const\s+POST\s*=\s*withAdmin\(/);
    const lessonFile = files().find((f) => f.path === "app/api/admin/lesson-file/route.ts")!;
    expect(strip(lessonFile.source)).toMatch(/export\s+const\s+POST\s*=\s*withAdmin\(/);
    const media = files().find((f) => f.path === "app/media/[...key]/route.ts")!;
    expect(strip(media.source)).toMatch(/serveMedia\(/);
    expect(strip(media.source)).not.toMatch(/\.put\(|putImage|POST|DELETE/);
  });

  describe("the rules themselves catch what they should (so the check cannot rot into a no-op)", () => {
    const route = "app/api/admin/courses/route.ts";
    test("route handlers", () => {
      expect(violations(route, `export const POST = withAdmin(async () => Response.json({}));`)).toEqual([]);
      expect(violations(route, `export const GET = withAdmin<{ params: Promise<{ id: string }> }>(async () => Response.json({}));\nexport const DELETE = withAdmin(async () => new Response());`)).toEqual([]);
      expect(violations(route, `export async function POST() { return Response.json({}); }`)).not.toEqual([]);
      expect(violations(route, `export function GET() { return Response.json({}); }`)).not.toEqual([]);
      expect(violations(route, `export const POST = async () => Response.json({});`)).not.toEqual([]);
      expect(violations(route, `export const GET = withAdmin(async () => Response.json({}));\nexport const POST = async () => Response.json({});`)).not.toEqual([]);
      expect(violations(route, `import { withAdmin } from "@/server/auth";\nexport const dynamic = "force-dynamic";`)).not.toEqual([]); // no handler at all
      expect(violations(route, `// withAdmin(\nexport async function POST() {}`)).not.toEqual([]); // a comment is not a guard
      expect(violations(route, `const h = withAdmin(async () => Response.json({}));\nexport { h as POST };`)).not.toEqual([]);
      expect(violations("app/admin/export/route.ts", `export async function GET() {}`)).not.toEqual([]); // routes under app/admin too
      expect(violations("app/api/newsletter/confirm/route.ts", `export async function GET() {}`)).toEqual([]); // public API: out of scope
    });

    test("pages and layouts", () => {
      expect(violations("app/admin/(panel)/courses/page.tsx", `export default async function P() { const e = await requireAdmin(); return null; }`)).toEqual([]);
      expect(violations("app/admin/(panel)/courses/page.tsx", `export default async function P() { return null; }`)).not.toEqual([]);
      expect(violations("app/admin/(panel)/courses/page.tsx", `// requireAdmin()\nexport default function P() { return null; }`)).not.toEqual([]);
      expect(violations("app/admin/login/page.tsx", `export default function P() { return null; }`)).toEqual([]);
      expect(violations("app/admin/(panel)/layout.tsx", `export default function L({ children }) { return children; }`)).not.toEqual([]);
      expect(violations("app/admin/(panel)/layout.tsx", `export default async function L({ children }) { await requireAdmin(); return children; }`)).toEqual([]);
      expect(violations("app/admin/layout.tsx", `export default function L({ children }) { return children; }`)).toEqual([]);
    });

    test("server actions", () => {
      const file = "server/actions/admin.ts";
      expect(violations(file, `"use server";\nexport const save = adminAction(async ({ email }, f: FormData) => {});`)).toEqual([]);
      expect(violations(file, `// guarded actions\n"use server";\nexport const save = adminAction(async () => {});\nexport type Result = { ok: boolean };`)).toEqual([]);
      expect(violations(file, `"use server";\nexport async function save() {}`)).not.toEqual([]);
      expect(violations(file, `"use server";\nexport const save = async () => {};`)).not.toEqual([]);
      expect(violations(file, `export const save = adminAction(async () => {});`)).not.toEqual([]); // not a "use server" file
      expect(violations("server/actions/admin-courses.ts", `"use server";\nexport async function save() {}`)).not.toEqual([]);
      expect(violations("server/actions/adminContent.ts", `"use server";\nexport const save = async () => {};`)).not.toEqual([]); // any admin* file
      expect(violations("server/actions/admin-content.ts", `"use server";\nexport const save = adminAction(async () => {});`)).toEqual([]);
      expect(violations("server/actions/public.ts", `"use server";\nexport async function submitContact() {}`)).toEqual([]); // public actions: out of scope
    });
  });
});
