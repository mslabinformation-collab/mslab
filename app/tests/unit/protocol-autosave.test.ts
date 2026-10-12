// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEBOUNCE_MS, localKey, NOTICE_MAX_CHARS, ProtocolAutosave, readConflict, readLocal, remember, resumeLocal, SENT_MAX_CHARS, sentKey, statusOf,
  type Answer, type Content, type SaveBody, type SendOptions, type ServerDraft,
} from "@/components/admin/protocol-autosave";
import { PROTOCOL_LIMITS } from "@/domain/protocols";

// The protocol screen's autosave (spec §4): when a box saves, what a save sends, the browser's copy until the server confirms it, the
// retries, the version check's refusal, and the lost answer that is ours. The server is answered by hand: every save waits for the test.

const TITLES = ["Ettevalmistus", "Värvimine"];
const draft = (over: Partial<ServerDraft> = {}): ServerDraft => ({
  registrationId: 7,
  version: 0,
  titles: TITLES,
  content: { notes: ["", ""], generalNote: "" },
  sentVersion: null,
  sentAt: null,
  savedAt: null,
  ...over,
});
const ok = (version: number, savedAt = "2026-10-12T08:00:00.000Z"): Answer => ({ status: 200, body: { ok: true, version, savedAt } });
const refused = (version: number, notes: string[], generalNote = ""): Answer => ({
  status: 409,
  body: { ok: false, error: "conflict", protocol: { version, stages: TITLES.map((title, i) => ({ title, note: notes[i] })), generalNote, sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:01:00.000Z" } },
});

/** A server answered by hand: each save waits until the test calls `answer`. */
function server() {
  const calls: { body: SaveBody; opts?: SendOptions; answer: (a: Answer) => void }[] = [];
  const send = (body: SaveBody, opts?: SendOptions) => new Promise<Answer>((resolve) => calls.push({ body, opts, answer: resolve }));
  return { calls, send };
}

/** A browser storage in a Map that can list its keys, counts its writes by key, and refuses the keys `full` names (a full or blocked one). */
function mapStorage(full: (key: string) => boolean = () => false) {
  const map = new Map<string, string>();
  const writes = new Map<string, number>();
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full(k)) throw new DOMException("full", "QuotaExceededError");
      writes.set(k, (writes.get(k) ?? 0) + 1);
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
  return { map, writes, storage };
}

let engine: ProtocolAutosave | null = null;
const start = (drafts: ServerDraft[], send: (b: SaveBody) => Promise<Answer>) => {
  engine = new ProtocolAutosave(drafts, send);
  engine.start(localStorage);
  return engine;
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
});
afterEach(() => {
  engine?.stop();
  engine = null;
  vi.useRealTimers();
});

describe("when a box saves, and what a save sends", () => {
  test("1.5 s after typing stops: one save with the version and the headings; saved, and the browser's copy is gone", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "K");
    await tick(1000);
    e.editNote(7, 0, "Ku");
    await tick(DEBOUNCE_MS - 1);
    expect(s.calls).toHaveLength(0);
    expect(e.get(7)!.status).toEqual({ kind: "pending" });
    expect(readLocal(localStorage, 7)?.content.notes).toEqual(["Ku", ""]); // kept until the server confirms it
    await tick(1);
    expect(s.calls.map((c) => c.body)).toEqual([{ registrationId: 7, version: 0, titles: TITLES, notes: ["Ku", ""], generalNote: "" }]);
    expect(e.get(7)!.status).toEqual({ kind: "saving" });
    s.calls[0].answer(ok(1));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 1, status: { kind: "saved", at: Date.parse("2026-10-12T08:00:00.000Z") }, confirmed: { notes: ["Ku", ""], generalNote: "" } });
    expect(readLocal(localStorage, 7)).toBeNull();
    expect(e.unsaved()).toBe(false);
  });

  test("on blur and on switching student (save) it goes at once, without the 1.5 s", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editGeneral(7, "Üldiselt hästi");
    void e.save(7);
    await tick();
    expect(s.calls.map((c) => c.body.generalNote)).toEqual(["Üldiselt hästi"]);
  });

  test("one save of a protocol at a time: what is typed during it goes next, with the version the first one got", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(1);
    s.calls[0].answer(ok(1));
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[0, "A"], [1, "AB"]]);
    s.calls[1].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, status: { kind: "saved" } });
  });

  test("typing back to the saved text needs no save: saved, the copy dropped, nothing sent", async () => {
    const s = server();
    const e = start([draft({ version: 3, content: { notes: ["Hea", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "Hea!");
    e.editNote(7, 0, "Hea");
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(0);
    expect(e.get(7)!.status.kind).toBe("saved");
    expect(readLocal(localStorage, 7)).toBeNull();
  });

  test("saveAll is true only when every protocol is confirmed", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 })], s.send);
    e.editNote(7, 0, "A");
    e.editNote(8, 0, "B");
    const all = e.saveAll();
    await tick();
    s.calls[0].answer(ok(1));
    s.calls[1].answer({ status: 500, body: { ok: false, error: "server" } });
    expect(await all).toBe(false);
  });
});

