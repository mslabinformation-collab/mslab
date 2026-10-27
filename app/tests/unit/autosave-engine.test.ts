// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AutosaveEngine, DEBOUNCE_MS, draftKey, KEEPALIVE_MAX_BYTES, patchSender, RETRY_MS, SAVE_TIMEOUT_MS, SENT_MAX_CHARS,
  type Fields, type SendPatch,
} from "@/components/admin/autosave/engine";
import * as constants from "@/components/admin/autosave/constants";
import { useAutosave } from "@/components/admin/autosave/useAutosave";
import * as protocolAutosave from "@/components/admin/protocol-autosave";
import { stubFetch } from "../fakes";

// The editors' autosave engine (admin UX pass, README §1.3; spec C1): when it saves, the browser's copy until the server confirms it, the retries,
// the keepalive on pagehide, the fields held back by their check, the version check's refusal and its restore, the lost answer that is ours
// (Review Focus 3), signed out and gone, and one save at a time. The server is answered by hand: every save waits for the test.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type Answer = Awaited<ReturnType<SendPatch>>;
const FIELDS: Fields = { title: "Pealkiri", body: "Tekst" };
const KEY = "mslab-draft:course:12:t1";
const ok = (version: string, savedAt = "2026-10-21T08:00:00.000Z"): Answer => ({ status: 200, body: { ok: true, version, savedAt } });
const stale = (version: string, value: Fields): Answer => ({ status: 409, body: { ok: false, error: "conflict", version, value } });

/** A server answered by hand: each save waits until the test calls `answer`. */
function server() {
  const calls: { body: { version: string; patch: Fields }; opts?: { keepalive?: boolean }; answer: (a: Answer) => void }[] = [];
  const send: SendPatch = (body, opts) => new Promise<Answer>((resolve) => calls.push({ body, opts, answer: resolve }));
  return { calls, send };
}

let engine: AutosaveEngine | null = null;
function make(send: SendPatch, over: { validate?: (f: Fields) => Record<string, string>; storage?: Storage | null } = {}) {
  engine = new AutosaveEngine({ owner: "course", key: "12", version: "v1", fields: { ...FIELDS }, send, validate: over.validate, tab: "t1" });
  engine.start(over.storage === undefined ? localStorage : over.storage);
  return engine;
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const stored = (key = KEY) => {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as { version: string; fields: Fields; sent: Fields[] });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
});
afterEach(() => {
  engine?.stop();
  engine = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("when it saves, and what a save sends", () => {
  test("saves 1500 ms after the last setField, and on flush()", async () => {
    const s = server();
    const e = make(s.send);
    expect(e.snapshot()).toEqual({ status: { kind: "saved", at: null }, fields: FIELDS, conflict: null });
    e.setField("title", "U");
    await tick(1000);
    e.setField("title", "Uus");
    expect(e.snapshot().status).toEqual({ kind: "dirty" });
    await tick(DEBOUNCE_MS - 1);
    expect(s.calls).toHaveLength(0);
    await tick(1);
    // only the changed fields, against the version the screen was given
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "Uus" } }]);
    expect(s.calls[0].opts).toBeUndefined();
    expect(e.snapshot().status).toEqual({ kind: "saving" });
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(e.snapshot()).toEqual({ status: { kind: "saved", at: new Date("2026-10-21T08:00:00.000Z") }, fields: { title: "Uus", body: "Tekst" }, conflict: null });
    expect(e.unconfirmed()).toBeNull();

    // flush: at once, against the version the first save got; the 1.5 s wait is cancelled
    e.setField("body", "Uus tekst");
    const flushed = e.flush();
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v2", patch: { body: "Uus tekst" } });
    s.calls[1].answer(ok("v3", "2026-10-21T08:05:00.000Z"));
    expect(await flushed).toBe(true);
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(2);
    // nothing changed: flush sends nothing and is confirmed
    expect(await e.flush()).toBe(true);
    expect(s.calls).toHaveLength(2);
  });

  test("typed back to the confirmed text: nothing is sent", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    e.setField("title", "Pealkiri");
    expect(e.snapshot().status).toEqual({ kind: "saved", at: null });
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  test("a hidden tab sends the waiting save at once", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.calls.map((c) => [c.body.patch, c.opts])).toEqual([[{ title: "Uus" }, undefined]]);
  });

  test("one save in flight at a time", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    await tick(DEBOUNCE_MS);
    e.setField("title", "AB");
    await tick(DEBOUNCE_MS);
    const flushed = e.flush();
    await tick();
    expect(s.calls).toHaveLength(1);
    s.calls[0].answer(ok("v2"));
    await tick();
    // what was typed meanwhile goes next, with the version the first one got
    expect(s.calls.map((c) => c.body)).toEqual([
      { version: "v1", patch: { title: "A" } },
      { version: "v2", patch: { title: "AB" } },
    ]);
    s.calls[1].answer(ok("v3"));
    expect(await flushed).toBe(true);
    expect(s.calls).toHaveLength(2);
    expect(e.snapshot().status.kind).toBe("saved");
  });

  test("stop() removes the listeners and the timers; start() again sends what waits", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    e.stop();
    await tick(60_000);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pagehide"));
    expect(s.calls).toHaveLength(0);
    expect(stored()?.fields.title).toBe("Uus"); // the copy stays for the next visit
    e.start(localStorage); // (React's strict mode: stop, then start again; nothing is resumed twice)
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "Uus" } }]);
  });
});

