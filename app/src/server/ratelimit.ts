// Fixed-window counter in the KV store (server/kv.ts, Postgres): `limit` accepted submissions per key, the window
// restarting with each accepted one. The count is read and then written, so a burst of simultaneous requests can pass
// a little more than `limit`; that is fine for spam control of contact forms (storage stays the source of truth).

import { sha256 } from "./token";

/** The part of the KV store (text values) the forms use; server/kv.ts PgKv satisfies it. */
export type TextKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /**
   * Atomic slots (PgKv; the tests' in-memory KV mirrors them), for a limit that must hold against requests sent at once: `reserve` takes
   * one of `limit` slots under `key` in one step (false: none left, nothing changed), `release` gives one back. Optional: reserveSlot and
   * releaseSlot fall back to read-then-write for a store without them.
   */
  reserve?(key: string, limit: number, windowSec: number): Promise<boolean>;
  release?(key: string): Promise<void>;
  /** Removes `key` (PgKv has one). Optional: forgetKey falls back to a put that expires at once for a store without it. */
  delete?(key: string): Promise<void>;
};

/** Submissions a visitor may make per form within RATE_WINDOW_SEC. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_SEC = 10 * 60;

/** true = allowed (and counted), false = over the limit. */
export async function rateLimit(kv: TextKv, key: string, limit: number, windowSec: number): Promise<boolean> {
  const n = Number((await kv.get(key)) ?? "0");
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: windowSec });
  return true;
}

/** Is the count under `key` below `limit`? Counts nothing: the password lock checks before it tries, and counts failures only (phase 2c). */
export async function belowLimit(kv: TextKv, key: string, limit: number): Promise<boolean> {
  return Number((await kv.get(key)) ?? "0") < limit;
}

/** One more under `key`. Its window (`windowSec`) starts again with each one, so a lock ends `windowSec` after the last failure. */
export async function countFailure(kv: TextKv, key: string, windowSec: number): Promise<void> {
  const n = Number((await kv.get(key)) ?? "0");
  await kv.put(key, String(n + 1), { expirationTtl: windowSec });
}

/**
 * Takes one of `limit` slots under `key` (true), or finds none left (false, and nothing is counted). The window (`windowSec`) starts
 * again with each slot taken. With the store's own `reserve` (one SQL statement in PgKv) two requests at the same moment cannot take the
 * same slot; without it this is rateLimit's read-then-write, which a burst can pass (phase 2c: the password login's IP limit).
 */
export async function reserveSlot(kv: TextKv, key: string, limit: number, windowSec: number): Promise<boolean> {
  return kv.reserve ? kv.reserve(key, limit, windowSec) : rateLimit(kv, key, limit, windowSec);
}

/** Gives back a slot taken with reserveSlot (never below 0; PgKv keeps the window as the last slot set it). */
export async function releaseSlot(kv: TextKv, key: string, windowSec: number): Promise<void> {
  if (kv.release) return kv.release(key);
  const n = Number((await kv.get(key)) ?? "0");
  if (n > 0) await kv.put(key, String(n - 1), { expirationTtl: windowSec });
}

/**
 * Removes `key`. A store without a delete gets the key re-put with an empty value and a 1-second life, so the mark is gone within
 * the second, and meanwhile reads as no mark to anything that tests the value for being there (an empty string is falsy).
 */
export async function forgetKey(kv: TextKv, key: string): Promise<void> {
  if (kv.delete) return kv.delete(key);
  await kv.put(key, "", { expirationTtl: 1 });
}

/** KV key of one visitor and form: `rl:<form>:<ip>`. */
export const rateKey = (form: string, ip: string) => `rl:${form}:${ip}`;

/** KV key of one form and a value the table must not hold as it is (an e-mail address): `rl:<form>:<SHA-256 of the value>`. */
export const hashedKey = async (form: string, value: string) => rateKey(form, await sha256(value));

/**
 * `key` for the fixed window of `windowSec` seconds that `now` falls in: `<key>:<window number>`. rateLimit restarts a key's expiry with
 * every accepted request, so a steady sender (the lesson player's report every 15 s) never lets a 60 s window end; counting under
 * this key does, because the next window is another key (give the entry two windows to live: rateLimit(kv, windowKey(…), limit, 2 * windowSec)).
 */
export const windowKey = (key: string, now: Date, windowSec: number) => `${key}:${Math.floor(now.getTime() / (windowSec * 1000))}`;

/** The eight 16-bit groups of an IPv6 address (handles "::" and a trailing dotted IPv4); null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let a = address;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = `${a.slice(0, v4.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - rest.length;
  return gap < 1 ? null : [...head, ...new Array<number>(gap).fill(0), ...rest];
}

/**
 * The rate limit bucket of an address. A visitor with IPv6 controls a whole /64 (often far more), so every address in it
 * must share one bucket: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" becomes "2001:db8:1:2::/64" (written the same however the
 * address was spelled). An IPv4-mapped IPv6 address ("::ffff:203.0.113.7") is the IPv4 address. IPv4 and anything that
 * is not an IP address (the dev-only "local" bucket, the tests' made-up ids) stay as they are.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // [::1] brackets, zone id (fe80::1%eth0)
  if (!ip.includes(":")) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The visitor's rate limit bucket (see normalizeIp): the first address of `x-forwarded-for`. Vercel's edge sets that
 * header to the visitor's address itself, replacing whatever the client sent; `next dev` and `next start` keep the
 * client's own (the e2e tests send one per test). `cf-connecting-ip` is not read: with nothing of Cloudflare in front of
 * the app any more, any client could send it and get a fresh bucket each time. null when the header is missing: the
 * caller decides (dev: one "local" bucket; production: no rate limit for that request, rather than one bucket for everybody).
 */
export function clientIp(headers: Pick<Headers, "get">): string | null {
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip ? normalizeIp(ip).slice(0, 64) : null; // an IPv6 address has at most 45 characters; KV keys stay short
}
