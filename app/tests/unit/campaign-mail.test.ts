import { describe, expect, test } from "vitest";
import { campaignContentFor, checkCampaignDraft, type NewsletterCampaignDraft } from "@/domain/newsletter-campaign";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import { campaignMail, type CampaignMailInput } from "@/server/campaign-mail";

// The newsletter campaign's mail (newsletter campaigns, Task 1; spec D5, D6): the account mails' card with the logo on top, the picture, the
// hidden preview line, the paragraphs, the code, the button and the footer (why she got it, the way out, the school). Every text of Maria's
// is escaped; the unsubscribe address is placed as it is given, because it is the subscriber's own link. The Russian footer texts are drafts
// for the native-speaker check; they are held to the account's typography rule (a no-break space after the one-letter words в, с, к, о, у).

const BASE = "https://mslab.example";
const LINK = "https://mslab.example/api/newsletter/loobu?t=abc_DEF-123";
const SCHOOL = { name: "MS LAB Koolituskeskus OÜ", address: "Rüütli 1, Pärnu" };

const checked = (raw: unknown): NewsletterCampaignDraft => {
  const r = checkCampaignDraft(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.fields));
  return r.value;
};
const FULL = checked({
  name: "Oktoobri pakkumine",
  subject: { et: "Sügispakkumine", ru: "Осеннее предложение" },
  preheader: { et: "−15% kõigile koolitustele", ru: "Скидка 15% на все курсы" },
  imageKey: "img/0f8fad5b-d9cb-469f-a165-70867728950e.jpg",
  body: { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац.\n\nВторой абзац." },
  code: "SUGIS15",
  buttonLabel: { et: "Vaata koolitusi", ru: "Смотреть курсы" },
  buttonHref: "/koolitused",
});

/** The input of a send to a subscriber of `pageLocale` (her language); the text is Maria's draft in `textLocale` (the Estonian one by default). */
function input(over: Partial<CampaignMailInput> = {}, draft: NewsletterCampaignDraft = FULL, pageLocale: "et" | "ru" = "et"): CampaignMailInput {
  return {
    content: campaignContentFor(draft, pageLocale),
    pageLocale,
    imageUrl: `${BASE}/media/img/flyer.jpg`,
    code: draft.code,
    buttonHref: draft.buttonHref,
    siteUrl: BASE,
    school: SCHOOL,
    unsubscribeHref: LINK,
    test: false,
    ...over,
  };
}

const lines = (text: string) => text.split("\n");
const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length;
/** The buttons of an HTML e-mail: the 48 px ink pills. */
const buttons = (html: string) => count(html, /mso-padding-alt/g);
const visibleText = (html: string) => html.replace(/<title>.*?<\/title>/, "").replace(/<[^>]+>/g, " ");

describe("campaignMail: the Estonian mail", () => {
  const mail = campaignMail(input());

  test("the subject is the campaign's; there is no recipient, no greeting and no signature (the mail is one text for all subscribers)", () => {
    expect(mail.subject).toBe("Sügispakkumine");
    expect(Object.keys(mail).sort()).toEqual(["html", "subject", "text"]);
    expect(lines(mail.text)[0]).toBe("Esimene lõik.");
  });

  test("the logo of the site on top (an absolute address), then the picture at the full width of the card, then the paragraphs, the code and the button", () => {
    const html = mail.html;
    expect(html).toContain(`<img src="${BASE}/brand/logo.png"`);
    expect(html).toContain(`<img src="${BASE}/media/img/flyer.jpg"`);
    expect(html).toMatch(/<img src="[^"]*flyer\.jpg"[^>]*style="display:block;width:100%;/);
    const at = (needle: string) => html.indexOf(needle);
    const order = [at("brand/logo.png"), at("flyer.jpg"), at("Esimene lõik."), at("Teine lõik."), at("SUGIS15"), at("Vaata koolitusi"), at("Said selle kirja")];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("one email-safe document: a title, the 480 px card of the account mails, tables and inline styles, no script and no external CSS", () => {
    expect(mail.html.startsWith("<!doctype html>")).toBe(true);
    expect(mail.html).toContain('<html lang="et">');
    expect(mail.html).toContain("<title>Sügispakkumine</title>");
    expect(mail.html).toContain('width="480"');
    expect(mail.html).not.toMatch(/<script|<link|<style/i);
  });

  test("the paragraphs are separate rows; the code is large in the lilac box; the button is the one ink pill, with the link written out under it", () => {
    expect(count(mail.html, /Esimene lõik\./g)).toBe(1);
    expect(mail.html).toContain("letter-spacing:8px");
    expect(buttons(mail.html)).toBe(1);
    expect(mail.html).toContain(`href="${BASE}/koolitused"`);
    expect(count(mail.html, new RegExp(`${BASE}/koolitused`, "g"))).toBe(3); // the button, and under it the link (its address and its text)
  });

  test("the footer in the subscriber's language: why she got it, the unsubscribe link, the school's name and address", () => {
    expect(mail.html).toContain("Said selle kirja, sest liitusid MS LAB-i uudiskirjaga.");
    expect(mail.html).toContain(`<a href="${LINK}"`);
    expect(mail.html).toMatch(/<a href="[^"]*"[^>]*>Loobu uudiskirjast<\/a>/);
    expect(mail.html).toContain("MS LAB Koolituskeskus OÜ");
    expect(mail.html).toContain("Rüütli 1, Pärnu");
  });

  test("the plain text holds the same paragraphs, the code, the button's address and the footer", () => {
    const text = lines(mail.text);
    expect(text).toContain("Esimene lõik.");
    expect(text).toContain("Teine lõik.");
    expect(text).toContain("SUGIS15");
    expect(text).toContain(`Vaata koolitusi: ${BASE}/koolitused`);
    expect(text).toContain("Said selle kirja, sest liitusid MS LAB-i uudiskirjaga.");
    expect(text).toContain(`Loobu uudiskirjast: ${LINK}`);
    expect(text).toContain("MS LAB Koolituskeskus OÜ");
    expect(text).toContain("Rüütli 1, Pärnu");
    expect(text.at(-1)).toBe("Rüütli 1, Pärnu");
    // the order is the mail's: paragraphs, code, button, then the footer
    const at = (needle: string) => text.indexOf(needle);
    expect([at("Esimene lõik."), at("Teine lõik."), at("SUGIS15"), at(`Vaata koolitusi: ${BASE}/koolitused`), at("Said selle kirja, sest liitusid MS LAB-i uudiskirjaga.")]).toEqual(
      [0, 2, 4, 6, 8],
    );
  });

  test("the plain text has no HTML in it and no preview line", () => {
    expect(mail.text).not.toMatch(/<[a-z/]/i);
    expect(mail.text).not.toContain("−15% kõigile koolitustele");
  });
});

describe("the images: the logo and the picture (fix round 1)", () => {
  const html = campaignMail(input()).html;
  const img = (src: string): string => {
    const tag = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`src="${src}"`));
    if (!tag) throw new Error(`no <img> with src ${src}`);
    return tag;
  };
  /** The card's inner width: the table of the account mails' card (480 wide) less its 1 px border on each side. */
  const inner = (): number => {
    const card = html.match(/<table role="presentation" width="(\d+)"[^>]*border:1px solid/);
    if (!card) throw new Error("no card");
    return Number(card[1]) - 2;
  };

  test("the logo: its address, the text \"MS LAB\" for clients that block images, the file's proportions (332x128 shown at 130x50), no border", () => {
    const logo = img(`${BASE}/brand/logo.png`);
    expect(logo).toContain('alt="MS LAB"');
    expect(logo).toContain('width="130"');
    expect(logo).toContain('height="50"');
    expect(logo).toMatch(/style="[^"]*width:130px;/);
    expect(logo).toMatch(/style="[^"]*height:auto;/);
    expect(logo).toMatch(/style="[^"]*border:0;/);
    expect(130 / 50).toBeCloseTo(332 / 128, 1);
  });

  test("the picture: the subject as its text, the width of the card's inside (Outlook reads the attribute, so 478 and not 480), full width and a free height elsewhere", () => {
    const picture = img(`${BASE}/media/img/flyer.jpg`);
    expect(inner()).toBe(478);
    expect(picture).toContain('alt="Sügispakkumine"');
    expect(picture).toContain(`width="${inner()}"`);
    expect(picture).not.toMatch(/ height="/); // (the file's height is not known here: the browser keeps its proportions)
    expect(picture).toMatch(/style="[^"]*display:block;/);
    expect(picture).toMatch(/style="[^"]*width:100%;/);
    expect(picture).toMatch(/style="[^"]*max-width:478px;/);
    expect(picture).toMatch(/style="[^"]*height:auto;/);
    expect(picture).toMatch(/style="[^"]*border:0;/);
  });

  test("the picture's text is the subject as the subscriber reads it (the Russian one for a Russian mail), escaped", () => {
    expect(img(`${BASE}/media/img/flyer.jpg`)).toContain('alt="Sügispakkumine"');
    const russian = campaignMail(input({}, FULL, "ru")).html;
    expect(russian).toMatch(/<img [^>]*src="[^"]*flyer\.jpg"[^>]*alt="Осеннее предложение"/);
    const quoted = campaignMail(input({ content: { ...input().content, subject: 'a "b" <c>' } })).html;
    expect(quoted).toMatch(/<img [^>]*src="[^"]*flyer\.jpg"[^>]*alt="a &quot;b&quot; &lt;c&gt;"/);
  });
});