describe("a long day on flaky Wi-Fi (Review Focus 1)", () => {
  test("a failed save keeps the text in the browser and is tried again after 2 and 5 s; back online, at once", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null);
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "retrying" });
    expect(readLocal(localStorage, 7)).toMatchObject({ version: 0, content: { notes: ["A", ""] } });
    await tick(1999);
    expect(s.calls).toHaveLength(1);
    await tick(1);
    expect(s.calls).toHaveLength(2);
    s.calls[1].answer(null);
    await tick(4999);
    expect(s.calls).toHaveLength(2);
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls).toHaveLength(3);
    s.calls[2].answer(ok(1));
    await tick();
    expect(e.get(7)!.status.kind).toBe("saved");
  });

  test("the tab shown again tries a waiting save at once", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null);
    await tick();
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(s.calls).toHaveLength(2);
  });

  test("Review Focus 1: a save whose answer was lost, then more typing: refused with that very text stored — ours — and the newer text goes on top, no notice", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // the server stored "A" as version 1; the answer never came
    await tick();
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toMatchObject({ version: 0, notes: ["AB", ""] });
    s.calls[1].answer(refused(1, ["A", ""]));
    await tick();
    expect(s.calls[2].body).toMatchObject({ version: 1, notes: ["AB", ""] });
    s.calls[2].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, conflict: null, content: { notes: ["AB", ""] }, status: { kind: "saved" } });
  });

  test("Review Focus 1: a lost answer, then six more failed saves of newer text and a retry: back online it is still ours, the newest text goes on top", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // the server stored "A" as version 1; the answer never came
    await tick();
    for (let i = 1; i <= 6; i++) {
      e.editNote(7, 0, `A${i}`);
      await tick(DEBOUNCE_MS);
      s.calls[i].answer(null); // none of these reached the server
      await tick();
    }
    await tick(30_000); // a retry of the same text adds nothing to what is kept
    expect(s.calls.map((c) => c.body.notes[0])).toEqual(["A", "A1", "A2", "A3", "A4", "A5", "A6", "A6"]);
    s.calls[7].answer(null);
    await tick();
    expect(readLocal(localStorage, 7)!.sent.map((c) => c.notes[0])).toEqual(["A", "A1", "A2", "A3", "A4", "A5", "A6"]);
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls[8].body).toMatchObject({ version: 0, notes: ["A6", ""] });
    s.calls[8].answer(refused(1, ["A", ""])); // the first text, kept all along: ours
    await tick();
    expect(s.calls[9].body).toMatchObject({ version: 1, notes: ["A6", ""] });
    s.calls[9].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, conflict: null, content: { notes: ["A6", ""] }, status: { kind: "saved" } });
  });

  test("remember: each text once, the newest always, the oldest left out past SENT_MAX_CHARS", () => {
    const c = (note: string): Content => ({ notes: [note], generalNote: "" });
    expect(remember([c("A")], c("A"))).toEqual([c("A")]);
    expect(remember([c("A"), c("B")], c("A"))).toEqual([c("A"), c("B")]);
    const half = "x".repeat(SENT_MAX_CHARS / 2);
    expect(remember([c(`1${half}`), c(`2${half}`)], c("3")).map((x) => x.notes[0][0])).toEqual(["2", "3"]);
    expect(remember([], c("y".repeat(SENT_MAX_CHARS + 1)))).toHaveLength(1);
  });

  test("Review Focus 1: a reload after a lost answer resumes the newer text on top of the stored one", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 0, titles: TITLES, content: { notes: ["AB", ""], generalNote: "" }, sent: [{ notes: ["A", ""], generalNote: "" }] }));
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["A", ""], generalNote: "" } })], s.send);
    expect(e.get(7)!.content.notes).toEqual(["AB", ""]);
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ registrationId: 7, version: 1, titles: TITLES, notes: ["AB", ""], generalNote: "" }]);
    expect(e.get(7)!.conflict).toBeNull();
  });

  test("a reload resumes a copy of the same version and saves it at once; a copy the server already has is dropped", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 2, titles: TITLES, content: { notes: ["jäi alles", ""], generalNote: "" }, sent: [] }));
    localStorage.setItem(localKey(8), JSON.stringify({ version: 2, titles: TITLES, content: { notes: ["sama", ""], generalNote: "" }, sent: [] }));
    const s = server();
    start([draft({ version: 2 }), draft({ registrationId: 8, version: 2, content: { notes: ["sama", ""], generalNote: "" } })], s.send);
    await tick();
    expect(s.calls.map((c) => [c.body.registrationId, c.body.notes[0]])).toEqual([[7, "jäi alles"]]);
    expect(readLocal(localStorage, 8)).toBeNull();
  });
});

