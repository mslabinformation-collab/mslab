// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListRows } from "@/components/admin/ListRows";
import listTable from "@/components/admin/list-table.module.css";

// ListRows (admin UX pass, README §1.10, Task 13 fix round): the whole row of an admin list is the link. The name Link stays the keyboard's
// and the screen reader's target; a plain click on the row anywhere else, away from the row's own controls, is forwarded to it, so Next's Link
// navigates as always. Nothing is stretched or clipped, and text in a row can still be selected.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** The table as the pages render it: a name link, an e-mail link, a button and a field in one row; a plain name (a payer with no account) in another. */
const table = (): ReactNode =>
  createElement(
    "table",
    { className: listTable.table },
    createElement("thead", null, createElement("tr", null, createElement("th", { id: "head" }, "Nimi"))),
    createElement(
      "tbody",
      null,
      createElement(
        "tr",
        { id: "r1" },
        createElement("td", { id: "date" }, createElement("span", { id: "deep" }, "21.10")),
        createElement(
          "td",
          { id: "who" },
          createElement("a", { id: "name", className: listTable.name, href: "/admin/opilased?id=1" }, createElement("b", { id: "inname" }, "Kati Kask")),
          createElement("a", { id: "mail", href: "mailto:kati@example.test" }, createElement("i", { id: "inmail" }, "kati@example.test")),
        ),
        createElement(
          "td",
          { id: "tools" },
          createElement("button", { id: "btn", type: "button" }, createElement("i", { id: "inbtn" }, "Saada")),
          createElement("label", { id: "lbl" }, "Märgi", createElement("input", { id: "field", type: "checkbox" })),
          createElement("span", { id: "role", role: "button", tabIndex: 0 }, "Roll"),
          createElement("span", { id: "edit", contentEditable: "true" }, "Muuda"),
        ),
      ),
      createElement("tr", { id: "r2" }, createElement("td", { id: "plain" }, createElement("span", { className: listTable.name }, "Ilma kontota"))),
    ),
  );

let opened: HTMLElement[];
const draw = (children: ReactNode = table()) => act(async () => root.render(createElement(ListRows, null, children)));
const $ = (id: string) => document.getElementById(id)!;
/** A click as a mouse makes it (primary button, no keys), unless `init` says otherwise. */
const click = (el: Element, init: MouseEventInit = {}) =>
  act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })));

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opened = [];
  await draw();
  // the name Link's own click: counted, and kept from following the address
  $("name").addEventListener("click", (e) => {
    e.preventDefault();
    opened.push(e.target as HTMLElement);
  });
});
afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("ListRows", () => {
  it("a click on a cell of the row, or on what is in it, follows the row's name link", async () => {
    await click($("date"));
    expect(opened).toHaveLength(1);
    await click($("deep"));
    await click($("who")); // the name's own cell, beside the link
    await click($("tools"));
    await click($("r1")); // the row itself (its padding)
    expect(opened).toHaveLength(5);
  });

  it("the name link's own click is one click, not two (the forwarded click bubbles back and is let go)", async () => {
    await click($("name"));
    expect(opened).toEqual([$("name")]);
    await click($("inname")); // the text inside the link
    expect(opened).toEqual([$("name"), $("inname")]);
  });

  it("the row's own controls get their click: an e-mail link, a button, a label and its field, a role=button, a contenteditable", async () => {
    for (const id of ["mail", "inmail", "btn", "inbtn", "lbl", "field", "role", "edit"]) await click($(id));
    expect(opened).toHaveLength(0);
  });

  it("Ctrl, Cmd, Shift and Alt clicks and a click of another button are the browser's own", async () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) await click($("date"), init);
    expect(opened).toHaveLength(0);
  });

  it("a click that was already handled (defaultPrevented) is left alone", async () => {
    $("date").addEventListener("click", (e) => e.preventDefault());
    await click($("date"));
    expect(opened).toHaveLength(0);
  });

  it("not while text is selected: dragging over a cell to copy it ends in a click on that cell", async () => {
    const range = document.createRange();
    range.selectNodeContents($("deep"));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(window.getSelection()!.isCollapsed).toBe(false);
    await click($("deep"));
    expect(opened).toHaveLength(0);
    window.getSelection()!.removeAllRanges();
    await click($("deep"));
    expect(opened).toHaveLength(1);
  });

  it("a row with no name link (a payer with no account), the header and what is outside the table do nothing", async () => {
    await click($("plain"));
    await click($("r2"));
    await click($("head"));
    await click(container);
    expect(opened).toHaveLength(0);
  });

  it("the table stays as it is: the wrapper is a plain block with one class (the tap flash off) and no style", () => {
    const box = container.firstElementChild as HTMLElement;
    expect(box.tagName).toBe("DIV");
    expect(listTable.rows).toBeTruthy();
    expect(box.getAttribute("class")).toBe(listTable.rows);
    expect(box.getAttribute("style")).toBeNull();
    expect(box.firstElementChild!.tagName).toBe("TABLE");
  });
});