describe("the preview line (preheader)", () => {
  test("it is the hidden first text of the HTML, ahead of the logo, the picture and every paragraph, and it is hidden", () => {
    const html = campaignMail(input()).html;
    const at = html.indexOf("−15% kõigile koolitustele");
    expect(at).toBeGreaterThan(html.indexOf("<body"));
    expect(at).toBeLessThan(html.indexOf("brand/logo.png"));
    expect(at).toBeLessThan(html.indexOf("flyer.jpg"));
    expect(at).toBeLessThan(html.indexOf("Esimene lõik."));
    const hidden = html.slice(html.lastIndexOf("<div", at), at);
    expect(hidden).toMatch(/display:none/);
    expect(hidden).toMatch(/max-height:0/);
    expect(hidden).toMatch(/overflow:hidden/);
    expect(hidden).toMatch(/opacity:0/);
    expect(visibleText(html).trimStart().startsWith("−15% kõigile koolitustele")).toBe(true); // (the first text a mail program finds)
  });

  test("it is followed by padding so that the inbox does not pull the paragraphs in after it", () => {
    const html = campaignMail(input()).html;
    const hiddenBlock = html.slice(html.indexOf("−15% kõigile koolitustele"), html.indexOf("brand/logo.png"));
    expect(count(hiddenBlock, /&zwnj;&nbsp;/g)).toBeGreaterThanOrEqual(50);
  });

  test("a campaign with no preview line has no hidden block", () => {
    const html = campaignMail(input({}, checked({ name: "n", subject: { et: "S" }, body: { et: "T" } }))).html;
    expect(html).not.toMatch(/display:none/);
  });

  test("it is escaped like every other text", () => {
    const html = campaignMail(input({ content: { ...input().content, preheader: '<b onclick="x">&' } })).html;
    expect(html).toContain("&lt;b onclick=&quot;x&quot;&gt;&amp;");
    expect(html).not.toContain("<b onclick");
  });
});

