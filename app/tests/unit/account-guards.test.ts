import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Guard for the client account's data endpoints (server/account-api.ts): nothing but a convention makes an endpoint start
// with the session check and answer through clientResponse (which carries a renewed session's cookies to the browser), so the
// source is read here. A new endpoint that skips either fails this test. The one answer that does not go through
// clientResponse is account deletion, which clears both cookies instead.

const SOURCE = readFileSync(join(process.cwd(), "src/server/account-api.ts"), "utf8").replace(/\r\n/g, "\n");

/** The data endpoints' section: from the 400 helper to the router of their paths. */
const START = "/** 400 for a body the endpoint cannot use";
const END = "/** The path of one e-course";
const section = SOURCE.slice(SOURCE.indexOf(START), SOURCE.indexOf(END));
const handlers = section.split(/\n(?=\/\*\*[^\n]*\n(?:[^\n]*\n)*?(?:export )?async function )/).filter((chunk) => /async function (\w+)/.test(chunk));
const nameOf = (chunk: string) => /async function (\w+)/.exec(chunk)![1];

/** The data endpoints in their order in the source; every one starts with requireClient. */
const HANDLERS = [
  "dashboard", "ecourse", "lesson", "progress", "lessonDone", "lessonFile", "testPage", "submitTest", "resubmitTest", "practicalPage", "uploadPhoto", "deletePhoto", "submitWork", "photo",
  "issueCertificateRoute", "certificateFile", "invoiceFile", "favouriteCourses", "favourite", "mergeFavouriteList", "profile", "newsletter", "setPassword", "removePassword", "changeRequest", "payRegistration",
  "protocol", "feedbackForm", "sendFeedback", "dismissFeedback", "terms", "deleteAccount",
];

