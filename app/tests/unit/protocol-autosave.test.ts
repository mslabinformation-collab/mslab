// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEBOUNCE_MS, FRESH_WAIT_MS, HIDDEN_RECHECK_MS, keepReading, localKey, NOTICE_MAX_CHARS, ProtocolAutosave, readConflict, readLocal, remember, resumeLocal, SENT_MAX_CHARS, sentKey, statusOf,
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

  test("'Selge' takes the line under the send button with it: what was refused is sent clean once the notice is looked at", async () => {
    const s = server();
    const e = start([draft({ version: 1, content: { notes: ["vana", ""], generalNote: "" } })], s.send);
    e.editNote(7, 0, "tahvel");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(refused(2, ["telefon", ""]));
    await tick();
    e.setSendError(7, "Vaata üle.");
    e.dismissConflict(7);
    expect(e.get(7)).toMatchObject({ conflict: null, sendError: null });
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

  test("pasted control characters are dropped, the words, tabs and line breaks kept; Word's line and page breaks become line breaks", () => {
    const e = start([draft()], server().send);
    e.editNote(7, 0, "Kulmud\u000bhästi\u0000\tjah\r\nlõpp\u000cuus leht");
    expect(e.get(7)!.content.notes[0]).toBe("Kulmud\nhästi\tjah\r\nlõpp\nuus leht");
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
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[0, "jäi alles"]]); // one save at a time: the next waits for the parting one
    s.calls[0].answer(ok(1)); // stored as version 1; a parting save's answer is not taken (its text is remembered as sent)
    await tick();
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

describe("the server's text read again: a screen restored by the browser's Back (fix round 1 of Task 11)", () => {
  // the render the screen was made from is the server's text at version 1; the page read again later brings the newer one
  const old = (over: Partial<ServerDraft> = {}) => draft({ version: 1, content: { notes: ["Esimene.", ""], generalNote: "" }, savedAt: Date.parse("2026-10-12T08:00:00.000Z"), ...over });
  const newer = (over: Partial<ServerDraft> = {}) =>
    draft({ version: 2, content: { notes: ["Teine.", ""], generalNote: "Üldiselt." }, savedAt: Date.parse("2026-10-12T08:05:00.000Z"), sentVersion: 1, sentAt: "2026-10-12T08:06:00.000Z", ...over });

  test("until the server's text is read the status says 'checking', never 'saved'; typing and the checking itself do not send anything", async () => {
    const s = server();
    const e = start([old()], s.send);
    e.awaitFresh();
    expect(e.get(7)!.status).toEqual({ kind: "checking" });
    expect(e.checking(7)).toBe(true);
    expect(e.checking()).toBe(true);
    void e.save(7); // a blur with nothing typed: still not 'saved'
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "checking" });
    expect(s.calls).toHaveLength(0);
    e.editNote(7, 0, "Esimene. Lisa.");
    expect(e.get(7)!.status).toEqual({ kind: "pending" });
    e.editNote(7, 0, "Esimene."); // typed back to the text shown: nothing to save, and still not 'saved'
    expect(e.get(7)!.status).toEqual({ kind: "checking" });
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(0);
  });

  test("a newer text of the server and nothing unsaved here: taken silently (text, version, send marks), 'saved' with the server's time, nothing sent", async () => {
    const s = server();
    const e = start([old()], s.send);
    e.awaitFresh();
    e.reconcile([newer()]);
    expect(e.get(7)).toMatchObject({
      version: 2,
      content: { notes: ["Teine.", ""], generalNote: "Üldiselt." },
      confirmed: { notes: ["Teine.", ""], generalNote: "Üldiselt." },
      sentVersion: 1,
      sentAt: "2026-10-12T08:06:00.000Z",
      conflict: null,
      status: { kind: "saved", at: Date.parse("2026-10-12T08:05:00.000Z") },
    });
    expect(e.checking()).toBe(false);
    expect(readLocal(localStorage, 7)).toBeNull();
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(0); // taking the server's text is not a save
  });

  test("a newer text of the server and text of this screen's own not saved: the refusal's path, the server's text shown, her words in the notice, nothing overwritten", async () => {
    const s = server();
    const e = start([old()], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "Esimene. Minu lisa."); // typed on the restored screen before the server's text came
    e.reconcile([newer()]);
    expect(e.get(7)).toMatchObject({
      version: 2,
      content: { notes: ["Teine.", ""] },
      confirmed: { notes: ["Teine.", ""] },
      conflict: { titles: TITLES, lost: { notes: ["Esimene. Minu lisa.", ""], generalNote: "" } },
      status: { kind: "saved" },
    });
    expect(e.checking(7)).toBe(false);
    expect(readConflict(localStorage, 7)?.lost?.notes).toEqual(["Esimene. Minu lisa.", ""]); // kept in the browser until 'Selge'
    await tick(DEBOUNCE_MS * 4);
    expect(s.calls).toHaveLength(0); // the stale text was never sent
    expect(e.unsaved()).toBe(false);
  });

  test("a text this screen sent whose answer was lost, found stored by the render: it is ours, and the newer text goes on top (no notice)", async () => {
    const s = server();
    const e = start([draft()], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // sent, the answer lost
    await tick();
    e.editNote(7, 0, "AB"); // typed on
    e.reconcile([draft({ version: 1, content: { notes: ["A", ""], generalNote: "" } })]);
    await tick();
    expect(e.get(7)!.conflict).toBeNull();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]]).slice(-1)).toEqual([[1, "AB"]]);
  });

  test("the same version: 'checking' becomes 'saved'; the send marks only move forward; an older render (this screen saved since) is ignored", async () => {
    const s = server();
    const e = start([old()], s.send);
    e.awaitFresh();
    e.reconcile([old()]);
    expect(e.get(7)).toMatchObject({ version: 1, status: { kind: "saved", at: Date.parse("2026-10-12T08:00:00.000Z") } });
    // a send made here (markSent) after the render was read is not undone by a render that was read before it
    e.markSent(7, 1, "2026-10-12T09:00:00.000Z");
    e.reconcile([old()]);
    expect(e.get(7)).toMatchObject({ sentVersion: 1, sentAt: "2026-10-12T09:00:00.000Z" });
    // … and a send from another device that the render knows of is taken
    e.reconcile([old({ sentVersion: 1, sentAt: "2026-10-12T09:30:00.000Z" })]);
    expect(e.get(7)).toMatchObject({ sentVersion: 1, sentAt: "2026-10-12T09:30:00.000Z" });
    // this screen saved version 2 since the render began: the render's version 1 changes nothing
    e.editNote(7, 0, "Teine.");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(2));
    await tick();
    e.reconcile([old()]);
    expect(e.get(7)).toMatchObject({ version: 2, content: { notes: ["Teine.", ""] }, conflict: null, status: { kind: "saved" } });
  });

  test("a successful save, or a refusal, is the server's own word: it ends 'checking' for that protocol", async () => {
    const s = server();
    const e = start([old(), old({ registrationId: 8 })], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "Teine.");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(2));
    await tick();
    expect(e.get(7)!.status).toMatchObject({ kind: "saved" });
    expect(e.checking(7)).toBe(false);
    e.editNote(8, 0, "Kolmas.");
    await tick(DEBOUNCE_MS);
    s.calls[1].answer({
      status: 409,
      body: { ok: false, error: "conflict", protocol: { version: 3, stages: TITLES.map((title, i) => ({ title, note: ["Neljas.", ""][i] })), generalNote: "", sentVersion: null, sentAt: null, updatedAt: "2026-10-12T08:07:00.000Z" } },
    });
    await tick();
    expect(e.checking(8)).toBe(false);
    expect(e.get(8)).toMatchObject({ version: 3, conflict: { lost: { notes: ["Kolmas.", ""] } } });
  });

  test("a student the render adds is taken in (the others stay as they are); one it leaves out stays with her text", () => {
    const e = start([old(), old({ registrationId: 8 })], server().send);
    e.awaitFresh();
    e.editNote(8, 0, "Minu tekst.");
    e.reconcile([newer(), draft({ registrationId: 9, version: 3, content: { notes: ["Uus.", ""], generalNote: "" } })]);
    expect(e.ids()).toEqual([7, 8, 9]);
    expect(e.get(9)).toMatchObject({ version: 3, content: { notes: ["Uus.", ""] }, status: { kind: "saved" } });
    expect(e.get(7)).toMatchObject({ version: 2 });
    expect(e.get(8)).toMatchObject({ version: 1, content: { notes: ["Minu tekst.", ""] } }); // (not in the render: untouched, still unsaved)
  });

  test("whenFresh: true at once when nothing is awaited, true when the render comes, false after FRESH_WAIT_MS without it", async () => {
    const e = start([old()], server().send);
    expect(await e.whenFresh([7])).toBe(true);
    e.awaitFresh();
    let answer: boolean | null = null;
    void e.whenFresh([7]).then((v) => (answer = v));
    await tick(FRESH_WAIT_MS - 1);
    expect(answer).toBeNull();
    e.reconcile([old()]);
    await tick();
    expect(answer).toBe(true);
    answer = null;
    e.awaitFresh();
    void e.whenFresh([7]).then((v) => (answer = v));
    await tick(FRESH_WAIT_MS);
    expect(answer).toBe(false);
    expect(e.checking(7)).toBe(true); // (a render that comes later still ends it)
  });

  test("other headings of a protocol not written yet (version 0): taken when nothing is typed, the refusal's path when something is", () => {
    const other = draft({ titles: ["Uus pealkiri", "Teine"], content: { notes: ["", ""], generalNote: "" } });
    const e = start([draft()], server().send);
    e.awaitFresh();
    e.reconcile([other]);
    expect(e.get(7)).toMatchObject({ titles: ["Uus pealkiri", "Teine"], status: { kind: "saved" }, conflict: null });
    e.stop();
    const f = start([draft()], server().send);
    f.awaitFresh();
    f.editNote(7, 0, "Kirjutatud vanade pealkirjade alla.");
    f.reconcile([other]);
    expect(f.get(7)).toMatchObject({ titles: ["Uus pealkiri", "Teine"], conflict: { titles: TITLES, lost: { notes: ["Kirjutatud vanade pealkirjade alla.", ""] } } });
  });
});

