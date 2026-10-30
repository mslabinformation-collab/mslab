// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOutbox, OUTBOX_KEY, type Outbox } from "@/components/admin/testplan-outbox";

// The test page's outbox (phase 4, piece 1, Task 3): the answers a device has not got to the server yet. A status press is sent at once, a
// note 1 s after the last keystroke; a send that fails is tried again after 2, 5, 10, 20, then every 30 s, and at once when the browser is
// back online or the tab is shown; an answer leaves the device's storage only when a save that carried it came back ok. Fake timers, a fake
// `put` and an in-memory Storage; the retries are the schedule the spec names.

const ANSWERS = { a: { status: "ok", note: "", at: "2026-10-16T10:00:00.000Z", byName: "Maria" } } as const;

/** A Storage in memory; `failSet` makes a write throw as a full or blocked one does. */
function memoryStorage(opts: { failSet?: boolean } = {}): Storage & { dump(): string | null } {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (opts.failSet) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      items.set(key, String(value));
    },
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
    dump: () => items.get(OUTBOX_KEY) ?? null,
  };
}

const okResponse = () => new Response(JSON.stringify({ ok: true, answers: ANSWERS }), { status: 200 });
const bodyOf = (put: ReturnType<typeof vi.fn>, call: number) => put.mock.calls[call][0] as { answers: Record<string, { status: string; note: string }> };

let made: Outbox[] = [];
function outboxOver(storage: Storage | null, put: (body: { answers: Record<string, never> }) => Promise<Response>, onAnswers = vi.fn()) {
  const outbox = createOutbox({
    storage,
    put: put as never,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    onAnswers,
  });
  made.push(outbox);
  return { outbox, onAnswers };
}
/** Lets the promises of a send settle (no time passes). */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T10:00:00.000Z"));
});
afterEach(() => {
  for (const outbox of made) outbox.stop();
  made = [];
  vi.useRealTimers();
});

describe("a status press", () => {
  test("is sent at once, carrying { status, note }; saving until the answer, then saved; the entry leaves the storage and the server's answers go to onAnswers", async () => {
    const storage = memoryStorage();
    const put = vi.fn(async () => okResponse());
    const { outbox, onAnswers } = outboxOver(storage, put);
    expect(outbox.status()).toBe("idle");

    outbox.answer("a", "ok", "");
    expect(put).toHaveBeenCalledTimes(1);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "ok", note: "" } } });
    expect(outbox.status()).toBe("saving");
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "ok", note: "" });

    await settle();
    expect(outbox.status()).toBe("saved");
    expect(storage.dump()).toBeNull();
    expect(onAnswers).toHaveBeenCalledWith(ANSWERS);
    expect(outbox.unsent().size).toBe(0);
  });

  test("a press after a note on the same check carries the note it was given", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "Nupp ei tööta");
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "bad", note: "Nupp ei tööta" } } });
  });

  test("onChange is told of every change, and not any more once it is unsubscribed", async () => {
    const { outbox } = outboxOver(memoryStorage(), vi.fn(async () => okResponse()));
    const heard = vi.fn();
    const off = outbox.onChange(heard);
    outbox.answer("a", "ok", "");
    expect(heard).toHaveBeenCalled();
    await settle();
    const after = heard.mock.calls.length;
    off();
    outbox.answer("a", "skip", "");
    expect(heard.mock.calls.length).toBe(after);
  });
});

