// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DIRS } from "@/server/feedback";

// public/feedback.js, the review comment bubble, run in a browser-like document: which `dir` a comment carries (the prototype's letter, "hub",
// "site" for the main site and, since Dim 22.10, "admin" for the admin's pages), and what it sends with it. The script is a plain browser file
// (not a module), so it is run here as the browser runs it: a classic script, once per page.

const SCRIPT = readFileSync(join(process.cwd(), "public", "feedback.js"), "utf8");

type Payload = { dir: string; route?: string; title?: string; text: string; el?: { label?: string; snippet?: string; sel?: string; y?: number; h?: number } };

let sent: Payload[];

/** Opens `path` (with `html` attributes) as a page and runs the widget on it. */
function openPage(path: string, htmlAttributes: Record<string, string> = {}) {
  history.pushState({}, "", path);
  for (const [name, value] of Object.entries(htmlAttributes)) document.documentElement.setAttribute(name, value);
  document.title = "Koolitused — MS LAB Koolituskeskus";
  (0, eval)(SCRIPT); // (indirect eval: the script's own global scope, like a <script> tag)
}

/** Writes `text` in the bubble's panel and presses „Saada“; the payload that went to /api/feedback. */
async function comment(text: string): Promise<Payload> {
  document.querySelector<HTMLButtonElement>("#mslab-fb .fb-fab")!.click();
  const area = document.querySelector<HTMLTextAreaElement>("#mslab-fb textarea")!;
  area.value = text;
  document.querySelector<HTMLButtonElement>("#mslab-fb .fb-send")!.click();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return sent[0];
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Payload);
      return new Response(JSON.stringify({ ok: true, id: "abc123def456gh" }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  delete (window as unknown as { __mslabFeedback?: boolean }).__mslabFeedback;
  document.getElementById("mslab-fb")?.remove();
  for (const style of [...document.head.querySelectorAll("style")]) style.remove();
  document.documentElement.removeAttribute("data-fb-dir");
  document.documentElement.removeAttribute("data-admin");
  localStorage.clear();
  history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("the comment bubble's direction (dir)", () => {
  test("an admin page (the root layout says so with data-fb-dir) sends dir admin and its path", async () => {
    openPage("/admin/koolitused", { "data-admin": "", "data-fb-dir": "admin" });
    expect(await comment("Nupp võiks olla suurem")).toMatchObject({ dir: "admin", route: "/admin/koolitused", text: "Nupp võiks olla suurem" });
  });

  test("a main-site page still sends dir site and its path (nothing marks it)", async () => {
    openPage("/koolitused");
    expect(await comment("Pealkiri")).toMatchObject({ dir: "site", route: "/koolitused" });
  });

  test("a prototype keeps its letter and its hash route, and the hub stays the hub", async () => {
    openPage("/p/d/#/koolitused");
    expect(await comment("Prototüüp")).toMatchObject({ dir: "d", route: "#/koolitused" });
  });

  test("the hub", async () => {
    openPage("/guide/");
    expect((await comment("Juhend")).dir).toBe("hub");
  });

  test("the bubble is the same button on every page: 'Kommentaar'", () => {
    openPage("/admin", { "data-fb-dir": "admin" });
    expect(document.querySelector("#mslab-fb .fb-fab")!.textContent).toBe("Kommentaar");
    expect(document.querySelector("#mslab-fb .fb-fab")!.getAttribute("aria-label")).toBe("Jäta kommentaar");
  });
});

describe("a marked place (fix round 1: no personal text from the admin's pages)", () => {
  /** Marks `target` as the comment's place (the pick mode: press „Märgi koht lehel“, then press the element), then writes `text` and sends. */
  async function commentOn(target: Element, text: string): Promise<Payload> {
    // (happy-dom has no hit test: the element under the pointer is the one the test names)
    document.elementsFromPoint = () => [target];
    document.querySelector<HTMLButtonElement>("#mslab-fb .fb-fab")!.click();
    document.querySelector<HTMLButtonElement>("#mslab-fb .fb-pick")!.click();
    document.querySelector<HTMLElement>("#mslab-fb .fb-ov")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    expect(document.querySelector("#mslab-fb .fb-pk")).not.toBeNull(); // (the place is marked: "Koht: …")
    const area = document.querySelector<HTMLTextAreaElement>("#mslab-fb textarea")!;
    area.value = text;
    document.querySelector<HTMLButtonElement>("#mslab-fb .fb-send")!.click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    return sent[0];
  }
  const student = () => {
    const row = document.createElement("section");
    row.id = "row";
    const heading = document.createElement("h2");
    heading.textContent = "Maria Tamm";
    const contact = document.createElement("p");
    contact.textContent = "maria.tamm@example.test · +372 5555 0000";
    row.append(heading, contact);
    document.body.append(row);
    return row;
  };
  afterEach(() => document.getElementById("row")?.remove());

  test("an admin page's place keeps the selector and the position, and sends no text of the element: no label, no snippet", async () => {
    const row = student();
    openPage("/admin/opilased", { "data-admin": "", "data-fb-dir": "admin" });
    const payload = await commentOn(row, "Rida võiks olla kitsam");
    expect(payload).toMatchObject({ dir: "admin", route: "/admin/opilased" });
    expect(payload.el).toBeDefined();
    expect(payload.el!.sel).toBe("#row");
    expect(typeof payload.el!.y).toBe("number");
    expect(typeof payload.el!.h).toBe("number");
    expect(payload.el).not.toHaveProperty("label");
    expect(payload.el).not.toHaveProperty("snippet");
    expect(JSON.stringify(payload)).not.toMatch(/Maria Tamm|maria\.tamm|5555/);
  });

  test("a main-site page's place still carries its heading as the label and the first words as the snippet", async () => {
    const row = student();
    openPage("/koolitused");
    const payload = await commentOn(row, "Pealkiri");
    expect(payload).toMatchObject({ dir: "site", el: { sel: "#row", label: "Maria Tamm" } });
    expect(payload.el!.snippet).toContain("Maria Tamm");
  });
});

describe("the comment list page (/guide/tagasiside/)", () => {
  test("names every direction the server knows, 'admin' included (no raw key on a comment's card)", () => {
    const html = readFileSync(join(process.cwd(), "public", "guide", "tagasiside", "index.html"), "utf8");
    const map = /var DIRS = \{([^}]*)\}/.exec(html)![1];
    const listed = Object.fromEntries([...map.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(listed).sort()).toEqual(Object.keys(DIRS).sort());
    expect(listed.admin).toBe(DIRS.admin);
  });
});
