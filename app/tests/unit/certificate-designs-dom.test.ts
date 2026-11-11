// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import type { AutosaveStatus } from "@/domain/autosave";
import type { DesignCardRow } from "@/server/certificate-designs";
import { stubFetch } from "../fakes";

// Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1) in a browser-like document (happy-dom), the routes answered here:
// one bordered box per design, as the UX pass (11.11, board 1) draws it — the header (the name, „Vaikimisi“ on the first, the tone pills, how many
// courses use it, „Vaata näidist ↗“), the picture (the preview is the drop zone, „Vaheta pilt · Eemalda“ under it) with its hint lines, „Kustuta“
// (greyed with the reason while in use or the last) — each autosaving on api/admin/tunnistuse-kujundus/<id> from its own version under the page's
// one status, the dashed add row „Lisa kujundus +“ at the end, „Kustuta“ through the confirmation. The photo goes up as a certificate background (a
// JPEG only, POST /api/admin/upload?for=certificate-background).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/shrink-image", () => ({ shrinkImage: async (file: File) => file, ShrinkError: class ShrinkError extends Error {} }));

import { CertificateDesigns } from "@/components/admin/CertificateDesigns";
import { CertificateSettings, type CertificateSettingsInitial } from "@/components/admin/CertificateSettings";

const LIGHT: DesignCardRow = { id: 1, name: "Hele", tone: "light", backgroundKey: "img/hele.jpg", sort: 1, version: "k:hele", courses: 3 };
const DARK: DesignCardRow = { id: 2, name: "Tume", tone: "dark", backgroundKey: "", sort: 2, version: "k:tume", courses: 1 };
const SPARE: DesignCardRow = { id: 5, name: "Kevad", tone: "light", backgroundKey: "", sort: 3, version: "k:kevad", courses: 0 };
const SAMPLE = "/api/admin/naidistunnistus?place=P%C3%A4rnu";

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
let versions: Record<number, string>;
let refuse: Record<string, string> | null;
let removal: Response | null;
let statuses: [string, AutosaveStatus][];
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  if (url === "/api/admin/upload?for=certificate-background") return Response.json({ ok: true, key: "img/taust.jpg" });
  if (url === "/api/admin/tunnistuse-kujundus" && init?.method === "POST") return Response.json({ ok: true, id: 9 }, { status: 201 });
  const row = /^\/api\/admin\/tunnistuse-kujundus\/(\d+)$/.exec(url);
  if (!row) return Response.json({ ok: false }, { status: 404 });
  const id = Number(row[1]);
  if (init?.method === "DELETE") return removal ?? Response.json({ ok: true });
  const body = JSON.parse(String(init?.body)) as { version: string };
  if (refuse) {
    const fields = refuse;
    refuse = null;
    return Response.json({ ok: false, error: "invalid", fields }, { status: 400 });
  }
  if (body.version !== versions[id]) return Response.json({ ok: false, error: "conflict", version: versions[id], value: {} }, { status: 409 });
  versions[id] = `${versions[id]}+`;
  return Response.json({ ok: true, version: versions[id], savedAt: "2026-11-11T11:20:00.000Z" });
};
const saves = () =>
  fetched.calls
    .filter((c) => c.method === "POST" && /tunnistuse-kujundus\/\d+$/.test(c.url))
    .map((c) => ({ url: c.url, ...(c.body as { version: string; patch: Record<string, unknown> }) }));

const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const rowOf = (id: number) => $(`[data-design-row="${id}"]`)!;
const show = async (designs: DesignCardRow[] = [LIGHT, DARK, SPARE]) => {
  await act(async () => root.render(createElement(CertificateDesigns, { designs, sampleHref: SAMPLE, onStatus: (part: string, s: AutosaveStatus) => void statuses.push([part, s]) })));
  await settle();
};
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
const buttonIn = (within: ParentNode, words: string) => [...within.querySelectorAll("button")].find((b) => text(b) === words) ?? null;

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset();
  versions = { 1: "k:hele", 2: "k:tume", 5: "k:kevad", 9: "k:uus" };
  refuse = null;
  removal = null;
  statuses = [];
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.useRealTimers();
});