describe("two devices (Review Focus 2)", () => {
  test("another device saved first: its text is shown with a notice that keeps this screen's words; nothing is overwritten or sent again", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(1);
    expect(e.get(7)).toMatchObject({
      version: 2,
      content: { notes: ["telefon", ""] },
      confirmed: { notes: ["telefon", ""] },
      conflict: { titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } },
      status: { kind: "saved", at: Date.parse("2026-10-12T08:01:00.000Z") },
    });
    expect(readLocal(localStorage, 7)).toBeNull();
    e.dismissConflict(7);
    expect(e.get(7)!.conflict).toBeNull();
  });

  test("a reload that finds the server moved on by another device: the kept text goes into the notice", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 1, titles: TITLES, content: { notes: ["minu", ""], generalNote: "" }, sent: [] }));
    const e = start([draft({ version: 2, content: { notes: ["teine", ""], generalNote: "" } })], server().send);
    expect(e.get(7)).toMatchObject({ content: { notes: ["teine", ""] }, conflict: { titles: TITLES, lost: { notes: ["minu", ""] } } });
  });

  test("the notice's words outlive a reload or a discarded tab, until 'Selge'", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    e.stop(); // the page is reloaded, or the tablet discards the tab
    const stored = draft({ version: 2, content: { notes: ["telefon", ""], generalNote: "" } });
    const again = start([stored], server().send);
    expect(again.get(7)!.conflict).toEqual({ titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } });
    again.dismissConflict(7);
    expect(readConflict(localStorage, 7)).toBeNull();
    again.stop();
    expect(start([stored], server().send).get(7)!.conflict).toBeNull();
  });
});

describe("huge pasted text (Review Focus 4)", () => {
  test("a box over 10 000 characters: nothing is sent, the status says so, the whole text stays on screen and in the browser; shortened, it saves", async () => {
    const s = server();
    const e = start([draft()], s.send);
    const long = "ü".repeat(PROTOCOL_LIMITS.note + 1);
    e.editNote(7, 1, long);
    await tick(DEBOUNCE_MS * 2);
    expect(await e.save(7)).toBe(false);
    expect(s.calls).toHaveLength(0);
    expect(e.get(7)!.status).toEqual({ kind: "tooLong", places: [1] });
    expect(e.get(7)!.content.notes[1]).toHaveLength(PROTOCOL_LIMITS.note + 1);
    expect(readLocal(localStorage, 7)?.content.notes[1]).toHaveLength(PROTOCOL_LIMITS.note + 1);
    e.editNote(7, 1, long.slice(0, PROTOCOL_LIMITS.note));
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(1);
  });

  test("pasted control characters are dropped, the words, tabs and line breaks kept", () => {
    const e = start([draft()], server().send);
    e.editNote(7, 0, "Kulmud\u000bhästi\u0000\tjah\r\nlõpp");
    expect(e.get(7)!.content.notes[0]).toBe("Kulmudhästi\tjah\r\nlõpp");
  });
});