describe("a note", () => {
  test("is sent 1 s after the last call: three calls within a second send once, with the last text", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.note("a", "N", "bad");
    await vi.advanceTimersByTimeAsync(400);
    outbox.note("a", "Nu", "bad");
    await vi.advanceTimersByTimeAsync(400);
    outbox.note("a", "Nupp", "bad");
    await vi.advanceTimersByTimeAsync(999);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "bad", note: "Nupp" } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("is kept in the storage while it waits, and flush() sends it at once (the field lost the focus)", async () => {
    const storage = memoryStorage();
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.note("a", "Nupp", "bad");
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "bad", note: "Nupp" });
    expect(outbox.status()).toBe("saving");
    await outbox.flush();
    expect(put).toHaveBeenCalledTimes(1);
    expect(outbox.status()).toBe("saved");
    await vi.advanceTimersByTimeAsync(5000);
    expect(put).toHaveBeenCalledTimes(1); // (the timer of the note was cancelled)
  });

  test("takes the status of the check from the argument, else from the press before it; with neither it has nothing to attach to and is dropped", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.note("unknown", "x");
    expect(outbox.unsent().size).toBe(0);
    outbox.answer("a", "skip", "");
    await settle();
    outbox.note("a", "Jäi vahele, sest ei ole aega");
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "skip", note: "Jäi vahele, sest ei ole aega" } } });
  });

  test("attaches to the check's press waiting here, whatever status the page passes (a page that has not drawn that press yet passes the one before)", async () => {
    const put = vi.fn(() => new Promise<Response>(() => {}));
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "");
    outbox.note("a", "Nupp ei tööta", "ok");
    expect(outbox.unsent().get("a")).toEqual({ status: "bad", note: "Nupp ei tööta" });
    // with no press waiting, the page's status is the one (the server's answer, perhaps the other admin's)
    outbox.note("b", "Hea", "skip");
    expect(outbox.unsent().get("b")).toEqual({ status: "skip", note: "Hea" });
  });

  test("typed while a save is on its way: the save finishes first, and the note then goes by its own timer, not at once", async () => {
    let finish: (r: Response) => void = () => {};
    const put = vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => (finish = r))).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "");
    outbox.note("a", "Nu", "bad");
    finish(okResponse());
    await settle();
    expect(put).toHaveBeenCalledTimes(1); // (the note still waits for its second)
    expect(outbox.unsent().get("a")).toMatchObject({ status: "bad", note: "Nu" }); // (the press that was sent is not the note that was typed)
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "bad", note: "Nu" } } });
  });
});