// Piece 4b, ruling R-i: Uudised mounts and unmounts an editor as Maria moves from post to post. A save already on its way when the screen goes may
// finish; a save waiting behind it (a flush, the text typed meanwhile that its answer would send next) is not sent after stop(): its text stays in
// this browser's copy, and the next mount resumes it.
describe("a save queued behind the one on its way, when the screen goes (piece 4b R-i)", () => {
  test("a flush queued behind it is not sent after stop(); the one on its way finishes, and the queued text's copy is resumed by the next mount", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(1);
    e.setField("title", "AB");
    const queued = e.flush();
    await tick();
    expect(s.calls).toHaveLength(1);
    e.stop();
    s.calls[0].answer(ok("v2"));
    expect(await queued).toBe(false);
    await tick(RETRY_MS[RETRY_MS.length - 1]);
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "A" } }]);
    // the copy: her text on the version the save on its way got
    expect(stored()).toMatchObject({ version: "v2", fields: { title: "AB", body: "Tekst" } });
    const next = new AutosaveEngine({ owner: "course", key: "12", version: "v2", fields: { title: "A", body: "Tekst" }, send: s.send, tab: "t2" });
    engine = next;
    next.start(localStorage);
    expect(next.snapshot().fields.title).toBe("AB");
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v2", patch: { title: "AB" } });
    s.calls[1].answer(ok("v3"));
    await tick();
    expect(next.snapshot().status.kind).toBe("saved");
    expect(localStorage.length).toBe(0);
  });

  test("the text typed while a save was on its way (its 1.5 s wait running) is not sent by that save's answer after stop()", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    await tick(DEBOUNCE_MS);
    e.setField("title", "AB");
    e.stop();
    s.calls[0].answer(ok("v2"));
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(1);
    expect(stored()).toMatchObject({ version: "v2", fields: { title: "AB" } });
  });

  test("the save on its way's own failure is not tried again after stop(), and a flush after stop() sends nothing; the copy keeps the text", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    await tick(DEBOUNCE_MS);
    e.stop();
    s.calls[0].answer(null);
    await tick(RETRY_MS[RETRY_MS.length - 1]);
    expect(await e.flush()).toBe(false);
    await tick();
    expect(s.calls).toHaveLength(1);
    expect(stored()).toMatchObject({ version: "v1", fields: { title: "A" }, sent: [{ title: "A", body: "Tekst" }] });
  });

  test("started again (React's strict mode: stop, then start), the queued text goes at once", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    await tick(DEBOUNCE_MS);
    e.setField("title", "AB");
    void e.flush();
    e.stop();
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(s.calls).toHaveLength(1);
    e.start(localStorage);
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v2", patch: { title: "AB" } });
  });

  test("useAutosave: a screen unmounted with a save on its way and one queued behind it sends nothing more", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const probe: { current: ReturnType<typeof useAutosave> | null } = { current: null };
    const s = server();
    function Probe() {
      const result = useAutosave({ owner: "course", key: "12", version: "v1", fields: FIELDS, save: s.send, label: (f) => f });
      useEffect(() => {
        probe.current = result;
      });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => probe.current!.setField("title", "A"));
    await act(async () => {
      await tick(DEBOUNCE_MS);
    });
    await act(async () => {
      probe.current!.setField("title", "AB");
      void probe.current!.flush();
    });
    await act(async () => root.unmount());
    container.remove();
    s.calls[0].answer(ok("v2"));
    await tick(60_000);
    expect(s.calls).toHaveLength(1);
    const copies = Object.keys(localStorage).filter((k) => k.startsWith("mslab-draft:course:12:"));
    expect(copies).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(copies[0])!)).toMatchObject({ version: "v2", fields: { title: "AB" } });
  });
});