describe("the data endpoints of the account API", () => {
  test("the section and its handlers are found", () => {
    expect(SOURCE.indexOf(START)).toBeGreaterThan(0);
    expect(SOURCE.indexOf(END)).toBeGreaterThan(SOURCE.indexOf(START));
    expect(handlers.map(nameOf)).toEqual(HANDLERS);
  });

  test.each(HANDLERS)(
    "%s starts with requireClient and hands a refusal back unchanged",
    (name) => {
      const body = handlers.find((h) => nameOf(h) === name)!.split("{\n").slice(1).join("{\n");
      expect(body.trimStart().startsWith("const session = await requireClient(request, deps);\n  if (session instanceof Response) return session;\n")).toBe(true);
    },
  );

  test("every answer goes through clientResponse (or badInput, which does), except the deletion's, which clears both cookies", () => {
    for (const handler of handlers) {
      const name = nameOf(handler);
      const answers = handler.match(/accountResponse\(/g) ?? [];
      if (name === "deleteAccount") {
        expect(handler).toContain("return accountResponse({ ok: true }, 200, clearedCookies());");
        expect(answers).toHaveLength(1);
      } else {
        expect(answers, name).toHaveLength(0);
        expect(handler, name).toMatch(/clientResponse\(session, |badInput\(session, |unauthorized\("none"\)/);
      }
    }
  });

  test("no handler builds a response of its own: not Response.json, not new Response (clientResponse and accountResponse set the headers and the cookies)", () => {
    expect(section).not.toMatch(/Response\.json\(|new Response\(/);
    for (const handler of handlers) expect(handler, nameOf(handler)).not.toMatch(/Response\.json\(|new Response\(/);
  });

  test("the 400 helper answers through clientResponse", () => {
    expect(section.slice(0, section.indexOf("\n\n"))).toContain("clientResponse(session, { ok: false, error: field }, 400)");
  });

  test("a practical photo's 302 is built above the handlers (photoAnswer, from private-file.ts), never by the handler itself", () => {
    const helper = SOURCE.indexOf("async function photoAnswer(");
    expect(helper).toBeGreaterThan(0);
    expect(helper).toBeLessThan(SOURCE.indexOf(START));
    expect(SOURCE.slice(helper, SOURCE.indexOf("\n}\n", helper))).toContain("privateFileAnswer(store, key");
    expect(handlers.find((h) => nameOf(h) === "photo")).toContain("photoAnswer(session, ");
  });

  test("a PDF (a certificate's, an invoice's) is built above the handlers (pdfAnswer: the bytes, the PDF's headers, the session's cookies), never by the handler itself", () => {
    const helper = SOURCE.indexOf("function pdfAnswer(");
    expect(helper).toBeGreaterThan(0);
    expect(helper).toBeLessThan(SOURCE.indexOf(START));
    const body = SOURCE.slice(helper, SOURCE.indexOf("\n}\n", helper));
    for (const part of ["BASE_HEADERS", "...download", "session.cookies"]) expect(body, part).toContain(part);
    // the type, the file name and nosniff come from the file's own headers (domain/certificate.ts certificateDownloadHeaders, domain/invoice.ts
    // invoiceDownloadHeaders), which each handler hands over; pinned by both routes' header tests
    for (const [handler, headers] of [["certificateFile", "certificateDownloadHeaders("], ["invoiceFile", "invoiceDownloadHeaders("]]) {
      const source = handlers.find((h) => nameOf(h) === handler);
      expect(source, handler).toContain("pdfAnswer(session, ");
      expect(source, handler).toContain(headers);
    }
  });

  test("the router sends every known path to a handler, and only GET /kursus/:slug, the test's, the practical work's, the certificate's, the invoice's and the lesson paths are matched by pattern", () => {
    const router = SOURCE.slice(SOURCE.indexOf(END), SOURCE.indexOf("/** The router: `null`"));
    const cases = [...router.matchAll(/case "(\w+) ([^"]+)": return (\w+)\(request, deps\);/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    expect(cases).toEqual([
      "GET / dashboard", "GET /lemmikud favouriteCourses", "POST /lemmikud favourite", "POST /lemmikud/merge mergeFavouriteList", "PATCH /andmed profile", "POST /uudiskiri newsletter", "POST /parool setPassword", "DELETE /parool removePassword",
      "POST /muutmine changeRequest", "POST /maksa payRegistration", "GET /protokoll protocol", "GET /tagasiside feedbackForm", "POST /tagasiside sendFeedback", "POST /tagasiside/peida dismissFeedback", "POST /tingimused terms", "POST /kustuta deleteAccount",
    ]);
    expect(router).toContain('request.method === "GET" ? COURSE_PATH.exec(path) : null');
    expect(router).toContain("LESSON_PATH.exec(path)");
    // the practical work's paths (e-course completion, Task 8): by pattern, before the lesson paths would read "praktiline" as a lesson
    expect(router).toContain("PRACTICAL_PATH.exec(path)");
    expect(router).toContain('request.method === "GET" ? PHOTO_PATH.exec(path) : null');
    expect(router.indexOf("PRACTICAL_PATH.exec(path)")).toBeLessThan(router.indexOf("LESSON_PATH.exec(path)"));
    // e-course completion: the test's paths come first, else "test" would be read as a lesson id
    expect(router).toContain("TEST_PATH.exec(path)");
    expect(router.indexOf("TEST_PATH.exec(path)")).toBeLessThan(router.indexOf("LESSON_PATH.exec(path)"));
    // the certificate (phase 3d): its POST path before the lesson paths, which would read "tunnistus" as a lesson; its PDF by GET only
    expect(router).toContain("CERT_PATH.exec(path)");
    expect(router.indexOf("CERT_PATH.exec(path)")).toBeLessThan(router.indexOf("LESSON_PATH.exec(path)"));
    expect(router).toContain('request.method === "GET" ? CERT_FILE_PATH.exec(path) : null');
    // an invoice's PDF (invoices Task 6): GET only, by its own path
    expect(router).toContain('request.method === "GET" ? INVOICE_FILE_PATH.exec(path) : null');
  });
});

// The account's pages (/konto…, /ru/konto…) are static shells: Next.js keeps the address of the request that renders a page, query
// included, in the page it caches, so no address with a query may reach them. The middleware answers one with a 303 (the parameters
// it knows move into the fragment); the app itself never makes such an address: its links and redirects carry their parameters in the
// fragment (`/konto/sisene#viga=link`, `#korda=1`, `#email=…`).
const SRC = join(process.cwd(), "src");
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));

describe("the app never builds an address of an account page with a query", () => {
  // a string that starts at an account page ("/konto…", "/ru/konto…", also after a ${…} or a template quote) and goes on to a "?"
  const SHELL_WITH_QUERY = /(?:["'`]|\}|href\([^,)]*,\s*["'`])(?:\/ru)?\/konto(?:\/[a-z0-9${}._-]+)*\?/;
  // a login parameter put after an interpolated address (`${login}?viga=link`, the form the verify redirect once had)
  const PARAM_AFTER_ADDRESS = /\}\?(?:viga|korda|email)=/;

  test("a login parameter after an interpolated address is seen too", () => {
    expect("`${login}?viga=link`").toMatch(PARAM_AFTER_ADDRESS);
    expect("`${base}#korda=1`").not.toMatch(PARAM_AFTER_ADDRESS);
  });

  test("the pattern sees the addresses it is meant for, and not the API's", () => {
    for (const bad of ['"/konto/sisene?korda=1"', "`/ru/konto?x=1`", 'href(locale, "/konto/kursus/x?a=b")', "`${base}/konto/sisene?viga=link`", "'/konto?x'"]) expect(bad, bad).toMatch(SHELL_WITH_QUERY);
    for (const fine of ['"/api/konto/verify?t="', '"/konto/sisene#korda=1"', '"/konto/sisene"', '"/koolitused/x?sessioon=1"', '"/kontakt?x=1"', 'const login = "/konto/sisene";']) expect(fine, fine).not.toMatch(SHELL_WITH_QUERY);
  });

  test("no file of src/ has one (the comments that name the old query form are not strings)", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const code = readFileSync(file, "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      return SHELL_WITH_QUERY.test(code) || PARAM_AFTER_ADDRESS.test(code) ? [file.slice(SRC.length + 1)] : [];
    });
    expect(offenders).toEqual([]);
  });
});