describe("a send that fails", () => {
  test("is retrying, and tried again after 2 s and 5 s; a success then clears the storage key's entry", async () => {
    const storage = memoryStorage();
    const put = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockImplementation(async () => okResponse());
    const { outbox, onAnswers } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    expect(outbox.status()).toBe("retrying");
    expect(put).toHaveBeenCalledTimes(1);
    expect(storage.dump()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1999);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(outbox.status()).toBe("retrying");

    await vi.advanceTimersByTimeAsync(4999);
    expect(put).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(3);
    expect(outbox.status()).toBe("saved");
    expect(storage.dump()).toBeNull();
    expect(onAnswers).toHaveBeenCalledTimes(1);
    // (carried the same entry all three times)
    for (const call of [0, 1, 2]) expect(bodyOf(put, call)).toEqual({ answers: { a: { status: "ok", note: "" } } });
  });

  test("the schedule goes on 10 s, 20 s, then every 30 s, and starts again from 2 s after a success", async () => {
    const put = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "ok", "");
    await settle();
    let calls = 1;
    for (const wait of [2000, 5000, 10_000, 20_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(put).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(put).toHaveBeenCalledTimes(++calls);
    }
    put.mockImplementation(async () => okResponse());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outbox.status()).toBe("saved");
    // a new failure starts at 2 s again
    put.mockRejectedValue(new TypeError("Failed to fetch"));
    outbox.answer("b", "ok", "");
    await settle();
    const before = put.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(put).toHaveBeenCalledTimes(before + 1);
  });

  test("an answer that is not ok JSON is a failure too (a 500 page, a 403, a 200 that is not our answer)", async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>500</html>", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403 }))
      .mockResolvedValueOnce(new Response("<html>fine</html>", { status: 200 }))
      .mockImplementation(async () => okResponse());
    const storage = memoryStorage();
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(outbox.status()).toBe("retrying");
    expect(storage.dump()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outbox.status()).toBe("saved");
    expect(storage.dump()).toBeNull();
  });

  test("is tried again at once when the browser is back online, and when the tab is shown again", async () => {
    const put = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "ok", "");
    await settle();
    expect(put).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("online"));
    expect(put).toHaveBeenCalledTimes(2);
    await settle();

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(put).toHaveBeenCalledTimes(2); // (hidden: nothing)
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(put).toHaveBeenCalledTimes(3);
    await settle();

    put.mockImplementation(async () => okResponse());
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(outbox.status()).toBe("saved");
    // nothing left: the events send nothing
    window.dispatchEvent(new Event("online"));
    expect(put).toHaveBeenCalledTimes(4);
  });

  test("a stopped outbox hears nothing and sends nothing", async () => {
    const put = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "ok", "");
    await settle();
    outbox.stop();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

// Admin UX pass piece 4c, R-i (Review Focus 5): a press after the session ended. The route answers 401 (withAdmin); the outbox says „signedOut“ and
// sets no retry timer (a timer would ask again every 30 s, for nothing, until she signs in); the press stays on the device and goes with the next try
// she makes (a press, a note, the tab shown again, the browser back online) or the next visit, after she signed in again.
describe("a 401: the session ended", () => {
  const unauthorized = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });

  test("is signedOut, with no retry timer: nothing is sent again by itself, the press stays in the storage and on the page", async () => {
    const storage = memoryStorage();
    const put = vi.fn(async () => unauthorized());
    const { outbox, onAnswers } = outboxOver(storage, put);
    outbox.answer("a", "bad", "Nupp ei tööta");
    await settle();
    expect(outbox.status()).toBe("signedOut");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(put).toHaveBeenCalledTimes(1); // (no request storm: not one retry in ten minutes)
    expect(outbox.status()).toBe("signedOut");
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "bad", note: "Nupp ei tööta" });
    expect(outbox.unsent().get("a")).toEqual({ status: "bad", note: "Nupp ei tööta" });
    expect(onAnswers).not.toHaveBeenCalled();
  });

  test("a new press tries once more (one request per press), and stays signedOut while the answer is 401", async () => {
    const storage = memoryStorage();
    const put = vi.fn(async () => unauthorized());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    outbox.answer("b", "bad", "");
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "ok", note: "" }, b: { status: "bad", note: "" } } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(outbox.status()).toBe("signedOut");
    expect(Object.keys(JSON.parse(storage.dump()!))).toEqual(["a", "b"]);
  });

  test("signed in again in another tab: the tab shown again sends the kept presses once, and they leave the storage", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockResolvedValueOnce(unauthorized()).mockImplementation(async () => okResponse());
    const { outbox, onAnswers } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    expect(outbox.status()).toBe("signedOut");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(outbox.status()).toBe("saved");
    expect(storage.dump()).toBeNull();
    expect(onAnswers).toHaveBeenCalledWith(ANSWERS);
  });

  test("the next visit after signing in again sends what the signed-out one kept, at once", async () => {
    const storage = memoryStorage();
    const signedOut = outboxOver(storage, vi.fn(async () => unauthorized()));
    signedOut.outbox.answer("a", "bad", "Jäi saatmata");
    await settle();
    signedOut.outbox.stop(); // (she goes to the sign-in page)

    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "bad", note: "Jäi saatmata" } } });
    await settle();
    expect(outbox.status()).toBe("saved");
    expect(storage.dump()).toBeNull();
  });

  // Task 4 review I-1: the magic link signs her in in a NEW tab. That tab sends what the signed-out one kept, and she goes on answering there; the
  // signed-out tab, shown again later, must not send its old press over what she saved since.
  describe("two tabs: the one she signed in with delivers the kept press", () => {
    type Saved = Record<string, { status: string; note: string }>;
    /** A server for both tabs: the signed-out tab's first save is refused, then every save goes in, each the newest answer. */
    const serverOf = () => {
      const server: Saved = {};
      const put = (refuseFirst: boolean) => {
        let refused = !refuseFirst;
        return vi.fn(async (body: { answers: Saved }) => {
          if (!refused) {
            refused = true;
            return unauthorized();
          }
          Object.assign(server, body.answers);
          return okResponse();
        });
      };
      return { server, put };
    };
    const shown = () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    test("the signed-out tab shown again sends nothing for that check, and the note saved in the other tab stays", async () => {
      const storage = memoryStorage();
      const { server, put } = serverOf();
      const putA = put(true);
      const a = outboxOver(storage, putA as never);
      a.outbox.answer("x", "ok", "");
      await settle();
      expect(a.outbox.status()).toBe("signedOut");

      // she signs in: the link opens tab B, which sends the kept press at once
      const putB = put(false);
      const b = outboxOver(storage, putB as never);
      await settle();
      expect(server.x).toEqual({ status: "ok", note: "" });
      expect(storage.dump()).toBeNull();
      // ...and writes a note there
      b.outbox.note("x", "Märkus tabis B", "ok");
      await b.outbox.flush();
      expect(server.x).toEqual({ status: "ok", note: "Märkus tabis B" });

      // back to tab A
      shown();
      await settle();
      expect(putA).toHaveBeenCalledTimes(1); // (only the 401: nothing sent over tab B's note)
      expect(server.x).toEqual({ status: "ok", note: "Märkus tabis B" });
      expect(a.outbox.unsent().size).toBe(0);
      expect(a.outbox.status()).not.toBe("signedOut");
      // and a press of another check in tab A goes as usual
      a.outbox.answer("y", "bad", "");
      await settle();
      expect(server.y).toEqual({ status: "bad", note: "" });
      expect(Object.keys(bodyOf(putA, 1).answers)).toEqual(["y"]);
    });

    test("a newer press tab B has not sent yet is taken by tab A instead (the newest press of a check wins)", async () => {
      const storage = memoryStorage();
      const { server, put } = serverOf();
      const putA = put(true);
      const a = outboxOver(storage, putA as never);
      a.outbox.answer("x", "ok", "");
      await settle();
      const b = outboxOver(storage, vi.fn(() => new Promise<Response>(() => {})) as never); // (tab B's saves never come back)
      vi.setSystemTime(new Date("2026-10-16T10:05:00.000Z"));
      b.outbox.answer("x", "bad", "Tabis B");
      shown();
      await settle();
      expect(bodyOf(putA, 1)).toEqual({ answers: { x: { status: "bad", note: "Tabis B" } } });
      expect(server.x).toEqual({ status: "bad", note: "Tabis B" });
    });

    test("a press the signed-out tab could not write (storage full) is never taken as delivered: shown again, it is sent", async () => {
      const flags = { failSet: true };
      const storage = memoryStorage(flags);
      const { server, put } = serverOf();
      const putA = put(true);
      const a = outboxOver(storage, putA as never);
      a.outbox.answer("x", "ok", "Ainult mälus");
      await settle();
      expect(storage.dump()).toBeNull(); // (not written)
      flags.failSet = false;
      shown();
      await settle();
      expect(server.x).toEqual({ status: "ok", note: "Ainult mälus" });
    });

    test("a press another tab delivers while this tab retries leaves no failure here: the next press says saving, its failure waits the first step (re-review Minor 1)", async () => {
      const storage = memoryStorage();
      const server: Saved = {};
      // tab A has no connection: every save of its fails
      const putA = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      const a = outboxOver(storage, putA as never);
      a.outbox.answer("x", "ok", "");
      await settle();
      await vi.advanceTimersByTimeAsync(2000); // (the first retry fails too: the next would wait 5 s, then 10 s)
      expect(putA).toHaveBeenCalledTimes(2);
      expect(a.outbox.status()).toBe("retrying");
      // tab B, online, delivers the kept press
      outboxOver(
        storage,
        vi.fn(async (body: { answers: Saved }) => {
          Object.assign(server, body.answers);
          return okResponse();
        }) as never,
      );
      await settle();
      expect(server.x).toEqual({ status: "ok", note: "" });
      // tab A shown again: the press is known delivered, so nothing is sent and no failure of its stands
      shown();
      await settle();
      expect(putA).toHaveBeenCalledTimes(2);
      expect(a.outbox.unsent().size).toBe(0);
      expect(a.outbox.status()).not.toBe("retrying");
      // its next press says „Salvestan…“ while on its way (not the retry line)...
      a.outbox.answer("y", "bad", "");
      expect(putA).toHaveBeenCalledTimes(3);
      expect(a.outbox.status()).toBe("saving");
      // ...and, failing, is tried again after the first step of the backoff (2 s), not the third (10 s)
      await settle();
      expect(a.outbox.status()).toBe("retrying");
      await vi.advanceTimersByTimeAsync(2000);
      expect(putA).toHaveBeenCalledTimes(4);
    });

    test("a storage that cannot be read tells nothing: the kept press is sent", async () => {
      const storage = memoryStorage();
      const { server, put } = serverOf();
      const putA = put(true);
      const a = outboxOver(storage, putA as never);
      a.outbox.answer("x", "ok", "");
      await settle();
      storage.getItem = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      shown();
      await settle();
      expect(server.x).toEqual({ status: "ok", note: "" });
    });
  });

  test("a failure after a 401 is a failure again (retrying, on its timer), not signedOut", async () => {
    const put = vi.fn().mockResolvedValueOnce(unauthorized()).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "ok", "");
    await settle();
    expect(outbox.status()).toBe("signedOut");
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(outbox.status()).toBe("retrying");
    await vi.advanceTimersByTimeAsync(2000);
    expect(outbox.status()).toBe("saved");
    expect(put).toHaveBeenCalledTimes(3);
  });
});

