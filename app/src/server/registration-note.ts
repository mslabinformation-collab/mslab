import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { registrations } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { NOTE_MAX } from "@/domain/registration";
import { contentVersion } from "@/lib/version";

// The registration drawer's „Märkus“ (admin UX pass, piece 2, Task 5; README A2 drawer 3, §1.3): the first form part saved by the editors'
// autosave (components/admin/autosave), through POST /api/admin/registreering/<id>/markus (server/autosave-route.ts autosaveHandler). The note is a
// part of its own, apart from the status (the pills save that at once, server/admin.ts saveStatus): `registrations` has no updated_at, so the
// part's version is the hash of the stored note (lib/version.ts contentVersion), and a status change or a payment does not make a note save stale.
// Without Next.js: tests/db/registration-note-route.test.ts runs the route on a real (PGlite) database. Logs never carry the note's text.

/** The note's part as the drawer holds it. */
export type NotePart = { note: string };

/** The version of a stored note: what the drawer is drawn with and what a save must come from. */
export const noteVersion = (note: string): Promise<string> => contentVersion({ note } satisfies NotePart);

/**
 * A save's patch: the note, at most NOTE_MAX characters (`tooLong`) and without a NUL character (`text`: a Postgres text column cannot hold
 * one). Stored as typed, spaces too: the browser keeps the same text until the server confirms it. No other field.
 */
export const notePatch = z
  .object({
    note: z
      .string()
      .max(NOTE_MAX, "tooLong")
      .refine((v) => !v.includes("\u0000"), "text"),
  })
  .partial()
  .strict();

/** The stored note of a registration and its version, or null for an id that is no registration (the route's 404). */
export async function readNote(db: Db, id: number): Promise<{ version: string; value: NotePart } | null> {
  const [row] = await db.select({ note: registrations.note }).from(registrations).where(eq(registrations.id, id)).limit(1);
  return row ? { version: await noteVersion(row.note), value: { note: row.note } } : null;
}

/**
 * Stores `patch` over the note a save was typed on (`version`). Another version is a conflict, answered with the stored note (the drawer shows it
 * and „Taasta minu tekst“ saves over it); the write itself is a compare-and-set on the note read (a save from another tab between the read and
 * the write is a conflict too, never overwritten). A patch with no note changes nothing and answers the current version.
 */
export async function writeNote(db: Db, id: number, patch: z.infer<typeof notePatch>, version: string, now: Date): Promise<SaveAnswer> {
  const conflict = async (): Promise<SaveAnswer> => {
    const stored = await readNote(db, id);
    return { ok: false, error: "conflict", version: stored?.version ?? "", value: stored?.value ?? null };
  };
  const current = await readNote(db, id);
  if (!current || current.version !== version) return conflict();
  if (patch.note === undefined) return { ok: true, version: current.version, savedAt: now.toISOString() };
  const [row] = await db
    .update(registrations)
    .set({ note: patch.note })
    .where(and(eq(registrations.id, id), eq(registrations.note, current.value.note)))
    .returning();
  if (!row) return conflict();
  return { ok: true, version: await noteVersion(row.note), savedAt: now.toISOString() };
}