describe("the browser's copy", () => {
  test("keeps a local copy at mslab-draft:{owner}:{key}:{tab} until the server confirms", async () => {
    expect(draftKey("course", "12", "t1")).toBe(KEY);
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    expect(stored()).toMatchObject({ version: "v1", fields: { title: "Uus", body: "Tekst" } });
    await tick(DEBOUNCE_MS);
    expect(stored()).toMatchObject({ fields: { title: "Uus" }, sent: [{ title: "Uus", body: "Tekst" }] }); // on its way: not confirmed yet
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(stored()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  test("a closed tab's copy is resumed by the next visit: dirty, and saved against the version it was typed on", async () => {
    localStorage.setItem("mslab-draft:course:12:old", JSON.stringify({ version: "v0", fields: { title: "Vanem", body: "Tekst" }, sent: [], at: 1 }));
    localStorage.setItem("mslab-draft:course:12:closed", JSON.stringify({ version: "v1", fields: { title: "Kadunud", body: "Tekst" }, sent: [], at: 2 }));
    localStorage.setItem("mslab-draft:course:13:other", JSON.stringify({ version: "v1", fields: { title: "Teine kursus" }, sent: [], at: 3 }));
    localStorage.setItem("mslab-draft:course:12:x:t9", JSON.stringify({ version: "v1", fields: { title: "Teine võti" }, sent: [], at: 4 }));
    const s = server();
    const e = make(s.send);
    expect(e.snapshot()).toMatchObject({ status: { kind: "dirty" }, fields: { title: "Kadunud", body: "Tekst" } }); // the newest
    expect(e.unconfirmed()).toMatchObject({ field: "title" });
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "Kadunud" } }]);
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");
    // the copies of this owner and key are gone; another key's stay
    expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).sort()).toEqual(["mslab-draft:course:12:x:t9", "mslab-draft:course:13:other"]);
  });

  test("a copy the server already holds is dropped, and nothing is sent", async () => {
    localStorage.setItem("mslab-draft:course:12:closed", JSON.stringify({ version: "v0", fields: { ...FIELDS }, sent: [], at: 1 }));
    const s = server();
    const e = make(s.send);
    expect(e.snapshot().status).toEqual({ kind: "saved", at: null });
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });

  test("a closed tab's copy against a server another device moved on: conflict, the copy's text kept", async () => {
    localStorage.setItem("mslab-draft:course:12:closed", JSON.stringify({ version: "v1", fields: { title: "Minu", body: "Tekst" }, sent: [], at: 1 }));
    const s = server();
    const e = new AutosaveEngine({ owner: "course", key: "12", version: "v3", fields: { title: "Teine seade", body: "Tekst" }, send: s.send, tab: "t1" });
    engine = e;
    e.start(localStorage);
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "Minu" } }]);
    s.calls[0].answer(stale("v3", { title: "Teine seade", body: "Tekst" }));
    await tick();
    expect(e.snapshot()).toEqual({ status: { kind: "conflict" }, fields: { title: "Minu", body: "Tekst" }, conflict: { version: "v3", value: { title: "Teine seade", body: "Tekst" } } });
    expect(stored()?.fields.title).toBe("Minu");
  });

  test("discardCopy() (a draft thrown away, „Loobu muudatustest“): every copy of the part goes, nothing more is sent or kept, nothing is unconfirmed", async () => {
    const s = server();
    const e = make(s.send);
    // a field the server refused, held back: uncertain, so this tab keeps a copy; and another tab's copy of the same part
    e.setField("title", "");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer({ status: 400, body: { ok: false, error: "invalid", fields: { title: "required" } } });
    await tick();
    expect(e.snapshot().status.kind).toBe("invalid");
    localStorage.setItem("mslab-draft:course:12:other", JSON.stringify({ version: "v1", fields: { title: "Teine", body: "Tekst" }, sent: [], at: 1 }));
    localStorage.setItem("mslab-draft:course:120:t9", "{}"); // (another part's copy stays)
    expect(stored()).not.toBeNull();
    e.discardCopy();
    expect(Object.keys(localStorage).sort()).toEqual(["mslab-draft:course:120:t9"]);
    expect(e.unconfirmed()).toBeNull();
    // typed into, flushed, back online: nothing goes and no copy comes back
    e.setField("body", "Veel");
    await tick(DEBOUNCE_MS);
    expect(await e.flush()).toBe(false);
    window.dispatchEvent(new Event("online"));
    await tick(RETRY_MS[RETRY_MS.length - 1]);
    expect(s.calls).toHaveLength(1);
    expect(stored()).toBeNull();
    // the next visit has nothing to resume
    e.stop();
    const next = new AutosaveEngine({ owner: "course", key: "12", version: "l:live", fields: { ...FIELDS }, send: s.send, tab: "t2" });
    engine = next;
    next.start(localStorage);
    await tick();
    expect(s.calls).toHaveLength(1);
    expect(next.snapshot().fields).toEqual(FIELDS);
  });

  test("adopt() (the page read again holds a value a server rule moved): an untouched field takes it as confirmed, nothing is sent; a field typed in, or on its way, keeps hers", async () => {
    const s = server();
    const e = make(s.send);
    expect(e.adopt("title", "Serveri oma")).toBe(true);
    expect(e.snapshot().fields).toEqual({ title: "Serveri oma", body: "Tekst" });
    expect(e.snapshot().status.kind).toBe("saved");
    expect(e.unconfirmed()).toBeNull();
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(0);
    // typed in (not yet saved): not taken
    e.setField("body", "Minu");
    expect(e.adopt("body", "Teine")).toBe(false);
    expect(e.snapshot().fields.body).toBe("Minu");
    // on its way: not taken either, and the save's answer confirms hers
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => c.body.patch)).toEqual([{ body: "Minu" }]);
    expect(e.adopt("body", "Teine")).toBe(false);
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(e.snapshot().fields).toEqual({ title: "Serveri oma", body: "Minu" });
    // in conflict: nothing is taken
    e.setField("title", "Uus");
    await tick(DEBOUNCE_MS);
    s.calls[1].answer(stale("v3", { title: "Teine seade", body: "Minu" }));
    await tick();
    expect(e.adopt("body", "Kolmas")).toBe(false);
    expect(e.snapshot().fields.body).toBe("Minu");
  });

  // piece 4b review I-1: a read that lands while a save of ANOTHER field is on its way. The save's answer confirms the text it sent — the old value of
  // the adopted field with it — so an adopt taken at once would leave the field differing from its confirmed text, and the next save would send it as
  // typed (a post's address would stop following its title). It is taken once the answer is in, and never sent.
  test("adopt() while a save of another field is on its way: taken once its answer is in, and never sent as typed", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("body", "Uus tekst");
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => c.body.patch)).toEqual([{ body: "Uus tekst" }]);
    expect(e.adopt("title", "Serveri oma")).toBe(true);
    // (not yet: the field shows what it showed, and its confirmed text is the one the save on its way carries)
    expect(e.snapshot().fields.title).toBe("Pealkiri");
    expect(e.confirmedValue("title")).toBe("Pealkiri");
    s.calls[0].answer(ok("v2"));
    await tick(DEBOUNCE_MS * 2);
    expect(e.snapshot().fields).toEqual({ title: "Serveri oma", body: "Uus tekst" });
    expect(e.confirmedValue("title")).toBe("Serveri oma");
    expect(e.snapshot().status.kind).toBe("saved");
    expect(e.unconfirmed()).toBeNull();
    // nothing more went out: not the adopted field, not anything else
    e.setField("body", "Veel");
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => c.body)).toEqual([
      { version: "v1", patch: { body: "Uus tekst" } },
      { version: "v2", patch: { body: "Veel" } },
    ]);
  });

  test("adopt() that waits for an answer: a field typed in meanwhile keeps hers; a conflict, a failure or a 404 takes nothing", async () => {
    // typed in before the answer: hers, sent as typed
    let s = server();
    let e = make(s.send);
    e.setField("body", "Uus");
    await tick(DEBOUNCE_MS);
    e.adopt("title", "Serveri oma");
    e.setField("title", "Minu");
    s.calls[0].answer(ok("v2"));
    await tick(DEBOUNCE_MS);
    expect(e.snapshot().fields.title).toBe("Minu");
    expect(s.calls[1].body).toEqual({ version: "v2", patch: { title: "Minu" } });
    e.stop();
    localStorage.clear();
    // the save on its way meets another tab's text: a conflict, nothing adopted
    s = server();
    e = make(s.send);
    e.setField("body", "Uus");
    await tick(DEBOUNCE_MS);
    e.adopt("title", "Serveri oma");
    s.calls[0].answer(stale("v3", { title: "Teine seade", body: "Tekst" }));
    await tick();
    expect(e.snapshot().fields.title).toBe("Pealkiri");
    e.stop();
    localStorage.clear();
    // no answer: unanswered, the adopt waits on; the retry's answer confirms, then it is taken — the retry never carries it
    s = server();
    e = make(s.send);
    e.setField("body", "Uus");
    await tick(DEBOUNCE_MS);
    e.adopt("title", "Serveri oma");
    s.calls[0].answer(null);
    await tick(RETRY_MS[0]);
    expect(e.snapshot().fields.title).toBe("Pealkiri");
    expect(s.calls[1].body.patch).toEqual({ body: "Uus" });
    s.calls[1].answer(ok("v2"));
    await tick();
    expect(e.snapshot().fields).toEqual({ title: "Serveri oma", body: "Uus" });
    await tick(DEBOUNCE_MS * 2);
    expect(s.calls).toHaveLength(2);
    e.stop();
    localStorage.clear();
    // gone (404): nothing adopted
    s = server();
    e = make(s.send);
    e.setField("body", "Uus");
    await tick(DEBOUNCE_MS);
    e.adopt("title", "Serveri oma");
    s.calls[0].answer({ status: 404, body: { ok: false, error: "notFound" } });
    await tick();
    expect(e.snapshot().fields.title).toBe("Pealkiri");
  });

  // piece 4b, Task 2 re-review N-1: an adopt that waits is replaced by a newer adopt of the same field. The save it waited for is answered 401 (signed
  // out: nothing confirmed, nothing unanswered), so the page's next read is taken at once — and the next confirmed save must not put the older one back.
  test("adopt() that waits, then signed out (401), then a newer adopt taken at once: the next confirmed save never brings the older value back", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("body", "Uus");
    await tick(DEBOUNCE_MS);
    expect(e.adopt("title", "Vana lugemine")).toBe(true); // waits for the save on its way
    s.calls[0].answer({ status: 401, body: { ok: false } });
    await tick();
    expect(e.snapshot().status.kind).toBe("signedOut");
    expect(e.snapshot().fields.title).toBe("Pealkiri"); // (nothing was confirmed: not taken)
    // the page's next read, with nothing on its way: taken at once
    expect(e.adopt("title", "Uus lugemine")).toBe(true);
    expect(e.snapshot().fields.title).toBe("Uus lugemine");
    // signed in again (the tab focused): the body goes again and is confirmed; the title stays the newer read's, and is never sent
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v1", patch: { body: "Uus" } });
    s.calls[1].answer(ok("v2"));
    await tick(DEBOUNCE_MS * 2);
    expect(e.snapshot().fields).toEqual({ title: "Uus lugemine", body: "Uus" });
    expect(e.confirmedValue("title")).toBe("Uus lugemine");
    expect(s.calls).toHaveLength(2);
  });

  test("two adopts of the same field while a save is on its way: the newer one is taken after the answer", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("body", "Uus");
    await tick(DEBOUNCE_MS);
    e.adopt("title", "Esimene");
    e.adopt("title", "Teine");
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(e.snapshot().fields.title).toBe("Teine");
    // and one back to the field's own text drops the one that waited: nothing is taken
    e.setField("body", "Veel");
    await tick(DEBOUNCE_MS);
    e.adopt("title", "Kolmas");
    e.adopt("title", "Teine");
    s.calls[1].answer(ok("v3"));
    await tick();
    expect(e.snapshot().fields.title).toBe("Teine");
    expect(s.calls).toHaveLength(2);
  });

  // piece 4b, Task 2 re-review N-2: a post's address that follows its title, whose engine missed the read that brought the server's new address (the
  // read is skipped once a save has landed since it), still holds the old one; the visit leaves with typed text unsent, so the copy holds that old
  // address too. Resumed as typed, it would be sent and the address would stop following. The copy keeps the confirmed text it was typed over (`base`):
  // a field that holds it was never typed, and the next visit's read stands there.
  test("a copy's field that was never typed takes the next visit's read on resume and is never sent; only the typed field goes", async () => {
    const s = server();
    const before = new AutosaveEngine({ owner: "site", key: "post", version: "v2", fields: { slug: "uus-postitus", body: "Tekst" }, send: s.send, tab: "old" });
    before.start(localStorage);
    before.setField("body", "Tekst ja veel");
    before.stop();
    expect(JSON.parse(localStorage.getItem("mslab-draft:site:post:old")!)).toMatchObject({ version: "v2", fields: { slug: "uus-postitus", body: "Tekst ja veel" }, base: { slug: "uus-postitus", body: "Tekst" } });
    const e = new AutosaveEngine({ owner: "site", key: "post", version: "v2", fields: { slug: "kevad", body: "Tekst" }, send: s.send, tab: "new" });
    engine = e;
    e.start(localStorage);
    expect(e.snapshot().fields).toEqual({ slug: "kevad", body: "Tekst ja veel" });
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v2", patch: { body: "Tekst ja veel" } }]);
    s.calls[0].answer(ok("v3"));
    await tick();
    expect(e.snapshot().fields).toEqual({ slug: "kevad", body: "Tekst ja veel" });
    expect(e.unconfirmed()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  test("the same in a text sent without an answer: its untyped field is the read's there too, so the retry sends only what was typed and the lost answer is still ours", async () => {
    localStorage.setItem(
      "mslab-draft:site:post:old",
      JSON.stringify({ version: "v2", fields: { slug: "uus-postitus", body: "Tekst ja veel ja veel" }, base: { slug: "uus-postitus", body: "Tekst" }, sent: [{ slug: "uus-postitus", body: "Tekst ja veel" }], at: 1 }),
    );
    const s = server();
    const e = new AutosaveEngine({ owner: "site", key: "post", version: "v3", fields: { slug: "kevad", body: "Tekst ja veel" }, send: s.send, tab: "new" });
    engine = e;
    e.start(localStorage);
    await tick();
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v2", patch: { body: "Tekst ja veel ja veel" } }]);
    // the server holds that visit's save whose answer was lost: ours, confirmed at its version, and the rest goes on from there
    s.calls[0].answer(stale("v3", { slug: "kevad", body: "Tekst ja veel" }));
    await tick();
    expect(e.snapshot().conflict).toBeNull();
    expect(s.calls[1].body).toEqual({ version: "v3", patch: { body: "Tekst ja veel ja veel" } });
    s.calls[1].answer(ok("v4"));
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "saved" }, fields: { slug: "kevad", body: "Tekst ja veel ja veel" } });
  });

  test("discardCopy() while a save is on its way: its answer leaves no copy behind", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    await tick(DEBOUNCE_MS);
    expect(stored()).not.toBeNull();
    e.discardCopy();
    s.calls[0].answer(null);
    await tick(RETRY_MS[0] * 2);
    expect(s.calls).toHaveLength(1);
    expect(stored()).toBeNull();
  });

  test("a browser that cannot keep a copy still saves", async () => {
    const s = server();
    const e = make(s.send, { storage: null });
    e.setField("title", "Uus");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");
  });
});

