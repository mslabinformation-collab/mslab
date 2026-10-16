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

  test("an answer that is not ok JSON is a failure too (a 500 page, a 401, a 200 that is not our answer)", async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>500</html>", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 }))
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
  test("a write that throws still sends, with the ordinary status: saving, then saved; keeps() says the device does not keep the answer", async () => {
    let finish: (r: Response) => void = () => {};
    const put = vi.fn(() => new Promise<Response>((r) => (finish = r)));
    const { outbox } = outboxOver(memoryStorage({ failSet: true }), put);
    expect(outbox.keeps()).toBe(true); // (nothing written yet)
    outbox.answer("a", "ok", "");
    expect(put).toHaveBeenCalledTimes(1);
    expect(outbox.status()).toBe("saving");
    expect(outbox.keeps()).toBe(false);
    finish(okResponse());
    await settle();
    expect(outbox.status()).toBe("saved");
  });

  test("no storage at all (null) is the same: a failed send is retrying, and the retries go on", async () => {
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => okResponse());
    const { outbox } = outboxOver(null, put);
    expect(outbox.keeps()).toBe(false);
    outbox.answer("a", "ok", "");
    expect(outbox.status()).toBe("saving");
    await settle();
    expect(outbox.status()).toBe("retrying");
    await vi.advanceTimersByTimeAsync(2000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(outbox.status()).toBe("saved");
  });

  test("keeps() is whether the last press could be written: a storage that is full, then has room again", async () => {
    const flags = { failSet: true };
    const put = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { outbox } = outboxOver(memoryStorage(flags), put);
    outbox.answer("a", "ok", "");
    expect(outbox.keeps()).toBe(false);
    flags.failSet = false;
    outbox.answer("b", "ok", "");
    expect(outbox.keeps()).toBe(true);
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