describe("the other answers and the parts", () => {
  test("signed out: said so and tried again later; the registration gone: said so, not tried again; the text stays", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 })], s.send);
    e.editNote(7, 0, "A");
    e.editNote(8, 0, "B");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer({ status: 401, body: { ok: false, error: "unauthorized" } });
    s.calls[1].answer({ status: 404, body: { ok: false, error: "notFound" } });
    await tick();
    expect([e.get(7)!.status.kind, e.get(8)!.status.kind]).toEqual(["signedOut", "gone"]);
    await tick(2000);
    expect(s.calls.map((c) => c.body.registrationId)).toEqual([7, 8, 7]);
    expect(readLocal(localStorage, 8)?.content.notes[0]).toBe("B");
  });

  test("statusOf: none before the first save, a draft, sent, changed; markSent", async () => {
    const s = server();
    const e = start([draft()], s.send);
    expect(statusOf(e.get(7)!)).toBe("none");
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(1));
    await tick();
    expect(statusOf(e.get(7)!)).toBe("draft");
    e.markSent(7, 1, "2026-10-12T15:00:00.000Z");
    expect(statusOf(e.get(7)!)).toBe("sent");
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    s.calls[1].answer(ok(2));
    await tick();
    expect(statusOf(e.get(7)!)).toBe("changed");
  });

  test("a browser that cannot keep the text (storage full): the entry says so until the server has it; a full storage never stops the save", async () => {
    const full = { getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} } as unknown as Storage;
    const s = server();
    const e = (engine = new ProtocolAutosave([draft()], s.send));
    e.start(full);
    e.editNote(7, 0, "A");
    expect(e.get(7)).toMatchObject({ kept: false, status: { kind: "pending" } });
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(1));
    await tick();
    expect(e.get(7)).toMatchObject({ kept: true, status: { kind: "saved" } });
  });

  test("while a send is on its way the protocol takes no edits: what is sent is what is on the screen", () => {
    const e = start([draft({ version: 1, content: { notes: ["Valmis", ""], generalNote: "" } })], server().send);
    e.setSending(7, true);
    e.editNote(7, 0, "Valmis!");
    expect(e.get(7)).toMatchObject({ sending: true, content: { notes: ["Valmis", ""] } });
    e.setSending(7, false);
    e.editNote(7, 0, "Valmis!");
    expect(e.get(7)!.content.notes[0]).toBe("Valmis!");
  });

  test("sends that overlap: the protocol stays read-only until the last of them is answered, and one 'off' too many changes nothing", () => {
    const e = start([draft({ version: 1, content: { notes: ["Valmis", ""], generalNote: "" } })], server().send);
    e.setSending(7, true);
    e.setSending(7, true);
    e.setSending(7, false); // the first answer: the second send still needs the text as it is
    e.editNote(7, 0, "Valmis!");
    expect(e.get(7)).toMatchObject({ sending: true, content: { notes: ["Valmis", ""] } });
    e.setSending(7, false);
    expect(e.get(7)!.sending).toBe(false);
    e.setSending(7, false); // (never below none: the next send must still lock)
    e.setSending(7, true);
    expect(e.get(7)!.sending).toBe(true);
    e.setSending(7, false);
    expect(e.get(7)!.sending).toBe(false);
  });

  test("the note under a send's button is kept with the protocol until its next edit or the next note", () => {
    const e = start([draft({ version: 1, content: { notes: ["Valmis", ""], generalNote: "" } })], server().send);
    expect(e.get(7)!.sendError).toBeNull();
    e.setSendError(7, "Saatmine ei õnnestunud.");
    expect(e.get(7)!.sendError).toBe("Saatmine ei õnnestunud.");
    e.editNote(7, 0, "Valmis!");
    expect(e.get(7)!.sendError).toBeNull();
    e.setSendError(7, "Uus");
    e.setSendError(7, null);
    expect(e.get(7)!.sendError).toBeNull();
    e.setSending(7, true);
    e.setSendError(7, "Ei");
    e.editNote(7, 0, "Valmis!!"); // (a read-only protocol takes no edit, and so does not drop the note)
    expect(e.get(7)!.sendError).toBe("Ei");
  });

  test("readLocal reads only a copy it wrote; resumeLocal's three outcomes", () => {
    localStorage.setItem(localKey(1), "{");
    localStorage.setItem(localKey(2), JSON.stringify({ version: "1", titles: [], content: { notes: [], generalNote: "" }, sent: [] }));
    localStorage.setItem(localKey(3), JSON.stringify({ version: 1, titles: ["a"], content: { notes: [1], generalNote: "" }, sent: [] }));
    for (const id of [1, 2, 3, 4]) expect(readLocal(localStorage, id), String(id)).toBeNull();
    expect(readLocal(null, 1)).toBeNull();
    const server = { version: 2, titles: TITLES, content: { notes: ["x", ""], generalNote: "" } };
    const local = (version: number, notes: string[], sent: string[][] = [], titles = TITLES) => ({ version, titles, content: { notes, generalNote: "" }, sent: sent.map((n) => ({ notes: n, generalNote: "" })) });
    expect(resumeLocal(server, null)).toEqual({ kind: "none" });
    expect(resumeLocal(server, local(1, ["x", ""]))).toEqual({ kind: "none" });
    expect(resumeLocal(server, local(2, ["y", ""]))).toEqual({ kind: "resume", content: { notes: ["y", ""], generalNote: "" } });
    expect(resumeLocal(server, local(1, ["xy", ""], [["x", ""]]))).toEqual({ kind: "resume", content: { notes: ["xy", ""], generalNote: "" } });
    expect(resumeLocal(server, local(1, ["y", ""]))).toEqual({ kind: "lost", titles: TITLES, content: { notes: ["y", ""], generalNote: "" } });
    expect(resumeLocal(server, local(2, ["y"], [], ["Vana"]))).toEqual({ kind: "lost", titles: ["Vana"], content: { notes: ["y"], generalNote: "" } });
  });
});