describe("a read that comes while a save is queued or on its way, and the answers a read can get (fix round 2 of Task 11)", () => {
  const at = (v: number, note: string, over: Partial<ServerDraft> = {}) =>
    draft({ version: v, content: { notes: [note, ""], generalNote: "" }, savedAt: Date.parse("2026-10-12T08:00:00.000Z"), ...over });

  test("P1: a lost answer, then 'AB' on its way, and the read finds the lost answer's text stored (v2 'A'): nothing flies beside it, no notice, the server ends with 'AB'", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // stored as v2 "A" on the server, the answer lost
    await tick();
    e.editNote(7, 0, "AB");
    await tick(DEBOUNCE_MS); // POST v1 "AB" on its way
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[1, "A"], [1, "AB"]]);
    e.reconcile([at(2, "A")]); // the read answers first
    await tick();
    expect(s.calls).toHaveLength(2); // no second POST of the protocol while one is on its way
    expect(e.get(7)).toMatchObject({ content: { notes: ["AB", ""] }, version: 1, conflict: null, status: { kind: "saving" } });
    expect(e.checking(7)).toBe(true); // the save's answer is what tells
    // the POST's answer: refused, the server is at v2 "A" — the text this screen sent before, so it is ours — and 'AB' goes on top, once
    s.calls[1].answer(refused(2, ["A", ""]));
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[1, "A"], [1, "AB"], [2, "AB"]]);
    expect(e.get(7)).toMatchObject({ conflict: null, status: { kind: "saving" } });
    s.calls[2].answer(ok(3));
    await tick();
    expect(s.calls).toHaveLength(3);
    expect(e.get(7)).toMatchObject({ version: 3, content: { notes: ["AB", ""] }, confirmed: { notes: ["AB", ""] }, conflict: null, status: { kind: "saved" } });
    expect(e.checking()).toBe(false);
    expect(readConflict(localStorage, 7)).toBeNull();
  });

  test("P2: a read that comes while this screen's save is on its way, and she typed on: no notice, the box keeps her text, the newer text goes next", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS); // POST v1 "A" on its way (the server commits it as v2)
    e.editNote(7, 0, "AB"); // typed on
    e.reconcile([at(2, "A")]); // the read after the commit, answered before the POST
    await tick();
    expect(e.get(7)).toMatchObject({ content: { notes: ["AB", ""] }, conflict: null });
    expect(s.calls).toHaveLength(1);
    s.calls[0].answer(ok(2));
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[1, "A"], [2, "AB"]]);
    s.calls[1].answer(ok(3));
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(2);
    expect(e.get(7)).toMatchObject({ version: 3, content: { notes: ["AB", ""] }, conflict: null, status: { kind: "saved" } });
    expect(e.checking()).toBe(false);
  });

  test("a read that came while a save was on its way, and the save got no answer: it is taken when the save is over — the lost answer's text stored is ours", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.reconcile([at(2, "A")]); // stored as v2 "A", the read answers first
    expect(e.checking(7)).toBe(true);
    s.calls[0].answer(null); // the POST's answer is lost
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, content: { notes: ["A", ""] }, conflict: null, status: { kind: "saved" } });
    expect(e.checking(7)).toBe(false);
    expect(s.calls).toHaveLength(1); // nothing more to send: the server holds exactly her text
  });

  test("a read that came while a save was on its way and typed on, the save got no answer: the newer text goes on top of the stored one, no notice, one save at a time", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB");
    e.reconcile([at(2, "A")]);
    s.calls[0].answer(null);
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, content: { notes: ["AB", ""] }, conflict: null });
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[1, "A"], [2, "AB"]]);
    s.calls[1].answer(ok(3));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 3, status: { kind: "saved" } });
  });

  test("a read while her next text waits for its 1.5 s (a lost answer's text stored): the newer text goes on top once, through the queue, and the waiting save does not send it again", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(null); // stored as v2 "A", the answer lost
    await tick();
    e.editNote(7, 0, "AB"); // waits for its 1.5 s
    e.reconcile([at(2, "A")]);
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[1, "A"], [2, "AB"]]);
    // the resend held across the 1.5 s (and the lost answer's retry): it went through the queue, so its waiting save is gone and nothing flies beside it
    await tick(DEBOUNCE_MS * 3);
    expect(s.calls).toHaveLength(2);
    s.calls[1].answer(ok(3));
    await tick(DEBOUNCE_MS * 3);
    expect(s.calls).toHaveLength(2); // (and the retry of the lost answer's save found nothing left to send)
    expect(e.get(7)).toMatchObject({ version: 3, content: { notes: ["AB", ""] }, conflict: null, status: { kind: "saved" } });
  });

  test("P3: the read finds LESS than the render this screen was made from (the protocol is gone, deleted with the account): the server's state is shown, her text is in the notice", async () => {
    const e = start([at(3, "Kolmas")], server().send);
    e.awaitFresh();
    e.reconcile([draft({ version: 0 })]);
    expect(e.get(7)).toMatchObject({ version: 0, content: { notes: ["", ""] }, conflict: { titles: TITLES, lost: { notes: ["Kolmas", ""] } } });
    expect(readConflict(localStorage, 7)?.lost?.notes).toEqual(["Kolmas", ""]);
    expect(e.checking()).toBe(false);
    // what she types next is a new protocol, from version 0
    const s = server();
    const f = start([at(3, "Kolmas")], s.send);
    f.awaitFresh();
    f.reconcile([draft({ version: 0 })]);
    f.editNote(7, 0, "Uus");
    void f.save(7);
    await tick();
    expect(s.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[0, "Uus"]]);
  });

  test("an older read after this screen has heard from the server (it saved since) is still ignored", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(2));
    await tick();
    e.reconcile([at(1, "E")]); // a read that was made before the save
    expect(e.get(7)).toMatchObject({ version: 2, content: { notes: ["A", ""] }, conflict: null, status: { kind: "saved" } });
  });

  test("P4: a student the read does not list says she is gone and is not 'checking' for good; one with text not saved yet keeps saving it", async () => {
    const s = server();
    const e = start([at(1, "x"), at(1, "y", { registrationId: 8 }), at(1, "z", { registrationId: 9 })], s.send);
    e.awaitFresh();
    e.editNote(9, 0, "z, mu lisa");
    e.reconcile([at(1, "x")]);
    expect(e.checking()).toBe(false);
    expect(e.get(7)!.status).toMatchObject({ kind: "saved" });
    expect(e.get(8)).toMatchObject({ status: { kind: "gone" }, version: 1, content: { notes: ["y", ""] } }); // her text stays
    expect(e.get(9)!.status).toEqual({ kind: "pending" }); // hers is not saved yet: a cancelled registration still saves, nothing typed is lost
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => [c.body.registrationId, c.body.notes[0]])).toEqual([[9, "z, mu lisa"]]);
  });

  test("a student missing from the read while her save is on its way: after the save the answer is its own, she is not marked gone", async () => {
    const s = server();
    const e = start([at(1, "x"), at(1, "y", { registrationId: 8 })], s.send);
    e.awaitFresh();
    e.editNote(8, 0, "y2");
    await tick(DEBOUNCE_MS);
    e.reconcile([at(1, "x")]);
    s.calls[0].answer(ok(2));
    await tick();
    expect(e.get(8)).toMatchObject({ version: 2, status: { kind: "saved" } });
    expect(e.checking()).toBe(false);
  });

  test("signedOut (the read was refused): each protocol says so instead of 'saved', 'checking' ends, a save still keeps it; a save the server takes ends it", async () => {
    const s = server();
    const e = start([at(1, "x"), at(1, "y", { registrationId: 8 })], s.send);
    e.awaitFresh();
    e.signedOut();
    expect(e.checking()).toBe(false);
    expect(await e.whenFresh([7, 8])).toBe(true);
    expect(e.get(7)!.status).toEqual({ kind: "signedOut" });
    void e.save(7);
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "signedOut" }); // nothing to save is not "saved"
    expect(s.calls).toHaveLength(0);
    e.editNote(8, 0, "y2");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok(2));
    await tick();
    expect(e.get(8)!.status).toMatchObject({ kind: "saved" });
  });
});

