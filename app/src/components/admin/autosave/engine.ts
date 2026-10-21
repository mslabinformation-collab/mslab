import type { AutosaveStatus } from "@/domain/autosave";
import { stableJson } from "@/lib/version";
import { DEBOUNCE_MS, KEEPALIVE_MAX_BYTES, RETRY_MS, SAVE_TIMEOUT_MS, SENT_MAX_CHARS } from "@/components/admin/protocol-autosave";

// The editors' autosave (admin UX pass, README §1.3; spec C1), without React: useAutosave.ts renders what it holds and tells it what is typed. It
// generalises protocol-autosave.ts (its behaviour and constants, not its protocol shapes; the protocol screen moves onto it in piece 2). One engine
// is one form part: a flat record of fields with the server's version of them. Nothing typed is lost:
// - a field saves 1.5 s after the last change (setField), and at once on flush() (blur, an instant field, leaving); one save at a time, the next
//   one waits for the one on its way; a save sends only the fields changed since the last confirmed one (the patch), with that version;
// - until the server confirms it, this browser keeps the form's text (localStorage `mslab-draft:{owner}:{key}:{tab}`, each tab its own key), with
//   the texts it sent without an answer; the next visit resumes it (resume, below);
// - a field its check (`validate`, or the server's 400) refuses is held back: the others still save, and the status is `invalid`;
// - a save that fails (no answer, 10 s without one, a server error) is tried again after 2, 5, 10, 20, then every 30 s, and at once when the
//   browser is back online, the tab is shown again or focused; signed out (401, 403) is tried the same way: she may sign in in another tab;
//   a refusal that would repeat (413, a 400 that is not a save or names no field of the patch, a 409 that is not a conflict's) waits instead:
//   no timer, once more on the next edit, focus or `online` (status `retry`, reason "error"); an edit that leaves nothing to send ends the wait;
// - the tab hidden sends a waiting save at once; the page put away (pagehide) sends it as a keepalive request while the page's bodies fit the
//   browsers' 64 KiB for them (KEEPALIVE_MAX_BYTES, shared by every engine of the page), else leaves it to the copy;
// - a refusal (409) brings the server's version and value: this form's own text (another tab typed the same) or one of its saves whose answer
//   was lost (protocol-autosave.ts:1134-1138) is not a conflict: it is confirmed, and newer text goes on from there; any other text is another
//   tab's or device's: the status is `conflict`, the form's text stays as it is (and in the copy), nothing is sent over the other text by itself,
//   and restore() („Taasta minu tekst“, B13) saves the form's text over the server's version: an explicit overwrite;
// - the row deleted meanwhile (404) is `gone`: the text stays in this browser, nothing is tried again.
// Old iPads run it: no regex lookbehind, no crypto.randomUUID (tests/unit/old-safari.test.ts). The server's side is server/autosave-route.ts.

export { DEBOUNCE_MS, KEEPALIVE_MAX_BYTES, RETRY_MS, SAVE_TIMEOUT_MS, SENT_MAX_CHARS };

/** A form part's fields: name → value (JSON). */
export type Fields = Record<string, unknown>;
/** One save: POST `{ version, patch }`; null when no answer came. `keepalive`: the request outlives the page (sent while it is put away). */
export type SendPatch = (body: { version: string; patch: Fields }, opts?: { keepalive?: boolean }) => Promise<{ status: number; body: unknown } | null>;
type Answer = Awaited<ReturnType<SendPatch>>;
/** What a 409 brought: the server's version and its stored value of the part. */
export type Conflict = { version: string; value: unknown };
export type Snapshot = { status: AutosaveStatus; fields: Fields; conflict: Conflict | null };
/** Why the form's text is not confirmed (the leave guard's notice, Task 10): the first field concerned (null: none in particular) and the reason. */
export type Unconfirmed = { field: string | null; reason: "offline" | "error" | "invalid" | "signedOut" };

/** The answers that say a save was not stored: the route's refusals and withAdmin's sign-in check. Any other answer may have stored it. */
const REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 413]);