describe("a page left while a save is on its way (stop() mid-flight)", () => {
  test("the save comes back ok: the press leaves the storage all the same (nothing is told: the page is gone), and the next visit sends nothing old", async () => {
    const storage = memoryStorage();
    let finish: (r: Response) => void = () => {};
    const put = vi.fn(() => new Promise<Response>((r) => (finish = r)));
    const { outbox, onAnswers } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    expect(storage.dump()).not.toBeNull();
    const heard = vi.fn();
    outbox.onChange(heard);
    outbox.stop(); // ("Avaleht" or Back, a moment after the last press)
    finish(okResponse());
    await settle();
    expect(storage.dump()).toBeNull();
    expect(onAnswers).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();

    const next = vi.fn(async () => okResponse());
    outboxOver(storage, next);
    await settle();
    expect(next).not.toHaveBeenCalled(); // (else the old press would be stamped the newest answer, over what came after it)
  });

  test("the save fails: the press stays in the storage for the next visit, and the stopped outbox tries nothing again", async () => {
    const storage = memoryStorage();
    let fail: (e: Error) => void = () => {};
    const put = vi.fn(() => new Promise<Response>((_, reject) => (fail = reject)));
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "bad", "Nupp ei tööta");
    outbox.stop();
    fail(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "bad", note: "Nupp ei tööta" });

    const next = vi.fn(async () => okResponse());
    outboxOver(storage, next);
    expect(bodyOf(next, 0)).toEqual({ answers: { a: { status: "bad", note: "Nupp ei tööta" } } });
  });
});

