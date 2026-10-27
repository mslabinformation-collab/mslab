// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { trapTab } from "@/lib/modal";

// The modals' Tab trap (lib/modal.ts trapTab, FOCUSABLE) on a real document: what Tab reaches inside a modal is what the browser's own Tab would — the
// account's change request reaches its message (a textarea) and a select; the home page's popup never stops at its form's hidden field or honeypot
// (admin UX pass piece 4b, Task 4 and its fix round).

afterEach(() => {
  document.body.innerHTML = "";
});

/** The focus after each of `n` presses of Tab (or Shift+Tab) in `box`, named by the element's data-name. */
function tabs(box: HTMLElement, n: number, shiftKey = false): string[] {
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    trapTab({ key: "Tab", shiftKey, preventDefault: vi.fn() }, box);
    seen.push((document.activeElement as HTMLElement | null)?.dataset.name ?? "none");
  }
  return seen;
}

describe("trapTab in a document", () => {
  test("the change request's fields: ✕, the choices, the message (textarea), a select, the button — and round again", () => {
    document.body.innerHTML = `
      <div id="box">
        <button data-name="close">✕</button>
        <input type="radio" name="what" data-name="date" />
        <input type="radio" name="what" data-name="cancel" />
        <textarea data-name="message"></textarea>
        <select data-name="pick"><option>a</option></select>
        <textarea disabled data-name="off"></textarea>
        <button type="submit" data-name="send">Saada</button>
      </div>`;
    const box = document.getElementById("box")!;
    (box.querySelector('[data-name="close"]') as HTMLElement).focus();
    expect(tabs(box, 6)).toEqual(["date", "cancel", "message", "pick", "send", "close"]);
    expect(tabs(box, 2, true)).toEqual(["send", "pick"]);
  });

  test("the popup's sign-up: never its hidden field, the honeypot (tabindex -1) or a link taken out of the tab order", () => {
    document.body.innerHTML = `
      <div id="box">
        <button data-name="close">✕</button>
        <input type="email" data-name="email" />
        <button type="submit" data-name="submit">Liitu</button>
        <a href="/privaatsus" data-name="privacy">Privaatsus</a>
        <input type="hidden" name="locale" value="et" data-name="hidden" />
        <div aria-hidden="true"><input name="website" tabindex="-1" data-name="honeypot" /></div>
        <a href="/x" tabindex="-1" data-name="skipped">x</a>
      </div>`;
    const box = document.getElementById("box")!;
    (box.querySelector('[data-name="close"]') as HTMLElement).focus();
    expect(tabs(box, 4)).toEqual(["email", "submit", "privacy", "close"]);
  });
});
