// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { movesTo } from "@/components/admin/NavProgress";

// NavProgress (06.11 polish board 6): which clicks start the rose line — a move to another admin address made in this tab.

const here = new URL("https://mslab.ee/admin/maksed?staatus=makstud") as unknown as Location;
const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
function link(href: string, attrs: Record<string, string> = {}) {
  const a = document.createElement("a");
  a.href = new URL(href, "https://mslab.ee").href;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  return a;
}

describe("movesTo", () => {
  it("a menu entry or a row's drawer is a move", () => {
    expect(movesTo(link("/admin/opilased"), plain, here)).toBe("/admin/opilased");
    expect(movesTo(link("/admin/registreerimised?id=4"), plain, here)).toBe("/admin/registreerimised?id=4");
    expect(movesTo(link("/admin/maksed"), plain, here)).toBe("/admin/maksed");
  });

  it("the same address, a fragment of it, another tab, a download, a modifier key or a link away from the admin is not", () => {
    expect(movesTo(link("/admin/maksed?staatus=makstud"), plain, here)).toBeNull();
    expect(movesTo(link("/admin/maksed?staatus=makstud#arveta"), plain, here)).toBeNull();
    expect(movesTo(link("/admin/opilased", { target: "_blank" }), plain, here)).toBeNull();
    expect(movesTo(link("/admin/arved/1.pdf", { download: "" }), plain, here)).toBeNull();
    expect(movesTo(link("/admin/opilased"), { ...plain, ctrlKey: true }, here)).toBeNull();
    expect(movesTo(link("/admin/opilased"), { ...plain, button: 1 }, here)).toBeNull();
    expect(movesTo(link("/koolitused"), plain, here)).toBeNull();
    expect(movesTo(link("https://partner.montonio.com/orders"), plain, here)).toBeNull();
  });
});