describe("the constants (the A screens, Task 1: they moved out of protocol-autosave.ts)", () => {
  const NAMES = ["DEBOUNCE_MS", "KEEPALIVE_MAX_BYTES", "RETRY_MS", "SAVE_TIMEOUT_MS", "SENT_MAX_CHARS"] as const;

  test("autosave/constants.ts holds them, with the values they always had", () => {
    expect(constants.DEBOUNCE_MS).toBe(1500);
    expect(constants.SAVE_TIMEOUT_MS).toBe(10_000);
    expect(constants.RETRY_MS).toEqual([2000, 5000, 10_000, 20_000, 30_000]);
    expect(constants.SENT_MAX_CHARS).toBe(200_000);
    expect(constants.KEEPALIVE_MAX_BYTES).toBe(64_000);
  });

  test("protocol-autosave.ts and the engine give the same values on (existing imports keep working)", () => {
    const fromEngine = { DEBOUNCE_MS, KEEPALIVE_MAX_BYTES, RETRY_MS, SAVE_TIMEOUT_MS, SENT_MAX_CHARS };
    for (const name of NAMES) {
      expect(protocolAutosave[name], name).toBe(constants[name]);
      expect(fromEngine[name], name).toBe(constants[name]);
    }
  });

  test("the engine imports them from constants.ts, not from protocol-autosave.ts (no chunk of the protocol screen, no cycle in piece 2)", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin/autosave/engine.ts"), "utf8");
    expect(source).toMatch(/from "@\/components\/admin\/autosave\/constants"|from "\.\/constants"/);
    expect(source).not.toMatch(/from "[^"]*protocol-autosave"/);
  });

  test("constants.ts imports nothing", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin/autosave/constants.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe("when a save fails", () => {
  test("retries after 2, 5, 10, 20, 30 s, and at once on online / focus", async () => {
    expect(RETRY_MS).toEqual([2000, 5000, 10_000, 20_000, 30_000]);
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    void e.flush();
    await tick();
    s.calls[0].answer(null); // no connection
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "retry" });
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "offline" });
    for (const wait of [2000, 5000, 10_000, 20_000, 30_000, 30_000]) {
      const n = s.calls.length;
      await tick(wait - 1);
      expect(s.calls).toHaveLength(n);
      await tick(1);
      expect(s.calls).toHaveLength(n + 1);
      expect(s.calls[n].body).toEqual({ version: "v1", patch: { title: "Uus" } });
      s.calls[n].answer(n % 2 ? null : { status: 503, body: null }); // no connection and server errors in turn, the last one a 503
      await tick();
    }
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "error" }); // the last one was a server error
    // back online: at once
    const n = s.calls.length;
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls).toHaveLength(n + 1);
    s.calls[n].answer(null);
    await tick();
    // back to the tab: at once, and the waits start again from 2 s
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(s.calls).toHaveLength(n + 2);
    s.calls[n + 1].answer({ status: 500, body: { ok: false, error: "server" } });
    await tick(RETRY_MS[0] - 1);
    expect(s.calls).toHaveLength(n + 2);
    await tick(1);
    expect(s.calls).toHaveLength(n + 3);
    s.calls[n + 2].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");
    expect(stored()).toBeNull();
    // nothing waits any more: neither a timer nor online sends again
    window.dispatchEvent(new Event("online"));
    await tick(60_000);
    expect(s.calls).toHaveLength(n + 3);
  });

  test("an answer that never comes is given up after 10 s and tried again", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    await tick(DEBOUNCE_MS);
    await tick(SAVE_TIMEOUT_MS - 1);
    expect(e.snapshot().status).toEqual({ kind: "saving" });
    await tick(1);
    expect(e.snapshot().status).toEqual({ kind: "retry" });
    expect(e.unconfirmed()?.reason).toBe("offline");
    await tick(RETRY_MS[0]);
    expect(s.calls).toHaveLength(2);
  });

  test("the texts sent without an answer are kept once each, at most SENT_MAX_CHARS together, the newest always", async () => {
    const s = server();
    const e = make(s.send);
    const text = (c: string) => c.repeat(SENT_MAX_CHARS / 3);
    for (const c of ["a", "a", "b", "c", "d"]) {
      e.setField("body", text(c));
      void e.flush();
      await tick();
      s.calls[s.calls.length - 1].answer(null);
      await tick();
    }
    const sent = stored()!.sent;
    expect(sent.map((v) => String(v.body)[0])).toEqual(["c", "d"]); // "a" once, then the oldest went first
    expect(sent.reduce((n, v) => n + JSON.stringify(v).length, 0)).toBeLessThanOrEqual(SENT_MAX_CHARS);
  });

  test("401 → signedOut, text kept; 404 → gone", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    void e.flush();
    await tick();
    s.calls[0].answer({ status: 401, body: { ok: false, error: "unauthorized" } });
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "signedOut" }, fields: { title: "Uus" } });
    expect(stored()?.fields.title).toBe("Uus");
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "signedOut" });
    // typing on while signed out still says so
    e.setField("body", "Veel");
    expect(e.snapshot().status).toEqual({ kind: "signedOut" });
    // signed in again in another tab: back to this one, it goes at once
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v1", patch: { title: "Uus", body: "Veel" } });
    s.calls[1].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");

    // the row was deleted meanwhile: gone, the text stays in this browser, nothing is tried again
    e.setField("title", "Veel uuem");
    void e.flush();
    await tick();
    s.calls[2].answer({ status: 404, body: { ok: false, error: "notFound" } });
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "gone" }, fields: { title: "Veel uuem" } });
    expect(stored()?.fields.title).toBe("Veel uuem");
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "error" });
    e.setField("body", "Ikka veel");
    expect(stored()?.fields.body).toBe("Ikka veel");
    window.dispatchEvent(new Event("online"));
    await tick(60_000);
    expect(await e.flush()).toBe(false);
    expect(s.calls).toHaveLength(3);
  });

  test("403 (another site's request) is signed out too", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    void e.flush();
    await tick();
    s.calls[0].answer({ status: 403, body: { ok: false, error: "forbidden" } });
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "signedOut" });
  });
});

