import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, Tx } from "@/db/client";
import { contentDrafts, settings } from "@/db/schema";
import { contentVersion } from "@/lib/version";
import { discardDrafts, publishDrafts, readDrafts, saveDraftPart, type Publisher } from "@/server/drafts";
import { makeTestDb } from "./helpers";

// The draft layer's store (admin UX pass, README §1.8, behaviours.md B2; server/drafts.ts): an unpublished change of a published thing is kept per
// entity, row and part in `content_drafts`, versioned, and leaves the live row alone until „Avalda muudatused“ copies it live in one transaction.
// The live side here is a stand-in publisher over `settings` rows (key "<entity>:<id>:<part>"), so that a publish really writes, under the same
// transaction, what a rollback must take back. Its version is lib/version.ts contentVersion of the stored value, as the site editors' is.

const MARIA = "maria@example.test";
const DIM = "dim@example.test";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
});

const liveKey = (entity: string, id: number, part: string) => `${entity}:${id}:${part}`;
async function setLive(entity: string, id: number, part: string, value: unknown): Promise<string> {
  await db.insert(settings).values({ key: liveKey(entity, id, part), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return contentVersion(value);
}
async function live(entity: string, id: number, part: string): Promise<unknown> {
  const [row] = await db.select().from(settings).where(eq(settings.key, liveKey(entity, id, part)));
  return row?.value;
}

/** The stand-in publisher of `entity` row `id`: reads and writes `settings` in the publish's transaction and logs what it was asked, in order. */
function settingsPublisher(entity: string, id: number, o: { failOn?: string } = {}) {
  const log: string[] = [];
  const read = async (tx: Tx, part: string) => (await tx.select().from(settings).where(eq(settings.key, liveKey(entity, id, part))).for("update"))[0]?.value;
  const publisher: Publisher = {
    async liveVersion(tx, part) {
      log.push(`live:${part}`);
      return contentVersion(await read(tx, part));
    },
    async write(tx, part, value) {
      log.push(`write:${part}`);
      await tx.update(settings).set({ value }).where(eq(settings.key, liveKey(entity, id, part)));
      if (part === o.failOn) throw new Error("the writer failed");
    },
    revalidate() {
      log.push("revalidate");
    },
  };
  return { publisher, log };
}

describe("saveDraftPart and readDrafts", () => {
  it("saveDraftPart creates version 1, then bumps; a stale version answers conflict with the stored value", async () => {
    const base = await setLive("course", 7, "summary", { summary: { et: "Vana" } });
    const first = { summary: { et: "Uus" } };
    expect(await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: first, baseVersion: base, version: null, by: MARIA })).toEqual({ ok: true, version: 1 });
    const [created] = await readDrafts(db, "course", 7);
    expect(created).toMatchObject({ part: "summary", value: first, baseVersion: base, version: 1 });
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(created).sort()).toEqual(["baseVersion", "part", "updatedAt", "value", "version"]);

    // a second create of the same part (another tab that also saw no draft): a conflict with what is stored, nothing changed
    expect(await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { summary: { et: "Teine" } }, baseVersion: base, version: null, by: DIM })).toEqual({
      ok: false, error: "conflict", version: 1, value: first,
    });

    // a save from the stored version bumps it; the base stays the live version the draft was made from (a later save edits the draft, not live)
    const second = { summary: { et: "Uuem" } };
    expect(await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: second, baseVersion: "f".repeat(32), version: 1, by: DIM })).toEqual({ ok: true, version: 2 });
    const [bumped] = await readDrafts(db, "course", 7);
    expect(bumped).toMatchObject({ part: "summary", value: second, baseVersion: base, version: 2 });
    expect(bumped.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect((await db.select({ by: contentDrafts.updatedBy }).from(contentDrafts))[0].by).toBe(DIM);

    // a stale version (or one from nowhere) is refused with the stored version and value, and changes nothing
    for (const stale of [1, 3, 0]) {
      expect(await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { summary: { et: "Hiline" } }, baseVersion: base, version: stale, by: MARIA }), String(stale)).toEqual({
        ok: false, error: "conflict", version: 2, value: second,
      });
    }
    expect((await readDrafts(db, "course", 7)).map((d) => [d.version, d.value])).toEqual([[2, second]]);

    // the live row was never touched
    expect(await live("course", 7, "summary")).toEqual({ summary: { et: "Vana" } });
  });

  it("a save to a draft that is gone (published or discarded meanwhile) is a conflict with version 0 and no value: there is no draft to save over", async () => {
    const base = await setLive("course", 7, "summary", { summary: { et: "Vana" } });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { a: 1 }, baseVersion: base, version: null, by: MARIA });
    expect(await discardDrafts(db, "course", 7)).toBe(1);
    expect(await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { a: 2 }, baseVersion: base, version: 1, by: MARIA })).toEqual({
      ok: false, error: "conflict", version: 0, value: null,
    });
    expect(await readDrafts(db, "course", 7)).toEqual([]);
    // a create starts it again, at version 1
    expect(await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { a: 2 }, baseVersion: base, version: null, by: MARIA })).toEqual({ ok: true, version: 1 });
  });

  it("each entity, row and part has its own draft and version; readDrafts lists one row's parts in the order they were first saved, also inside a transaction", async () => {
    const save = (entity: string, entityId: number, part: string, value: unknown) => saveDraftPart(db, { entity, entityId, part, value, baseVersion: "b", version: null, by: MARIA });
    expect(await save("course", 7, "price", { priceCents: 29000 })).toEqual({ ok: true, version: 1 });
    expect(await save("course", 7, "summary", ["x"])).toEqual({ ok: true, version: 1 });
    expect(await save("course", 8, "summary", "teine kursus")).toEqual({ ok: true, version: 1 });
    expect(await save("home", 7, "summary", 42)).toEqual({ ok: true, version: 1 });
    expect((await readDrafts(db, "course", 7)).map((d) => [d.part, d.value])).toEqual([["price", { priceCents: 29000 }], ["summary", ["x"]]]);
    expect((await readDrafts(db, "course", 8)).map((d) => d.value)).toEqual(["teine kursus"]);
    expect((await readDrafts(db, "home", 7)).map((d) => d.value)).toEqual([42]);
    expect(await readDrafts(db, "course", 9)).toEqual([]);
    expect(await db.transaction(async (tx) => (await readDrafts(tx, "course", 7)).map((d) => d.part))).toEqual(["price", "summary"]);
  });
});

