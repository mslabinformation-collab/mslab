import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ContactBlock, type ContactTexts } from "@/components/site/ContactBlock";
import { TrainerLink } from "@/components/site/TrainerLink";

vi.mock("@/server/actions/public", () => ({ submitContact: vi.fn() }));
// (next/image as a plain img: its style and src are what the site sends)
vi.mock("next/image", () => ({ default: (p: Record<string, unknown>) => createElement("img", { src: p.src, alt: p.alt, style: p.style }) }));

// The site's small round avatars cut the contact photo as Koolitaja's circle frames it (UX pass 11.11, A11/P7): the photo covers the round frame,
// placed by the point and zoomed about it (domain/site-editor.ts circleCrop). The portrait standing in keeps the avatars' own framing (no crop). By
// the contact form the avatar has the name only (P8: the reply time is the block's lead's).

const T: ContactTexts = {
  eyebrow: "Kontakt",
  title: "Võta ühendust.",
  lead: "Kirjuta Mariale — vastan tavaliselt ühe tööpäeva jooksul.",
  name: "Nimi",
  email: "E-post",
  message: "Sõnum",
  messagePlaceholder: "",
  submit: "Saada",
  sending: "Saadan…",
  sent: "Saadetud.",
  errorRequired: "",
  errorEmail: "",
  errorTooMany: "",
  errorGeneric: "",
};

/** The markup between the avatar's frame and the name after it. */
const avatarOf = (html: string, marker: string) => html.slice(html.indexOf(marker), html.indexOf("</span>", html.indexOf(marker)) + 7);

describe("the contact form's avatar", () => {
  test("the contact photo cut by its circle, and the name only beside it", () => {
    const html = renderToStaticMarkup(createElement(ContactBlock, { locale: "et", t: T, person: { name: "Maria Sosnina", photo: "/media/img/k.jpg", crop: { pos: "35% 25%", zoom: 180 } } }));
    const avatar = avatarOf(html, "data-contact-avatar");
    expect(avatar).toContain('src="/media/img/k.jpg"');
    expect(avatar).toContain("object-position:35% 25%;transform:scale(1.8);transform-origin:35% 25%");
    expect(html).toMatch(/data-contact-avatar=""[^]*?<\/span><b>Maria Sosnina<\/b><\/div>/);
    expect(html).not.toContain("<br");
  });

  test("the portrait standing in: the avatars' own framing (no style)", () => {
    const html = renderToStaticMarkup(createElement(ContactBlock, { locale: "et", t: T, person: { name: "Maria Sosnina", photo: "/media/img/p.jpg", crop: null } }));
    expect(avatarOf(html, "data-contact-avatar")).not.toContain("style=");
  });
});

describe("the course page's „Koolitaja“ line", () => {
  test("the 28 px avatar is cut by the same circle", () => {
    const html = renderToStaticMarkup(
      createElement(TrainerLink, { trainer: { name: "Maria Sosnina", role: "", text: "", portrait: "", avatar: "/media/img/k.jpg", avatarCrop: { pos: "40% 30%", zoom: 100 }, href: "/koolitaja" } }),
    );
    const avatar = avatarOf(html, "data-trainer-avatar");
    expect(avatar).toContain("object-position:40% 30%");
    expect(avatar).not.toContain("transform");
  });
});