describe("the page put away", () => {
  test("pagehide sends with keepalive only when the body is ≤ 64 000 bytes", async () => {
    const s = server();
    const e = make(s.send);
    window.dispatchEvent(new Event("pageshow")); // a new page's budget
    const wrapper = JSON.stringify({ version: "v1", patch: { body: "" } }).length; // ASCII: one byte a character
    const fits = "õ".repeat((KEEPALIVE_MAX_BYTES - wrapper) / 2); // two bytes each in UTF-8: exactly 64 000 with the wrapper
    e.setField("body", fits);
    window.dispatchEvent(new Event("pagehide"));
    expect(s.calls.map((c) => c.opts)).toEqual([{ keepalive: true }]);
    expect(new TextEncoder().encode(JSON.stringify(s.calls[0].body)).length).toBe(KEEPALIVE_MAX_BYTES);
    s.calls[0].answer(ok("v2"));
    await tick();

    // one byte more is left to the browser's copy; it goes at its time if the page comes back
    window.dispatchEvent(new Event("pageshow"));
    e.setField("body", `${fits}a`);
    window.dispatchEvent(new Event("pagehide"));
    expect(s.calls).toHaveLength(1);
    expect(stored()?.fields.body).toBe(`${fits}a`);
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1].opts).toBeUndefined();
  });

  test("the keepalive budget is the page's: what one save spent, another cannot until the page is shown again", async () => {
    const s = server();
    const e = make(s.send);
    window.dispatchEvent(new Event("pageshow"));
    e.setField("body", "õ".repeat(20_000)); // 40 000 bytes and the wrapper
    window.dispatchEvent(new Event("pagehide"));
    s.calls[0].answer(ok("v2"));
    await tick();
    e.setField("body", "ä".repeat(20_000));
    window.dispatchEvent(new Event("pagehide"));
    expect(s.calls).toHaveLength(1);
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("pagehide"));
    expect(s.calls.map((c) => c.opts)).toEqual([{ keepalive: true }, { keepalive: true }]);
  });
});