describe("a device that was closed", () => {
  test("survives a reload: a new outbox over the same storage sends the leftover entry at once", async () => {
    const storage = memoryStorage();
    const failing = outboxOver(storage, vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    failing.outbox.answer("a", "bad", "Nupp ei tööta");
    await settle();
    failing.outbox.stop();

    const put = vi.fn(async () => okResponse());
    const { outbox, onAnswers } = outboxOver(storage, put);
    expect(put).toHaveBeenCalledTimes(1); // (before anything is pressed)
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "bad", note: "Nupp ei tööta" } } });
    expect(outbox.unsent().get("a")).toMatchObject({ status: "bad" });
    await settle();
    expect(storage.dump()).toBeNull();
    expect(onAnswers).toHaveBeenCalledTimes(1);
    expect(outbox.status()).toBe("saved");
  });

  test("nothing in the storage, nothing sent; rubbish in it is read as empty, and only the entries that are answers are sent", async () => {
    const storage = memoryStorage();
    storage.setItem(OUTBOX_KEY, "{not json");
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    expect(put).not.toHaveBeenCalled();
    expect(outbox.status()).toBe("idle");
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "maybe", note: "", clientAt: "x" }, b: 5, c: { status: "ok", note: "ok", clientAt: "2026-10-16T09:00:00.000Z" } }));
    const again = outboxOver(storage, put);
    expect(bodyOf(put, 0)).toEqual({ answers: { c: { status: "ok", note: "ok" } } }); // (only the one that is an answer)
    again.outbox.stop();
  });

  test("another tab's entries are picked up before a send; the newer press of a check wins", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    // another tab of this browser saved a newer press of "a" and one of "b", which this tab never heard of
    storage.setItem(
      OUTBOX_KEY,
      JSON.stringify({
        a: { status: "bad", note: "Teises vahelehes", clientAt: "2026-10-16T10:00:30.000Z" },
        b: { status: "skip", note: "", clientAt: "2026-10-16T10:00:10.000Z" },
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "bad", note: "Teises vahelehes" }, b: { status: "skip", note: "" } } });
    await settle();
    expect(storage.dump()).toBeNull();
  });

  test("an older press in the storage does not win over this tab's newer one", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "bad", note: "vana", clientAt: "2026-10-16T09:00:00.000Z" } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "ok", note: "" } } });
  });

  test("an entry without an instant (another version's, a hand edit) is taken as the oldest press there is: sent, then cleared", async () => {
    const storage = memoryStorage();
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "bad", note: "Ilma ajata" }, b: { status: "skip", note: "", clientAt: "not an instant" } }));
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "bad", note: "Ilma ajata" }, b: { status: "skip", note: "" } } });
    await settle();
    expect(storage.dump()).toBeNull();
    expect(outbox.status()).toBe("saved");
  });

  test("...and it never wins over a press of this tab", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    outbox.answer("b", "ok", "");
    await settle();
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "bad", note: "vana" }, b: { status: "bad", note: "vana", clientAt: "zzz" } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "ok", note: "" }, b: { status: "ok", note: "" } } });
  });
});