describe("keepReading: refusals and a tab hidden for long (fix round 2 of Task 11)", () => {
  const at = (v: number, note: string, over: Partial<ServerDraft> = {}) => draft({ version: v, content: { notes: [note, ""], generalNote: "" }, ...over });
  const wire = (d: ServerDraft) => ({ registrationId: d.registrationId, name: "Mari", awaiting: false, version: d.version, titles: d.titles, notes: d.content.notes, generalNote: d.content.generalNote, sentVersion: null, sentAt: null, savedAt: null });
  let visibility = "visible";
  let clock = 1_000_000;

  beforeEach(() => {
    visibility = "visible";
    clock = 1_000_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "visibilityState");
  });
  const show = (state: "hidden" | "visible") => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  test("401 and 403: the engine says it is signed out, at once and for good (no retries)", async () => {
    for (const status of [401, 403]) {
      const e = new ProtocolAutosave([at(1, "x")], server().send);
      e.start(localStorage);
      e.awaitFresh();
      const read = vi.fn(async () => ({ status, body: { ok: false, error: "unauthorized" } }));
      const reading = keepReading(e, { sessioon: 5 }, read, () => {});
      await tick();
      expect(e.get(7)!.status).toEqual({ kind: "signedOut" });
      expect(e.checking()).toBe(false);
      await tick(120_000);
      expect(read).toHaveBeenCalledTimes(1);
      reading.stop();
      e.stop();
    }
  });

  test("404 (no such session): none of the students is listed, so each says she is gone", async () => {
    const e = start([at(1, "x"), at(1, "y", { registrationId: 8 })], server().send);
    e.awaitFresh();
    const reading = keepReading(e, { sessioon: 5 }, async () => ({ status: 404, body: { ok: false, error: "notFound" } }), () => {});
    await tick();
    expect([e.get(7)!.status.kind, e.get(8)!.status.kind]).toEqual(["gone", "gone"]);
    expect(e.checking()).toBe(false);
    reading.stop();
  });

  test("a tab hidden for over five minutes reads again when it is shown; one hidden for less does not", async () => {
    const e = start([at(1, "x")], server().send);
    e.awaitFresh();
    const read = vi.fn(async () => ({ status: 200, body: { ok: true, students: [wire(at(1, "x"))] } }));
    const reading = keepReading(e, { sessioon: 5 }, read, () => {});
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(e.checking()).toBe(false);
    show("hidden");
    clock += HIDDEN_RECHECK_MS - 1;
    show("visible");
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(e.checking()).toBe(false);
    show("hidden");
    clock += HIDDEN_RECHECK_MS + 1;
    show("visible");
    expect(e.get(7)!.status).toEqual({ kind: "checking" }); // unread again until the server answers
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(e.get(7)!.status).toMatchObject({ kind: "saved" });
    reading.stop();
  });

  test("item 6: after a refused read (401) the tab shown again or focused reads again, never on a timer; signed in, the protocols say 'saved'", async () => {
    const e = start([at(1, "x")], server().send);
    e.awaitFresh();
    let status = 401;
    const read = vi.fn(async () => (status === 200 ? { status, body: { ok: true, students: [wire(at(1, "x"))] } } : { status, body: { ok: false, error: "unauthorized" } }));
    const reading = keepReading(e, { sessioon: 5 }, read, () => {});
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "signedOut" });
    show("hidden");
    show("visible"); // still signed out: asked again, refused again
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    await tick(120_000);
    expect(read).toHaveBeenCalledTimes(2);
    status = 200; // signed in again in another tab, and back to this one
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    expect(e.get(7)!.status).toMatchObject({ kind: "saved" });
    window.dispatchEvent(new Event("focus")); // signed in and read: a focus asks nothing more
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    reading.stop();
  });
});