describe("a field held back by its check", () => {
  test("an invalid field is left out of the patch; the others still save; status invalid lists it", async () => {
    const s = server();
    const e = make(s.send, { validate: (f): Record<string, string> => (String(f.title).trim() === "" ? { title: "required" } : {}) });
    e.setField("title", "");
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["title"] });
    e.setField("body", "Uus tekst");
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { body: "Uus tekst" } }]);
    s.calls[0].answer(ok("v2"));
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "invalid", fields: ["title"] }, fields: { title: "", body: "Uus tekst" } });
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "invalid" });
    expect(stored()?.fields.title).toBe(""); // the held-back text stays in this browser
    expect(await e.flush()).toBe(false); // nothing to send, and not confirmed
    expect(s.calls).toHaveLength(1);
    // corrected: it goes
    e.setField("title", "Uus pealkiri");
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toEqual({ version: "v2", patch: { title: "Uus pealkiri" } });
    s.calls[1].answer(ok("v3"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");
    expect(stored()).toBeNull();
  });

  test("a field the server refuses (400 with its code) is held back the same way, and the rest goes at once", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus pealkiri");
    e.setField("body", "Liiga pikk");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer({ status: 400, body: { ok: false, error: "invalid", fields: { body: "tooLong" } } });
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v1", patch: { title: "Uus pealkiri" } });
    s.calls[1].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["body"] });
    // typed again: tried again
    e.setField("body", "Lühem");
    await tick(DEBOUNCE_MS);
    expect(s.calls[2].body).toEqual({ version: "v2", patch: { body: "Lühem" } });
  });
});

describe("a refused field never loops, and a field error clears a stale failure (review, fix round 1)", () => {
  const required = { status: 400, body: { ok: false, error: "invalid", fields: { title: "required" } } };
  const newRow = (send: SendPatch, validate?: (f: Fields) => Record<string, string>) => {
    // a new row: the title is empty, and its check requires one
    engine = new AutosaveEngine({ owner: "post", key: "1", version: "v1", fields: { title: "", body: "x" }, send, validate, tab: "t1" });
    engine.start(localStorage);
    return engine;
  };

  test("a field the server refuses, typed back to the confirmed value after a lost answer, is held back: never re-sent at once", async () => {
    const s = server();
    const e = newRow(s.send);
    e.setField("title", "A");
    void e.flush();
    await tick();
    s.calls[0].answer(null); // lost: the server may hold "A"
    await tick();
    e.setField("title", ""); // typed back to the empty title
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toEqual({ version: "v1", patch: { title: "" } }); // (the server may hold "A": so the title goes)
    s.calls[1].answer(required);
    await tick();
    expect(s.calls).toHaveLength(2); // not again at once
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["title"] });
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "invalid" });
    await tick(120_000);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls).toHaveLength(2);
    // typed in again: tried again
    e.setField("title", "B");
    await tick(DEBOUNCE_MS);
    expect(s.calls[2].body).toEqual({ version: "v1", patch: { title: "B" } });
  });

  test("the form's own check holds back the same field: nothing is sent, the lost save's retry included", async () => {
    const s = server();
    const e = newRow(s.send, (f): Record<string, string> => (f.title === "" ? { title: "required" } : {}));
    e.setField("title", "A");
    void e.flush();
    await tick();
    s.calls[0].answer(null);
    await tick();
    e.setField("title", "");
    await tick(120_000);
    expect(s.calls).toHaveLength(1);
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["title"] });
  });

  test("a failure, then a 400 on the only field: invalid, reason invalid, and no retry left", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Liiga pikk pealkiri");
    void e.flush();
    await tick();
    s.calls[0].answer({ status: 503, body: null });
    await tick();
    await tick(RETRY_MS[0]);
    s.calls[1].answer({ status: 400, body: { ok: false, error: "invalid", fields: { title: "tooLong" } } });
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["title"] });
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "invalid" });
    await tick(120_000);
    expect(s.calls).toHaveLength(2);
  });

  test("401, then a 400 on the only field: invalid, not signed out", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Liiga pikk pealkiri");
    void e.flush();
    await tick();
    s.calls[0].answer({ status: 401, body: { ok: false, error: "unauthorized" } });
    await tick();
    window.dispatchEvent(new Event("focus")); // signed in again in another tab
    await tick();
    s.calls[1].answer({ status: 400, body: { ok: false, error: "invalid", fields: { title: "tooLong" } } });
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["title"] });
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "invalid" });
    await tick(120_000);
    expect(s.calls).toHaveLength(2);
  });

  test("a refusal that would repeat (413) is not tried again on a timer: once on the next edit, focus or online", async () => {
    const s = server();
    const e = make(s.send);
    const tooBig = { status: 413, body: { ok: false, error: "size" } };
    e.setField("body", "Liiga suur");
    void e.flush();
    await tick();
    s.calls[0].answer(tooBig);
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "retry" });
    expect(e.unconfirmed()).toEqual({ field: "body", reason: "error" });
    await tick(120_000);
    expect(s.calls).toHaveLength(1);
    expect(stored()?.fields.body).toBe("Liiga suur"); // the text stays in this browser
    // the next edit: one send (after its 1.5 s)
    e.setField("body", "Väiksem");
    await tick(DEBOUNCE_MS);
    expect(s.calls).toHaveLength(2);
    s.calls[1].answer(tooBig);
    await tick(120_000);
    expect(s.calls).toHaveLength(2);
    // focus: once
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(s.calls).toHaveLength(3);
    s.calls[2].answer(tooBig);
    await tick();
    // online: once
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(s.calls).toHaveLength(4);
    s.calls[3].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");
  });

  test.each([
    ["a 400 that is not a save", { status: 400, body: { ok: false, error: "body" } }],
    ["a 400 that names no field of the patch", { status: 400, body: { ok: false, error: "invalid", fields: { other: "unknown" } } }],
    ["a 409 that is not a conflict's", { status: 409, body: { ok: false, error: "conflict" } }],
  ])("%s waits for the next edit the same way", async (_name, refusal) => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Uus");
    void e.flush();
    await tick();
    s.calls[0].answer(refusal);
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "retry" });
    expect(e.unconfirmed()?.reason).toBe("error");
    await tick(120_000);
    expect(s.calls).toHaveLength(1);
    e.setField("title", "Uuem");
    await tick(DEBOUNCE_MS);
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { title: "Uus" } }, { version: "v1", patch: { title: "Uuem" } }]);
  });
});