// The rulings of the earlier tasks' reviews (Task 2: the screen recognises its own lost answer; a first save creates a "Mustand" row, so
// looking must send nothing) and what this task's review of the brief added (a second conflict keeps the first one's words; a save whose
// answer is unknown is not "saved"; any answer that is not a refusal may have been stored).
describe("looking creates nothing, and the lost answers that are ours", () => {
  test("looking creates nothing: saving, saving all, or typing and typing back in protocols never typed in sends no request", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 }), draft({ registrationId: 9, version: 2, content: { notes: ["Hea", ""], generalNote: "" } })], s.send);
    expect(await e.save(7)).toBe(true);
    expect(await e.save(8)).toBe(true);
    expect(await e.save(9)).toBe(true);
    expect(await e.saveAll()).toBe(true);
    e.editNote(8, 0, "x");
    e.editNote(8, 0, "");
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(0);
    for (const id of [7, 8, 9]) expect(readLocal(localStorage, id), String(id)).toBeNull();
    expect(e.ids().map((id) => statusOf(e.get(id)!))).toEqual(["none", "none", "draft"]);
  });

  test("a lost answer, then a refusal with a text this screen never sent: that one is another device's, and the notice keeps the screen's words", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // "A" never reached the server; the phone saved "telefon" first
    await tick();
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    s.calls[1].answer(refused(1, ["telefon", ""]));
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(2);
    expect(e.get(7)).toMatchObject({ version: 1, content: { notes: ["telefon", ""] }, conflict: { titles: TITLES, lost: { notes: ["AB", ""], generalNote: "" } } });
  });

  test("an answer that is not the server's (a Wi-Fi login page's 200) is not taken as saved: the text may be stored, and a refusal with it is ours", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer({ status: 200, body: null });
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "retrying" });
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    s.calls[1].answer(refused(1, ["A", ""]));
    await tick();
    expect(s.calls[2].body).toMatchObject({ version: 1, notes: ["AB", ""] });
    s.calls[2].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, conflict: null, status: { kind: "saved" } });
  });

  test("a save on its way, then the text typed back to the saved one: not 'saved' until the server says so; its answer lost, the server is asked again", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["A", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "A"); // while "AB" is on its way
    expect(e.get(7)!.status).toEqual({ kind: "pending" });
    expect([e.unsaved(), e.unconfirmed(7)]).toEqual([true, true]); // the chip, the leave warning and the status agree
    expect(readLocal(localStorage, 7)).toMatchObject({ version: 1, content: { notes: ["A", ""] }, sent: [{ notes: ["AB", ""], generalNote: "" }] });
    s.calls[0].answer(null); // the server stored "AB" as version 2; the answer never came
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toMatchObject({ version: 1, notes: ["A", ""] });
    s.calls[1].answer(refused(2, ["AB", ""])); // ours
    await tick();
    expect(s.calls[2].body).toMatchObject({ version: 2, notes: ["A", ""] });
    s.calls[2].answer(ok(3));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 3, conflict: null, content: { notes: ["A", ""] }, confirmed: { notes: ["A", ""] }, status: { kind: "saved" } });
    expect(readLocal(localStorage, 7)).toBeNull();
  });

  test("leaving the screen within 1.5 s of typing (another admin page) sends the waiting save at once; the copy stays until the server is seen to hold it", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 })], s.send);
    e.editNote(7, 0, "viimane lause");
    e.stop();
    expect(s.calls.map((c) => c.body)).toEqual([{ registrationId: 7, version: 0, titles: TITLES, notes: ["viimane lause", ""], generalNote: "" }]);
    s.calls[0].answer(ok(1)); // not applied: the screen is gone
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(1);
    expect(readLocal(localStorage, 7)?.content.notes[0]).toBe("viimane lause");
    const again = server();
    const back = start([draft({ version: 1, content: { notes: ["viimane lause", ""], generalNote: "" } }), draft({ registrationId: 8 })], again.send);
    await tick(DEBOUNCE_MS);
    expect(again.calls).toHaveLength(0);
    expect(readLocal(localStorage, 7)).toBeNull();
    expect(back.get(7)).toMatchObject({ version: 1, conflict: null, status: { kind: "saved" } });
  });

  test("the tab hidden within 1.5 s of typing (another app, the tablet locked) saves at once", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    hidden.mockRestore();
    expect(s.calls.map((c) => c.body.notes[0])).toEqual(["A"]);
    s.calls[0].answer(ok(1));
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(1);
    expect(e.get(7)!.status.kind).toBe("saved");
  });

  test("a second conflict before 'Selge' keeps the first one's words too, on the screen and in the browser", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    e.editNote(7, 0, "telefon, lisa");
    e.editGeneral(7, "üldine");
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toMatchObject({ version: 2, notes: ["telefon, lisa", ""], generalNote: "üldine" });
    s.calls[1].answer(refused(3, ["arvuti", ""]));
    await tick();
    const both = { titles: TITLES, lost: { notes: ["tahvel\n\ntelefon, lisa", ""], generalNote: "üldine" } };
    expect(e.get(7)).toMatchObject({ version: 3, content: { notes: ["arvuti", ""] }, conflict: both });
    e.stop();
    expect(start([draft({ version: 3, content: { notes: ["arvuti", ""], generalNote: "" } })], server().send).get(7)!.conflict).toEqual(both);
  });
});