// The final review's Important 1: the screen left (a menu link) while a save is on its way. The newest text must still reach the server, after
// the save on its way and never beside it, from the version that save got; nothing is told and no timer runs after the screen is gone.
describe("leaving the screen while a save is on its way (final review, Important 1)", () => {
  /** A hand-answered server that also counts the saves on their way at once. */
  function counted() {
    const s = server();
    let flying = 0;
    let most = 0;
    const send = (body: SaveBody, opts?: SendOptions) => {
      flying++;
      most = Math.max(most, flying);
      return s.send(body, opts).finally(() => void flying--);
    };
    return { calls: s.calls, send, most: () => most, flying: () => flying };
  }
  const sent = (s: { calls: { body: SaveBody }[] }) => s.calls.map((c) => [c.body.version, c.body.notes[0]]);
  /** Long enough for every retry a failed save would start (2 + 5 + 10 + 20 + 30 + 30 + … s). */
  const RETRY_TOTAL = 120_000;

  test("(a) the box loses focus: 'A' on its way, 'AB' waits behind it, the screen is left; 'AB' goes once after 'A' is answered, from the version 'A' got", async () => {
    const s = counted();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS); // POST v0 "A" on its way (slow Wi-Fi)
    e.editNote(7, 0, "AB");
    void e.save(7); // the blur: "AB" waits behind "A"
    e.stop(); // the menu link
    const told = vi.fn();
    e.subscribe(told);
    await tick(DEBOUNCE_MS * 4);
    expect(sent(s)).toEqual([[0, "A"]]); // one save at a time
    s.calls[0].answer(ok(1));
    await tick();
    expect(sent(s)).toEqual([[0, "A"], [1, "AB"]]); // the newest text, from the version "A" got
    expect(readLocal(localStorage, 7)).toMatchObject({ version: 1, content: { notes: ["AB", ""] }, sent: [{ notes: ["AB", ""], generalNote: "" }] });
    s.calls[1].answer(ok(2)); // not waited for: the screen is gone
    await tick(RETRY_TOTAL);
    expect(s.calls).toHaveLength(2);
    expect(s.most()).toBe(1);
    expect(told).not.toHaveBeenCalled();
  });

  test("(b) the box keeps the focus: 'A' on its way, 'AB' waiting for its 1.5 s, the screen is left; 'AB' never flies beside 'A' and goes once after it, from the version 'A' got", async () => {
    const s = counted();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB"); // waits for its 1.5 s
    e.stop();
    const told = vi.fn();
    e.subscribe(told);
    await tick();
    expect(sent(s)).toEqual([[0, "A"]]); // nothing beside "A"
    s.calls[0].answer(ok(1));
    await tick();
    expect(sent(s)).toEqual([[0, "A"], [1, "AB"]]);
    s.calls[1].answer(ok(2));
    await tick(RETRY_TOTAL);
    expect(s.calls).toHaveLength(2);
    expect(s.most()).toBe(1);
    expect(told).not.toHaveBeenCalled();
  });

  test("a save queued by a blur and one waiting for its 1.5 s when the screen is left: the newest text goes once, after the save on its way", async () => {
    const s = counted();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB");
    void e.save(7); // the blur: queued behind "A"
    e.editNote(7, 0, "ABC"); // back in the box, typed on: waits for its 1.5 s
    e.stop();
    await tick();
    expect(sent(s)).toEqual([[0, "A"]]);
    s.calls[0].answer(ok(1));
    await tick();
    expect(sent(s)).toEqual([[0, "A"], [1, "ABC"]]);
    s.calls[1].answer(null);
    await tick(RETRY_TOTAL);
    expect(s.calls).toHaveLength(2);
    expect(s.most()).toBe(1);
  });

  test("the answer of the save on its way is lost after the screen is left: 'AB' still goes once after it, and this browser remembers both texts, so a later visit that finds 'A' stored resumes 'AB' with no notice", async () => {
    const s = counted();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB");
    e.stop();
    await tick();
    s.calls[0].answer(null); // the server stored "A" as version 1; the answer never came
    await tick();
    expect(sent(s)).toEqual([[0, "A"], [0, "AB"]]); // one after the other, never together
    expect(s.most()).toBe(1);
    expect(readLocal(localStorage, 7)).toMatchObject({ version: 0, content: { notes: ["AB", ""] }, sent: [{ notes: ["A", ""], generalNote: "" }, { notes: ["AB", ""], generalNote: "" }] });
    s.calls[1].answer(refused(1, ["A", ""])); // ignored: the screen is gone
    await tick(RETRY_TOTAL);
    expect(s.calls).toHaveLength(2);
    const again = server();
    const back = start([draft({ version: 1, content: { notes: ["A", ""], generalNote: "" } })], again.send);
    await tick();
    expect(again.calls.map((c) => [c.body.version, c.body.notes[0]])).toEqual([[1, "AB"]]);
    again.calls[0].answer(ok(2));
    await tick();
    expect(back.get(7)).toMatchObject({ version: 2, conflict: null, status: { kind: "saved" } });
  });

  test("the save on its way is answered after the screen is left, nothing newer typed: its version and text are taken quietly and the copy goes; no timer, nobody told", async () => {
    const s = counted();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.stop();
    const told = vi.fn();
    e.subscribe(told);
    s.calls[0].answer(ok(1));
    await tick(RETRY_TOTAL);
    expect(e.get(7)).toMatchObject({ version: 1, confirmed: { notes: ["A", ""], generalNote: "" } });
    expect(readLocal(localStorage, 7)).toBeNull();
    expect(s.calls).toHaveLength(1);
    expect(told).not.toHaveBeenCalled();
  });

  test("the save on its way is refused after the screen is left (another device saved first): no notice, no timer; 'AB' goes once and the copy keeps it, so the next visit shows it in the notice", async () => {
    const s = counted();
    const e = start([draft()], s.send);
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    e.editNote(7, 0, "AB");
    e.stop();
    s.calls[0].answer(refused(1, ["telefon", ""]));
    await tick();
    expect(e.get(7)!.conflict).toBeNull();
    expect(sent(s)).toEqual([[0, "A"], [0, "AB"]]);
    s.calls[1].answer(refused(1, ["telefon", ""]));
    await tick(RETRY_TOTAL);
    expect(s.calls).toHaveLength(2);
    const back = start([draft({ version: 1, content: { notes: ["telefon", ""], generalNote: "" } })], server().send);
    expect(back.get(7)).toMatchObject({ content: { notes: ["telefon", ""] }, conflict: { titles: TITLES, lost: { notes: ["AB", ""], generalNote: "" } } });
  });
});

