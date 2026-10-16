import type { IncomingAnswer, Status } from "@/domain/testplan";
import type { PageAnswer } from "@/server/testplan"; // (a type only: erased by the build; this file runs on old iPads, no lookbehind here nor in what it imports, tests/unit/old-safari.test.ts)

// The test page's outbox (phase 4, piece 1, spec §4 "Saving"), without React: TestPlan.tsx renders what it holds and tells it what the tester
// presses and types. An answer the server has not confirmed is never lost:
// - a status press is sent at once, a note 1 s after the last keystroke (or at once, when the field loses the focus: flush);
// - until a save that carried an answer comes back ok, this browser keeps it (localStorage `mslab-testplan-outbox`, one entry per check, the newest
//   press of a check wins), and a reload or a new tab sends what it finds there at once. A browser that cannot keep it (storage full, blocked or
//   absent) still sends it; the status then says "offline" for as long as the answer is unsent;
// - a save that fails is tried again after 2, 5, 10, 20, then every 30 s, and at once when the browser is back online or the tab is shown again;
// - one save at a time: a press made while a save is on its way waits for it, and is sent right after it. An answer leaves the outbox only when
//   the save that carried THAT press came back ok, never one made after it was sent.
// The storage is shared by the tabs of a browser, so it is changed entry by entry (read, change, write back) and read again before each send: a tab
// never erases another's unsent answers. The server stamps `at` itself (spec §5); `clientAt` only orders the presses of one check on this device,
// so it stays in the outbox and is not sent.

/** The `localStorage` key of the unsent answers: `{ <checkId>: { status, note, clientAt } }`. */
export const OUTBOX_KEY = "mslab-testplan-outbox";
/** A save that fails is tried again after these (ms); after the last, every `RETRY_MS[4]`. */
export const RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000] as const;
/** A note is sent this long (ms) after the last keystroke. */
export const NOTE_WAIT_MS = 1000;

export type OutboxStatus = "idle" | "saving" | "saved" | "retrying" | "offline";
/** An unsent answer: what the tester pressed or typed, and the (strictly increasing) instant of that press on this device. */
type Entry = { status: Status; note: string; clientAt: string };

export type Outbox = {
  /** A status press: queued and sent at once. `note` is the check's note as it stands. */
  answer(id: string, status: Status, note: string): void;
  /** A note typed: queued, sent 1 s after the last call. `status` is the check's status as it stands (else the press before it, else the note has nothing to attach to and is dropped). */
  note(id: string, note: string, status?: Status): void;
  /** Sends what is queued now (a note waiting for its second included); resolves when that save is over, whatever came of it. */
  flush(): Promise<void>;
  status(): OutboxStatus;
  /** The answers not confirmed yet (the page shows them over the server's). A new map on every call. */
  unsent(): ReadonlyMap<string, { status: Status; note: string }>;
  /** `fn` is called after every change of `status()` or `unsent()`; returns the unsubscribe. */
  onChange(fn: () => void): () => void;
  stop(): void;
};

export type OutboxDeps = {
  /** localStorage, or null where there is none (the outbox then lives in memory only). */
  storage: Storage | null;
  put: (body: { answers: Record<string, IncomingAnswer> }) => Promise<Response>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** The server's answers, all of them, from a save that came back ok. */
  onAnswers: (answers: Record<string, PageAnswer>) => void;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is Status => v === "ok" || v === "bad" || v === "skip";

/** The entries a stored value holds (anything else: rubbish, another version's: none). An entry without a usable instant counts as the oldest. */
function parseStored(text: string | null): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (text === null) return out;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObject(value)) return out;
  for (const [id, raw] of Object.entries(value)) {
    if (!isObject(raw) || !isStatus(raw.status) || typeof raw.note !== "string") continue;
    out.set(id, { status: raw.status, note: raw.note, clientAt: typeof raw.clientAt === "string" ? raw.clientAt : "" });
  }
  return out;
}

/** The server's good answer: `{ ok: true, answers: {…} }` (200). Anything else is a failure to try again. */
async function answersOf(res: Response): Promise<Record<string, PageAnswer> | null> {
  if (!res.ok) return null;
  try {
    const body: unknown = await res.json();
    return isObject(body) && body.ok === true && isObject(body.answers) ? (body.answers as Record<string, PageAnswer>) : null;
  } catch {
    return null;
  }
}

/**
 * The outbox over `deps`. It reads the storage when it is made and sends at once what it finds there. It listens to the window's `online` and the
 * document's `visibilitychange` (a tab shown again) where there are any; `stop()` lets go of them and of its timers.
 */