/** The key of a tab's copy of a form part in this browser's storage. */
export const draftKey = (owner: string, key: string, tab: string): string => `mslab-draft:${owner}:${key}:${tab}`;

/** A name for this page's tab: its copy is its own (no crypto.randomUUID: iOS before 15.4 has none), as protocol-autosave.ts names its tabs. */
const newTabName = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const same = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** What the page may still send as keepalive requests (every engine's together), until it is shown again. */
let keepaliveLeft = KEEPALIVE_MAX_BYTES;

/**
 * A value added once to the texts sent without an answer (a retry of the same text adds nothing), at most SENT_MAX_CHARS of JSON together: the
 * oldest go first, never the newest (after hours offline a refusal then shows the conflict instead of saving on top: nothing is lost either way).
 */
function remember(list: readonly Fields[], value: Fields): Fields[] {
  const out = list.some((v) => same(v, value)) ? [...list] : [...list, value];
  let total = out.reduce((n, v) => n + stableJson(v).length, 0);
  while (out.length > 1 && total > SENT_MAX_CHARS) total -= stableJson(out.shift()).length;
  return out;
}

// ---------- this browser's storage (full or blocked: nothing kept, nothing thrown) ----------

function getRaw(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // full or blocked: the copy is not kept
  }
}

function removeKey(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // blocked: nothing was kept
  }
}

/** The keys of the copies of one form part: `prefix` and a tab name (no further `:`, which would be another key's copy). */
function copyKeys(storage: Storage, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes(":")) out.push(key);
    }
  } catch {
    // a storage that cannot list its keys: nothing to resume
  }
  return out;
}

type LocalCopy = { version: string; fields: Fields; sent: Fields[]; at: number };

function parseCopy(raw: string | null): LocalCopy | null {
  try {
    const c: unknown = JSON.parse(raw ?? "null");
    if (!isRecord(c) || typeof c.version !== "string" || !isRecord(c.fields)) return null;
    const sent = Array.isArray(c.sent) ? c.sent.filter(isRecord) : [];
    return { version: c.version, fields: c.fields, sent, at: typeof c.at === "number" ? c.at : 0 };
  } catch {
    return null;
  }
}