describe("an edit after a waiting refusal, and a correction typed during a refused save (review, fix round 2)", () => {
  const tooBig = { status: 413, body: { ok: false, error: "size" } };
  const tooLong = { status: 400, body: { ok: false, error: "invalid", fields: { title: "tooLong" } } };

  test("413, then typed back to the confirmed text: saved, nothing unconfirmed, nothing sent", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("body", "Liiga suur");
    void e.flush();
    await tick();
    s.calls[0].answer(tooBig);
    await tick();
    e.setField("body", "Tekst");
    expect(e.snapshot().status).toEqual({ kind: "saved", at: null });
    expect(e.unconfirmed()).toBeNull();
    await tick(120_000);
    expect(s.calls).toHaveLength(1);
    expect(stored()).toBeNull();
  });

  test("413, then the only changed field is one its check refuses: invalid, reason invalid", async () => {
    const s = server();
    const e = make(s.send, { validate: (f): Record<string, string> => (f.body === "" ? { body: "required" } : {}) });
    e.setField("body", "Liiga suur");
    void e.flush();
    await tick();
    s.calls[0].answer(tooBig);
    await tick();
    e.setField("body", "");
    expect(e.snapshot().status).toEqual({ kind: "invalid", fields: ["body"] });
    expect(e.unconfirmed()).toEqual({ field: "body", reason: "invalid" });
    await tick(120_000);
    expect(s.calls).toHaveLength(1);
  });

  test("a lost answer, then a 400 on a title corrected while that save was on its way: the correction is not held, and it is sent", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    void e.flush();
    await tick();
    s.calls[0].answer(null); // lost
    await tick();
    e.setField("title", "Liiga pikk pealkiri");
    void e.flush();
    await tick();
    e.setField("title", "Hea"); // corrected during the flight
    s.calls[1].answer(tooLong);
    await tick();
    expect(e.snapshot().status).toEqual({ kind: "dirty" });
    await tick(DEBOUNCE_MS);
    expect(s.calls[2].body).toEqual({ version: "v1", patch: { title: "Hea" } });
    s.calls[2].answer(ok("v2"));
    await tick(120_000);
    expect(e.snapshot().status.kind).toBe("saved");
    expect(s.calls).toHaveLength(3);
  });

  test("a lost answer, then a 400 on a title typed back to the confirmed text during that save: the confirmed text is sent, not held", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    void e.flush();
    await tick();
    s.calls[0].answer(null); // lost: the server may hold "A"
    await tick();
    e.setField("title", "Liiga pikk pealkiri");
    void e.flush();
    await tick();
    e.setField("title", "Pealkiri"); // back to the confirmed text during the flight
    s.calls[1].answer(tooLong);
    await tick(DEBOUNCE_MS);
    expect(s.calls[2].body).toEqual({ version: "v1", patch: { title: "Pealkiri" } }); // (the server may hold "A")
    s.calls[2].answer(ok("v2"));
    await tick();
    expect(e.snapshot().status.kind).toBe("saved");
  });
});

