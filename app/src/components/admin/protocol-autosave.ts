import { hasText, overLimit, protocolStatus, type NotePlace, type ProtocolStatus } from "@/domain/protocols";
import { toStorable } from "@/lib/to-storable"; // (never lib/storable: this file runs on old iPads, tests/unit/old-safari.test.ts)

// The protocol screen's autosave (phase protocols, spec §4), without React: ProtocolScreen.tsx renders what it holds and tells it what Maria
// types. Nothing typed is lost:
// - a box saves 1.5 s after typing stops, on blur and on switching student (save); one save of a protocol at a time, the next one waits;
// - until the server confirms a text, this browser keeps it (localStorage), and a reload or a new tab resumes it (start); a browser that
//   cannot keep it (storage full or blocked) says so (Entry.kept);
// - each tab of the browser keeps its own copy (`mslab-protocol:<registration>:<tab>`, the texts it sent without an answer apart in
//   `mslab-protocol-sent:…`, written only when they change) and its own notice (`mslab-protocol-conflict:<registration>:<tab>`): a tab never
//   removes or overwrites another tab's. A new tab resumes every copy it finds (a closed tab's, or one of no tab): the newest one is the
//   screen's text, the others' words go into the notice, and those copies go only once their words are kept by this tab or on the server;
// - a save that fails is tried again after 2, 5, 10, 20, then every 30 s, and at once when the browser is back online or the tab is shown
//   again; the status says "Salvestamata — proovin uuesti";
// - a save carries the version the server confirmed last. A refusal (409) brings what is stored: the screen's own text is simply saved; a
//   text this screen sent and never heard back about (the answer was lost on the way) was ours, and the newer text is saved on top of it with
//   no notice; otherwise another device or tab saved first, its text is shown, and this screen's unsaved words go into the notice: newer text
//   is never overwritten. The texts sent without an answer are kept once each, up to SENT_MAX_CHARS; the notice's words are kept until
//   "Selge", across a reload, a second refusal adds its words to them (the newest within NOTICE_MAX_CHARS), and while this browser cannot
//   keep them under the notice's key they stay in the copy and the entry says so;
// - while a save's answer is unknown (on its way, or lost) the protocol is not "saved", even when the screen shows the text confirmed last:
//   the server may hold the newer one, so it is asked again;
// - nothing is sent for a protocol whose boxes were never typed in: a first save creates the protocol ("Mustand"), so looking creates none;
// - the tab hidden (another app, the tablet locked) sends a waiting save at once; the page put away (pagehide: the tab closed, the tablet's
//   browser freezing it) sends it as a keepalive request when it is small enough, else leaves it to the copy; leaving the screen for another
//   admin page sends it unanswered (stop);
// - while a send is on its way (setSending, counted) the protocol takes no edits;
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
  /** A send is on its way (setSending): the boxes are read-only and edits are not taken. */
  sending: boolean;
  /** The line under the protocol's send button (why the last send did not go through); it stays with the protocol until its next send or edit. */
  sendError: string | null;
  /**
   * This browser holds what is not on the server (the unsaved text, the notice's words); false: its storage is full or blocked, and a reload
   * would lose them. The screen says so ("Seda teksti ei saa selles seadmes hoida …").
   */
  kept: boolean;
};

/**
 * What this browser keeps of a protocol until the server confirms it: the version it builds on, the texts sent without an answer, when it was
 * written (ms: the newest of several tabs' copies is resumed), and the notice's words while they cannot be kept under their own key.
 */
export type LocalCopy = { version: number; titles: string[]; content: Content; sent: Content[]; at?: number; lost?: Conflict };

export const DEBOUNCE_MS = 1500;
/** A save that has not been answered in 10 s is given up (and kept, and tried again). */
export const SAVE_TIMEOUT_MS = 10_000;
/** The waits before trying a failed save again; the last one repeats. */
export const RETRY_MS = [2000, 5000, 10_000, 20_000, 30_000] as const;

/** The most text this browser keeps of the saves sent without an answer, in characters (one protocol at its limits holds 310 000). */
export const SENT_MAX_CHARS = 200_000;
/** The most text a notice keeps of the refusals before "Selge", in characters: the oldest go first, never the newest. */
export const NOTICE_MAX_CHARS = 200_000;
/** The most a page that is put away sends as keepalive requests, in bytes (the browsers' limit for them all is 64 KiB). */
export const KEEPALIVE_MAX_BYTES = 64_000;

