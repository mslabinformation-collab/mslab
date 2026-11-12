// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { Header } from "@/components/site/Header";

// the menu links mark the page they are on (usePathname): a page that is none of theirs
vi.mock("next/navigation", () => ({ usePathname: () => "/kontakt-test" }));

const draw = (locale: "et" | "ru") => {
  const box = document.createElement("div");
  box.innerHTML = renderToStaticMarkup(createElement(Header, { locale }));
  return box;
};
const labels = (nav: Element) => [...nav.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

// The site's header (UX pass 11.11, Dim's calls 1 and 3): no cart icon and no „0“ badge („Osta kohe“ is the checkout), and „Kontakt“ the last menu
// item on a computer and in the phone menu.
describe("the header (UX pass 11.11 P2, P9)", () => {
  test("the menu ends with „Kontakt“, on a computer and in the phone menu", () => {
    const box = draw("et");
    const navs = box.querySelectorAll('nav[aria-label="Põhimenüü"]');
    expect(navs).toHaveLength(2);
    const want = [
      ["Koolitused", "/koolitused"],
      ["Koolituskalender", "/koolituskalender"],
      ["Praktika", "/praktika"],
      ["Koolitaja", "/koolitaja"],
      ["Uudised ja nõuanded", "/uudised"],
      ["Kontakt", "/kontakt"],
    ];
    expect(labels(navs[0])).toEqual(want);
    // the phone menu: the same links, then the language and the account
    expect(labels(navs[1]).slice(0, want.length)).toEqual(want);
    const ru = draw("ru").querySelector('nav[aria-label="Главное меню"]')!;
    expect(labels(ru).at(-1)).toEqual(["Контакты", "/ru/kontakt"]);
  });

  test("no cart: no link to /ostukorv and no count", () => {
    const box = draw("et");
    expect(box.querySelector('a[href$="/ostukorv"]')).toBeNull();
    expect(box.querySelector('[aria-label="Ostukorv"]')).toBeNull();
    expect(box.textContent).not.toMatch(/\b0\b/);
  });
});