describe("CertificateDesigns", () => {
  test("a box per design in order: the header (name, „Vaikimisi“ on the first, tone, count, sample), the picture with its hint lines, „Kustuta“ greyed with why while in use", async () => {
    await show();
    expect(text($("h2"))).toBe("Kujundused");
    expect(container.textContent).toContain(
      "Tunnistuse taust ja teksti värv. Koolituse kaardil „Tunnistus“ valid, millist kujundust see koolitus kasutab. Väljastatud tunnistused jäävad selliseks, nagu need väljastati.",
    );
    const rows = [...container.querySelectorAll("[data-design-row]")];
    expect(rows.map((r) => r.getAttribute("data-design-row"))).toEqual(["1", "2", "5"]);
    expect(rows.map((r) => $<HTMLInputElement>("[data-design-name]", r)!.value)).toEqual(["Hele", "Tume", "Kevad"]);
    expect($<HTMLInputElement>("[data-design-name]", rows[0])!.getAttribute("aria-label")).toBe("Kujunduse nimi");
    expect(rows.map((r) => text($("legend", r)))).toEqual(["Kujundus „Hele“", "Kujundus „Tume“", "Kujundus „Kevad“"]);
    expect(rows.map((r) => text($("[data-design-default]", r)))).toEqual(["Vaikimisi", "", ""]);
    expect(rows.map((r) => $<HTMLInputElement>("[data-design-tone]:checked", r)!.value)).toEqual(["light", "dark", "light"]);
    expect([...rows[0].querySelectorAll("[data-design-tone]")].map((r) => text(r.closest("label")))).toEqual(["Hele taust, tume tekst", "Tume taust, hele tekst"]);
    expect(rows.map((r) => text($("[data-design-used]", r)))).toEqual(["Kasutab 3 koolitust", "Kasutab 1 koolitus", "Pole kasutusel"]);
    expect(text(rows[0])).toContain("Koolitus, millel kujundust valitud pole, kasutab vaikimisi kujundust.");
    expect(text(rows[1])).not.toContain("Koolitus, millel kujundust valitud pole");
    // the preview is the drop zone: the picture, or (none yet) dashed with „Lohista pilt siia“ and „Vali pilt“ in it
    expect($("[data-drop-zone] [data-current-image]", rows[0])!.getAttribute("data-current-image")).toBe("img/hele.jpg");
    expect(text($("[data-drop-zone][data-no-image]", rows[1]))).toBe("Lohista pilt siiaVali pilt");
    expect(text(rows[0])).toContain("Lohista uus pilt eelvaatele või vajuta „Vaheta pilt“. JPEG, kuni 1,5 MB, horisontaalne A4 (näiteks 3508 × 2480 px). Pilt kärbitakse lehe järgi.");
    expect(text(rows[1])).toContain("Pilti pole veel. JPEG, kuni 1,5 MB, horisontaalne A4 (näiteks 3508 × 2480 px). Ilma pildita on taust ühtlane.");
    expect(text($("[data-image-field]", rows[0]))).toContain("Vaheta pilt");
    expect(text($("[data-image-remove]", rows[0]))).toBe("Eemalda");
    expect($("[data-image-remove]", rows[1])).toBeNull();
    expect(rows.map((r) => $<HTMLAnchorElement>("[data-design-sample]", r)!.getAttribute("href"))).toEqual([`${SAMPLE}&design=1`, `${SAMPLE}&design=2`, `${SAMPLE}&design=5`]);
    expect(text($("[data-design-sample]", rows[0]))).toBe("Vaata näidist ↗");
    expect($("[data-design-sample]", rows[0])!.getAttribute("target")).toBe("_blank");
    // one delete style: red-outlined „Kustuta“; in use it is greyed, the reason beside it
    expect(rows.map((r) => text($("[data-design-remove]", r)))).toEqual(["Kustuta", "Kustuta", "Kustuta"]);
    expect(rows.map((r) => $("[data-design-remove]", r)!.getAttribute("aria-disabled"))).toEqual(["true", "true", null]);
    expect(text($("[data-design-kept]", rows[0]))).toBe("Kasutusel olevat kujundust ei saa kustutada.");
    expect($("[data-design-kept]", rows[2])).toBeNull();
    const describedBy = $("[data-design-remove]", rows[0])!.getAttribute("aria-describedby")!.split(" ");
    expect(describedBy.map((id) => text(document.getElementById(id)))).toEqual(["Kasutab 3 koolitust", "Kasutusel olevat kujundust ei saa kustutada."]);
    // the dashed add row at the end
    expect($("[data-design-add-row]")!.previousElementSibling).toBe(rows[2]);
    expect($<HTMLInputElement>("[data-design-new-name]")!.placeholder).toBe("Uue kujunduse nimi");
    expect(text($("[data-design-add]"))).toBe("Lisa kujundus +");
    expect(fetched.calls).toHaveLength(0);
  });

  test("a greyed „Kustuta“ asks nothing; the last design cannot go, even unused", async () => {
    await show();
    await click($("[data-design-remove]", rowOf(1)));
    expect($("[data-confirm-panel]")).toBeNull();
    await show([{ ...SPARE, courses: 0 }]);
    expect($("[data-design-remove]")!.getAttribute("aria-disabled")).toBe("true");
    expect(text($("[data-design-kept]"))).toBe("Viimast kujundust ei saa kustutada.");
  });

  test("a name typed saves its row 1.5 s later from the row's version, under „kujundus-<id>“ of the page's status; a name refused says why in the field", async () => {
    await show();
    await type($<HTMLInputElement>("[data-design-name]", rowOf(5))!, "Kevadine");
    await wait(DEBOUNCE_MS + 50);
    await settle();
    expect(saves()).toEqual([{ url: "/api/admin/tunnistuse-kujundus/5", version: "k:kevad", patch: { name: "Kevadine" } }]);
    expect(statuses.some(([part, s]) => part === "kujundus-5" && s.kind === "saved" && s.at !== null)).toBe(true);
    expect(text($("legend", rowOf(5)))).toBe("Kujundus „Kevadine“");

    refuse = { name: "taken" };
    const name = $<HTMLInputElement>("[data-design-name]", rowOf(5))!;
    await type(name, "Tume");
    await wait(DEBOUNCE_MS + 50);
    await settle();
    expect(saves().at(-1)).toEqual({ url: "/api/admin/tunnistuse-kujundus/5", version: "k:kevad+", patch: { name: "Tume" } });
    expect(document.getElementById(`${name.id}-error`)?.textContent).toBe("Sellise nimega kujundus on juba olemas.");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(statuses.at(-1)).toEqual(["kujundus-5", expect.objectContaining({ kind: "invalid" })]);
  });

  test("the tone and the photo save at once; the photo goes up as a certificate background (JPEG only) and „Eemalda“ takes it off", async () => {
    await show();
    await click($<HTMLInputElement>('[data-design-tone="dark"]', rowOf(5)));
    await settle();
    expect(saves()).toEqual([{ url: "/api/admin/tunnistuse-kujundus/5", version: "k:kevad", patch: { tone: "dark" } }]);
    expect($<HTMLInputElement>("[data-design-tone]:checked", rowOf(5))!.value).toBe("dark");

    const file = $<HTMLInputElement>('input[type="file"]', rowOf(5))!;
    expect(file.getAttribute("accept")).toBe("image/jpeg");
    Object.defineProperty(file, "files", { configurable: true, value: [new File(["x"], "taust.jpg", { type: "image/jpeg" })] });
    await act(async () => void file.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    expect(fetched.calls.filter((c) => c.url.startsWith("/api/admin/upload")).map((c) => c.url)).toEqual(["/api/admin/upload?for=certificate-background"]);
    expect(saves().at(-1)).toEqual({ url: "/api/admin/tunnistuse-kujundus/5", version: "k:kevad+", patch: { backgroundKey: "img/taust.jpg" } });
    expect($("[data-current-image]", rowOf(5))!.getAttribute("data-current-image")).toBe("img/taust.jpg");
    expect(text(rowOf(5))).toContain("Lohista uus pilt eelvaatele");

    const remove = $("[data-image-remove]", rowOf(5))!;
    expect(remove.getAttribute("aria-label")).toBe("Eemalda pilt: Taustapilt");
    await click(remove);
    await settle();
    expect(saves().at(-1)!.patch).toEqual({ backgroundKey: "" });
  });

  test("a picture dropped on the preview uploads as one picked; a dragged text is not taken", async () => {
    await show();
    const zone = $("[data-drop-zone]", rowOf(2))!;
    const drop = (types: string[], files: File[]) => {
      const e = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      Object.defineProperty(e, "dataTransfer", { value: { types, files } });
      return act(async () => void zone.dispatchEvent(e));
    };
    await drop(["text/plain"], []);
    await settle();
    expect(fetched.calls).toHaveLength(0);
    await drop(["Files"], [new File(["x"], "taust.jpg", { type: "image/jpeg" })]);
    await settle();
    expect(fetched.calls.filter((c) => c.url.startsWith("/api/admin/upload")).map((c) => c.url)).toEqual(["/api/admin/upload?for=certificate-background"]);
    expect(saves().at(-1)).toEqual({ url: "/api/admin/tunnistuse-kujundus/2", version: "k:tume", patch: { backgroundKey: "img/taust.jpg" } });
    expect($("[data-current-image]", rowOf(2))!.getAttribute("data-current-image")).toBe("img/taust.jpg");
  });

  test("„Lisa kujundus +“ creates one (the server's name, or the one typed) and reads the page again; its box's name takes the focus once it is there", async () => {
    await show();
    await click($("[data-design-add]"));
    await settle();
    expect(fetched.calls.filter((c) => c.url === "/api/admin/tunnistuse-kujundus").map((c) => [c.method, c.body])).toEqual([["POST", {}]]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await show([LIGHT, DARK, SPARE, { id: 9, name: "Uus kujundus", tone: "light", backgroundKey: "", sort: 4, version: "k:uus", courses: 0 }]);
    expect(document.activeElement).toBe($("[data-design-name]", rowOf(9)));
    expect($<HTMLInputElement>("[data-design-name]", rowOf(9))!.value).toBe("Uus kujundus");

    await type($<HTMLInputElement>("[data-design-new-name]")!, "Lilled");
    await click($("[data-design-add]"));
    await settle();
    expect(fetched.calls.filter((c) => c.url === "/api/admin/tunnistuse-kujundus").map((c) => c.body)).toEqual([{}, { name: "Lilled" }]);
    expect($<HTMLInputElement>("[data-design-new-name]")!.value).toBe("");
  });

  test("„Lisa kujundus +“ with a name the route refuses: its words under the field, the name stays, nothing read again", async () => {
    fetched.restore();
    fetched = stubFetch(async (url, init) =>
      url === "/api/admin/tunnistuse-kujundus" ? Response.json({ ok: false, error: "invalid", fields: { name: "taken" } }, { status: 400 }) : route(url, init),
    );
    await show();
    await type($<HTMLInputElement>("[data-design-new-name]")!, "hele");
    await click($("[data-design-add]"));
    await settle();
    expect(text($("[data-design-add-error]"))).toBe("Sellise nimega kujundus on juba olemas.");
    expect($<HTMLInputElement>("[data-design-new-name]")!.value).toBe("hele");
    expect($<HTMLInputElement>("[data-design-new-name]")!.getAttribute("aria-invalid")).toBe("true");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  test("„Kustuta“ asks first; „Jah, kustuta“ deletes the design, reads the page again and puts the focus on the add row's name", async () => {
    await show();
    await click($("[data-design-remove]", rowOf(5)));
    const panel = $("[data-confirm-panel]", rowOf(5))!;
    expect(text(panel)).toContain("Kas kustutan kujunduse „Kevad“?");
    expect(text(panel)).toContain("Väljastatud tunnistused jäävad selliseks, nagu need väljastati.");
    expect(fetched.calls).toHaveLength(0);
    await click(buttonIn(panel, "Katkesta"));
    await settle();
    expect($("[data-confirm-panel]")).toBeNull();
    await click($("[data-design-remove]", rowOf(5)));
    await click(buttonIn($("[data-confirm-panel]", rowOf(5))!, "Jah, kustuta"));
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url])).toEqual([["DELETE", "/api/admin/tunnistuse-kujundus/5"]]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe($("[data-design-new-name]"));
  });

  test("a delete refused because a course picked the design meanwhile: the box says how many use it and why, „Kustuta“ greyed", async () => {
    removal = Response.json({ ok: false, error: "inUse", courses: 2 }, { status: 409 });
    await show();
    await click($("[data-design-remove]", rowOf(5)));
    await click(buttonIn($("[data-confirm-panel]", rowOf(5))!, "Jah, kustuta"));
    await settle();
    expect(text($("[data-design-used]", rowOf(5)))).toBe("Kasutab 2 koolitust");
    expect(text($("[data-design-kept]", rowOf(5)))).toBe("Kasutusel olevat kujundust ei saa kustutada.");
    expect($("[data-design-remove]", rowOf(5))!.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe($("[data-design-kept]", rowOf(5)));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  test("on the Seaded certificate card: the designs under it, each sample drawn from the card's values as typed", async () => {
    const initial: CertificateSettingsInitial = {
      place: "Pärnu linn",
      registryCode: "16346048",
      practicalLine: "Praktiline töö",
      trainerName: "Maria Sosnina",
      nextYear: 2026,
      nextSeq: 15,
      last: null,
      version: "c:t1.c1",
      designs: [LIGHT, DARK],
    };
    await act(async () => root.render(createElement(CertificateSettings, { initial })));
    await settle();
    expect($("[data-certificate-settings] [data-design-row]")).toBeNull();
    const cardSample = $<HTMLAnchorElement>("[data-cert-sample]")!.getAttribute("href")!;
    expect($<HTMLAnchorElement>("[data-certificate-designs] [data-design-sample]")!.getAttribute("href")).toBe(`${cardSample}&design=1`);
    await type($<HTMLInputElement>("[data-cert-place]")!, "Tallinn");
    expect(new URL($<HTMLAnchorElement>('[data-design-row="2"] [data-design-sample]')!.href, "https://mslab.ee").searchParams.get("place")).toBe("Tallinn");
    expect(new URL($<HTMLAnchorElement>('[data-design-row="2"] [data-design-sample]')!.href, "https://mslab.ee").searchParams.get("design")).toBe("2");
  });
});