/** The answers that say a save was not stored: the route's refusals (not a save, the version check, too big) and its sign-in check. */
const REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 413]);

/** A tab's copy of a protocol (`tab`), or one of no tab (an older one, kept by an older screen): both are resumed. */
export const localKey = (registrationId: number, tab?: string): string => `mslab-protocol:${registrationId}${tab ? `:${tab}` : ""}`;
/** The texts a tab sent without an answer, apart from its copy: written when they change, not with every keystroke. */
export const sentKey = (registrationId: number, tab: string): string => `mslab-protocol-sent:${registrationId}:${tab}`;
/** A tab's notice text (or one of no tab), kept until "Selge". */
export const conflictKey = (registrationId: number, tab?: string): string => `mslab-protocol-conflict:${registrationId}${tab ? `:${tab}` : ""}`;

const copy = (c: Content): Content => ({ notes: [...c.notes], generalNote: c.generalNote });

export const sameContent = (a: Content, b: Content): boolean =>
  a.generalNote === b.generalNote && a.notes.length === b.notes.length && a.notes.every((n, i) => n === b.notes[i]);

const sameTitles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameList = (a: readonly Content[], b: readonly Content[]): boolean => a.length === b.length && a.every((c, i) => sameContent(c, b[i]));
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isContent = (v: unknown): v is Content =>
  typeof v === "object" && v !== null && isStrings((v as Content).notes) && typeof (v as Content).generalNote === "string";
const isContents = (v: unknown): v is Content[] => Array.isArray(v) && v.every(isContent);
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

// ---------- the notice: its parts ----------

/** Two texts as one: the longer when it holds the other (typed on), else both, the older first. */
const joinText = (older: string, newer: string): string => (newer.includes(older) ? newer : older.includes(newer) ? older : `${older}\n\n${newer}`);