describe("another tab or device saved first (409)", () => {
  test("409 → status conflict, the local text kept; restore() saves it over the server's version", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Minu");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(stale("v5", { title: "Teine aken", body: "Tekst" }));
    await tick();
    expect(e.snapshot()).toEqual({
      status: { kind: "conflict" },
      fields: { title: "Minu", body: "Tekst" },
      conflict: { version: "v5", value: { title: "Teine aken", body: "Tekst" } },
    });
    expect(stored()?.fields.title).toBe("Minu");
    expect(e.unconfirmed()).toEqual({ field: "title", reason: "error" });
    // nothing goes over the other window's text by itself: not typing on, not a retry, not online, not flush
    e.setField("body", "Veel");
    expect(e.snapshot().status).toEqual({ kind: "conflict" });
    await tick(60_000);
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(await e.flush()).toBe(false);
    expect(s.calls).toHaveLength(1);
    expect(stored()?.fields).toEqual({ title: "Minu", body: "Veel" });
    // „Taasta minu tekst“: the screen's text saved over the server's version
    const restored = e.restore();
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v5", patch: { title: "Minu", body: "Veel" } });
    s.calls[1].answer(ok("v6"));
    expect(await restored).toBe(true);
    expect(e.snapshot()).toMatchObject({ status: { kind: "saved" }, conflict: null, fields: { title: "Minu", body: "Veel" } });
    expect(stored()).toBeNull();
  });

  test("a 409 whose stored text is the screen's own (another tab typed the same) is simply confirmed", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "Sama");
    await tick(DEBOUNCE_MS);
    s.calls[0].answer(stale("v4", { title: "Sama", body: "Tekst" }));
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "saved" }, conflict: null });
    expect(s.calls).toHaveLength(1);
  });

  test("a lost answer retried with nothing typed since: the refusal brings the save itself, confirmed", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    void e.flush();
    await tick();
    s.calls[0].answer(null); // the server stored it as v2, but the answer was lost on the way
    await tick();
    await tick(RETRY_MS[0]);
    expect(s.calls[1].body).toEqual({ version: "v1", patch: { title: "A" } });
    s.calls[1].answer(stale("v2", { title: "A", body: "Tekst" }));
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "saved" }, conflict: null, fields: { title: "A" } });
    expect(s.calls).toHaveLength(2);
    expect(stored()).toBeNull();
    // and the next save goes from v2
    e.setField("title", "B");
    await tick(DEBOUNCE_MS);
    expect(s.calls[2].body).toEqual({ version: "v2", patch: { title: "B" } });
  });

  test("a lost answer, retried, is not a conflict with itself", async () => {
    // typed on since the lost save, so only the engine's memory of what it sent tells (protocol-autosave.ts:1134-1138)
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    await tick(DEBOUNCE_MS);
    await tick(SAVE_TIMEOUT_MS); // stored as v2, the answer never came
    expect(e.snapshot().status).toEqual({ kind: "retry" });
    e.setField("title", "AB");
    await tick(DEBOUNCE_MS);
    expect(s.calls[1].body).toEqual({ version: "v1", patch: { title: "AB" } });
    s.calls[1].answer(stale("v2", { title: "A", body: "Tekst" }));
    await tick();
    expect(s.calls[2].body).toEqual({ version: "v2", patch: { title: "AB" } });
    expect(e.snapshot().conflict).toBeNull();
    s.calls[2].answer(ok("v3"));
    await tick();
    expect(e.snapshot()).toMatchObject({ status: { kind: "saved" }, conflict: null, fields: { title: "AB" } });
  });

  test("a lost answer, then a real change from another tab: conflict, the local text kept", async () => {
    const s = server();
    const e = make(s.send);
    e.setField("title", "A");
    void e.flush();
    await tick();
    s.calls[0].answer({ status: 502, body: null }); // a server error: it may have stored it all the same
    await tick();
    await tick(RETRY_MS[0]);
    s.calls[1].answer(stale("v3", { title: "Teine aken", body: "Tekst" })); // another tab saved over it since
    await tick();
    expect(e.snapshot()).toEqual({ status: { kind: "conflict" }, fields: { title: "A", body: "Tekst" }, conflict: { version: "v3", value: { title: "Teine aken", body: "Tekst" } } });
    expect(stored()?.fields.title).toBe("A");
  });

  test("a lost answer of an earlier visit, kept in its copy, is recognised by the next one", async () => {
    localStorage.setItem("mslab-draft:course:12:closed", JSON.stringify({ version: "v1", fields: { title: "AB", body: "Tekst" }, sent: [{ title: "A", body: "Tekst" }], at: 1 }));
    const s = server();
    const e = new AutosaveEngine({ owner: "course", key: "12", version: "v2", fields: { title: "A", body: "Tekst" }, send: s.send, tab: "t1" });
    engine = e;
    e.start(localStorage);
    await tick();
    s.calls[0].answer(stale("v2", { title: "A", body: "Tekst" }));
    await tick();
    expect(s.calls[1].body).toEqual({ version: "v2", patch: { title: "AB" } });
    expect(e.snapshot().conflict).toBeNull();
  });
});

describe("patchSender", () => {
  test("POSTs { version, patch } as JSON with the admin's cookie, keepalive when asked; null without an answer", async () => {
    const f = stubFetch(() => Response.json({ ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" }));
    const send = patchSender("/api/admin/salvesta/test/7");
    expect(await send({ version: "v1", patch: { title: "Uus" } }, { keepalive: true })).toEqual({ status: 200, body: { ok: true, version: "v2", savedAt: "2026-10-21T08:00:00.000Z" } });
    expect(f.calls.map((c) => [c.url, c.method, c.headers.get("content-type"), c.body])).toEqual([["/api/admin/salvesta/test/7", "POST", "application/json", { version: "v1", patch: { title: "Uus" } }]]);
    expect(f.fn.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", keepalive: true });
    await send({ version: "v1", patch: {} });
    expect(f.fn.mock.calls[1][1]).toMatchObject({ keepalive: false });
    f.restore();
    const down = stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await send({ version: "v1", patch: {} })).toBeNull();
    down.restore();
  });
});

describe("useAutosave", () => {
  test("the engine's state with the fields' labels; it starts with the screen and stops with it", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    type Hook = ReturnType<typeof useAutosave>;
    const probe: { current: Hook | null } = { current: null };
    const s = server();
    function Probe() {
      const result = useAutosave({
        owner: "course",
        key: "12",
        version: "v1",
        fields: FIELDS,
        save: s.send,
        validate: (f): Record<string, string> => (f.title === "" ? { title: "required" } : {}),
        label: (field) => (field === "title" ? "Pealkiri" : field),
      });
      useEffect(() => {
        probe.current = result;
      });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    expect(probe.current).toMatchObject({ status: { kind: "saved", at: null }, fields: FIELDS, conflict: null });
    await act(async () => probe.current!.setField("title", ""));
    expect(probe.current).toMatchObject({ status: { kind: "invalid", fields: ["Pealkiri"] }, fields: { title: "" } });
    await act(async () => probe.current!.setField("body", "Uus"));
    const copies = [...Array(localStorage.length)].map((_, i) => localStorage.key(i)!);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^mslab-draft:course:12:[a-z0-9]+$/);
    await act(async () => {
      await tick(DEBOUNCE_MS);
    });
    expect(s.calls.map((c) => c.body)).toEqual([{ version: "v1", patch: { body: "Uus" } }]);
    await act(async () => {
      s.calls[0].answer(null);
      await tick();
    });
    expect(probe.current!.status).toEqual({ kind: "retry" });
    expect(probe.current!.unconfirmed()).toEqual({ field: "title", reason: "offline" });
    await act(async () => root.unmount());
    container.remove();
    // stopped: the retry's timer is gone
    await tick(60_000);
    expect(s.calls).toHaveLength(1);
  });
});
