// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostEditor } from "@/components/admin/PostEditor";
import type { PostPartValue, SitePartState } from "@/domain/site-entities";
import { stubFetch } from "../fakes";

// C3 Uudised, the post (admin UX pass piece 4b, Task 2; README §4 C3; the Part 4 C3 frame; piece4-texts S4-19…S4-24, S4-4; rulings R-a, R-b, R-g): the
// site editors' page (site/SiteEditorPage.tsx) on the post's one part `post` (POST /api/admin/sisu/post/<id>/osa/post) — a published post with its
// PublishBar (S4-24's labels), one that is not published with the same header and no bar (it saves straight to its row, R-a) — the cover, „Pealkiri“,
// „Tekst“ and the kept fields, the footer line (S4-20) with „Kustuta postitus“ (S4-23), and „Avaldamine“ with the instant „Avaldatud“ (R-b: POST
// /api/admin/uudised/<id>/avaldatud, `Puudub: …` under it, S4-22). The address follows the title until the post is published, unless she types one
// (R-g); an address another post has is said at its field with ADM:2281, after a save, a publish or the switch (the "invalid" hold).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/admin/uudised/7",
  useSearchParams: () => new URLSearchParams(),
}));

const ID = 7;
const POST: PostPartValue = {
  title: { et: "Uued koolituskuupäevad Tartus", ru: "Новые даты в Тарту" },
  slug: "uued-koolituskuupaevad-tartus",
  category: { et: "Uudis", ru: "Новость" },
  excerpt: { et: "Detsembris Tartus.", ru: "" },
  body: { et: "Detsembris toome Kulmude LAMI koolituse Tartusse.", ru: "В декабре в Тарту." },
  coverKey: "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg",
  publishedAt: "2026-10-02",
};
const NEW: PostPartValue = { title: { et: "Uus postitus" }, slug: "uus-postitus-2", category: { et: "" }, excerpt: { et: "" }, body: { et: "" }, coverKey: "", publishedAt: "2026-10-27" };

/** The post's part as the page reads it (readSiteEditor): no draft, its value live. */
const partsOf = (value: PostPartValue, version = "l:post"): Record<string, SitePartState> => ({ post: { version, value, live: value } });

