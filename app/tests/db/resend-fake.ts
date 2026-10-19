import type { ResendLike } from "@/server/resend-marketing";

// An in-memory Resend for the newsletter sync's tests (server/resend-marketing.ts ResendLike): contacts with their `unsubscribed`, properties
// and segments, the account's segments and contact properties, and the suppression list. It records every call by name, and a test can make a
// method fail (`fail`), always or from a function that decides per call. The real API is never called. Webhook signatures are checked by the
// real SDK in the route's tests, so `webhooks.verify` is not faked.

export type FakeError = { name: string; statusCode: number | null; message: string };
export type FakeContact = { id: string; email: string; unsubscribed: boolean; properties: Record<string, string>; segments: Set<string> };
type Failure = FakeError | ((args: unknown) => FakeError | null);

export const NOT_FOUND: FakeError = { name: "not_found", statusCode: 404, message: "Contact not found" };
export const RATE_LIMITED: FakeError = { name: "rate_limit_exceeded", statusCode: 429, message: "Too many requests" };
export const DOWN: FakeError = { name: "internal_server_error", statusCode: 500, message: "Internal server error" };
/** What Resend answers when the plan's contacts are used up (the wording of its rate-limit page). */
export const CONTACTS_QUOTA: FakeError = { name: "validation_error", statusCode: 403, message: "You have reached your contacts quota. Please upgrade your plan to send more emails." };

