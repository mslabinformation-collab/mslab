import { hasText, overLimit, protocolStatus, type NotePlace, type ProtocolStatus } from "@/domain/protocols";
import { toStorable } from "@/lib/to-storable"; // (never lib/storable: this file runs on old iPads, tests/unit/old-safari.test.ts)

// The protocol screen's autosave (phase protocols, spec §4), without React: ProtocolScreen.tsx renders what it holds and tells it what Maria
// types. Nothing typed is lost:
// - a box saves 1.5 s after typing stops, on blur and on switching student (save); one save of a protocol at a time, the next one waits;
// - until the server confirms a text, this browser keeps it (localStorage `mslab-protocol:<registration>`), and a reload or a new tab resumes
//   it (start); a browser that cannot keep it (storage full or blocked) says so (Entry.kept);
// - a save that fails is tried again after 2, 5, 10, 20, then every 30 s, and at once when the browser is back online or the tab is shown
//   again; the status says "Salvestamata — proovin uuesti";
// - a save carries the version the server confirmed last. A refusal (409) brings what is stored: when that text is one this screen sent and
//   never heard back about (the answer was lost on the way), it was ours, and the newer text is saved on top of it with no notice; otherwise
//   another device or tab saved first, its text is shown, and this screen's unsaved words go into the notice: newer text is never overwritten.
//   The texts sent without an answer are kept once each, up to SENT_MAX_CHARS; the notice's words are kept (`mslab-protocol-conflict:<id>`)
//   until "Selge", across a reload, and a second refusal before "Selge" adds its words to them (mergeConflicts);
// - while a save's answer is unknown (on its way, or lost) the protocol is not "saved", even when the screen shows the text confirmed last:
//   the server may hold the newer one, so it is asked again;
// - nothing is sent for a protocol whose boxes were never typed in: a first save creates the protocol ("Mustand"), so looking creates none;
// - while a send is on its way (setSending) the protocol takes no edits;
// - a box over 10 000 characters is never cut: nothing is sent until it is shortened, the status and the box say so;
// - pasted control characters that Postgres cannot store are dropped (toStorable), the words kept.
// The server's side is server/protocols.ts saveProtocol behind POST /api/admin/protokoll.

/** What the screen edits of a protocol: the notes under its headings, in order, and the general notes. */
export type Content = { notes: string[]; generalNote: string };

/** A protocol's save, as its status line says it. `at`: when the server saved it last (ms), null before the first save. */
export type SaveStatus =
  | { kind: "saved"; at: number | null }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "retrying" }
  | { kind: "tooLong"; places: NotePlace[] }
  | { kind: "signedOut" }
  | { kind: "gone" };

/** A protocol as the server holds it (the page's, or a 409's). `version` 0: none yet. */
export type ServerDraft = {
  registrationId: number;
  version: number;
  titles: string[];
  content: Content;
  sentVersion: number | null;
  sentAt: string | null;
  /** When the server last saved it (ms); null before the first save. */
  savedAt: number | null;
};

/** Another device saved first: the headings this screen had, and its text that could not be saved (null: it had nothing new). */
export type Conflict = { titles: string[]; lost: Content | null };

/** One protocol on the screen: what the server confirmed (`confirmed` at `version`), what the screen shows (`content`), its save. */
export type Entry = {
  registrationId: number;
  version: number;
  titles: string[];
  confirmed: Content;
  content: Content;
  sentVersion: number | null;
  sentAt: string | null;
  savedAt: number | null;
  status: SaveStatus;
  conflict: Conflict | null;
  /** "Saada" is on its way (Task 6): the boxes are read-only and edits are not taken. */
  sending: boolean;
  /** This browser holds the screen's unsaved text; false: its storage is full or blocked, and a reload would lose the text. */
  kept: boolean;
};

/** What this browser keeps of a protocol until the server confirms it: the version it builds on, and the texts sent without an answer. */
export type LocalCopy = { version: number; titles: string[]; content: Content; sent: Content[] };

export const DEBOUNCE_MS = 1500;
/** A save that has not been answered in 10 s is given up (and kept, and tried again). */
export const SAVE_TIMEOUT_MS = 10_000;
/** The waits before trying a failed save again; the last one repeats. */
export const RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000] as const;