/** POST `url` with `{ version, patch }` as JSON and the admin's cookie (server/autosave-route.ts), given up after 10 s. Never throws. */
export function patchSender(url: string): SendPatch {
  return async (body, opts) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
        keepalive: opts?.keepalive === true,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

type Timer = ReturnType<typeof setTimeout>;

/** The autosave of one form part (see the top of the file). */
export class AutosaveEngine {
  private readonly owner: string;
  private readonly key: string;
  private readonly tab: string;
  private readonly send: SendPatch;
  private readonly validate: (f: Fields) => Record<string, string>;
  /** The server's version of the part as this form last heard it, and its fields then. */
  private version: string;
  private confirmed: Fields;
  /** What the form shows. */
  private fields: Fields;
  private status: AutosaveStatus = { kind: "saved", at: null };
  private savedAt: Date | null = null;
  private conflict: Conflict | null = null;
  private gone = false;
  private signedOut = false;
  /** Why the last save failed (null: it did not): no answer, or an answer that was not a save. */
  private lastFailure: "offline" | "error" | null = null;
  /** The last save was refused in a way that would repeat (wait): it goes again on the next edit, focus or `online`, not on a timer. */
  private waiting = false;
  /** The part's value as each save sent without an answer would have left it: any of them may be stored (a lost answer). */
  private unanswered: Fields[] = [];
  /** The same of the save on its way. */
  private flying: Fields | null = null;
  /** The fields the server's check refused (400): held back until they are typed in again. */
  private readonly serverInvalid = new Set<string>();
  private debounce: Timer | null = null;
  private retry: Timer | null = null;
  private attempts = 0;
  private chain: Promise<boolean> | null = null;
  private storage: Storage | null = null;
  private running = false;
  private resumed = false;
  /** Other tabs' copies read by resume: removed once this form's text is confirmed, each only if nobody wrote it since. */
  private taken: { key: string; raw: string }[] = [];
  private readonly listeners = new Set<() => void>();
  private snap: Snapshot | null = null;

  constructor(o: { owner: string; key: string; version: string; fields: Fields; send: SendPatch; validate?: (f: Fields) => Record<string, string>; tab?: string }) {
    this.owner = o.owner;
    this.key = o.key;
    this.tab = o.tab ?? newTabName();
    this.send = o.send;
    this.validate = o.validate ?? (() => ({}));
    this.version = o.version;
    this.confirmed = { ...o.fields };
    this.fields = { ...o.fields };
  }

  /**
   * Starts saving, after the screen is shown: the copy an earlier visit kept is resumed once (React's strict mode may stop and start it again),
   * and the browser's events are heard. Started again, what waits goes at once.
   */
  start(storage: Storage | null): void {
    this.storage = storage;
    this.running = true;
    window.addEventListener("online", this.onBack);
    window.addEventListener("focus", this.onBack);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    document.addEventListener("visibilitychange", this.onVisibility);
    if (!this.resumed) {
      this.resumed = true;
      this.resume();
    } else if (this.sendable()) this.schedule(0);
    this.refresh();
  }

  /** Stops: no listener, no timer. A save on its way still has its answer taken; the copy stays for the next visit. */
  stop(): void {
    this.running = false;
    window.removeEventListener("online", this.onBack);
    window.removeEventListener("focus", this.onBack);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearDebounce();
    this.clearRetry();
  }

  /** A field typed in: kept in this browser at once, saved 1.5 s after the last change. While in conflict or gone it is kept, not sent. */
  setField(name: string, value: unknown): void {
    if (name in this.fields && same(this.fields[name], value)) return;
    this.fields = { ...this.fields, [name]: value };
    this.serverInvalid.delete(name);
    if (this.uncertain()) this.keep();
    else this.dropCopy();
    if (this.sendable()) this.schedule(DEBOUNCE_MS);
    else {
      // nothing left to send (typed back, or only held fields): a refusal that waited for this edit (wait) no longer stands
      this.clearDebounce();
      if (this.waiting) this.answered();
    }
    this.refresh();
  }

  /** Saves now, after the save on its way; true when the form's text is confirmed (false: held back, failed, in conflict or gone). */
  flush(): Promise<boolean> {
    return this.queue(false);
  }

  /** „Taasta minu tekst“ after a conflict: the form's text is saved over the server's version (an explicit overwrite, B13). */
  restore(): Promise<boolean> {
    const c = this.conflict;
    if (!c) return this.flush();
    this.conflict = null;
    this.version = c.version;
    this.confirmed = this.over(c.value);
    this.unanswered = [];
    this.keep();
    this.refresh();
    return this.queue(false);
  }

  /** For useSyncExternalStore: told after every change. */
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** For useSyncExternalStore: the same object until the next change. */
  readonly snapshot = (): Snapshot => {
    if (!this.snap) this.snap = { status: this.status, fields: this.fields, conflict: this.conflict };
    return this.snap;
  };

  /** Null when the server holds the form's text; else the first field concerned and why (the leave guard asks before the text is left). */
  unconfirmed(): Unconfirmed | null {
    if (!this.uncertain()) return null;
    const reason = this.reason();
    const changed = Object.keys(this.fields).find((n) => !same(this.fields[n], this.confirmed[n])) ?? null;
    return { field: reason === "invalid" ? (this.held()[0] ?? changed) : changed, reason };
  }

  private reason(): Unconfirmed["reason"] {
    switch (this.status.kind) {
      case "invalid":
      case "signedOut":
        return this.status.kind;
      case "retry":
        return this.lastFailure ?? "error";
      case "conflict":
      case "gone":
        return "error";
      default:
        return typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error";
    }
  }

  // ---------- what is sent ----------

  /** The server may not hold the form's text: a field differs from the confirmed one, or a save's answer is unknown. */
  private uncertain(): boolean {
    return this.flying !== null || this.unanswered.length > 0 || Object.keys(this.fields).some((n) => !same(this.fields[n], this.confirmed[n]));
  }

  /** Would a save send this field: changed since the confirmed text, or sent by a save without an answer (the server may hold that one)? */
  private due(n: string): boolean {
    return !same(this.fields[n], this.confirmed[n]) || this.unanswered.some((u) => n in u && !same(u[n], this.confirmed[n]));
  }

  /** The fields a save would send that their check refuses (the form's own or the server's), in the form's order: held back. */
  private held(): string[] {
    const codes = this.validate(this.fields);
    return Object.keys(this.fields).filter((n) => (n in codes || this.serverInvalid.has(n)) && this.due(n));
  }

  /** The fields a save sends: the due ones, minus the held ones (by the same rule, so a refused field is never in it). */
  private patch(): Fields {
    const held = new Set(this.held());
    const out: Fields = {};
    for (const n of Object.keys(this.fields)) if (!held.has(n) && this.due(n)) out[n] = this.fields[n];
    return out;
  }

  private blocked(): boolean {
    return this.conflict !== null || this.gone;
  }

  private sendable(): boolean {
    return !this.blocked() && Object.keys(this.patch()).length > 0;
  }

  /** The server's stored value read over this form's fields (a part may hold more than the form edits). */
  private over(value: unknown): Fields {
    const v = isRecord(value) ? value : {};
    return Object.fromEntries(Object.keys(this.fields).map((n) => [n, v[n]]));
  }

  /** One save after the one on its way. `keepalive` (pagehide) only when none is on its way: it goes at once. */
  private queue(keepalive: boolean): Promise<boolean> {
    this.clearDebounce();
    const before = this.chain;
    const go = () => this.sendNow(false);
    const next = before ? before.then(go, go) : this.sendNow(keepalive);
    this.chain = next;
    void next.then(
      () => {
        if (this.chain === next) this.chain = null;
      },
      () => {
        if (this.chain === next) this.chain = null;
      },
    );
    return next;
  }

  private async sendNow(keepalive: boolean): Promise<boolean> {
    if (this.blocked()) return false;
    const patch = this.patch();
    if (Object.keys(patch).length === 0) {
      // nothing to send (all confirmed, or only held fields): nothing to try again
      this.clearRetry();
      this.answered();
      this.rest();
      return this.unconfirmed() === null;
    }
    this.clearRetry();
    this.waiting = false;
    const version = this.version;
    const sent: Fields = { ...this.confirmed, ...patch };
    this.flying = sent;
    this.keep();
    this.setStatus({ kind: "saving" });
    const answer = await this.answerOf(this.send({ version, patch }, keepalive ? { keepalive: true } : undefined));
    this.flying = null;
    return this.take(answer, patch, sent);
  }

  /** The sender's answer, or null when none came in SAVE_TIMEOUT_MS (or it threw): whatever the sender, the queue never waits for good. */
  private answerOf(p: Promise<Answer>): Promise<Answer> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), SAVE_TIMEOUT_MS);
      p.then(
        (a) => {
          clearTimeout(timer);
          resolve(a);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  private take(answer: Answer, patch: Fields, sent: Fields): Promise<boolean> | boolean {
    const reply = answer && isRecord(answer.body) ? answer.body : null;
    const status = answer?.status ?? 0;
    if (status === 200 && reply?.ok === true && typeof reply.version === "string") {
      this.confirm(reply.version, sent, typeof reply.savedAt === "string" ? new Date(reply.savedAt) : new Date());
      return this.goOn();
    }
    if (status === 409 && reply?.error === "conflict" && typeof reply.version === "string") return this.refused(reply.version, reply.value, sent);
    if (status === 400 && reply?.error === "invalid" && isRecord(reply.fields)) {
      const named = Object.keys(reply.fields).filter((n) => n in patch);
      if (named.length > 0) {
        // the route's own word on these fields: each still holding the refused value is held back (held; one corrected while the save was on
        // its way goes with the rest), no earlier failure stands, and the rest goes at once; never a patch that still holds a refused value (it
        // would be refused again, at once, without end)
        const refused = named.filter((n) => same(this.fields[n], patch[n]));
        for (const n of refused) this.serverInvalid.add(n);
        this.answered();
        if (Object.keys(this.patch()).some((n) => refused.includes(n))) return this.wait();
        return this.goOn();
      }
    }
    if (status === 401 || status === 403) {
      this.signedOut = true;
      return this.failed("error");
    }
    if (status === 404) {
      this.gone = true;
      this.rest();
      return false;
    }
    // the route's refusals left (413, a 400 that is not a save or names no field of the patch, a 409 that is not a conflict's): not stored, and
    // sent again as it is they would be refused again
    if (answer && REFUSALS.has(status)) return this.wait();
    // no answer, a server error, or an answer that is not the route's (a Wi-Fi login page): the text may be stored all the same (the next
    // refusal tells), so it is remembered, and tried again on the timer
    this.unanswered = remember(this.unanswered, sent);
    return this.failed(answer ? "error" : "offline");
  }

  /** The route answered (a save, a refusal of fields, a conflict): no earlier failure, sign-in or wait stands. */
  private answered(): void {
    this.attempts = 0;
    this.signedOut = false;
    this.lastFailure = null;
    this.waiting = false;
  }

  /**
   * A refusal that would repeat: no timer (a part over the size limit would upload again every 30 s), but once more on the next edit, focus or
   * `online` (onBack). The text and the copy stay; the status is `retry`, the reason "error".
   */
  private wait(): false {
    this.answered();
    this.lastFailure = "error";
    this.waiting = true;
    this.clearRetry();
    this.rest();
    return false;
  }

  /** The server holds `value` at `version`: the form's confirmed text. */
  private confirm(version: string, value: Fields, at: Date): void {
    this.version = version;
    this.confirmed = value;
    this.savedAt = at;
    this.unanswered = [];
    this.answered();
  }

  /** After a confirmed save: what is still changed goes at once, unless it is still being typed (its 1.5 s wait runs). */
  private goOn(): Promise<boolean> | boolean {
    if (this.debounce === null && this.sendable()) return this.sendNow(false);
    this.rest();
    return this.unconfirmed() === null;
  }

  /**
   * A 409. The server holds this form's text (another tab typed the same), or a save of this form whose answer was lost (it remembered what it
   * sent): confirmed at the server's version, and newer text goes on from there. Anything else is another tab's or device's text: conflict.
   */
  private refused(version: string, value: unknown, sent: Fields): Promise<boolean> | boolean {
    const stored = this.over(value);
    const mine = remember(this.unanswered, sent);
    this.unanswered = [];
    this.answered();
    if (same(stored, this.fields) || mine.some((m) => same(m, stored))) {
      this.confirm(version, stored, new Date());
      return this.goOn();
    }
    this.conflict = { version, value };
    this.clearDebounce();
    this.clearRetry();
    this.rest();
    return false;
  }

  private failed(why: "offline" | "error"): false {
    this.lastFailure = why;
    const wait = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)];
    this.attempts++;
    this.clearRetry();
    if (this.running)
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.queue(false);
      }, wait);
    this.rest();
    return false;
  }

  // ---------- the browser's events ----------

  /** Back online, the tab shown or focused: a failed, signed-out or waiting save goes at once, and its waits start again. */
  private readonly onBack = (): void => {
    if (this.retry === null && !this.signedOut && !this.waiting) return;
    this.attempts = 0;
    this.clearRetry();
    void this.queue(false);
  };

  /** Hidden (another app, the tablet locked): the waiting save goes now. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "visible") this.onBack();
    else if (this.debounce !== null) void this.queue(false);
  };

  /** The page put away: a waiting save goes as a keepalive request while the page's budget holds its body; a bigger one is left to the copy. */
  private readonly onPageHide = (): void => {
    if (this.chain !== null || this.blocked() || (this.debounce === null && this.retry === null)) return;
    const patch = this.patch();
    if (Object.keys(patch).length === 0) return;
    const bytes = utf8Bytes(JSON.stringify({ version: this.version, patch }));
    if (bytes > keepaliveLeft) return;
    keepaliveLeft -= bytes;
    void this.queue(true);
  };

  private readonly onPageShow = (): void => {
    keepaliveLeft = KEEPALIVE_MAX_BYTES;
  };

  // ---------- the copy ----------

  /**
   * The copy an earlier visit kept (any tab's of this browser, of this owner and key). The newest one, when its fields differ from the server's,
   * becomes the form's text, status `dirty`, and is saved at once against the version it was typed on, with the texts it sent without an answer:
   * the server decides. 200: saved. 409 with one of those texts (that visit's lost answer): saved on top. 409 with another device's text:
   * `conflict`, the copy's text kept. A copy the server holds already is dropped. The copies read go once this form's text is confirmed, each
   * only if nobody wrote it since (an open tab typing into its own keeps it). A simplified protocol-autosave.ts resume: an older copy's words
   * give way to the newest's, with no notice of them.
   */
  private resume(): void {
    const storage = this.storage;
    if (!storage) return;
    const own = this.copyKey();
    let newest: LocalCopy | null = null;
    for (const key of copyKeys(storage, draftKey(this.owner, this.key, ""))) {
      const raw = getRaw(storage, key);
      const copy = parseCopy(raw);
      if (raw === null || !copy) continue;
      if (key !== own) this.taken.push({ key, raw });
      if (!newest || copy.at >= newest.at) newest = copy;
    }
    if (!newest) return;
    const fields: Fields = { ...this.fields };
    for (const n of Object.keys(fields)) if (n in newest.fields) fields[n] = newest.fields[n];
    if (same(fields, this.fields)) return this.dropCopy();
    this.fields = fields;
    this.version = newest.version;
    this.unanswered = newest.sent.map((s) => this.over(s));
    this.keep();
    this.schedule(0);
  }

  private copyKey(): string {
    return draftKey(this.owner, this.key, this.tab);
  }

  /** Nothing on its way: the copy kept or dropped, and the status, as they are now. */
  private rest(): void {
    if (this.uncertain()) this.keep();
    else this.dropCopy();
    this.refresh();
  }

  /**
   * Keeps the form's text under this tab's key, with the texts sent without an answer. After stop only while that key still exists: a screen
   * opened again resumes the copy and releases it, and writing it back would bring back a copy nobody holds.
   */
  private keep(): void {
    const storage = this.storage;
    if (!storage) return;
    const key = this.copyKey();
    if (!this.running && getRaw(storage, key) === null) return;
    const sent = this.flying ? remember(this.unanswered, this.flying) : this.unanswered;
    writeKey(storage, key, { version: this.version, fields: this.fields, sent, at: Date.now() });
  }

  /** The server holds the form's text: this tab's copy goes, and so do the copies it resumed. */
  private dropCopy(): void {
    const storage = this.storage;
    if (!storage) return;
    removeKey(storage, this.copyKey());
    for (const t of this.taken) if (getRaw(storage, t.key) === t.raw) removeKey(storage, t.key);
    this.taken = [];
  }

  // ---------- timers and the status ----------

  private schedule(ms: number): void {
    this.clearDebounce();
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.queue(false);
    }, ms);
  }

  private clearDebounce(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private clearRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }

  /** The status when no save is starting: the first that holds of conflict, gone, signed out, typing, on its way, failed, held back, saved. */
  private current(): AutosaveStatus {
    if (this.conflict) return { kind: "conflict" };
    if (this.gone) return { kind: "gone" };
    if (this.signedOut) return { kind: "signedOut" };
    if (this.debounce !== null) return { kind: "dirty" };
    if (this.flying) return { kind: "saving" };
    if (this.retry !== null || this.lastFailure) return { kind: "retry" };
    const held = this.held();
    if (held.length > 0) return { kind: "invalid", fields: held };
    if (this.uncertain()) return { kind: "dirty" };
    return { kind: "saved", at: this.savedAt };
  }

  private refresh(): void {
    this.setStatus(this.current());
  }

  private setStatus(status: AutosaveStatus): void {
    this.status = status;
    this.snap = null;
    for (const fn of this.listeners) fn();
  }
}