// Fix round 1 of the review: two tabs of one browser share its storage, so each keeps its own copy and notice; the notice's words are never
// moved out of the browser while it cannot keep them; and the smaller points (a refusal with the screen's own text, the parting save of strict
// mode, a keystroke writes only the text, the notice's size, the tablet put to sleep).
describe("two tabs, a full storage, and the rest (fix round 1)", () => {
  const shown = () => draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } });
  const tabs: ProtocolAutosave[] = [];
  const tab = (name: string, send: (b: SaveBody, o?: SendOptions) => Promise<Answer>, storage: Storage = localStorage, drafts: ServerDraft[] = [shown()]) => {
    const t = new ProtocolAutosave(drafts, send, { tab: name });
    t.start(storage);
    tabs.push(t);
    return t;
  };
  beforeEach(() => {
    // the copies of several tabs are ordered by when each was written
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-10-12T08:00:00.000Z") });
  });
  afterEach(() => {
    for (const t of tabs.splice(0)) t.stop();
  });

  test("Important 1: tab B only leaving the student, then typing, never removes or overwrites tab A's unsaved copy", async () => {
    const a = server();
    const b = server();
    const tabA = tab("A", a.send);
    const tabB = tab("B", b.send);
    tabA.editNote(7, 0, "tahvel, võrguta");
    await tick(DEBOUNCE_MS);
    a.calls[0].answer(null); // offline
    await tick();
    expect(readLocal(localStorage, 7, "A")?.content.notes[0]).toBe("tahvel, võrguta");
    expect(await tabB.save(7)).toBe(true); // B switches away from the student, typing nothing
    expect(b.calls).toHaveLength(0);
    expect(readLocal(localStorage, 7, "A")?.content.notes[0]).toBe("tahvel, võrguta");
    expect(tabA.unsaved()).toBe(true);
    tabB.editNote(7, 0, "telefon");
    expect(readLocal(localStorage, 7, "A")?.content.notes[0]).toBe("tahvel, võrguta");
    expect(readLocal(localStorage, 7, "B")?.content.notes[0]).toBe("telefon");
    await tick(DEBOUNCE_MS);
    b.calls[0].answer(ok(2));
    await tick();
    expect(readLocal(localStorage, 7, "B")).toBeNull(); // B's own copy goes once the server has B's text
    expect(readLocal(localStorage, 7, "A")?.content.notes[0]).toBe("tahvel, võrguta"); // A's stays: its text is not on the server
  });

  test("Important 1: closed tabs' copies: a new tab resumes the newest, the other's words go into the notice; both copies go once all is kept", async () => {
    const a = server();
    const b = server();
    const tabA = tab("A", a.send);
    const tabB = tab("B", b.send);
    tabA.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    a.calls[0].answer(null);
    await tick();
    tabB.editNote(7, 0, "telefon");
    await tick(DEBOUNCE_MS);
    b.calls[0].answer(null);
    await tick();
    tabA.stop();
    tabB.stop();
    const c = server();
    const tabC = tab("C", c.send);
    const words = { titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } };
    expect(tabC.get(7)).toMatchObject({ content: { notes: ["telefon", ""] }, conflict: words });
    await tick();
    expect(c.calls.map((x) => [x.body.version, x.body.notes[0]])).toEqual([[1, "telefon"]]);
    c.calls[0].answer(ok(2));
    await tick();
    expect(readLocal(localStorage, 7)).toBeNull(); // every copy gone: the server has the text, the notice has the words
    expect(readConflict(localStorage, 7)).toEqual(words);
    expect(readConflict(localStorage, 7, "C")).toEqual(words);
  });

  test("Important 1: one tab's notice or 'Selge' never removes or overwrites another tab's notice words", async () => {
    const a = server();
    const b = server();
    const tabA = tab("A", a.send);
    const tabB = tab("B", b.send);
    tabA.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    a.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    expect(readConflict(localStorage, 7, "A")?.lost?.notes[0]).toBe("tahvel");
    tabB.dismissConflict(7); // B has no notice: nothing of A's goes
    expect(readConflict(localStorage, 7, "A")?.lost?.notes[0]).toBe("tahvel");
    tabB.editNote(7, 0, "arvuti");
    await tick(DEBOUNCE_MS);
    b.calls[0].answer(refused(3, ["kolmas", ""]));
    await tick();
    expect(readConflict(localStorage, 7, "A")?.lost?.notes[0]).toBe("tahvel");
    expect(readConflict(localStorage, 7, "B")?.lost?.notes[0]).toBe("arvuti");
    tabB.dismissConflict(7);
    expect(readConflict(localStorage, 7, "A")?.lost?.notes[0]).toBe("tahvel");
    expect(readConflict(localStorage, 7, "B")).toBeNull();
  });

  test("Important 2: a storage that cannot take the notice: the copy keeps the words, the entry says so, a reload shows them; with room again they move", async () => {
    let blocked = true;
    const m = mapStorage((k) => blocked && k.startsWith("mslab-protocol-conflict:"));
    const s = server();
    const e = tab("A", s.send, m.storage);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    const words = { titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } };
    expect(e.get(7)).toMatchObject({ kept: false, content: { notes: ["telefon", ""] }, conflict: words });
    expect(readLocal(m.storage, 7, "A")).toMatchObject({ lost: words }); // still in this browser
    e.stop();
    const again = tab("B", server().send, m.storage, [draft({ version: 2, content: { notes: ["telefon", ""], generalNote: "" } })]);
    expect(again.get(7)).toMatchObject({ kept: false, conflict: words });
    blocked = false;
    again.editNote(7, 1, "lisa"); // the next write finds room
    expect(again.get(7)!.kept).toBe(true);
    expect(readConflict(m.storage, 7, "B")).toEqual(words);
    expect(readLocal(m.storage, 7, "A")).toBeNull(); // the old copy went once its words were kept under the notice's key
  });

  test("Important 2, the reviewer's probe: a storage that cannot list its keys nor take the notice: a reload still shows the words", async () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k.startsWith("mslab-protocol-conflict:")) throw new DOMException("full", "QuotaExceededError");
        map.set(k, v);
      },
      removeItem: (k: string) => void map.delete(k),
    } as unknown as Storage;
    const s = server();
    const e = tab("A", s.send, storage);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    expect(e.get(7)).toMatchObject({ kept: false, conflict: { lost: { notes: ["tahvel", ""] } } });
    e.stop();
    const again = tab("B", server().send, storage, [draft({ version: 2, content: { notes: ["telefon", ""], generalNote: "" } })]);
    expect(again.get(7)).toMatchObject({ kept: false, conflict: { titles: TITLES, lost: { notes: ["tahvel", ""], generalNote: "" } } });
  });

  test("Important 2: a full storage and a real conflict: the words stay on the screen and the entry says the browser cannot keep them", async () => {
    const m = mapStorage(() => true);
    const s = server();
    const e = tab("A", s.send, m.storage);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    expect(e.get(7)).toMatchObject({ kept: false, status: { kind: "saved" }, conflict: { lost: { notes: ["tahvel", ""] } } });
    e.dismissConflict(7);
    expect(e.get(7)!.kept).toBe(true); // nothing is left to keep
  });

  test("Important 2: a reload whose notice cannot be kept leaves the copy where it is, and the next reload shows the words again", async () => {
    const m = mapStorage((k) => k.startsWith("mslab-protocol-conflict:"));
    m.storage.setItem(localKey(7), JSON.stringify({ version: 1, titles: TITLES, content: { notes: ["minu", ""], generalNote: "" }, sent: [] }));
    const moved = draft({ version: 2, content: { notes: ["teine", ""], generalNote: "" } });
    const first = tab("A", server().send, m.storage, [moved]);
    expect(first.get(7)).toMatchObject({ kept: false, content: { notes: ["teine", ""] }, conflict: { lost: { notes: ["minu", ""] } } });
    expect(m.map.has(localKey(7))).toBe(true);
    first.stop();
    expect(tab("B", server().send, m.storage, [moved]).get(7)!.conflict).toEqual({ titles: TITLES, lost: { notes: ["minu", ""], generalNote: "" } });
  });

  test("Minor 3: a refusal that holds exactly the screen's text (the same save twice) is taken as saved, with no notice", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(1, ["A", ""]));
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(1);
    expect(e.get(7)).toMatchObject({ version: 1, conflict: null, status: { kind: "saved" } });
    expect(readLocal(localStorage, 7)).toBeNull();
  });

  test("strict mode's stop between two starts: the parting save is remembered, so a refusal that holds its text is ours", async () => {
    localStorage.setItem(localKey(7), JSON.stringify({ version: 0, titles: TITLES, content: { notes: ["jäi alles", ""], generalNote: "" }, sent: [] }));
    const s = server();
    const e = new ProtocolAutosave([draft()], s.send);
    tabs.push(e);
    e.start(localStorage);
    e.stop(); // React strict mode's cleanup: the resumed save goes as a parting one (it reached the server)
    e.start(localStorage);
    e.editNote(7, 0, "jäi alles, lisa");
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[0, "jäi alles"], [0, "jäi alles, lisa"]]);
    s.calls[1].answer(refused(1, ["jäi alles", ""]));
    await tick();
    expect(s.calls[2].body).toMatchObject({ version: 1, notes: ["jäi alles, lisa", ""] });
    s.calls[2].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, conflict: null, status: { kind: "saved" } });
  });

  test("Minor 5: a keystroke writes only the text; the texts sent without an answer are written when they change", async () => {
    const m = mapStorage();
    const s = server();
    const e = tab("A", s.send, m.storage, [draft()]);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null);
    await tick();
    const sentWrites = m.writes.get(sentKey(7, "A"));
    const copyWrites = m.writes.get(localKey(7, "A"))!;
    expect(sentWrites).toBe(1);
    for (const text of ["AB", "ABC", "ABCD"]) e.editNote(7, 0, text);
    expect(m.writes.get(sentKey(7, "A"))).toBe(sentWrites);
    expect(m.writes.get(localKey(7, "A"))).toBe(copyWrites + 3);
    expect(readLocal(m.storage, 7, "A")).toMatchObject({ content: { notes: ["ABCD", ""] }, sent: [{ notes: ["A", ""], generalNote: "" }] });
  });

  test("Minor 6: the notice keeps the newest words within NOTICE_MAX_CHARS, the oldest left out first", async () => {
    const s = server();
    const e = start([shown()], s.send);
    const letters = "abcdefgh"; // eight refusals of 27 000 characters each: 216 000 together
    for (let i = 0; i < letters.length; i++) {
      const text = letters[i].repeat(9000);
      e.edit(7, { notes: [text, text], generalNote: text });
      await tick(DEBOUNCE_MS);
      s.calls[i].answer(refused(i + 2, [`teine ${i}`, ""]));
      await tick();
    }
    const lost = e.get(7)!.conflict!.lost!;
    const all = [...lost.notes, lost.generalNote].join("");
    const count = (ch: string) => all.split(ch).length - 1;
    expect(count("a")).toBe(0);
    expect([..."bcdefgh"].map(count)).toEqual(Array(7).fill(27_000));
    expect(7 * 27_000).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
    expect(readConflict(localStorage, 7)).toEqual(e.get(7)!.conflict);
  });

  test("Minor 7: the page hidden for good (the tablet asleep, the tab closed): a waiting save goes as a keepalive request when it is small enough", async () => {
    const s = server();
    const e = start([draft(), draft({ registrationId: 8 })], s.send);
    e.editNote(7, 0, "lühike");
    const big = "€".repeat(10_000); // 90 000 bytes: over a keepalive request's 64 KB
    e.edit(8, { notes: [big, big], generalNote: big });
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(s.calls.map((c) => [c.body.registrationId, c.opts])).toEqual([[7, { keepalive: true }]]);
    await tick(DEBOUNCE_MS); // the page came back (the browser's cache): the big one goes at its time
    expect(s.calls.map((c) => [c.body.registrationId, c.opts?.keepalive ?? false])).toEqual([[7, true], [8, false]]);
    expect(readLocal(localStorage, 8)?.content.generalNote).toHaveLength(10_000); // in the browser until the server has it
  });
});