describe("publishDrafts", () => {
  it("publishDrafts copies parts whose base_version still matches live, deletes them, lists the rest as blocked", async () => {
    const summaryBase = await setLive("course", 7, "summary", { et: "Vana kirjeldus" });
    const priceBase = await setLive("course", 7, "price", { cents: 25000 });
    const moduleBase = await setLive("course", 7, "module-3", { title: "Moodul 03" });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { et: "Uus kirjeldus" }, baseVersion: summaryBase, version: null, by: MARIA });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "module-3", value: { title: "Moodul 03 (uus)" }, baseVersion: moduleBase, version: null, by: MARIA });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "price", value: { cents: 29000 }, baseVersion: priceBase, version: null, by: MARIA });
    // live price changed since the draft was made (another way of saving it): its draft is blocked, not written over the newer live value
    await setLive("course", 7, "price", { cents: 27000 });
    // another course's draft is not this publish's business
    await saveDraftPart(db, { entity: "course", entityId: 8, part: "summary", value: { et: "Teine" }, baseVersion: summaryBase, version: null, by: MARIA });

    const { publisher, log } = settingsPublisher("course", 7);
    expect(await publishDrafts(db, "course", 7, publisher)).toEqual({ published: ["summary", "module-3"], blocked: ["price"] });

    // live has the published parts, the blocked one keeps its newer live value
    expect(await live("course", 7, "summary")).toEqual({ et: "Uus kirjeldus" });
    expect(await live("course", 7, "module-3")).toEqual({ title: "Moodul 03 (uus)" });
    expect(await live("course", 7, "price")).toEqual({ cents: 27000 });
    // the published drafts are gone; the blocked one stays as it was, and so does the other course's
    expect((await readDrafts(db, "course", 7)).map((d) => [d.part, d.value, d.version, d.baseVersion])).toEqual([["price", { cents: 29000 }, 1, priceBase]]);
    expect((await readDrafts(db, "course", 8)).map((d) => d.part)).toEqual(["summary"]);
    // every part's live version is compared before the first write; the public pages are revalidated once, after the writes
    expect(log).toEqual(["live:summary", "live:module-3", "live:price", "write:summary", "write:module-3", "revalidate"]);
  });

  it("nothing to publish (no drafts, or every one blocked): nothing is written and nothing revalidated", async () => {
    const empty = settingsPublisher("course", 7);
    expect(await publishDrafts(db, "course", 7, empty.publisher)).toEqual({ published: [], blocked: [] });
    expect(empty.log).toEqual([]);

    const base = await setLive("course", 7, "summary", { et: "Vana" });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { et: "Uus" }, baseVersion: base, version: null, by: MARIA });
    await setLive("course", 7, "summary", { et: "Vahepeal muudetud" });
    const blocked = settingsPublisher("course", 7);
    expect(await publishDrafts(db, "course", 7, blocked.publisher)).toEqual({ published: [], blocked: ["summary"] });
    expect(blocked.log).toEqual(["live:summary"]);
    expect(await live("course", 7, "summary")).toEqual({ et: "Vahepeal muudetud" });
    expect((await readDrafts(db, "course", 7)).map((d) => d.value)).toEqual([{ et: "Uus" }]);
  });

  it("publishDrafts runs in one transaction: a write that throws leaves every draft in place", async () => {
    const summaryBase = await setLive("course", 7, "summary", { et: "Vana" });
    const priceBase = await setLive("course", 7, "price", { cents: 25000 });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { et: "Uus" }, baseVersion: summaryBase, version: null, by: MARIA });
    await saveDraftPart(db, { entity: "course", entityId: 7, part: "price", value: { cents: 29000 }, baseVersion: priceBase, version: null, by: MARIA });
    const before = await readDrafts(db, "course", 7);

    const { publisher, log } = settingsPublisher("course", 7, { failOn: "price" });
    await expect(publishDrafts(db, "course", 7, publisher)).rejects.toThrow("the writer failed");

    // the first part's write was taken back with the rest: live is as it was, every draft is still there, unchanged, and nothing was revalidated
    expect(log).toEqual(["live:summary", "live:price", "write:summary", "write:price"]);
    expect(await live("course", 7, "summary")).toEqual({ et: "Vana" });
    expect(await live("course", 7, "price")).toEqual({ cents: 25000 });
    expect(await readDrafts(db, "course", 7)).toEqual(before);

    // and a publish that goes through afterwards publishes both
    expect(await publishDrafts(db, "course", 7, settingsPublisher("course", 7).publisher)).toEqual({ published: ["summary", "price"], blocked: [] });
  });

  it("a revalidation that throws does not undo or fail the publish: it is logged without the error's text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const base = await setLive("course", 7, "summary", { et: "Vana" });
      await saveDraftPart(db, { entity: "course", entityId: 7, part: "summary", value: { et: "Uus" }, baseVersion: base, version: null, by: MARIA });
      const { publisher } = settingsPublisher("course", 7);
      publisher.revalidate = () => {
        throw new Error("secret text");
      };
      expect(await publishDrafts(db, "course", 7, publisher)).toEqual({ published: ["summary"], blocked: [] });
      expect(await live("course", 7, "summary")).toEqual({ et: "Uus" });
      expect(await readDrafts(db, "course", 7)).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls.flat().join(" ")).toContain("[drafts]");
      expect(error.mock.calls.flat().join(" ")).not.toContain("secret text");
    } finally {
      error.mockRestore();
    }
  });
});

describe("discardDrafts", () => {
  it("discardDrafts deletes only that entity's drafts", async () => {
    const save = (entity: string, entityId: number, part: string) => saveDraftPart(db, { entity, entityId, part, value: { part }, baseVersion: "b", version: null, by: MARIA });
    await save("course", 7, "summary");
    await save("course", 7, "price");
    await save("course", 8, "summary");
    await save("home", 7, "summary");
    const base = await setLive("course", 7, "summary", { et: "Vana" });

    expect(await discardDrafts(db, "course", 7)).toBe(2);
    expect(await readDrafts(db, "course", 7)).toEqual([]);
    expect((await readDrafts(db, "course", 8)).map((d) => d.part)).toEqual(["summary"]);
    expect((await readDrafts(db, "home", 7)).map((d) => d.part)).toEqual(["summary"]);
    // live stays as it is („Avalikul lehel jääb praegune versioon.“), and a second discard has nothing left to delete
    expect(await contentVersion(await live("course", 7, "summary"))).toBe(base);
    expect(await discardDrafts(db, "course", 7)).toBe(0);
  });
});