/** The most text this browser keeps of the saves sent without an answer, in characters (one protocol at its limits holds 310 000). */
export const SENT_MAX_CHARS = 200_000;

/** The answers that say a save was not stored: the route's refusals (not a save, the version check, too big) and its sign-in check. */
const REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 413]);

export const localKey = (registrationId: number): string => `mslab-protocol:${registrationId}`;
/** A conflict's notice text, kept until "Selge". */
export const conflictKey = (registrationId: number): string => `mslab-protocol-conflict:${registrationId}`;

const copy = (c: Content): Content => ({ notes: [...c.notes], generalNote: c.generalNote });

export const sameContent = (a: Content, b: Content): boolean =>
  a.generalNote === b.generalNote && a.notes.length === b.notes.length && a.notes.every((n, i) => n === b.notes[i]);

const sameTitles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isContent = (v: unknown): v is Content =>
  typeof v === "object" && v !== null && isStrings((v as Content).notes) && typeof (v as Content).generalNote === "string";
const size = (c: Content): number => c.notes.reduce((n, note) => n + note.length, c.generalNote.length);

/**
 * The texts sent since the last confirmed version, with `text` added (an answer lost: any of them may be what the server holds). Each text
 * once: a retry of the same text adds nothing. At most SENT_MAX_CHARS together: the oldest go first, never the newest (after a day offline
 * that long a refusal shows the notice with the screen's words in it, instead of saving on top: nothing is lost either way).
 */
export function remember(sent: readonly Content[], text: Content): Content[] {
  const out = sent.some((c) => sameContent(c, text)) ? [...sent] : [...sent, copy(text)];
  let total = out.reduce((n, c) => n + size(c), 0);
  while (out.length > 1 && total > SENT_MAX_CHARS) total -= size(out.shift()!);
  return out;
}

/** The copy this browser kept of a protocol, or null: none, storage blocked, or anything that is not a copy this code wrote. */
export function readLocal(storage: Storage | null, registrationId: number): LocalCopy | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(localKey(registrationId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const c = value as Record<string, unknown>;
    if (typeof c.version !== "number" || !isStrings(c.titles) || !isContent(c.content) || !Array.isArray(c.sent) || !c.sent.every(isContent)) return null;
    return { version: c.version, titles: c.titles, content: c.content, sent: c.sent };
  } catch {
    return null;
  }
}

/** Writes one key; false when this browser cannot keep it (no storage, or full or blocked): the screen then says so (Entry.kept). */
function writeKey(storage: Storage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(storage: Storage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // blocked storage: nothing was kept
  }
}

/** The conflict this browser kept (its notice's words, until "Selge"), or null: none, or anything this code did not write. */
export function readConflict(storage: Storage | null, registrationId: number): Conflict | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(conflictKey(registrationId)) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const c = value as Record<string, unknown>;
    return isStrings(c.titles) && isContent(c.lost) ? { titles: c.titles, lost: c.lost } : null;
  } catch {
    return null;
  }
}

/** Two texts as one: the longer when it holds the other (typed on), else both, the older first. */
const joinText = (older: string, newer: string): string => (newer.includes(older) ? newer : older.includes(newer) ? older : `${older}\n\n${newer}`);

/**
 * A second refusal while the first one's notice is still open (before "Selge"): one notice that holds the words of both, so neither is lost.
 * Under the same headings each box holds both texts; under other headings (the course's headings changed before the first save) the older
 * headings and their texts come first, then the newer ones.
 */
function mergeConflicts(older: Conflict | null, newer: Conflict): Conflict {
  if (!older?.lost) return newer.lost || !older ? newer : older;
  if (!newer.lost) return older;
  const a = older.lost;
  const b = newer.lost;
  const generalNote = joinText(a.generalNote, b.generalNote);
  if (sameTitles(older.titles, newer.titles))
    return { titles: [...newer.titles], lost: { notes: newer.titles.map((_, i) => joinText(a.notes[i] ?? "", b.notes[i] ?? "")), generalNote } };
  return {
    titles: [...older.titles, ...newer.titles],
    lost: { notes: [...older.titles.map((_, i) => a.notes[i] ?? ""), ...newer.titles.map((_, i) => b.notes[i] ?? "")], generalNote },
  };
}