describe("what is escaped: every text of Maria's", () => {
  const evil = '<script>alert("x")</script> & \'q\'';
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;";
  const mail = campaignMail(
    input({
      content: { locale: "et", subject: evil, preheader: evil, paragraphs: [evil, `2 ${evil}`], buttonLabel: evil },
      code: evil,
      school: { name: evil, address: evil },
      buttonHref: "https://mslab.example/x?a=1&b=2",
    }),
  );

  test("the body, the code, the button label, the preview line, the subject (title and picture text) and the school stay text; no tag of theirs is in the HTML", () => {
    expect(mail.html).not.toContain("<script");
    expect(mail.html).not.toContain("alert(\"x\")");
    expect(mail.html).toContain(`<title>${escaped}</title>`);
    expect(count(mail.html, new RegExp(escaped.replace(/[()]/g, "\\$&"), "g"))).toBeGreaterThanOrEqual(8); // title, alt, preheader, 2 paragraphs, code, label, name, address
    expect(mail.html).toContain(`>${escaped}</a>`); // the button's label
  });

  test("the button's address is escaped in its attribute, and is the same text in the link written out under it", () => {
    expect(mail.html).toContain('href="https://mslab.example/x?a=1&amp;b=2"');
    expect(mail.html).not.toContain("a=1&b=2");
  });

  test("the plain text has them as they are (no HTML there to break)", () => {
    expect(lines(mail.text)).toContain(evil);
  });

  test("a subject cannot close the title or the picture's text attribute", () => {
    const html = campaignMail(input({ content: { ...input().content, subject: '"></title><img src=x onerror=alert(1)>' } })).html;
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror=alert(1)>');
  });
});