describe("the clean-up after a confirmed save", () => {
  test("an older press of that check left in the storage (the newer one could not be written: storage full) goes too: the next visit does not send it again", async () => {
    const flags = { failSet: false };
    const storage = memoryStorage(flags);
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "bad", "Nupp ei tööta");
    await settle(); // (that save failed: the Viga waits in the storage)
    flags.failSet = true;
    outbox.answer("a", "ok", "Parandatud"); // (not written: the storage still holds the Viga)
    await settle();
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "ok", note: "Parandatud" } } });
    expect(storage.dump()).toBeNull();

    flags.failSet = false;
    const next = vi.fn(async () => okResponse());
    outboxOver(storage, next);
    await settle();
    expect(next).not.toHaveBeenCalled(); // (else: a fixed check a Viga again, and a false "Testimine — Viga" to Dim)
  });

  test("a newer press of that check in the storage (another tab's, made while the save was on its way) is kept", async () => {
    const storage = memoryStorage();
    let finish: (r: Response) => void = () => {};
    const put = vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => (finish = r))).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", ""); // (at 10:00:00)
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "bad", note: "Teises vahelehes", clientAt: "2026-10-16T10:00:30.000Z" } }));
    finish(okResponse());
    await settle();
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "bad", note: "Teises vahelehes" });
  });
});

describe("a storage that cannot be written", () => {
  // (the answers are then in this page's memory only: the status never says "offline", whose text promises they are kept on the device)
  test("a write that throws still sends, with the ordinary status: saving, then saved", async () => {
    let finish: (r: Response) => void = () => {};
    const put = vi.fn(() => new Promise<Response>((r) => (finish = r)));
    const { outbox } = outboxOver(memoryStorage({ failSet: true }), put);
    outbox.answer("a", "ok", "");
    expect(put).toHaveBeenCalledTimes(1);
    expect(outbox.status()).toBe("saving");
    finish(okResponse());
    await settle();
    expect(outbox.status()).toBe("saved");
  });

  test("no storage at all (null) is the same: a failed send is retrying, and the retries go on", async () => {
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(null, put);
    outbox.answer("a", "ok", "");
    expect(outbox.status()).toBe("saving");
    await settle();
    expect(outbox.status()).toBe("retrying");
    await vi.advanceTimersByTimeAsync(2000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(outbox.status()).toBe("saved");
  });

  test("a storage that cannot be read (getItem throws) is the same: the press is sent", async () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    expect(put).toHaveBeenCalledTimes(1);
    await settle();
    expect(outbox.status()).toBe("saved");
  });
});

describe("presses on one check", () => {
  test("two presses before the send leave only the latest in the body (the first send failed, the second press went at once, the retry carries the latest only)", async () => {
    const storage = memoryStorage();
    const put = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    await settle();
    outbox.answer("a", "bad", "");
    await settle();
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "bad", note: "" } } });
    expect(Object.keys(JSON.parse(storage.dump()!))).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bodyOf(put, 2)).toEqual({ answers: { a: { status: "bad", note: "" } } });
    expect(storage.dump()).toBeNull();
  });

  test("a press made while the save of an earlier press is on its way is not cleared by that save's answer, and is sent right after it", async () => {
    const storage = memoryStorage();
    let finish: (r: Response) => void = () => {};
    const put = vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => (finish = r))).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    outbox.answer("a", "bad", "");
    expect(put).toHaveBeenCalledTimes(1); // (one save at a time)
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "ok", note: "" } } });
    finish(okResponse());
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "bad", note: "" } } });
    expect(storage.dump()).toBeNull();
    expect(outbox.status()).toBe("saved");
  });

  test("the same without a storage to fall back on: the newer press is still sent after the save of the older one", async () => {
    let finish: (r: Response) => void = () => {};
    const put = vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => (finish = r))).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(null, put);
    outbox.answer("a", "ok", "");
    outbox.answer("a", "bad", "Viga");
    finish(okResponse());
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "bad", note: "Viga" } } });
    expect(outbox.status()).toBe("saved");
  });

  test("presses at the same millisecond keep their order (the later one wins)", async () => {
    const put = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const storage = memoryStorage();
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "ok", "");
    outbox.answer("a", "skip", "");
    outbox.answer("a", "bad", "");
    await settle();
    expect(outbox.unsent().get("a")).toMatchObject({ status: "bad" });
    expect(JSON.parse(storage.dump()!).a.status).toBe("bad");
  });

  test("an id like constructor or __proto__ is an ordinary check", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("constructor", "ok", "");
    outbox.answer("__proto__", "bad", "x");
    await settle();
    expect(Object.keys(bodyOf(put, 0).answers)).toEqual(["constructor"]);
    expect(Object.keys(bodyOf(put, 1).answers)).toEqual(["__proto__"]);
  });

  test("flush() with nothing waiting does nothing", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    await outbox.flush();
    expect(put).not.toHaveBeenCalled();
    expect(outbox.status()).toBe("idle");
  });
});