export function fakeResend() {
  const contacts = new Map<string, FakeContact>();
  const segments: { id: string; name: string; created_at: string }[] = [];
  const properties: { id: string; key: string; type: "string" }[] = [];
  const suppressions: { id: string; email: string; origin: "bounce" | "complaint" | "manual"; source_id: string | null; created_at: string }[] = [];
  const calls: string[] = [];
  const fail = new Map<string, Failure>();
  /** Runs before each call (after it is recorded): a test advances its clock here. */
  let onCall: ((name: string) => void) | null = null;
  let seq = 0;

  const ok = <T>(data: T) => ({ data, error: null });
  const err = (error: FakeError) => ({ data: null, error });
  /** The address a path carries: the client encodes the characters a path cannot hold. */
  const pathEmail = (email: string) => decodeURIComponent(email).toLowerCase();
  const find = (o: { id?: string | null; email?: string | null }) =>
    o.id ? contacts.get(o.id) : [...contacts.values()].find((c) => c.email === pathEmail(o.email ?? ""));
  const view = (c: FakeContact) => ({ id: c.id, email: c.email, unsubscribed: c.unsubscribed, created_at: "2026-10-01T00:00:00.000Z", first_name: null, last_name: null });
  const page = <T extends { id: string }>(all: T[], o: { limit?: number; after?: string }) => {
    const limit = o.limit ?? 20;
    const start = o.after ? all.findIndex((x) => x.id === o.after) + 1 : 0;
    return ok({ object: "list" as const, data: all.slice(start, start + limit), has_more: start + limit < all.length });
  };
  /** Records the call; the failure the test set for it, if any. */
  const gate = (name: string, args: unknown): FakeError | null => {
    calls.push(name);
    onCall?.(name);
    const f = fail.get(name);
    return typeof f === "function" ? f(args) : (f ?? null);
  };

  const r: ResendLike = {
    contacts: {
      async list(o) {
        const f = gate("contacts.list", o);
        if (f) return err(f);
        const all = [...contacts.values()].filter((c) => !o.segmentId || c.segments.has(o.segmentId)).map(view);
        return page(all, o);
      },
      async get(o) {
        const f = gate("contacts.get", o);
        if (f) return err(f);
        const c = find(o);
        return c ? ok({ ...view(c), object: "contact" as const, properties: {} }) : err(NOT_FOUND);
      },
      async create(o) {
        const f = gate("contacts.create", o);
        if (f) return err(f);
        if (find({ email: o.email })) return err({ name: "validation_error", statusCode: 422, message: "Contact already exists" });
        const c: FakeContact = { id: `ct_${++seq}`, email: o.email.toLowerCase(), unsubscribed: o.unsubscribed, properties: { ...o.properties }, segments: new Set(o.segments.map((s) => s.id)) };
        contacts.set(c.id, c);
        return ok({ object: "contact" as const, id: c.id });
      },
      async update(o) {
        const f = gate("contacts.update", o);
        if (f) return err(f);
        const c = find(o);
        if (!c) return err(NOT_FOUND);
        c.unsubscribed = o.unsubscribed;
        Object.assign(c.properties, o.properties);
        return ok({ object: "contact" as const, id: c.id });
      },
      async remove(o) {
        const f = gate("contacts.remove", o);
        if (f) return err(f);
        const c = find(o);
        if (!c) return err(NOT_FOUND);
        contacts.delete(c.id);
        return ok({ object: "contact" as const, deleted: true, contact: c.id });
      },
      segments: {
        async list(o) {
          const f = gate("contacts.segments.list", o);
          if (f) return err(f);
          const c = contacts.get(o.contactId);
          if (!c) return err(NOT_FOUND);
          return page(segments.filter((s) => c.segments.has(s.id)), o);
        },
        async add(o) {
          const f = gate("contacts.segments.add", o);
          if (f) return err(f);
          const c = contacts.get(o.contactId);
          if (!c) return err(NOT_FOUND);
          c.segments.add(o.segmentId);
          return ok({ id: o.segmentId });
        },
        async remove(o) {
          const f = gate("contacts.segments.remove", o);
          if (f) return err(f);
          const c = contacts.get(o.contactId);
          if (!c || !c.segments.has(o.segmentId)) return err(NOT_FOUND);
          c.segments.delete(o.segmentId);
          return ok({ id: o.segmentId, audienceId: o.segmentId, deleted: true });
        },
      },
    },
    segments: {
      async list(o) {
        const f = gate("segments.list", o);
        return f ? err(f) : page(segments, o);
      },
      async create(o) {
        const f = gate("segments.create", o);
        if (f) return err(f);
        const s = { id: `seg_${++seq}`, name: o.name, created_at: "2026-10-01T00:00:00.000Z" };
        segments.push(s);
        return ok({ object: "segment" as const, id: s.id, name: s.name });
      },
    },
    contactProperties: {
      async list(o) {
        const f = gate("contactProperties.list", o);
        return f ? err(f) : page(properties, o);
      },
      async create(o) {
        const f = gate("contactProperties.create", o);
        if (f) return err(f);
        const p = { id: `prop_${++seq}`, key: o.key, type: o.type };
        properties.push(p);
        return ok({ object: "contact_property" as const, id: p.id });
      },
    },
    suppressions: {
      async list(o) {
        const f = gate("suppressions.list", o);
        return f ? err(f) : page(suppressions, o);
      },
    },
    usage: {
      async get() {
        const f = gate("usage.get", null);
        return f ? err(f) : ok({ contacts: { used: contacts.size, limit: 1000 } });
      },
    },
    webhooks: {
      verify() {
        throw new Error("the fake does not verify webhooks: the route's tests use the real SDK");
      },
    },
  };

  return {
    r,
    contacts,
    segments,
    properties,
    suppressions,
    calls,
    fail,
    set onCall(f: ((name: string) => void) | null) {
      onCall = f;
    },
    /** A contact that is already in Resend. */
    add(email: string, o: { unsubscribed?: boolean; properties?: Record<string, string>; segments?: string[] } = {}): FakeContact {
      const c: FakeContact = { id: `ct_${++seq}`, email: email.toLowerCase(), unsubscribed: o.unsubscribed ?? false, properties: { ...o.properties }, segments: new Set(o.segments) };
      contacts.set(c.id, c);
      return c;
    },
    /** The contact of an address, if Resend has one. */
    of(email: string): FakeContact | undefined {
      return [...contacts.values()].find((c) => c.email === email.toLowerCase());
    },
    /** The id of a segment by its name. */
    segment(name: string): string | undefined {
      return segments.find((s) => s.name === name)?.id;
    },
    /** The calls that change something in Resend, in order. */
    writes(): string[] {
      return calls.filter((c) => /\.(create|update|remove|add)$/.test(c));
    },
  };
}

export type FakeResend = ReturnType<typeof fakeResend>;
