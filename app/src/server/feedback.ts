import { logFailure } from "./log";
import { sendTelegram, type Env } from "./notify";
import { rateKey, rateLimit, type TextKv } from "./ratelimit";
import { keyMatches } from "./review-key";

// Design-review comments (public/feedback.js on the hub, the prototypes and, until launch, the main site's pages and the admin's pages: Dim 22.10).
// A port of the old review site's Worker (mslab-guide, retired 03.10.2026) with the same contract, KV keys and record fields, so the
// comments stored before the move and the list page /guide/tagasiside/ keep working:
//
//   POST  /api/feedback        store a comment, ping Telegram          (anyone; honeypot, 30 per 10 min per visitor)
//   GET   /api/feedback/:id    one comment's place, for "?fb=<id>"     (anyone who has the id)
//   GET   /api/feedback        every comment with its "show me" link  (header x-key: ADMIN_KEY)
//   PATCH /api/feedback/:id    { done: true|false }                    (header x-key: ADMIN_KEY)
//
// KV: `fb:<at>:<id>` holds the record (JSON), `id:<id>` the key of the record. Storage is the contract; the Telegram
// ping is best effort, and the request fails (502) only when both fail. Logs carry no names, texts or addresses.

/** The KV operations the comments use (server/kv.ts PgKv satisfies it). */
export type FeedbackKv = TextKv & {
  list(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};

/** The env the comments use: the notification env, the comment KV and the ADMIN_KEY secret of the list. */
export type FeedbackEnv = Omit<Env, "KV"> & { KV: FeedbackKv; ADMIN_KEY?: string };

export type Reply = { status: number; body: Record<string, unknown> };

/** Largest accepted request body (bytes), as in the old review Worker. */
export const MAX_BYTES = 20_000;
/** PATCH carries only { done }. */
export const MAX_PATCH_BYTES = 200;
/** Comments per visitor (IPv6: per /64) and window. Maria leaves them in bursts while she goes through a page. */
export const FEEDBACK_RATE_LIMIT = 30;
export const FEEDBACK_RATE_WINDOW_SEC = 10 * 60;

const MOODS = { good: "Meeldib", bad: "Ei meeldi", change: "Muuta" } as const;
export const DIRS = {
  a: "A · Pehme toimetus",
  b: "B · Õppeteekond",
  c: "C · Kunst pilgus",
  d: "D · Studio",
  a0: "A · 1. versioon",
  b0: "B · 1. versioon",
  moodboard: "Visuaalsed uuringud",
  hub: "Juhend (avaleht)",
  site: "Põhileht",
  admin: "Haldus",
} as const;
const DEVICES = { desk: "arvuti", tab: "tahvel", mob: "telefon" } as const;

type Dir = keyof typeof DIRS;
type Mood = keyof typeof MOODS;
type Device = keyof typeof DEVICES;

export type Comment = {
  id: string;
  at: string;
  name?: string;
  dir: Dir;
  /** Prototypes: the hash route ("#/koolitused"); main site and admin: the page path ("/koolitused", "/admin/koolitused"). */
  route?: string;
  title?: string;
  device?: Device;
  width?: number;
  mood?: Mood;
  text: string;
  el: { label?: string; snippet?: string; sel?: string; y?: number; h?: number };
  done: boolean;
};

const ID = /^[a-z0-9]{6,20}$/;
export const isCommentId = (id: string): boolean => ID.test(id);

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const has = <T extends object>(map: T, key: unknown): key is keyof T => typeof key === "string" && Object.hasOwn(map, key);

/** A main-site page path: "/" or "/x…", never "//host" (a link under our origin must stay on it), no query or hash. */
export const isSitePath = (v: unknown): v is string => typeof v === "string" && /^\/(?:[^/\\\s?#][^\\\s?#]*)?$/.test(v);

/** An admin page path: "/admin" or "/admin/…", a same-site path (isSitePath) and nothing else ("/administrator" is not one). */
export const isAdminPath = (v: unknown): v is string => isSitePath(v) && /^\/admin(?:\/|$)/.test(v);

/** 14 characters of [0-9a-z] (the old review Worker's format). */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

/** Where "Näita kohta" lands: the page itself (main site, admin), or the hub viewer at the direction, device and page. */
export function placeLink(origin: string, rec: Pick<Comment, "id" | "dir" | "device" | "route">): string {
  if (rec.dir === "hub") return `${origin}/guide/?fb=${rec.id}`;
  if (rec.dir === "site") return `${origin}${isSitePath(rec.route) ? rec.route : "/"}?fb=${rec.id}`;
  if (rec.dir === "admin") return `${origin}${isAdminPath(rec.route) ? rec.route : "/admin"}?fb=${rec.id}`;
  const hp = new URLSearchParams({ vaade: rec.dir, seade: rec.device || "desk" });
  if (rec.route) hp.set("leht", rec.route);
  return `${origin}/guide/?fb=${rec.id}#${hp}`;
}

/** The comment record from a POST body; null when there is no text. */
export function parseComment(b: Record<string, unknown>, id: string, at: Date): Comment | null {
  const text = str(b.text, 4000);
  if (!text) return null;
  const dir: Dir = has(DIRS, b.dir) ? b.dir : "hub";
  const el = b.el && typeof b.el === "object" ? (b.el as Record<string, unknown>) : {};
  const route = str(b.route, 200);
  return {
    id,
    at: at.toISOString(),
    name: str(b.name, 60),
    dir,
    route: (dir === "site" && !isSitePath(route)) || (dir === "admin" && !isAdminPath(route)) ? undefined : route,
    title: str(b.title, 120),
    device: has(DEVICES, b.device) ? b.device : undefined,
    width: num(b.width),
    mood: has(MOODS, b.mood) ? b.mood : undefined,
    text,
    // An admin page shows students' names, e-mail addresses and phone numbers: its comment keeps where the place is (selector, position) and never
    // the words of the element (label, snippet), whatever the body says (public/feedback.js does not send them either).
    el:
      dir === "admin"
        ? { sel: str(el.sel, 600), y: num(el.y), h: num(el.h) }
        : { label: str(el.label, 80), snippet: str(el.snippet, 200), sel: str(el.sel, 600), y: num(el.y), h: num(el.h) },
    done: false,
  };
}

/** The Telegram ping for a new comment. */
export function telegramText(rec: Comment, origin: string): string {
  const device = rec.device ? DEVICES[rec.device] : "";
  return (
    `💬 ${rec.name ? rec.name + " — kommentaar" : "Uus kommentaar"}\n` +
    `${DIRS[rec.dir]}${rec.title ? " · " + rec.title : ""}\n` +
    (device ? `Seade: ${device}${rec.width ? " " + rec.width + "px" : ""}\n` : "") +
    (rec.mood ? `Hinnang: ${MOODS[rec.mood]}\n` : "") +
    (rec.el.label ? `Koht: ${rec.el.label}\n` : "") +
    (rec.el.snippet && rec.el.snippet !== rec.el.label ? `«${rec.el.snippet.slice(0, 140)}»\n` : "") +
    `\n${rec.text}\n\n` +
    `Näita kohta: ${placeLink(origin, rec)}`
  );
}

/**
 * The request body as text, at most `max` bytes; null when it is longer. Reads the stream itself, so an oversized body
 * (with or without a Content-Length) is never buffered whole.
 */
export async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const parseObject = (raw: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Rate limit that fails open: when KV cannot count, the comment still goes through (as the site's forms do). */
async function withinRateLimit(kv: FeedbackKv, ip: string | null): Promise<boolean> {
  if (ip === null) return true; // never on Vercel (x-forwarded-for is always there); one shared bucket would lock everybody out
  try {
    return await rateLimit(kv, rateKey("feedback", ip), FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_SEC);
  } catch (e) {
    logFailure("[feedback] rate limit unavailable, allowing", e);
    return true;
  }
}

export type CreateDeps = {
  env: FeedbackEnv;
  /** Base of the "Näita kohta" link (allow-listed request origin, else SITE_URL). */
  origin: string;
  /** The visitor's rate limit bucket; null = none known. */
  ip: string | null;
  now: Date;
};

/** POST /api/feedback with the body as text (null = longer than MAX_BYTES). */
export async function createComment(deps: CreateDeps, raw: string | null): Promise<Reply> {
  if (raw === null) return { status: 413, body: { ok: false } };
  const b = parseObject(raw);
  if (!b) return { status: 400, body: { ok: false } };
  if (b.website) return { status: 200, body: { ok: true } }; // honeypot: pretend success, store nothing
  const rec = parseComment(b, newId(), deps.now);
  if (!rec) return { status: 400, body: { ok: false, error: "text" } };
  if (!(await withinRateLimit(deps.env.KV, deps.ip))) {
    console.info("[feedback] rate limited");
    return { status: 429, body: { ok: false, error: "rate" } };
  }

  let stored = false;
  try {
    const key = `fb:${rec.at}:${rec.id}`;
    await deps.env.KV.put(key, JSON.stringify(rec));
    await deps.env.KV.put(`id:${rec.id}`, key);
    stored = true;
  } catch (e) {
    logFailure("[feedback] storing the comment failed", e);
  }
  const telegram = await sendTelegram(deps.env, telegramText(rec, deps.origin));
  console.info(`[feedback] comment ${rec.id} (${rec.dir}): stored ${stored}, Telegram ${telegram}`);
  if (!stored && !telegram) return { status: 502, body: { ok: false } };
  return { status: 200, body: { ok: true, id: rec.id, stored, telegram } };
}

async function recordById(kv: FeedbackKv, id: string): Promise<{ key: string; rec: Comment } | null> {
  const key = await kv.get(`id:${id}`);
  if (!key) return null;
  const v = await kv.get(key);
  return v ? { key, rec: JSON.parse(v) as Comment } : null;
}

/** GET /api/feedback/:id — what "?fb=<id>" needs to outline the place (no key: the id itself is the secret). */
export async function commentPlace(kv: FeedbackKv, id: string): Promise<Reply> {
  const r = isCommentId(id) ? await recordById(kv, id) : null;
  if (!r) return { status: 404, body: { ok: false } };
  const { dir, route, device, text, name } = r.rec;
  const el = r.rec.el ?? {};
  return { status: 200, body: { ok: true, dir, route, device, text, name, el: { label: el.label, sel: el.sel, y: el.y, h: el.h } } };
}

/** GET /api/feedback — every comment, newest first, each with its link. */
export async function listComments(kv: FeedbackKv, origin: string, given: string | null, key: string): Promise<Reply> {
  if (!(await keyMatches(given, key))) return { status: 401, body: { ok: false } };
  const items: Comment[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "fb:", cursor });
    const values = await Promise.all(page.keys.map((k) => kv.get(k.name)));
    for (const v of values) if (v) items.push(JSON.parse(v) as Comment);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  items.sort((x, y) => (x.at < y.at ? 1 : -1));
  return { status: 200, body: { ok: true, items: items.map((r) => ({ ...r, link: placeLink(origin, r) })) } };
}

/** PATCH /api/feedback/:id with `{ done: boolean }` (body as text; null = too long). */
export async function setDone(kv: FeedbackKv, id: string, given: string | null, key: string, raw: string | null): Promise<Reply> {
  if (!(await keyMatches(given, key))) return { status: 401, body: { ok: false } };
  const r = isCommentId(id) ? await recordById(kv, id) : null;
  if (!r) return { status: 404, body: { ok: false } };
  if (raw === null) return { status: 413, body: { ok: false } };
  const b = parseObject(raw);
  if (!b || typeof b.done !== "boolean") return { status: 400, body: { ok: false } };
  r.rec.done = b.done;
  await kv.put(r.key, JSON.stringify(r.rec));
  return { status: 200, body: { ok: true } };
}