/** What a reload does with a kept copy: nothing (none, or the server holds it), resume it (and save it), or show it as not saved. */
export type Resume = { kind: "none" } | { kind: "resume"; content: Content } | { kind: "lost"; titles: string[]; content: Content };

/**
 * A kept copy against what the server holds now: the same text is nothing to do; other headings, or a server that moved on by another
 * device, make it "lost" (the notice shows it); the same version, or a server that moved on by a save of this browser whose answer was lost
 * (its stored text is one this browser sent), resume it.
 */
export function resumeLocal(server: { version: number; titles: string[]; content: Content }, local: LocalCopy | null): Resume {
  if (!local || sameContent(local.content, server.content)) return { kind: "none" };
  if (!sameTitles(local.titles, server.titles)) return { kind: "lost", titles: local.titles, content: local.content };
  if (local.version === server.version) return { kind: "resume", content: local.content };
  if (server.version > local.version && local.sent.some((c) => sameContent(c, server.content))) return { kind: "resume", content: local.content };
  return { kind: "lost", titles: local.titles, content: local.content };
}

/** A protocol's status mark (domain/protocols.ts protocolStatus): version 0 is none yet. */
export const statusOf = (e: Pick<Entry, "version" | "sentAt" | "sentVersion">): ProtocolStatus => protocolStatus(e.version === 0 ? null : e);

/** Is anything written on the screen? */
export const written = (e: Pick<Entry, "content">): boolean =>
  hasText({ stages: e.content.notes.map((note) => ({ title: "", note })), generalNote: e.content.generalNote });

/** Does the screen show text the server has not confirmed? */
export const unsavedEntry = (e: Pick<Entry, "content" | "confirmed">): boolean => !sameContent(e.content, e.confirmed);

/** A 409's protocol (server/protocols.ts draftJson) as a ServerDraft; null for anything else. */
export function readDraft(registrationId: number, value: unknown): ServerDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.version !== "number" || !Array.isArray(p.stages) || typeof p.generalNote !== "string") return null;
  const stages = p.stages as unknown[];
  if (!stages.every((s) => typeof s === "object" && s !== null && typeof (s as { title?: unknown }).title === "string" && typeof (s as { note?: unknown }).note === "string")) return null;
  const typed = stages as { title: string; note: string }[];
  return {
    registrationId,
    version: p.version,
    titles: typed.map((s) => s.title),
    content: { notes: typed.map((s) => s.note), generalNote: p.generalNote },
    sentVersion: typeof p.sentVersion === "number" ? p.sentVersion : null,
    sentAt: typeof p.sentAt === "string" ? p.sentAt : null,
    savedAt: typeof p.updatedAt === "string" ? Date.parse(p.updatedAt) : null,
  };
}

/** What a save sends (server/protocols.ts SaveInput). */
export type SaveBody = { registrationId: number; version: number; titles: string[]; notes: string[]; generalNote: string };
/** The server's answer to a save; null when none came (no connection, the 10 s ran out). */
export type Answer = { status: number; body: unknown } | null;
export type Send = (body: SaveBody) => Promise<Answer>;

/** POST /api/admin/protokoll with the admin's cookie, given up after 10 s. Never throws. */
export async function postSave(body: SaveBody): Promise<Answer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/admin/protokoll", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The autosave of one screen's protocols (see the top of the file). */
export class ProtocolAutosave {
  private readonly entries = new Map<number, Entry>();
  private readonly order: number[];
  private readonly send: Send;
  private readonly debounce = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly retry = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<number, number>();
  private readonly chains = new Map<number, Promise<boolean>>();
  /** Texts sent without an answer since the last confirmed one: any of them may be stored (a lost answer). */
  private readonly unanswered = new Map<number, Content[]>();
  /** The text of the save on its way. */
  private readonly flying = new Map<number, Content>();
  private readonly listeners = new Set<() => void>();
  private storage: Storage | null = null;
  private running = false;
  private resumed = false;
  private revision = 0;

  constructor(drafts: readonly ServerDraft[], send: Send = postSave) {
    this.send = send;
    this.order = drafts.map((d) => d.registrationId);
    for (const d of drafts)
      this.entries.set(d.registrationId, {
        registrationId: d.registrationId,
        version: d.version,
        titles: [...d.titles],
        confirmed: copy(d.content),
        content: copy(d.content),
        sentVersion: d.sentVersion,
        sentAt: d.sentAt,
        savedAt: d.savedAt,
        status: { kind: "saved", at: d.savedAt },
        conflict: null,
        sending: false,
        kept: true,
      });
  }