// The final review's parked items, fixed before the first real course day.
describe("the final review's parked items", () => {
  const notes = (s: { calls: { body: SaveBody }[] }) => s.calls.map((c) => [c.body.version, c.body.notes[0]]);
  const at = (v: number, note: string, over: Partial<ServerDraft> = {}) => draft({ version: v, content: { notes: [note, ""], generalNote: "" }, ...over });
  const keys = () => Object.keys(localStorage).filter((k) => k.includes(":7"));

  test("item 1: a quick remount — the old screen's late answer never brings back the copy the new screen released, and the next visit has no notice", async () => {
    const s = server();
    const old = new ProtocolAutosave([draft()], s.send, { tab: "t1" });
    old.start(localStorage);
    old.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS); // POST v0 "A" on its way (slow Wi-Fi)
    old.editNote(7, 0, "AB"); // waits for its 1.5 s
    old.stop(); // the screen left, and opened again at once: the server has stored "A" as v1, its answer is still on its way
    const s2 = server();
    const back = new ProtocolAutosave([at(1, "A")], s2.send, { tab: "t2" });
    engine = back;
    back.start(localStorage);
    await tick();
    expect(notes(s2)).toEqual([[1, "AB"]]); // the old screen's copy resumed: "A" was its own, "AB" goes on top
    s2.calls[0].answer(ok(2));
    await tick();
    expect(keys()).toEqual([]); // the new screen has it on the server: every copy released
    s.calls[0].answer(ok(1)); // the old screen's answer, late
    await tick();
    expect(notes(s)).toEqual([[0, "A"], [1, "AB"]]); // its parting save still goes
    s.calls[1].answer(ok(2));
    await tick();
    expect(keys()).toEqual([]); // no stray copy of the old screen
    back.editNote(7, 0, "ABC");
    await tick(DEBOUNCE_MS);
    s2.calls[1].answer(ok(3));
    await tick();
    back.stop();
    const next = new ProtocolAutosave([at(3, "ABC")], server().send, { tab: "t3" });
    engine = next;
    next.start(localStorage);
    expect(next.get(7)).toMatchObject({ conflict: null, content: { notes: ["ABC", ""] }, status: { kind: "saved" } });
  });

  test("item 1: the screen left with nobody back — the late answer still updates the old screen's copy (its key still exists)", async () => {
    const s = server();
    const old = new ProtocolAutosave([draft()], s.send, { tab: "t1" });
    old.start(localStorage);
    old.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS);
    old.editNote(7, 0, "AB");
    old.stop();
    s.calls[0].answer(ok(1));
    await tick();
    expect(readLocal(localStorage, 7, "t1")).toMatchObject({ version: 1, content: { notes: ["AB", ""] }, sent: [{ notes: ["AB", ""], generalNote: "" }] });
    expect(notes(s)).toEqual([[0, "A"], [1, "AB"]]);
  });

  test("item 7b: a successful read after a refused one ends 'signed out': each protocol says 'saved' again, a student it drops is gone", async () => {
    const s = server();
    const e = start([at(1, "x"), at(1, "y", { registrationId: 8 })], s.send);
    e.awaitFresh();
    e.signedOut();
    expect([e.get(7)!.status.kind, e.get(8)!.status.kind]).toEqual(["signedOut", "signedOut"]);
    e.reconcile([at(1, "x")]);
    expect(e.get(7)!.status).toMatchObject({ kind: "saved" });
    expect(e.get(8)!.status).toEqual({ kind: "gone" });
    void e.save(7); // nothing to save: 'saved', not the old 'signed out'
    await tick();
    expect(e.get(7)!.status).toMatchObject({ kind: "saved" });
    expect(s.calls).toHaveLength(0);
  });

  test("item 7b: a save refused as signed out, then a successful read: her text is saved at once, without waiting for the retry", async () => {
    const s = server();
    const e = start([at(1, "x")], s.send);
    e.editNote(7, 0, "x2");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer({ status: 401, body: { ok: false, error: "auth" } });
    await tick();
    expect(e.get(7)!.status).toEqual({ kind: "signedOut" });
    e.reconcile([at(1, "x")]); // signed in again: the read went through
    await tick();
    expect(notes(s)).toEqual([[1, "x2"], [1, "x2"]]);
    s.calls[1].answer(ok(2));
    await tick();
    expect(e.get(7)).toMatchObject({ version: 2, status: { kind: "saved" } });
  });

  test("item 7c: a save answered 404 is the server's word, like a 200: a read kept for after that save is not taken", async () => {
    const s = server();
    const e = start([at(1, "E")], s.send);
    e.awaitFresh();
    e.editNote(7, 0, "A");
    await tick(DEBOUNCE_MS); // its save on its way
    e.reconcile([at(2, "Teisest seadmest")]); // a read made before the registration went: kept for after the save
    s.calls[0].answer({ status: 404, body: { ok: false, error: "notFound" } });
    await tick();
    expect(e.get(7)).toMatchObject({ status: { kind: "gone" }, version: 1, content: { notes: ["A", ""] }, conflict: null });
    expect(e.checking(7)).toBe(false);
    await tick(120_000);
    expect(s.calls).toHaveLength(1);
  });
});