describe("list tables (the stylesheet)", () => {
  const css = readFileSync(join(process.cwd(), "src/components/admin/list-table.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** The body of the `@container (…)` block that starts with `head`: from its brace to the matching one. */
  const block = (head: string) => {
    const at = css.indexOf(head);
    expect(at, head).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(head);
  };
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();

  it("a row becomes a block of label/value lines below a 760 px card, for every list: there is no other switch (Maksed's 980 px one went with A6)", () => {
    expect(css.match(/@container[^{]*\{/g)).toEqual(["@container (max-width: 760px) {"]);
    expect(css).not.toMatch(/stackAt980|980px/);
  });

  it("nothing is stretched, positioned or clipped to make the row a link: the row is the link by ListRows", () => {
    expect(css).not.toMatch(/::after/);
    expect(css).not.toMatch(/z-index/);
    expect(css).not.toMatch(/position:\s*(relative|static)/);
    const card = /\n\.card \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(squash(card)).toBe("container-type: inline-size;");
  });

  it("a row with a name link shows a pointer, and the highlight under a mouse only", () => {
    expect(css).toMatch(/\.table tbody tr:has\(a\.name\) \{\s*cursor: pointer;/);
    expect(css).toMatch(/@media \(hover: hover\) \{\s*\.table tbody tr:has\(a\.name\):hover \{\s*background: var\(--row-highlight\);/);
  });

  it("iOS: the wrapper holding the click listener has no grey tap flash; a pressed row tints itself instead (with a fallback where :has is unknown)", () => {
    // the wrapper's own rule: the flash off
    expect(squash(/\n\.rows \{([^}]*)\}/.exec(css)?.[1] ?? "")).toBe("-webkit-tap-highlight-color: transparent;");
    // the press tint on a row with a name link, from the same token as the hover
    expect(css).toMatch(/\.table tbody tr:has\(a\.name\):active \{\s*background: var\(--row-highlight\);/);
    // iOS 15.0-15.3 drops the rule above (no :has): the fallback tints the pressed row without it, and only where :has is unknown
    expect(css).toMatch(/@supports not selector\(:has\(a\)\) \{\s*\.table tbody tr:active \{\s*background: var\(--row-highlight\);/);
    // the press tint is not inside the (hover: hover) block: a finger has no hover, and :active does not stick the way :hover does
    expect(block("@media (hover: hover)")).not.toMatch(/:active/);
  });

  it("every page's own container queries agree: every list stacks at the shared 760 switch; Registreerimised (A2) and Maksed (A6) draw a phone card of their own", () => {
    const page = (f: string) => readFileSync(join(process.cwd(), "src/app/admin/(panel)", f), "utf8");
    // Registreerimised has five columns and its own phone card (A2): the shared 760 switch, nothing at 980
    expect(page("registreerimised/registrations.module.css")).toMatch(/@container \(max-width: 760px\)/);
    expect(page("registreerimised/registrations.module.css")).not.toMatch(/980px/);
    expect(page("registreerimised/page.tsx")).not.toMatch(/stackAt980/);
    // Maksed has six columns and its own phone card (A6): the same 760 switch
    expect(page("maksed/payments.module.css")).toMatch(/@container \(max-width: 760px\)/);
    expect(page("maksed/payments.module.css")).not.toMatch(/980px/);
    expect(page("tagasiside/feedback.module.css")).toMatch(/@container \(max-width: 760px\)/);
    expect(page("tagasiside/feedback.module.css")).not.toMatch(/980px/);
    for (const f of ["registreerimised", "opilased", "maksed", "tagasiside", "tunnistused"]) expect(page(`${f}/page.tsx`)).not.toMatch(/stackAt980/);
    // every list's table is inside ListRows (Registreerimised and Maksed add their own class for the phone card)
    for (const f of ["registreerimised", "opilased", "maksed", "tagasiside", "tunnistused"])
      expect(page(`${f}/page.tsx`), f).toMatch(/<ListRows>\s*<table className=\{`\$\{ui\.table\} \$\{listTable\.table\}(?: \$\{styles\.list\})?`\}>/);
    // the card's rules outweigh the shared label rows' (`.table td`, `.table td:first-child`) by naming the table
    expect(page("registreerimised/registrations.module.css")).toMatch(/table\.list td:first-child \{/);
    expect(page("maksed/payments.module.css")).toMatch(/table\.list td:first-child \{/);
  });
});

// B1 Koolitused (piece 3a, Task 3): a list of rows (DragList's `ol > li[data-drag-row]`) rather than a table. The same delegated handler serves it: the
// row is the `li`, its name Link the same `a.name`, and the handle, the arrows and the „↕“ menu are buttons, so they keep their own clicks.
describe("ListRows: a list of rows (DragList's li) as well as a table", () => {
  const rows = (): ReactNode =>
    createElement(
      "ol",
      null,
      createElement(
        "li",
        { id: "li1", "data-drag-row": "1" },
        createElement("button", { id: "handle", type: "button" }, "⋮⋮"),
        createElement("span", { id: "arrows" }, createElement("button", { id: "up", type: "button" }, "↑")),
        createElement("span", { id: "thumb" }),
        createElement("a", { id: "lname", className: listTable.name, href: "/admin/koolitused/1" }, "Kulmude LAMI"),
        createElement("span", { id: "tag" }, createElement("i", { id: "intag" }, "Kontaktõpe")),
      ),
      createElement("li", { id: "li2", "data-drag-row": "2" }, createElement("span", { id: "nolink" }, "Ilma lingita")),
    );

  it("a click on the row anywhere but its controls follows its name link", async () => {
    await draw(rows());
    const seen: Element[] = [];
    $("lname").addEventListener("click", (e) => {
      e.preventDefault();
      seen.push(e.target as Element);
    });
    for (const id of ["thumb", "tag", "intag", "li1"]) await click($(id));
    expect(seen).toHaveLength(4);
    await click($("lname"));
    expect(seen).toHaveLength(5); // the link's own click is one click
  });

  it("the handle and the arrows get their own click; a row with no name link does nothing", async () => {
    await draw(rows());
    const seen: Element[] = [];
    $("lname").addEventListener("click", (e) => {
      e.preventDefault();
      seen.push(e.target as Element);
    });
    for (const id of ["handle", "up", "nolink", "li2"]) await click($(id));
    expect(seen).toHaveLength(0);
  });
});