// Dim 29.10: a press can be taken back. `clear(id)` is queued like a press: the latest press of a check wins, in the queue, in the storage and in
// the body ({ status: "clear", note: "" }); the server removes the check's answer from the tester's own side (src/server/testplan.ts parseBody).
describe("a clear: an answer taken back (Dim 29.10)", () => {
  test("is sent at once like a press: saving, then saved; its entry leaves the storage and the server's answers go to onAnswers", async () => {
    const storage = memoryStorage();
    const put = vi.fn(async () => okResponse());
    const { outbox, onAnswers } = outboxOver(storage, put);
    outbox.clear("a");
    expect(put).toHaveBeenCalledTimes(1);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "clear", note: "" } } });
    expect(outbox.status()).toBe("saving");
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "clear", note: "" });
    expect(outbox.unsent().get("a")).toEqual({ status: "clear", note: "" }); // (the page shows the check taken back until the server has said so)

    await settle();
    expect(outbox.status()).toBe("saved");
    expect(storage.dump()).toBeNull();
    expect(onAnswers).toHaveBeenCalledWith(ANSWERS);
    expect(outbox.unsent().size).toBe(0);
  });

  test("after an unsent press it replaces it: the retry carries the clear only, and the storage holds the one entry", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "bad", "Nupp ei tööta");
    await settle(); // (that save failed: the Viga waits)
    outbox.clear("a");
    await settle();
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "clear", note: "" } } });
    expect(Object.keys(JSON.parse(storage.dump()!))).toEqual(["a"]);
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "clear" });
    expect(outbox.unsent().get("a")).toEqual({ status: "clear", note: "" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(bodyOf(put, 2)).toEqual({ answers: { a: { status: "clear", note: "" } } });
    expect(storage.dump()).toBeNull();
  });

  test("a press after an unsent clear replaces it", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.clear("a");
    await settle();
    outbox.answer("a", "ok", "Tahvlis korras");
    await settle();
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "ok", note: "Tahvlis korras" } } });
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "ok", note: "Tahvlis korras" });
    expect(outbox.unsent().get("a")).toEqual({ status: "ok", note: "Tahvlis korras" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(bodyOf(put, 2)).toEqual({ answers: { a: { status: "ok", note: "Tahvlis korras" } } });
    expect(storage.dump()).toBeNull();
  });

  test("made while the save of a press is on its way: that save is not cleared by its answer, and the clear is sent right after it", async () => {
    const storage = memoryStorage();
    let finish: (r: Response) => void = () => {};
    const put = vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => (finish = r))).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.answer("a", "bad", "");
    outbox.clear("a");
    expect(put).toHaveBeenCalledTimes(1); // (one save at a time)
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "bad", note: "" } } });
    finish(okResponse());
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "clear", note: "" } } });
    expect(storage.dump()).toBeNull();
    expect(outbox.status()).toBe("saved");
  });

  test("takes back a note waiting for its second: the note's timer is cancelled, and no save of the note follows", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "");
    await settle();
    outbox.note("a", "Nupp ei tööta");
    await vi.advanceTimersByTimeAsync(400);
    outbox.clear("a");
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "clear", note: "" } } });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
  });

  test("survives a reload: a new outbox over the same storage sends the leftover clear at once", async () => {
    const storage = memoryStorage();
    const failing = outboxOver(storage, vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    failing.outbox.clear("a");
    await settle();
    failing.outbox.stop();

    const put = vi.fn(async () => okResponse());
    const { outbox, onAnswers } = outboxOver(storage, put);
    expect(put).toHaveBeenCalledTimes(1); // (before anything is pressed)
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "clear", note: "" } } });
    expect(outbox.unsent().get("a")).toEqual({ status: "clear", note: "" });
    await settle();
    expect(storage.dump()).toBeNull();
    expect(onAnswers).toHaveBeenCalledTimes(1);
    expect(outbox.status()).toBe("saved");
  });

  test("a stored status that is neither a press nor a clear is still dropped", async () => {
    const storage = memoryStorage();
    storage.setItem(
      OUTBOX_KEY,
      JSON.stringify({ a: { status: "maybe", note: "", clientAt: "2026-10-16T09:00:00.000Z" }, b: { status: "clear", note: "", clientAt: "2026-10-16T09:00:00.000Z" } }),
    );
    const put = vi.fn(async () => okResponse());
    outboxOver(storage, put);
    expect(bodyOf(put, 0)).toEqual({ answers: { b: { status: "clear", note: "" } } });
  });

  test("a stored clear and a newer press of another tab: the newer one wins, whichever it is", async () => {
    const storage = memoryStorage();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.clear("a");
    await settle();
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "skip", note: "Teises vahelehes", clientAt: "2026-10-16T10:00:30.000Z" } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bodyOf(put, 1)).toEqual({ answers: { a: { status: "skip", note: "Teises vahelehes" } } });
  });

  test("a note after a clear is a note on a check never answered: it attaches to the status the page passes (the clear waiting is not a status), else it is dropped", async () => {
    const put = vi.fn(() => new Promise<Response>(() => {}));
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "");
    outbox.clear("a");
    outbox.note("a", "x"); // (neither the press before the clear nor the clear itself is a status to attach to)
    expect(outbox.unsent().get("a")).toEqual({ status: "clear", note: "" });
    outbox.note("a", "Hea", "skip"); // (with no press waiting, the page's status is the one)
    expect(outbox.unsent().get("a")).toEqual({ status: "skip", note: "Hea" });
  });

  test("once the clear is confirmed, a note with no status of its own is dropped, as for a check never answered", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "");
    await settle();
    outbox.clear("a");
    await settle();
    expect(put).toHaveBeenCalledTimes(2);
    outbox.note("a", "Nupp ei tööta");
    expect(outbox.unsent().size).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(put).toHaveBeenCalledTimes(2);
  });

  test("onChange is told, and a stopped outbox takes no clear", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    const heard = vi.fn();
    outbox.onChange(heard);
    outbox.clear("a");
    expect(heard).toHaveBeenCalled();
    await settle();
    outbox.stop();
    outbox.clear("b");
    expect(put).toHaveBeenCalledTimes(1);
    expect(outbox.unsent().size).toBe(0);
  });
});