/** Two refusals' words as one notice: under the same headings each box holds both texts; under other headings the older ones come first. */
function mergeTwo(older: Conflict & { lost: Content }, newer: Conflict & { lost: Content }): Conflict & { lost: Content } {
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

type Part = Conflict & { lost: Content };
const isPart = (c: Conflict): c is Part => c.lost !== null;

/** A notice's parts (each refusal's words, oldest first): each once, at most NOTICE_MAX_CHARS together, the oldest left out first. */
function capParts(parts: readonly Conflict[]): Part[] {
  const out: Part[] = [];
  for (const p of parts.filter(isPart)) {
    const same = out.findIndex((q) => sameTitles(q.titles, p.titles) && sameContent(q.lost, p.lost));
    if (same >= 0) out.splice(same, 1);
    out.push({ titles: [...p.titles], lost: copy(p.lost) });
  }
  let total = out.reduce((n, p) => n + size(p.lost), 0);
  while (out.length > 1 && total > NOTICE_MAX_CHARS) total -= size(out.shift()!.lost);
  return out;
}

/** The notice the screen shows: its parts as one. */
const combine = (parts: readonly Part[]): Conflict | null => parts.reduce<Part | null>((acc, p) => (acc ? mergeTwo(acc, p) : { titles: [...p.titles], lost: copy(p.lost) }), null);

// ---------- this browser's storage ----------

/** A key as it was read: removed later only if nobody wrote it since (another tab may be typing into its own). */
type Held = { key: string; raw: string };

function getRaw(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
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

/** Can this storage list its keys (every browser's localStorage can)? */
const canList = (storage: Storage): boolean => {
  try {
    return typeof storage.key === "function" && typeof storage.length === "number";
  } catch {
    return false;
  }
};

/** The keys of `base` and of every tab's (`base:<tab>`), with `extra`; a storage that cannot list its keys gives `base` and `extra` only. */
function keysOf(storage: Storage, base: string, extra: readonly string[]): string[] {
  const out: string[] = [];
  try {
    const n = canList(storage) ? storage.length : 0;
    for (let i = 0; i < n; i++) {
      const key = storage.key(i);
      if (key !== null && (key === base || key.startsWith(`${base}:`))) out.push(key);
    }
  } catch {
    // a storage that cannot list its keys
  }
  for (const key of [base, ...extra]) if (!out.includes(key)) out.push(key);
  return out;
}

function parseJson(raw: string | null): unknown {
  try {
    return JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
}

/** A notice's stored words, or null for anything this code did not write. */
function parseConflict(value: unknown): Part | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  return isStrings(c.titles) && isContent(c.lost) ? { titles: c.titles, lost: c.lost } : null;
}

/** A copy as stored, or null for anything this code did not write (its own sent texts, if kept apart, are added by readCopies). */
function parseCopy(raw: string | null): LocalCopy | null {
  const value = parseJson(raw);
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.version !== "number" || !isStrings(c.titles) || !isContent(c.content)) return null;
  if (c.sent !== undefined && !isContents(c.sent)) return null;
  const lost = parseConflict(c.lost);
  return {
    version: c.version,
    titles: c.titles,
    content: c.content,
    sent: (c.sent as Content[] | undefined) ?? [],
    ...(typeof c.at === "number" ? { at: c.at } : {}),
    ...(lost ? { lost } : {}),
  };
}

type FoundCopy = { copy: LocalCopy; held: Held[] };

/** Every copy of a protocol in this browser (every tab's, and one of no tab), oldest first; `own`: a tab's key read even when not listed. */
function readCopies(storage: Storage | null, registrationId: number, own?: string): FoundCopy[] {
  if (!storage) return [];
  const base = localKey(registrationId);
  const out: FoundCopy[] = [];
  for (const key of keysOf(storage, base, own ? [localKey(registrationId, own)] : [])) {
    const raw = getRaw(storage, key);
    const found = parseCopy(raw);
    if (!found || raw === null) continue;
    const held: Held[] = [{ key, raw }];
    const tabSent = sentKey(registrationId, key === base ? "" : key.slice(base.length + 1));
    const sentRaw = getRaw(storage, tabSent);
    const sent = parseJson(sentRaw);
    if (sentRaw !== null && isContents(sent)) {
      found.sent = sent;
      held.push({ key: tabSent, raw: sentRaw });
    }
    out.push({ copy: found, held });
  }
  return out.sort((a, b) => (a.copy.at ?? 0) - (b.copy.at ?? 0));
}

type FoundNotice = { parts: Part[]; held: Held };

/** Every notice of a protocol in this browser (every tab's, and one of no tab), each with its parts. */
function readNotices(storage: Storage | null, registrationId: number, own?: string): FoundNotice[] {
  if (!storage) return [];
  const out: FoundNotice[] = [];
  for (const key of keysOf(storage, conflictKey(registrationId), own ? [conflictKey(registrationId, own)] : [])) {
    const raw = getRaw(storage, key);
    const value = parseJson(raw);
    const whole = parseConflict(value);
    if (!whole || raw === null) continue;
    const stored = (value as { parts?: unknown }).parts;
    const parts = Array.isArray(stored) ? stored.map(parseConflict).filter((p): p is Part => p !== null) : [];
    out.push({ parts: parts.length > 0 ? parts : [whole], held: { key, raw } });
  }
  return out;
}

/** A copy this browser kept of a protocol: `tab`'s, or without it the newest of all; null: none, storage blocked, or not a copy of this code. */
export function readLocal(storage: Storage | null, registrationId: number, tab?: string): LocalCopy | null {
  const all = readCopies(storage, registrationId, tab);
  const wanted = tab ? all.filter((c) => c.held[0].key === localKey(registrationId, tab)) : all;
  return wanted.length > 0 ? wanted[wanted.length - 1].copy : null;
}

/** A notice this browser kept (its words, until "Selge"): `tab`'s, or without it every tab's as one; null: none, or not one of this code. */
export function readConflict(storage: Storage | null, registrationId: number, tab?: string): Conflict | null {
  const all = readNotices(storage, registrationId, tab);
  const wanted = tab ? all.filter((n) => n.held.key === conflictKey(registrationId, tab)) : all;
  return combine(capParts(wanted.flatMap((n) => n.parts)));
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

/** Does the screen show text the server has not confirmed? (The engine's `unconfirmed` also counts a save whose answer is unknown.) */
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
/** `keepalive`: the request outlives the page (sent while it is put away). */
export type SendOptions = { keepalive?: boolean };
export type Send = (body: SaveBody, opts?: SendOptions) => Promise<Answer>;

/** POST /api/admin/protokoll with the admin's cookie, given up after 10 s. Never throws. */
export async function postSave(body: SaveBody, opts?: SendOptions): Promise<Answer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/admin/protokoll", {
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
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** A name for this page's tab: its keys in this browser's storage are its own (no crypto.randomUUID: iOS before 15.4 has none). */
const newTabName = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The autosave of one screen's protocols (see the top of the file). */
export class ProtocolAutosave {
  private readonly entries = new Map<number, Entry>();
  private readonly order: number[];
  private readonly send: Send;
  /** This page's name for its own keys in the browser's storage (each page load has its own, so a duplicated tab never shares them). */
  private readonly tab: string;
  /**
   * The name its keys are written under: `tab`, or "" (the keys of no tab) with a storage that cannot list its keys, where a reload could not
   * find a tab's keys (no browser's localStorage is one: a test's or a stand-in's).
   */
  private keyTab = "";
  private readonly debounce = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly retry = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<number, number>();
  private readonly chains = new Map<number, Promise<boolean>>();
  /** Texts sent without an answer since the last confirmed one: any of them may be stored (a lost answer). */
  private readonly unanswered = new Map<number, Content[]>();
  /** How many sends of a protocol are on their way: it takes no edits until the last of them is answered. */
  private readonly sends = new Map<number, number>();
  /** The text of the save on its way. */
  private readonly flying = new Map<number, Content>();
  /** The notice's parts (each refusal's words, oldest first); the entry's `conflict` is them as one. */
  private readonly parts = new Map<number, Part[]>();
  /** The protocols whose notice's words this browser could not keep under the notice's key (they stay in the copy). */
  private readonly unkept = new Set<number>();
  /** The sent texts last written apart from the copy (written again only when they change). */
  private readonly sentWritten = new Map<number, Content[]>();
  /** Other tabs' (closed ones') keys this page resumed: removed once their words are kept by this page or on the server. */
  private readonly taken = new Map<number, Held[]>();
  private readonly listeners = new Set<() => void>();
  private storage: Storage | null = null;
  private running = false;
  private resumed = false;
  private revision = 0;
  private keepaliveLeft = KEEPALIVE_MAX_BYTES;

  constructor(drafts: readonly ServerDraft[], send: Send = postSave, options: { tab?: string } = {}) {
    this.send = send;
    this.tab = options.tab ?? newTabName();
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
        sendError: null,
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

  /** Is the server's text of a protocol not known to be the screen's (not confirmed, or a save's answer unknown)? The chip says "Salvestamata". */
  unconfirmed(id: number): boolean {
    const e = this.entries.get(id);
    return e !== undefined && this.uncertain(e);
  }

  /** Is any protocol's text not known to be on the server? (Leaving the page asks first.) */
  unsaved(): boolean {
    return this.order.some((id) => this.unconfirmed(id));
  }

  /**
   * Starts saving, after the page has loaded (its server render shows the server's text): the copies this browser kept are resumed once, and
   * the online, visibility and page events are heard. React may stop and start it again (strict mode): a second start resumes nothing twice.
   */
  start(storage: Storage | null): void {
    this.storage = storage;
    this.keyTab = storage && canList(storage) ? this.tab : "";
    this.running = true;
    window.addEventListener("online", this.onBack);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
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
   * this browser). A save still waiting for its 1.5 s goes now, unanswered and remembered as maybe stored: the server has the text when
   * another device opens it, and this browser's copy stays until a later visit finds the text stored (resumeLocal).
   */
  stop(): void {
    const waiting = [...this.debounce.keys()];
    this.running = false;
    window.removeEventListener("online", this.onBack);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const timer of [...this.debounce.values(), ...this.retry.values()]) clearTimeout(timer);
    this.debounce.clear();
    this.retry.clear();
    for (const id of waiting) {
      const e = this.entries.get(id);
      if (!e || e.sending || !this.uncertain(e) || overLimit(e.content.notes, e.content.generalNote).length > 0) continue;
      const body = this.bodyOf(e);
      this.unanswered.set(id, remember(this.unanswered.get(id) ?? [], { notes: body.notes, generalNote: body.generalNote }));
      this.keep(e);
      void this.send(body).catch(() => null);
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
    e.sendError = null;
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
    return this.queue(id, false);
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

  /**
   * A send is on its way (on) or answered (off): meanwhile the protocol takes no edits, so the version sent is the one on the screen. Sends
   * are counted: with two on their way the first answer does not open what the second still needs shut.
   */
  setSending(id: number, on: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    const n = Math.max(0, (this.sends.get(id) ?? 0) + (on ? 1 : -1));
    if (n === 0) this.sends.delete(id);
    else this.sends.set(id, n);
    e.sending = n > 0;
    this.changed();
  }

  /** The line under a protocol's send button, or none: kept with the protocol (not with the button, which goes when Maria changes student). */
  setSendError(id: number, message: string | null): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.sendError = message;
    this.changed();
  }

  /**
   * "Selge": the notice goes, and with it the words this page kept for it (its own key, and those it took over from closed tabs); another
   * open tab's notice is its own.
   */
  dismissConflict(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.conflict = null;
    e.sendError = null; // (the line that told her to look at the notice goes with it)
    this.parts.delete(id);
    this.unkept.delete(id);
    removeKey(this.storage, conflictKey(id, this.keyTab));
    if (this.uncertain(e)) this.keep(e);
    else this.dropCopy(e);
    this.changed();
  }

  private readonly onBack = (): void => {
    for (const e of this.entries.values())
      if (e.status.kind === "retrying" || e.status.kind === "signedOut") {
        this.attempts.delete(e.registrationId);
        void this.save(e.registrationId);
      }
  };

  /** Shown again: the waiting retries go at once. Hidden (another app, the tablet locked): the waiting saves go now. */
  private readonly onVisible = (): void => {
    if (document.visibilityState === "visible") this.onBack();
    else for (const id of [...this.debounce.keys()]) void this.save(id);
  };

  /**
   * The page is put away (the tab closed or reloaded, the tablet's browser freezing it): a waiting save goes as a keepalive request, which
   * outlives the page, while the bodies fit the browsers' 64 KiB for them; a bigger one is left to this browser's copy (and goes at its time
   * if the page comes back from the browser's cache).
   */
  private readonly onPageHide = (): void => {
    for (const id of [...this.debounce.keys()]) {
      const e = this.entries.get(id);
      if (!e || e.sending || !this.uncertain(e) || overLimit(e.content.notes, e.content.generalNote).length > 0) continue;
      const bytes = utf8Bytes(JSON.stringify(this.bodyOf(e)));
      if (bytes > this.keepaliveLeft) continue;
      this.keepaliveLeft -= bytes;
      void this.queue(id, true);
    }
  };

  private readonly onPageShow = (): void => {
    this.keepaliveLeft = KEEPALIVE_MAX_BYTES;
  };

  /**
   * Resumes what this browser kept of a protocol: every tab's copy and notice (a closed tab's, or one of no tab). The newest copy that builds on
   * the server's text becomes the screen's; the words of every other copy that the server does not hold go into the notice. The keys read are
   * removed once their words are kept by this page or on the server, and only if nobody wrote them since.
   */
  private resume(e: Entry): void {
    const id = e.registrationId;
    const own = (key: string) => key === localKey(id, this.keyTab) || key === sentKey(id, this.keyTab) || key === conflictKey(id, this.keyTab);
    const server = { version: e.version, titles: e.titles, content: e.confirmed };
    const taken: Held[] = [];
    const parts: Conflict[] = [];
    for (const notice of readNotices(this.storage, id, this.keyTab)) {
      taken.push(notice.held);
      parts.push(...notice.parts);
    }
    let chosen: LocalCopy | null = null;
    let sent: Content[] = [];
    for (const found of readCopies(this.storage, id, this.keyTab)) {
      taken.push(...found.held);
      if (found.copy.lost) parts.push(found.copy.lost);
      const plan = resumeLocal(server, found.copy);
      if (plan.kind === "lost") parts.push({ titles: plan.titles, lost: plan.content });
      if (plan.kind !== "resume") continue;
      for (const text of found.copy.sent) sent = remember(sent, text);
      if (chosen && !sameContent(chosen.content, plan.content)) parts.push({ titles: [...e.titles], lost: copy(chosen.content) });
      chosen = found.copy;
    }
    this.taken.set(id, taken.filter((held) => !own(held.key)));
    if (parts.length > 0) this.showConflict(e, null, parts);
    if (chosen) {
      if (sent.length > 0) this.unanswered.set(id, sent);
      e.content = copy(chosen.content);
      const places = overLimit(e.content.notes, e.content.generalNote);
      e.status = places.length > 0 ? { kind: "tooLong", places } : { kind: "pending" };
      if (places.length === 0) this.schedule(id, 0);
      this.keep(e);
    } else if (this.unkept.has(id)) this.keep(e);
    else this.dropCopy(e);
  }

  /**
   * Is the server's text not known to be the screen's: the screen shows text not confirmed, or a save's answer is unknown (on its way, or
   * lost: the server may hold that save's text)? Only then is anything sent: a protocol never typed in is never saved (its first save would
   * create it, a "Mustand").
   */
  private uncertain(e: Entry): boolean {
    return unsavedEntry(e) || this.unanswered.has(e.registrationId) || this.flying.has(e.registrationId);
  }

  private bodyOf(e: Entry): SaveBody {
    return { registrationId: e.registrationId, version: e.version, titles: [...e.titles], notes: [...e.content.notes], generalNote: e.content.generalNote };
  }

  /** One save after the one on its way. `keepalive`: the page is put away (onPageHide), and no save is on its way: it goes at once. */
  private queue(id: number, keepalive: boolean): Promise<boolean> {
    this.clearTimer(this.debounce, id);
    const before = this.chains.get(id);
    const next = before
      ? before.then(
          () => this.sendIfNeeded(id),
          () => this.sendIfNeeded(id),
        )
      : keepalive
        ? this.sendIfNeeded(id, true)
        : Promise.resolve().then(() => this.sendIfNeeded(id));
    this.chains.set(id, next);
    void next.then(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  private async sendIfNeeded(id: number, keepalive = false): Promise<boolean> {
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
    const body = this.bodyOf(e);
    const payload: Content = { notes: body.notes, generalNote: body.generalNote };
    const version = e.version;
    this.flying.set(id, payload);
    this.keep(e);
    this.set(e, { kind: "saving" });
    const answer = await this.send(body, keepalive ? { keepalive: true } : undefined);
    this.flying.delete(id);
    if (!this.running) return false;
    const reply = (answer?.body ?? null) as Record<string, unknown> | null;
    if (answer && answer.status === 200 && reply?.ok === true && typeof reply.version === "number") {
      this.unanswered.delete(id);
      this.attempts.delete(id);
      e.version = reply.version;
      e.confirmed = payload;
      e.savedAt = typeof reply.savedAt === "string" ? Date.parse(reply.savedAt) : Date.now();
      if (sameContent(e.content, payload)) {
        this.settle(e);
        return true;
      }
      return this.sendIfNeeded(id); // typed on while it was saving: the rest goes at once
    }
    if (answer && answer.status === 409 && reply?.error === "conflict") {
      const stored = readDraft(id, reply.protocol);
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

  /** The server's text as the screen's confirmed one (a refusal's, or one of a save whose answer was lost). */
  private adopt(e: Entry, stored: ServerDraft): void {
    e.version = stored.version;
    e.titles = [...stored.titles];
    e.confirmed = copy(stored.content);
    e.sentVersion = stored.sentVersion;
    e.sentAt = stored.sentAt;
    e.savedAt = stored.savedAt;
  }

  private conflict(e: Entry, stored: ServerDraft, sentFrom: number): Promise<boolean> | boolean {
    const mine = this.unanswered.get(e.registrationId) ?? [];
    this.unanswered.delete(e.registrationId);
    this.attempts.delete(e.registrationId);
    if (sameTitles(stored.titles, e.titles) && sameContent(stored.content, e.content)) {
      // the server holds exactly the screen's text (the same save twice, or another tab typed the same): nothing to tell
      this.adopt(e, stored);
      this.settle(e);
      return true;
    }
    if (stored.version > sentFrom && sameTitles(stored.titles, e.titles) && mine.some((c) => sameContent(c, stored.content))) {
      // our own earlier save, whose answer was lost: it is stored as that version, and the screen's newer text goes on from there
      this.adopt(e, stored);
      return this.sendIfNeeded(e.registrationId);
    }
    // another device or tab saved first: its text is shown, and this screen's goes into the notice (newer text is never overwritten); a
    // screen that shows the text confirmed last has no words of its own to lose (the other device built on that text)
    const nothingNew = sameContent(e.content, stored.content) || sameContent(e.content, e.confirmed);
    this.showConflict(e, { titles: e.titles, lost: nothingNew ? null : copy(e.content) });
    this.adopt(e, stored);
    e.content = copy(stored.content);
    this.settle(e);
    return false;
  }

  /**
   * The notice (one refusal's words, or the parts a reload found): added to a notice still open, so the words of the first are not lost, and
   * kept under this page's key until "Selge" (a reload, or a tab the tablet discarded, shows them again).
   */
  private showConflict(e: Entry, conflict: Conflict | null, found: readonly Conflict[] = []): void {
    const id = e.registrationId;
    const parts = capParts([...(this.parts.get(id) ?? []), ...found, ...(conflict ? [conflict] : [])]);
    if (parts.length > 0) {
      this.parts.set(id, parts);
      e.conflict = combine(parts);
    } else if (!e.conflict && conflict) e.conflict = { titles: [...conflict.titles], lost: null };
    this.storeNotice(e);
  }

  /** Writes the notice's words under this page's key; false (the copy keeps them, and the entry says so) when this browser cannot. */
  private storeNotice(e: Entry): boolean {
    const id = e.registrationId;
    const parts = this.parts.get(id) ?? [];
    if (parts.length === 0 || writeKey(this.storage, conflictKey(id, this.keyTab), { ...combine(parts), parts })) {
      this.unkept.delete(id);
      return true;
    }
    this.unkept.add(id);
    return false;
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

  /**
   * Confirmed: "Salvestatud HH:MM", and this page's copy is no longer needed, unless it holds the notice's words because this browser could
   * not keep them under the notice's key.
   */
  private settle(e: Entry): void {
    if (this.unkept.has(e.registrationId)) this.storeNotice(e);
    if (this.unkept.has(e.registrationId)) this.keep(e);
    else this.dropCopy(e);
    this.set(e, { kind: "saved", at: e.savedAt });
  }

  /** Nothing is left to keep: this page's copy goes, and so do the closed tabs' keys it took over. */
  private dropCopy(e: Entry): void {
    const id = e.registrationId;
    removeKey(this.storage, localKey(id, this.keyTab));
    removeKey(this.storage, sentKey(id, this.keyTab));
    this.sentWritten.delete(id);
    e.kept = true;
    this.release(id);
  }

  /**
   * Keeps the screen's text in this browser under this page's key (and the notice's words while they cannot be kept under their own), with
   * the texts that may be stored already (sent without an answer, or on their way) apart, written only when they change; `kept` says
   * whether that worked. The caller sets the status next, which tells the screen.
   */
  private keep(e: Entry): void {
    const id = e.registrationId;
    if (this.unkept.has(id)) this.storeNotice(e);
    const notice = this.unkept.has(id) ? e.conflict : null;
    const value = { version: e.version, titles: e.titles, content: e.content, at: Date.now(), ...(notice?.lost ? { lost: notice } : {}) };
    const copied = writeKey(this.storage, localKey(id, this.keyTab), value);
    const flying = this.flying.get(id);
    const unanswered = this.unanswered.get(id) ?? [];
    const sent = flying ? remember(unanswered, flying) : unanswered;
    let sentKept = true;
    const last = this.sentWritten.get(id);
    if (!last || !sameList(last, sent)) {
      if (sent.length === 0) removeKey(this.storage, sentKey(id, this.keyTab));
      else sentKept = writeKey(this.storage, sentKey(id, this.keyTab), sent);
      if (sentKept) this.sentWritten.set(id, sent);
    }
    e.kept = copied && sentKept && !this.unkept.has(id);
    if (e.kept) this.release(id);
  }

  /** The closed tabs' keys this page took over go, now that their words are kept here or on the server: each only if nobody wrote it since. */
  private release(id: number): void {
    const held = this.taken.get(id);
    if (!held || !this.storage) return;
    for (const h of held) if (getRaw(this.storage, h.key) === h.raw) removeKey(this.storage, h.key);
    this.taken.delete(id);
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