  /** For useSyncExternalStore: told after every change. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** For useSyncExternalStore: a number that moves with every change. */
  readonly snapshot = (): number => this.revision;

  ids(): number[] {
    return [...this.order];
  }

  get(id: number): Entry | undefined {
    return this.entries.get(id);
  }

  /** Does the screen show any text the server has not confirmed? */
  unsaved(): boolean {
    return [...this.entries.values()].some(unsavedEntry);
  }

  /**
   * Starts saving, after the page has loaded (its server render shows the server's text): the copies this browser kept are resumed once, and
   * the online and visibility events are heard. React may stop and start it again (strict mode): a second start resumes nothing twice.
   */
  start(storage: Storage | null): void {
    this.storage = storage;
    this.running = true;
    window.addEventListener("online", this.onBack);
    document.addEventListener("visibilitychange", this.onVisible);
    if (!this.resumed) {
      this.resumed = true;
      for (const e of this.entries.values()) this.resume(e);
    } else {
      for (const e of this.entries.values()) if (this.uncertain(e)) this.schedule(e.registrationId, 0);
    }
    this.changed();
  }

  /**
   * Stops (the screen is left for another admin page): no timer runs on, and an answer still on its way is not applied (the text stays in
   * this browser). A save still waiting for its 1.5 s goes now, unanswered: the server has the text when another device opens it, and this
   * browser's copy stays until a later visit finds the text stored (resumeLocal).
   */
  stop(): void {
    const waiting = [...this.debounce.keys()];
    this.running = false;
    window.removeEventListener("online", this.onBack);
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const timer of [...this.debounce.values(), ...this.retry.values()]) clearTimeout(timer);
    this.debounce.clear();
    this.retry.clear();
    for (const id of waiting) {
      const e = this.entries.get(id);
      if (!e || e.sending || !this.uncertain(e) || overLimit(e.content.notes, e.content.generalNote).length > 0) continue;
      const parting = copy(e.content);
      void this.send({ registrationId: id, version: e.version, titles: [...e.titles], notes: parting.notes, generalNote: parting.generalNote }).catch(() => null);
    }
  }

  editNote(id: number, index: number, value: string): void {
    const e = this.entries.get(id);
    if (e) this.edit(id, { notes: e.content.notes.map((n, i) => (i === index ? value : n)), generalNote: e.content.generalNote });
  }

  editGeneral(id: number, value: string): void {
    const e = this.entries.get(id);
    if (e) this.edit(id, { notes: e.content.notes, generalNote: value });
  }

  /**
   * What the screen shows now: kept in this browser at once, saved 1.5 s after the last change (never while a box is over its limit). Typed
   * back to the text confirmed last, nothing is sent, unless a save's answer is unknown: the server may hold that save's text instead.
   */
  edit(id: number, content: Content): void {
    const e = this.entries.get(id);
    if (!e || e.sending) return;
    e.content = { notes: content.notes.map(toStorable), generalNote: toStorable(content.generalNote) };
    if (!this.uncertain(e)) {
      this.clearTimer(this.debounce, id);
      this.settle(e);
      return;
    }
    this.keep(e);
    const places = overLimit(e.content.notes, e.content.generalNote);
    if (places.length > 0) {
      this.clearTimer(this.debounce, id);
      this.set(e, { kind: "tooLong", places });
      return;
    }
    this.set(e, { kind: "pending" });
    this.schedule(id, DEBOUNCE_MS);
  }

  /** Saves now (blur, switching student, before a send), after the save on its way; true when the screen's text is confirmed. */
  save(id: number): Promise<boolean> {
    this.clearTimer(this.debounce, id);
    const before = this.chains.get(id) ?? Promise.resolve(true);
    const next = before.then(
      () => this.sendIfNeeded(id),
      () => this.sendIfNeeded(id),
    );
    this.chains.set(id, next);
    void next.then(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  /** Saves every protocol now; true when every one is confirmed. */
  async saveAll(): Promise<boolean> {
    const results = await Promise.all(this.order.map((id) => this.save(id)));
    return results.every(Boolean);
  }

  /** "Saada" went through: `version` is the one the student sees now. */
  markSent(id: number, version: number, sentAt: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.sentVersion = version;
    e.sentAt = sentAt;
    this.changed();
  }

  /** "Saada" is on its way (on) or answered (off): meanwhile the protocol takes no edits, so the version sent is the one on the screen. */
  setSending(id: number, on: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.sending = on;
    this.changed();
  }

  /** "Selge": the notice goes, and with it the words this browser kept for it. */
  dismissConflict(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.conflict = null;
    removeKey(this.storage, conflictKey(id));
    this.changed();
  }

  private readonly onBack = (): void => {
    for (const e of this.entries.values())
      if (e.status.kind === "retrying" || e.status.kind === "signedOut") {
        this.attempts.delete(e.registrationId);
        void this.save(e.registrationId);
      }
  };

  /** Shown again: the waiting retries go at once. Hidden (another app, the tablet locked, a tab it may discard): the waiting saves go now. */
  private readonly onVisible = (): void => {
    if (document.visibilityState === "visible") this.onBack();
    else for (const id of [...this.debounce.keys()]) void this.save(id);
  };

  private resume(e: Entry): void {
    // a notice not closed yet ("Selge") comes back with its words
    e.conflict = readConflict(this.storage, e.registrationId);
    const plan = resumeLocal({ version: e.version, titles: e.titles, content: e.confirmed }, readLocal(this.storage, e.registrationId));
    if (plan.kind === "none") {
      removeKey(this.storage, localKey(e.registrationId));
      return;
    }
    if (plan.kind === "lost") {
      this.showConflict(e, { titles: plan.titles, lost: plan.content });
      removeKey(this.storage, localKey(e.registrationId));
      return;
    }
    const local = readLocal(this.storage, e.registrationId);
    if (local && local.sent.length > 0) this.unanswered.set(e.registrationId, local.sent);
    e.content = copy(plan.content);
    const places = overLimit(e.content.notes, e.content.generalNote);
    e.status = places.length > 0 ? { kind: "tooLong", places } : { kind: "pending" };
    if (places.length === 0) this.schedule(e.registrationId, 0);
  }

  /**
   * Is the server's text not known to be the screen's: the screen shows text not confirmed, or a save's answer is unknown (on its way, or
   * lost: the server may hold that save's text)? Only then is anything sent: a protocol never typed in is never saved (its first save would
   * create it, a "Mustand").
   */
  private uncertain(e: Entry): boolean {
    return unsavedEntry(e) || this.unanswered.has(e.registrationId) || this.flying.has(e.registrationId);
  }

  private async sendIfNeeded(id: number): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || !this.running || e.status.kind === "gone") return false;
    if (!this.uncertain(e)) {
      this.settle(e);
      return true;
    }
    const places = overLimit(e.content.notes, e.content.generalNote);
    if (places.length > 0) {
      this.set(e, { kind: "tooLong", places });
      return false;
    }
    this.clearTimer(this.retry, id);
    const payload = copy(e.content);
    const version = e.version;
    this.flying.set(id, payload);
    this.keep(e);
    this.set(e, { kind: "saving" });
    const answer = await this.send({ registrationId: id, version, titles: [...e.titles], notes: payload.notes, generalNote: payload.generalNote });
    this.flying.delete(id);
    if (!this.running) return false;
    const body = (answer?.body ?? null) as Record<string, unknown> | null;
    if (answer && answer.status === 200 && body?.ok === true && typeof body.version === "number") {
      this.unanswered.delete(id);
      this.attempts.delete(id);
      e.version = body.version;
      e.confirmed = payload;
      e.savedAt = typeof body.savedAt === "string" ? Date.parse(body.savedAt) : Date.now();
      if (sameContent(e.content, payload)) {
        this.settle(e);
        return true;
      }
      return this.sendIfNeeded(id); // typed on while it was saving: the rest goes at once
    }
    if (answer && answer.status === 409 && body?.error === "conflict") {
      const stored = readDraft(id, body.protocol);
      if (stored) return this.conflict(e, stored, version);
    }
    if (answer && (answer.status === 401 || answer.status === 403)) return this.failed(e, { kind: "signedOut" });
    if (answer && answer.status === 404) {
      this.set(e, { kind: "gone" });
      return false;
    }
    // no answer, a server error, or an answer that is not the server's (a Wi-Fi login page): the text may be stored all the same (the next
    // refusal tells); kept here, and tried again. Only the server's own refusals (400, 409, 413) are sure not to have stored it.
    if (!answer || !REFUSALS.has(answer.status)) this.unanswered.set(id, remember(this.unanswered.get(id) ?? [], payload));
    return this.failed(e, { kind: "retrying" });
  }

  private conflict(e: Entry, stored: ServerDraft, sentFrom: number): Promise<boolean> | false {
    const mine = this.unanswered.get(e.registrationId) ?? [];
    this.unanswered.delete(e.registrationId);
    this.attempts.delete(e.registrationId);
    if (stored.version > sentFrom && sameTitles(stored.titles, e.titles) && mine.some((c) => sameContent(c, stored.content))) {
      // our own earlier save, whose answer was lost: it is stored as that version, and the screen's newer text goes on from there
      e.version = stored.version;
      e.confirmed = copy(stored.content);
      e.sentVersion = stored.sentVersion;
      e.sentAt = stored.sentAt;
      e.savedAt = stored.savedAt;
      return this.sendIfNeeded(e.registrationId);
    }
    // another device or tab saved first: its text is shown, and this screen's goes into the notice (newer text is never overwritten); a
    // screen that shows the text confirmed last has no words of its own to lose (the other device built on that text)
    const nothingNew = sameContent(e.content, stored.content) || sameContent(e.content, e.confirmed);
    this.showConflict(e, { titles: e.titles, lost: nothingNew ? null : copy(e.content) });
    e.version = stored.version;
    e.titles = [...stored.titles];
    e.confirmed = copy(stored.content);
    e.content = copy(stored.content);
    e.sentVersion = stored.sentVersion;
    e.sentAt = stored.sentAt;
    e.savedAt = stored.savedAt;
    this.settle(e);
    return false;
  }

  /**
   * The notice, and its words kept in this browser until "Selge" (a reload, or a discarded tab, shows them again). A notice still open gets
   * the new words added (mergeConflicts): the words of the first are not lost.
   */
  private showConflict(e: Entry, conflict: Conflict): void {
    e.conflict = mergeConflicts(e.conflict, conflict);
    if (e.conflict.lost) writeKey(this.storage, conflictKey(e.registrationId), e.conflict);
  }

  private failed(e: Entry, status: SaveStatus): false {
    this.set(e, status);
    const n = this.attempts.get(e.registrationId) ?? 0;
    this.attempts.set(e.registrationId, n + 1);
    this.clearTimer(this.retry, e.registrationId);
    this.retry.set(
      e.registrationId,
      setTimeout(() => {
        this.retry.delete(e.registrationId);
        void this.save(e.registrationId);
      }, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]),
    );
    return false;
  }

  /** Confirmed: "Salvestatud HH:MM", and this browser's copy is no longer needed. */
  private settle(e: Entry): void {
    removeKey(this.storage, localKey(e.registrationId));
    e.kept = true; // nothing is left to keep
    this.set(e, { kind: "saved", at: e.savedAt });
  }

  /**
   * Keeps the screen's text in this browser, with the texts that may be stored already (sent without an answer, or on their way); `kept` says
   * whether that worked. The caller sets the status next, which tells the screen.
   */
  private keep(e: Entry): void {
    const flying = this.flying.get(e.registrationId);
    const unanswered = this.unanswered.get(e.registrationId) ?? [];
    const sent = flying ? remember(unanswered, flying) : unanswered;
    const copyOf: LocalCopy = { version: e.version, titles: e.titles, content: e.content, sent };
    e.kept = writeKey(this.storage, localKey(e.registrationId), copyOf);
  }

  private schedule(id: number, ms: number): void {
    this.clearTimer(this.debounce, id);
    this.debounce.set(
      id,
      setTimeout(() => {
        this.debounce.delete(id);
        void this.save(id);
      }, ms),
    );
  }

  private clearTimer(timers: Map<number, ReturnType<typeof setTimeout>>, id: number): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  private set(e: Entry, status: SaveStatus): void {
    e.status = status;
    this.changed();
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