// Dim 30.10: a note box under every check. A note typed on a check with no answer of hers (or on her note) goes as a press of its own,
// `{ status: "note", note }`, with the debounce and the flush of any note; the server keeps it apart from a verdict, and an emptied one ("") is a clear.
describe("a note on its own (Dim 30.10)", () => {
  test("is a note with the status \"note\": sent 1 s after the last call, kept in the storage meanwhile, at once on flush()", async () => {
    const storage = memoryStorage();
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    outbox.note("a", "Nu", "note");
    outbox.note("a", "Nupp on hall", "note");
    expect(outbox.unsent().get("a")).toEqual({ status: "note", note: "Nupp on hall" });
    expect(JSON.parse(storage.dump()!).a).toMatchObject({ status: "note", note: "Nupp on hall" });
    await vi.advanceTimersByTimeAsync(999);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "note", note: "Nupp on hall" } } });
    await settle();
    expect(storage.dump()).toBeNull();
    // flush (the box lost the focus) sends at once
    outbox.note("b", "Teine", "note");
    await outbox.flush();
    expect(bodyOf(put, 1)).toEqual({ answers: { b: { status: "note", note: "Teine" } } });
  });

  test("the box emptied is a note of \"\" (the server takes it as the clear), with the same debounce", async () => {
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.note("a", "", "note");
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "note", note: "" } } });
  });

  test("a press waiting here wins over the page's \"note\" (a page not redrawn since); a press after the note replaces it", async () => {
    const put = vi.fn(() => new Promise<Response>(() => {}));
    const { outbox } = outboxOver(memoryStorage(), put);
    outbox.answer("a", "bad", "");
    outbox.note("a", "Nupp ei tööta", "note");
    expect(outbox.unsent().get("a")).toEqual({ status: "bad", note: "Nupp ei tööta" });
    outbox.note("b", "Märkus", "note");
    outbox.answer("b", "ok", "Märkus");
    expect(outbox.unsent().get("b")).toEqual({ status: "ok", note: "Märkus" });
    // a clear waiting is no press: the note goes on its own, in its place
    outbox.clear("c");
    outbox.note("c", "Pärast tagasivõtmist", "note");
    expect(outbox.unsent().get("c")).toEqual({ status: "note", note: "Pärast tagasivõtmist" });
  });

  test("survives a reload: a stored note is read back and sent at once; a note with no status of its own then stays a note", async () => {
    const storage = memoryStorage();
    storage.setItem(OUTBOX_KEY, JSON.stringify({ a: { status: "note", note: "Jäi saatmata", clientAt: "2026-10-16T09:00:00.000Z" } }));
    const put = vi.fn(async () => okResponse());
    const { outbox } = outboxOver(storage, put);
    expect(bodyOf(put, 0)).toEqual({ answers: { a: { status: "note", note: "Jäi saatmata" } } });
    await settle();
    expect(storage.dump()).toBeNull();
    outbox.note("a", "Jäi saatmata, nüüd läks");
    expect(outbox.unsent().get("a")).toEqual({ status: "note", note: "Jäi saatmata, nüüd läks" });
  });
});