/** The routes: the part's version and value; a save from another version is a 409; a published post's save is a draft, an unpublished one's the row. */
const remote = {
  published: true,
  version: "l:post",
  value: POST as Record<string, unknown>,
  n: 0,
  refuse: null as null | Record<string, string>,
  avalda: (): Response => Response.json({ stamp: 5, published: ["post"], blocked: [] }),
  avaldatud: (): Response => Response.json({ ok: true, stamp: 5 }),
  log: [] as { version: string; patch: Record<string, unknown> }[],
  /** While set, a save waits for it before the route answers (a save on its way). */
  gate: null as Promise<void> | null,
  /** While set, the next save is stored — with these fields the server makes too (the address that follows the title) — but answered 500, once. */
  lost: null as null | Record<string, unknown>,
};
function resetRemote(published: boolean, value: PostPartValue) {
  remote.published = published;
  remote.version = "l:post";
  remote.value = { ...value };
  remote.n = 0;
  remote.refuse = null;
  remote.avalda = () => Response.json({ stamp: 5, published: ["post"], blocked: [] });
  remote.avaldatud = () => Response.json({ ok: true, stamp: 5 });
  remote.log = [];
  remote.gate = null;
  remote.lost = null;
}
const respond = (url: string, init: RequestInit | undefined): Response | Promise<Response> => {
  if (url === `/api/admin/sisu/post/${ID}/avalda`) return remote.avalda();
  if (url === `/api/admin/sisu/post/${ID}/loobu`) return Response.json({ stamp: 5 });
  if (url === `/api/admin/uudised/${ID}/avaldatud`) return remote.avaldatud();
  if (url === `/api/admin/uudised/${ID}/kustuta`) return Response.json({ ok: true });
  if (url !== `/api/admin/sisu/post/${ID}/osa/post`) return Response.json({ ok: false }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  remote.log.push(body);
  const gate = remote.gate;
  return gate ? gate.then(() => saveAnswer(body)) : saveAnswer(body);
};
/** The part's route's answer to a save (the version check, the value merged, the new version). */
const saveAnswer = (body: { version: string; patch: Record<string, unknown> }): Response => {
  if (remote.refuse) return Response.json({ ok: false, error: "invalid", fields: remote.refuse }, { status: 400 });
  if (body.version !== remote.version) return Response.json({ ok: false, error: "conflict", version: remote.version, value: remote.value }, { status: 409 });
  remote.n += 1;
  remote.value = { ...remote.value, ...body.patch };
  remote.version = remote.published ? `d:1.${remote.n}` : `l:row-${remote.n}`;
  if (remote.lost) {
    remote.value = { ...remote.value, ...remote.lost };
    remote.lost = null;
    return Response.json({ ok: false, error: "server" }, { status: 500 });
  }
  return Response.json({ ok: true, version: remote.version, savedAt: "2026-10-27T09:15:00.000Z" });
};

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => Array.from(container.querySelectorAll<E>(selector));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
type Props = Parameters<typeof PostEditor>[0];
const props = (over: Partial<Props> = {}): Props => ({ id: ID, published: true, parts: partsOf(POST), stamp: 1, created: false, search: "", ...over });
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(PostEditor, props(over))));
  await settle();
};
const type = async (el: Element | null, value: string) => {
  expect(el, "the field to type in").not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const leave = async (el: Element | null) => {
  await act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** A field by its name: a one-language field's data-field, a two-language field's data-i18n (the ET side). */
const field = <E extends HTMLElement = HTMLInputElement>(name: string) => $<E>(`[data-field="${name}"], [data-i18n="${name}"]`);
const errorOf = (name: string) => {
  const el = field(name);
  const ids = (el?.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)).find((p) => p?.hasAttribute("data-field-error") || p?.className.includes("error")) ?? null;
};
const button = (name: string) => $$<HTMLButtonElement>("button").find((b) => text(b) === name) ?? null;
const posts = () => fetched.calls.filter((c) => c.method === "POST").map((c) => c.url);
const chipWords = () => text($("[data-save-status] [role=status]"));

beforeEach(() => {
  localStorage.clear();
  resetRemote(true, POST);
  fetched = stubFetch(respond);
  router.refresh.mockReset();
  router.push.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.restoreAllMocks();
});

describe("a published post: the template with its bar (S4-24, S4-20)", () => {
  it("H1 the title, „Vaata lehel ↗“ at its live address; a changed „Tekst“ is on the bar with „· avaldamata“; the preview is the live address in draft mode", async () => {
    await show();
    expect(text($("h1"))).toBe("Uued koolituskuupäevad Tartus");
    expect($<HTMLAnchorElement>("[data-site-view]")?.getAttribute("href")).toBe("/uudised/uued-koolituskuupaevad-tartus");
    expect($("[data-publish-bar]")).toBeNull();
    await type(field("post.body"), "Detsembris toome LAMI koolituse Tartusse.");
    await leave(field("post.body"));
    expect(text($("[data-publish-words]"))).toBe("Avaldamata muudatused: 1 · Tekst. Avalikul lehel on näha eelmine versioon.");
    expect($<HTMLAnchorElement>("[data-publish-preview]")?.getAttribute("href")).toBe(`/api/admin/eelvaade?tee=${encodeURIComponent("/uudised/uued-koolituskuupaevad-tartus")}`);
    expect(field("post.body")!.closest("[data-unpublished]")).not.toBeNull();
    expect(remote.log).toEqual([{ version: "l:post", patch: { body: { et: "Detsembris toome LAMI koolituse Tartusse.", ru: "В декабре в Тарту." } } }]);
    expect(chipWords()).toMatch(/^Mustand salvestatud \d\d:\d\d$/);
  });

  it("the footer line: `Avaldatud {dd.mm.yyyy} · /uudised/{slug}` of what the public sees; the switch is on", async () => {
    await show();
    expect(text($("[data-post-where]"))).toBe("Avaldatud 02.10.2026 · /uudised/uued-koolituskuupaevad-tartus");
    expect($<HTMLInputElement>('[data-field="post.published"]')?.checked).toBe(true);
  });

  it("the editor's card: the cover, „Pealkiri“, „Tekst“ (its 150 px box), then „Aadress“, „Kategooria“, „Lühitekst“, „Kuupäev“", async () => {
    await show();
    const card = $("#postitus");
    const order = Array.from(card?.querySelectorAll<HTMLElement>("[data-single-image], [data-i18n], [data-field]") ?? []).map(
      (el) => el.getAttribute("data-single-image") ?? el.getAttribute("data-i18n") ?? el.getAttribute("data-field"),
    );
    expect(order).toEqual(["cover", "post.title", "post.body", "post.slug", "post.category", "post.excerpt", "post.publishedAt"]);
    // the card's name is „Postitus“ (ADM:2259), not its text field's (review m7)
    expect(card?.getAttribute("aria-label")).toBe("Postitus");
    expect(field("post.body")?.tagName).toBe("TEXTAREA");
    // „Avaldamine“ is its own card, with the switch and its hint
    expect(text($("[data-post-publish] h2"))).toBe("Avaldamine");
    expect(text($("[data-post-publish]"))).toContain("Avaldatud postitus on blogis ja avalehel nähtav.");
  });
});

describe("a post that is not published (R-a): the same header, no bar", () => {
  it("no bar, no „· avaldamata“, no „Vaata lehel ↗“; a field typed and left saves to its row, the chip says „Salvestatud“; the footer `Mustand · /uudised/{slug}`", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    expect(text($("h1"))).toBe("Uus postitus");
    expect($("[data-site-view]")).toBeNull();
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/uus-postitus-2");
    await type(field("post.category"), "Uudis");
    await leave(field("post.category"));
    expect(remote.log.at(-1)?.patch).toEqual({ category: { et: "Uudis" } });
    expect($("[data-publish-bar]")).toBeNull();
    expect($("[data-unpublished]")).toBeNull();
    expect(chipWords()).toMatch(/^Salvestatud \d\d:\d\d$/);
    expect($<HTMLInputElement>('[data-field="post.published"]')?.checked).toBe(false);
  });

  it("no cover yet: the empty area is the drawn one, across the card and 220 px tall, with „Vali pilt“ under it (review m10); other screens keep theirs", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    const empty = $('[data-single-image="cover"] [data-no-image]');
    expect(text(empty)).toBe("Pilti pole veel valitud.");
    expect(empty?.closest('[class*="cover"]')).not.toBeNull();
    expect(text($('[data-single-image="cover"]'))).toContain("Vali pilt");
    const css = readFileSync(join(process.cwd(), "src/components/admin/PostEditor.module.css"), "utf8");
    expect(css).toMatch(/\.cover img\[data-current-image\],\s*\.cover \[data-no-image\] \{\s*max-width: none;\s*height: 220px;\s*border-radius: 16px;/);
    // (SingleImage's own box, which the other screens use, is as it was)
    expect(readFileSync(join(process.cwd(), "src/components/admin/site-editor.module.css"), "utf8")).toMatch(/\.singleImage,\s*\.noImage \{\s*width: 100%;\s*max-width: 420px;/);
  });

  it("„Lisa postitus +“ opened it (`?loodud=1`): ADM:2273's line, and the cursor is in „Pealkiri“", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW), created: true });
    expect(text($("[data-post-created]"))).toBe("Postitus loodud. Lisa kaanepilt ja avalda, kui kõik on valmis.");
    expect(document.activeElement).toBe(field("post.title"));
    // published (the switch's read, the address unchanged): the line has nothing more to ask
    await show({ published: true, parts: partsOf(NEW), created: true, stamp: 5 });
    expect($("[data-post-created]")).toBeNull();
  });
});