export function createOutbox(deps: OutboxDeps): Outbox {
  const { storage } = deps;
  const queue = new Map<string, Entry>();
  /** The last status pressed per check: what a note without a status of its own attaches to. */
  const known = new Map<string, Status>();
  /** The instant of the newest press of each check that a save has confirmed: the storage may still hold it (a write that failed), and it is not taken again. */
  const confirmed = new Map<string, string>();
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  /** A send was asked for while one was on its way: it follows at once. */
  let again = false;
  let failing = false;
  let attempts = 0;
  /** Some save has come back ok (the status then reads "saved" once nothing is left). */
  let saved = false;
  /** The last write to the storage went through (false: no storage, or it threw). */
  let kept = storage !== null;
  let stopped = false;
  let noteTimer: unknown = null;
  let retryTimer: unknown = null;
  let lastStamp = 0;

  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const stamp = (): string => {
    lastStamp = Math.max(deps.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  /** What the storage holds now (empty when it cannot be read). */
  function readStore(): Map<string, Entry> {
    if (storage === null) return new Map();
    try {
      return parseStored(storage.getItem(OUTBOX_KEY));
    } catch {
      return new Map();
    }
  }
  /**
   * Changes the stored entries one by one (read, change, write back), so another tab's are kept. `keeps`: this write is of a press, so whether it
   * went through is whether the press is kept on this device (taking an answer out says nothing of that).
   */
  function writeStore(change: (stored: Map<string, Entry>) => void, keeps: boolean): void {
    if (storage === null) {
      if (keeps) kept = false;
      return;
    }
    try {
      const stored = readStore();
      change(stored);
      if (stored.size === 0) storage.removeItem(OUTBOX_KEY);
      else storage.setItem(OUTBOX_KEY, JSON.stringify(Object.fromEntries(stored)));
      if (keeps) kept = true;
    } catch {
      if (keeps) kept = false;
    }
  }
  /** Takes the stored entries that are newer than the queue's (another tab's presses, or the ones left by an earlier visit). */
  function adopt(): void {
    for (const [id, entry] of readStore()) {
      const mine = queue.get(id);
      if (entry.clientAt <= (confirmed.get(id) ?? "")) continue;
      if (!mine || entry.clientAt > mine.clientAt) {
        queue.set(id, entry);
        known.set(id, entry.status);
      }
    }
  }

  const clearNote = () => {
    if (noteTimer !== null) deps.clearTimer(noteTimer);
    noteTimer = null;
  };
  const clearRetry = () => {
    if (retryTimer !== null) deps.clearTimer(retryTimer);
    retryTimer = null;
  };

  /** One save of everything queued, and what comes of it; the next one follows at once while presses keep arriving, until one fails. */
  async function run(): Promise<void> {
    do {
      again = false;
      adopt();
      if (queue.size === 0) return;
      const sent = new Map(queue);
      emit();
      let answers: Record<string, PageAnswer> | null = null;
      try {
        const body = { answers: Object.fromEntries([...sent].map(([id, e]) => [id, { status: e.status, note: e.note }])) };
        answers = await answersOf(await deps.put(body));
      } catch {
        answers = null;
      }
      if (stopped) return;
      if (answers === null) {
        failing = true;
        clearRetry();
        retryTimer = deps.setTimer(() => void send(), RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)]);
        attempts++;
        emit();
        return;
      }
      failing = false;
      attempts = 0;
      saved = true;
      // an entry is done only if it is still the press that was sent
      for (const [id, entry] of sent) {
        if (entry.clientAt > (confirmed.get(id) ?? "")) confirmed.set(id, entry.clientAt);
        if (queue.get(id)?.clientAt === entry.clientAt) queue.delete(id);
      }
      writeStore((stored) => {
        for (const [id, entry] of sent) if (stored.get(id)?.clientAt === entry.clientAt) stored.delete(id);
      }, false);
      deps.onAnswers(answers);
      emit();
    } while (again);
  }

  /** Sends now (one save at a time; asked for during one, it follows it). Resolves when the saves are over. */
  function send(): Promise<void> {
    if (stopped) return Promise.resolve();
    clearRetry();
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const queueEntry = (id: string, status: Status, note: string) => {
    const entry: Entry = { status, note, clientAt: stamp() };
    queue.set(id, entry);
    known.set(id, status);
    writeStore((stored) => void stored.set(id, entry), true);
  };

  const onBack = () => {
    if (queue.size > 0) void send();
  };
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") onBack();
  };
  if (typeof window !== "undefined") window.addEventListener("online", onBack);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  // what an earlier visit left goes at once
  adopt();
  if (queue.size > 0) void send();

  return {
    answer(id, status, note) {
      if (stopped) return;
      clearNote();
      queueEntry(id, status, note);
      emit();
      void send();
    },
    note(id, note, status) {
      if (stopped) return;
      const of = status ?? queue.get(id)?.status ?? known.get(id);
      if (of === undefined) return;
      queueEntry(id, of, note);
      clearNote();
      noteTimer = deps.setTimer(() => {
        noteTimer = null;
        void send();
      }, NOTE_WAIT_MS);
      emit();
    },
    flush() {
      clearNote();
      return send();
    },
    status() {
      if (queue.size === 0) return saved ? "saved" : "idle";
      if (!kept) return "offline";
      return failing ? "retrying" : "saving";
    },
    unsent() {
      return new Map([...queue].map(([id, e]) => [id, { status: e.status, note: e.note }]));
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    stop() {
      stopped = true;
      clearNote();
      clearRetry();
      if (typeof window !== "undefined") window.removeEventListener("online", onBack);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