describe("the unsubscribe address is placed as it is given", () => {
  test("the subscriber's own link reaches href verbatim, and the plain text too", () => {
    const mail = campaignMail(input({ unsubscribeHref: "https://mslab.example/api/newsletter/loobu?t=Zx9_k-0123456789" }));
    expect(mail.html).toContain('<a href="https://mslab.example/api/newsletter/loobu?t=Zx9_k-0123456789"');
    expect(mail.text).toContain("Loobu uudiskirjast: https://mslab.example/api/newsletter/loobu?t=Zx9_k-0123456789");
  });

  test("a site address with a query is not rewritten (& stays &)", () => {
    const href = "https://mslab.example/api/newsletter/loobu?t=abc_DEF-123&l=ru";
    expect(campaignMail(input({ unsubscribeHref: href })).html).toContain(`<a href="${href}"`);
  });

  test("what could end the attribute or open a tag (a double quote, < and >) is escaped, the rest is left alone", () => {
    const html = campaignMail(input({ unsubscribeHref: 'https://x.example/"><script>alert(1)</script>' })).html;
    expect(html).not.toContain("<script");
    expect(html).toContain('<a href="https://x.example/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});

describe("the footer is in the subscriber's language, whatever language the text is in", () => {
  test("a Russian subscriber who gets the Estonian text (the Russian side is empty): Estonian content, Russian footer", () => {
    const noRu = checked({ ...FULL, subject: { et: "Sügispakkumine" }, body: { et: "Esimene lõik.\n\nTeine lõik." } });
    const content = campaignContentFor(noRu, "ru");
    expect(content.locale).toBe("et");
    const mail = campaignMail(input({ content, pageLocale: "ru" }, noRu, "ru"));
    expect(mail.subject).toBe("Sügispakkumine");
    expect(mail.html).toContain("Esimene lõik.");
    expect(mail.html).not.toContain("Said selle kirja");
    expect(mail.html).not.toContain("Loobu uudiskirjast");
    expect(mail.html).toContain(ru.mail.campaign.reason);
    expect(mail.html).toContain(ru.mail.campaign.unsubscribe);
    expect(mail.html).toContain('<html lang="et">'); // (the text's language: it is Estonian text)
    expect(lines(mail.text)).toContain(ru.mail.campaign.reason);
    expect(lines(mail.text)).toContain(`${ru.mail.campaign.unsubscribe}: ${LINK}`);
  });

  test("a Russian subscriber with a Russian campaign: Russian text, Russian footer, the button opens the Russian page of the site", () => {
    const mail = campaignMail(input({}, FULL, "ru"));
    expect(mail.subject).toBe("Осеннее предложение");
    expect(mail.html).toContain('<html lang="ru">');
    expect(mail.html).toContain("Первый абзац.");
    expect(mail.html).toContain("Смотреть курсы");
    expect(mail.html).toContain(ru.mail.campaign.reason);
    expect(mail.html).toContain(`href="${BASE}/ru/koolitused"`);
    expect(mail.html).toContain("Скидка 15% на все курсы");
  });

  test("an Estonian subscriber: the Estonian footer", () => {
    expect(campaignMail(input()).html).toContain(et.mail.campaign.reason);
    expect(campaignMail(input()).html).toContain(et.mail.campaign.unsubscribe);
  });
});

describe("the button's address", () => {
  const button = (buttonHref: string | null, pageLocale: "et" | "ru" = "et", siteUrl = BASE) => campaignMail(input({ buttonHref, siteUrl }, FULL, pageLocale)).html;

  test("a path of the site becomes an absolute address in the subscriber's language", () => {
    expect(button("/koolitused")).toContain(`href="${BASE}/koolitused"`);
    expect(button("/koolitused", "ru")).toContain(`href="${BASE}/ru/koolitused"`);
    expect(button("/praktika#taotlus", "ru")).toContain(`href="${BASE}/ru/praktika#taotlus"`);
    expect(button("/")).toContain(`href="${BASE}/"`);
    expect(button("/", "ru")).toContain(`href="${BASE}/ru"`);
  });

  test("a trailing slash of the site's address is not doubled", () => {
    expect(button("/koolitused", "et", `${BASE}/`)).toContain(`href="${BASE}/koolitused"`);
    expect(campaignMail(input({ siteUrl: `${BASE}/` })).html).toContain(`<img src="${BASE}/brand/logo.png"`);
  });

  test("a path that already has the language in front keeps it once", () => {
    expect(button("/ru/koolitused", "ru")).toContain(`href="${BASE}/ru/koolitused"`);
    expect(button("/ru/koolitused", "et")).toContain(`href="${BASE}/koolitused"`);
    expect(button("/ruumid", "ru")).toContain(`href="${BASE}/ru/ruumid"`);
  });

  test("an https address is used as it is", () => {
    expect(button("https://www.example.com/pakkumine?x=1", "ru")).toContain('href="https://www.example.com/pakkumine?x=1"');
  });

  test("an address that is neither (it cannot come from the check) gets no button, never a link to somewhere else", () => {
    for (const bad of ["javascript:alert(1)", "//evil.example/x", "/\\evil.example", "koolitused", ""]) {
      const html = button(bad);
      expect(buttons(html), bad).toBe(0);
      expect(html, bad).not.toContain("javascript:");
      expect(html, bad).not.toContain("evil.example");
    }
  });
});

describe("the parts that are left out when they are empty", () => {
  const without = (over: Partial<CampaignMailInput>) => campaignMail(input(over));

  test("no picture: no picture row (the logo is the only image)", () => {
    const mail = without({ imageUrl: null });
    expect(count(mail.html, /<img /g)).toBe(1);
    expect(mail.html).toContain("brand/logo.png");
  });

  test("with a picture: two images", () => {
    expect(count(campaignMail(input()).html, /<img /g)).toBe(2);
  });

  test("no code: no code box and no code line", () => {
    const mail = without({ code: null });
    expect(mail.html).not.toContain("letter-spacing:8px");
    expect(mail.html).not.toContain("SUGIS15");
    expect(mail.text).not.toContain("SUGIS15");
  });

  test("no button label or no address: no button, no link under it, no line in the plain text", () => {
    for (const mail of [without({ buttonHref: null }), without({ content: { ...input().content, buttonLabel: null } })]) {
      expect(buttons(mail.html)).toBe(0);
      expect(mail.html).not.toContain("/koolitused");
      expect(mail.text).not.toContain("koolitused");
      expect(mail.text).not.toContain("Vaata koolitusi");
    }
  });

  test("a Russian mail whose Russian button label is empty has no button (the Estonian label is not borrowed)", () => {
    // (checkCampaignDraft refuses such a draft now: this is a row stored before that rule, or made by hand)
    const noLabel: NewsletterCampaignDraft = { ...FULL, buttonLabel: { et: "Vaata koolitusi", ru: "" } };
    const mail = campaignMail(input({}, noLabel, "ru"));
    expect(mail.html).toContain("Первый абзац.");
    expect(buttons(mail.html)).toBe(0);
    expect(mail.html).not.toContain("Vaata koolitusi");
  });

  test("a school with no address prints no address line; the name alone is the line", () => {
    const mail = without({ school: { name: "MS LAB", address: "" } });
    expect(lines(mail.text).at(-1)).toBe("MS LAB");
    expect(mail.text.endsWith("\n")).toBe(false);
    expect(mail.html).toContain(">MS LAB<");
    expect(mail.html).not.toContain("Rüütli");
    expect(mail.html).not.toMatch(/<td[^>]*>\s*<\/td>/); // (no empty row)
  });

  test("a school with an address of only white space is the same as none; a name of none is \"MS LAB\"", () => {
    const mail = without({ school: { name: "  ", address: " \n " } });
    expect(lines(mail.text).at(-1)).toBe("MS LAB");
    expect(mail.html).toContain(">MS LAB<");
  });
});

describe("the test mail („Saada proov“)", () => {
  test("its subject starts with „[Proov]“, in the document's title too; the body is the campaign's, unchanged", () => {
    const live = campaignMail(input());
    const test = campaignMail(input({ test: true }));
    expect(test.subject).toBe("[Proov] Sügispakkumine");
    expect(test.html).toContain("<title>[Proov] Sügispakkumine</title>");
    expect(live.subject).toBe("Sügispakkumine");
    expect(live.html).not.toContain("[Proov]");
    expect(test.html.replace("<title>[Proov] ", "<title>")).toBe(live.html);
    expect(test.text).toBe(live.text);
  });

  test("the Russian test mail starts the same way (Maria reads it, whatever the language of the text)", () => {
    expect(campaignMail(input({ test: true }, FULL, "ru")).subject).toBe("[Proov] Осеннее предложение");
  });
});

describe("the texts of the footer", () => {
  test("the spec's Estonian words, verbatim", () => {
    expect(et.mail.campaign.reason).toBe("Said selle kirja, sest liitusid MS LAB-i uudiskirjaga.");
    expect(et.mail.campaign.unsubscribe).toBe("Loobu uudiskirjast");
  });

  test("Estonian and Russian hold the same keys, none empty", () => {
    expect(Object.keys(ru.mail.campaign).sort()).toEqual(Object.keys(et.mail.campaign).sort());
    for (const [key, text] of [...Object.entries(et.mail.campaign), ...Object.entries(ru.mail.campaign)]) expect(text.trim(), key).not.toBe("");
  });

  test("Russian typography: no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    for (const [key, text] of Object.entries(ru.mail.campaign)) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });

  test("the Russian words are Cyrillic (the draft is a translation, not a copy of the Estonian)", () => {
    for (const [key, text] of Object.entries(ru.mail.campaign)) expect(text, key).toMatch(/[а-яё]/i);
  });
});