describe("„Avaldatud“ (R-b, S4-22)", () => {
  it("on, refused: `Puudub: kaanepilt` under the switch, the switch off again, the cards take typing, nothing read", async () => {
    resetRemote(false, NEW);
    remote.avaldatud = () => Response.json({ ok: false, missing: ["kaanepilt"] });
    await show({ published: false, parts: partsOf(NEW) });
    await click(field("post.published"));
    expect(posts()).toEqual([`/api/admin/uudised/${ID}/avaldatud`]);
    expect(fetched.calls.at(-1)?.body).toEqual({ on: true });
    const said = $("[data-switch-error]");
    expect(text(said)).toBe("Puudub: kaanepilt");
    expect(said?.getAttribute("role")).toBe("alert");
    expect(field("post.published")!.getAttribute("aria-describedby")).toContain(said!.id);
    expect($<HTMLInputElement>('[data-field="post.published"]')?.checked).toBe(false);
    expect($("[data-cards-waiting]")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    // the part's next save takes the line away
    await type(field("post.category"), "Uudis");
    await leave(field("post.category"));
    expect($("[data-switch-error]")).toBeNull();
  });

  it("on, done: what is typed is saved first, then the switch; the cards wait for the page's read from its stamp", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await type(field("post.category"), "Uudis");
    await click(field("post.published"));
    expect(posts()).toEqual([`/api/admin/sisu/post/${ID}/osa/post`, `/api/admin/uudised/${ID}/avaldatud`]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect($("[data-cards-waiting]")).not.toBeNull();
    expect($<HTMLInputElement>('[data-field="post.published"]')?.checked).toBe(true);
    // the read the answer asked for (stamp 5): a published post, with its bar's header
    await show({ published: true, parts: partsOf({ ...NEW, category: { et: "Uudis" } }), stamp: 5 });
    expect($("[data-cards-waiting]")).toBeNull();
    expect($("[data-site-view]")).not.toBeNull();
  });

  it("a save that does not go through switches nothing: no switch POST, the chip says why — brought into view, the focus on its „Näita“ (review m5)", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    remote.refuse = { title: "required" };
    await type(field("post.title"), "");
    await click(field("post.published"));
    expect(posts()).toEqual([`/api/admin/sisu/post/${ID}/osa/post`]);
    expect($<HTMLInputElement>('[data-field="post.published"]')?.checked).toBe(false);
    expect($("[data-save-status]")?.getAttribute("data-save-kind")).toBe("invalid");
    expect(document.activeElement).toBe($("[data-save-status] button"));
    expect(text(document.activeElement)).toBe("Näita");
    expect($("[data-cards-waiting]")).toBeNull();
  });

  it("off, refused because a draft was changed meanwhile: the bar lists it after the page's read", async () => {
    remote.avaldatud = () => Response.json({ ok: false, blocked: [{ part: "post", reason: "changed", fields: ["Pealkiri"] }] });
    await show();
    await click(field("post.published"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const changed = { ...POST, title: { et: "Teises aknas", ru: POST.title.ru } };
    await show({ parts: { post: { version: "d:1.9", value: changed, live: POST } }, stamp: 6 });
    expect(text($("[data-publish-blocked] li"))).toBe("Pealkiri");
    expect($<HTMLInputElement>('[data-field="post.published"]')?.checked).toBe(true);
  });
});

describe("an address another post has (ADM:2281): the \"invalid\" hold, said at the field — never an empty notice under the bar", () => {
  const taken = [{ part: "post", reason: "invalid", fields: ["Aadress"], errors: { slug: "slugTaken" } }];

  it("„Avalda muudatused“: „See aadress on juba teisel postitusel.“ at „Aadress“, the focus there; no notice under the bar; its next save takes the words away", async () => {
    remote.avalda = () => Response.json({ stamp: 5, published: [], blocked: taken });
    await show();
    await type(field("post.slug"), "kuidas-valida-kulmuvarvi");
    await leave(field("post.slug"));
    await click($("[data-publish-go]"));
    expect(text(errorOf("post.slug"))).toBe("See aadress on juba teisel postitusel.");
    expect(field("post.slug")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field("post.slug"));
    expect($("[data-publish-blocked]")).toBeNull();
    expect($("[data-publish-bar]")).not.toBeNull();
    expect($("[data-cards-waiting]")).toBeNull();
    await type(field("post.slug"), "kulmuvarv-2026");
    await leave(field("post.slug"));
    expect(errorOf("post.slug")).toBeNull();
  });

  it("„Avaldatud“ on, answered with the same hold: the same words at „Aadress“, nothing under the switch", async () => {
    resetRemote(false, NEW);
    remote.avaldatud = () => Response.json({ ok: false, blocked: taken });
    await show({ published: false, parts: partsOf(NEW) });
    await click(field("post.published"));
    expect(text(errorOf("post.slug"))).toBe("See aadress on juba teisel postitusel.");
    expect($("[data-switch-error]")).toBeNull();
    expect(document.activeElement).toBe(field("post.slug"));
  });

  it("a save the server refuses with `slugTaken` (a typed address, R-g) says the post's words, not the course's", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    remote.refuse = { slug: "slugTaken" };
    await type(field("post.slug"), "kuidas-valida-kulmuvarvi");
    await leave(field("post.slug"));
    expect(text(errorOf("post.slug"))).toBe("See aadress on juba teisel postitusel.");
  });
});

describe("the address follows the title until the post is first published (R-g; Task 1's hand-off)", () => {
  it("a new title: the field shows its address, the save sends no `slug`; the page read after it brings the stored one (numbered), taken as saved", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await type(field("post.title"), "Kevad");
    expect(field("post.slug")!.value).toBe("kevad");
    await leave(field("post.title"));
    expect(remote.log.at(-1)?.patch).toEqual({ title: { et: "Kevad" } });
    // the save changed the list's row: the page is read again
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const stored = { ...NEW, title: { et: "Kevad" }, slug: "kevad-2" };
    await show({ published: false, parts: { post: { version: remote.version, value: stored, live: stored } } });
    expect(field("post.slug")!.value).toBe("kevad-2");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/kevad-2");
    // nothing sent for it, and a body save neither sends it nor reads the page
    await type(field("post.body"), "Tekst.");
    await leave(field("post.body"));
    expect(remote.log.at(-1)?.patch).toEqual({ body: { et: "Tekst." } });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("an address she types is hers: it is sent, and the title no longer moves it", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await type(field("post.slug"), "minu-aadress");
    await leave(field("post.slug"));
    expect(remote.log.at(-1)?.patch).toEqual({ slug: "minu-aadress" });
    await type(field("post.title"), "Kevad");
    expect(field("post.slug")!.value).toBe("minu-aadress");
  });

  // review I-1 (1): the page's read for one title lands while the save of the next title is on its way. Its address is that earlier title's: not taken
  // while the save is on its way (and never sent: the engine would have sent it as typed, and the address would stop following); the field shows the
  // address the newest title makes until the read after that save brings the stored one.
  it("a new post's title typed while another save is on its way still follows: the read's address is never sent, the next read's is taken", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await type(field("post.title"), "Kevad");
    await leave(field("post.title"));
    const first = remote.version;
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // the next title goes out and hangs
    let open = () => {};
    remote.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await type(field("post.title"), "Kevadine");
    await leave(field("post.title"));
    expect(remote.log.map((b) => b.patch)).toEqual([{ title: { et: "Kevad" } }, { title: { et: "Kevadine" } }]);
    // the read asked for after „Kevad“ lands now, with the address the server made of it
    const readOne = { ...NEW, title: { et: "Kevad" }, slug: "kevad" };
    await show({ published: false, parts: { post: { version: first, value: readOne, live: readOne } } });
    expect(field("post.slug")!.value).toBe("kevadine");
    remote.gate = null;
    await act(async () => open());
    await settle();
    await act(async () => void (await new Promise((r) => setTimeout(r, 1700))));
    await settle();
    // nothing went out for the address: it still follows the title
    expect(remote.log.map((b) => b.patch)).toEqual([{ title: { et: "Kevad" } }, { title: { et: "Kevadine" } }]);
    expect(field("post.slug")!.value).toBe("kevadine");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/kevadine");
    // the read after „Kevadine“: its stored address (numbered) is taken
    const readTwo = { ...NEW, title: { et: "Kevadine" }, slug: "kevadine-2" };
    await show({ published: false, parts: { post: { version: remote.version, value: readTwo, live: readTwo } } });
    expect(field("post.slug")!.value).toBe("kevadine-2");
    expect(remote.log).toHaveLength(2);
  });

  // review I-1 (2): an address she typed, kept in this browser's copy and not saved (she left with the save queued, R-i), comes back with the next
  // visit: it is hers — saved, shown, and never put back by a read made before its save.
  it("a restored typed address is not reverted by a stale read", async () => {
    resetRemote(false, NEW);
    localStorage.setItem(`mslab-draft:site:post:${ID}:post:old`, JSON.stringify({ version: "l:post", fields: { ...NEW, slug: "minu-aadress" }, sent: [], at: 1 }));
    await show({ published: false, parts: partsOf(NEW) });
    expect(remote.log.map((b) => b.patch)).toEqual([{ slug: "minu-aadress" }]);
    expect(field("post.slug")!.value).toBe("minu-aadress");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/minu-aadress");
    // a read from before its save (its version is not the part's now), then the same read again
    await show({ published: false, parts: partsOf(NEW) });
    await show({ published: false, parts: partsOf(NEW) });
    await act(async () => void (await new Promise((r) => setTimeout(r, 1700))));
    expect(field("post.slug")!.value).toBe("minu-aadress");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/minu-aadress");
    expect(remote.log).toHaveLength(1);
    // and the title does not move it
    await type(field("post.title"), "Kevad");
    expect(field("post.slug")!.value).toBe("minu-aadress");
  });

  // piece 4b final review I-1: the title's save is stored — with the address the server makes from it — but its answer is lost. The retry meets the
  // stored value in a 409: her own save, not another window's. No conflict notice, the address is the server's, and it goes on following the title.
  it("a lost answer of a title save, then the retry's 409: no conflict, the address shows the server's `kevad` and goes on following", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    remote.lost = { slug: "kevad" };
    await type(field("post.title"), "Kevad");
    await leave(field("post.title"));
    expect(remote.log.map((b) => b.patch)).toEqual([{ title: { et: "Kevad" } }]);
    // back online: the retry goes from the version the lost answer never brought
    await act(async () => void window.dispatchEvent(new Event("online")));
    await settle();
    expect(remote.log).toEqual([
      { version: "l:post", patch: { title: { et: "Kevad" } } },
      { version: "l:post", patch: { title: { et: "Kevad" } } },
    ]);
    expect(chipWords()).not.toContain("teises aknas");
    expect(button("Taasta minu tekst")).toBeNull();
    expect(field("post.slug")!.value).toBe("kevad");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/kevad");
    // a new title moves it again, and the address was never sent as typed
    await type(field("post.title"), "Kevadine");
    expect(field("post.slug")!.value).toBe("kevadine");
    await leave(field("post.title"));
    expect(remote.log.at(-1)).toEqual({ version: "l:row-1", patch: { title: { et: "Kevadine" } } });
    expect(remote.log.some((b) => "slug" in b.patch)).toBe(false);
  });

  // Task 2 re-review N-2: the read after a title save is skipped when another save landed before it (review I-1), so the engine still holds the old
  // address; she then types and leaves before it is sent, and the copy holds that old address too. The next visit must not take it as hers: it is
  // the field's confirmed text in the copy, so the read's address stands, nothing is sent for it, and it goes on following the title.
  it("a restored copy keeps following: an address she never typed (the engine's, from before a skipped read) is not sent as typed", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await type(field("post.title"), "Kevad");
    await leave(field("post.title"));
    const afterTitle = remote.version;
    remote.value = { ...remote.value, slug: "kevad" }; // (the server made it from the title, R-g)
    await type(field("post.body"), "Tekst.");
    await leave(field("post.body"));
    // the read asked for after the title lands now: a save has landed since, so its address is not taken (the engine keeps the old one)
    const read = { ...NEW, title: { et: "Kevad" }, slug: "kevad" };
    await show({ published: false, parts: { post: { version: afterTitle, value: read, live: read } } });
    expect(field("post.slug")!.value).toBe("kevad");
    // she types on and leaves the post before it is sent: the copy keeps the text
    await type(field("post.body"), "Tekst. Veel.");
    await act(async () => root.render(createElement("div")));
    await settle();
    expect(remote.log.map((b) => b.patch)).toEqual([{ title: { et: "Kevad" } }, { body: { et: "Tekst." } }]);
    // the next visit: the page's read, then the copy resumed — only the typed text goes, the address is the server's and still follows
    const stored = remote.value as PostPartValue;
    await show({ published: false, parts: { post: { version: remote.version, value: stored, live: stored } } });
    expect(remote.log.at(-1)?.patch).toEqual({ body: { et: "Tekst. Veel." } });
    expect(field("post.slug")!.value).toBe("kevad");
    await type(field("post.title"), "Kevadine");
    expect(field("post.slug")!.value).toBe("kevadine");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/kevadine");
  });

  it("an emptied address is the title's again: the field, its hint and the footer say the title's address, never an empty one (review m6)", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await type(field("post.slug"), "minu-aadress");
    await leave(field("post.slug"));
    await type(field("post.slug"), "");
    expect(field("post.slug")!.value).toBe("uus-postitus");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/uus-postitus");
    expect(text(field("post.slug")!.closest("[class]")?.parentElement ?? null)).toContain("Lehe aadress: /uudised/uus-postitus.");
    await leave(field("post.slug"));
    expect(remote.log.at(-1)?.patch).toEqual({ slug: "" });
    // following again: a new title makes it
    await type(field("post.title"), "Kevad");
    expect(field("post.slug")!.value).toBe("kevad");
    expect(text($("[data-post-where]"))).toBe("Mustand · /uudised/kevad");
  });

  it("a published post's address never follows", async () => {
    await show();
    await type(field("post.title"), "Kevad");
    expect(field("post.slug")!.value).toBe("uued-koolituskuupaevad-tartus");
  });

  it("a published post: the first draft save reads the page again (its row says „Avaldamata muudatused“), the next one does not", async () => {
    await show();
    await type(field("post.body"), "Uus tekst.");
    await leave(field("post.body"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await type(field("post.body"), "Uus tekst, veel.");
    await leave(field("post.body"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("„Kustuta postitus“ (S4-23)", () => {
  it("its ConfirmPanel, with the public line for a published post; „Katkesta“ gives the focus back; yes: the post goes, the list opens with `?kustutatud=1`", async () => {
    localStorage.setItem(`mslab-draft:site:post:${ID}:post:old`, JSON.stringify({ version: "l:post", fields: POST, sent: [], at: 1 }));
    localStorage.setItem("mslab-draft:site:post:70:post:old", "{}");
    await show({ search: "kulmu" });
    await click(button("Kustuta postitus"));
    const panel = $("[data-confirm-panel]");
    expect(text(panel?.querySelector("p") ?? null)).toBe("Kas kustutan selle postituse?");
    expect($$("[data-confirm-panel] li").map(text)).toEqual(["Postitus kaob blogist ja avalehelt.", "Seda ei saa tagasi võtta."]);
    expect(button("Jah, kustuta")).not.toBeNull();
    await click(button("Katkesta"));
    expect(document.activeElement).toBe(button("Kustuta postitus"));
    await click(button("Kustuta postitus"));
    await click(button("Jah, kustuta"));
    expect(posts()).toEqual([`/api/admin/uudised/${ID}/kustuta`]);
    expect(router.push).toHaveBeenCalledWith("/admin/uudised?otsi=kulmu&kustutatud=1");
    expect(router.refresh).toHaveBeenCalled();
    expect(Object.keys(localStorage)).toEqual(["mslab-draft:site:post:70:post:old"]);
  });

  it("a post that is not published: no public line", async () => {
    resetRemote(false, NEW);
    await show({ published: false, parts: partsOf(NEW) });
    await click(button("Kustuta postitus"));
    expect($$("[data-confirm-panel] li").map(text)).toEqual(["Seda ei saa tagasi võtta."]);
  });
});

describe("gone (S4-4)", () => {
  it("a save answered 404: „Seda postitust enam ei ole. Tekst on selles seadmes alles.“", async () => {
    await show({ id: 8 });
    await type(field("post.body"), "Uus.");
    await leave(field("post.body"));
    expect(chipWords()).toBe("Seda postitust enam ei ole. Tekst on selles seadmes alles.");
  });
});
