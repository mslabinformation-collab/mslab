import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { lessonFiles, lessons } from "@/db/schema";
import { storable } from "@/lib/storable";
import { logFailure } from "./log";
import { hasImageSignature, MAX_IMAGE_BYTES, UploadError, type FileStore, type ImageType } from "./media";

// A lesson's files (spec 3a section 4): PDF, Word (.docx) or an image, at most 4 MB like the images (Vercel takes request bodies up
// to 4.5 MB). Kept in the image store (R2; app/.media-local under `next dev` and the e2e run) under the private prefix
// lessons/<uuid>.<ext>: /media serves img/ keys only (media.ts isMediaKey), so a file is reached only through the account API,
// which checks the student's access and the lesson order and then sends a 5-minute signed R2 address (or, locally, the bytes).

export const LESSON_FILE_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type LessonFileType = keyof typeof LESSON_FILE_TYPES;

const BY_EXTENSION: Record<string, LessonFileType> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** How long a signed file address works: the student's click follows it at once. */
export const FILE_URL_TTL_SEC = 300;
const NAME_MAX = 120;

/**
 * The type of an uploaded file: the browser's, or the extension of the name when the browser sends none (a name without a dot
 * has no extension: "pdf" is a name). null: not one of ours.
 */
export function lessonFileType(file: { type: string; name: string }): LessonFileType | null {
  if (Object.hasOwn(LESSON_FILE_TYPES, file.type)) return file.type as LessonFileType;
  if (file.type && file.type !== "application/octet-stream") return null;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null; // not BY_EXTENSION[ext]: ".constructor" is a property of every object
}

const startsWith = (head: Uint8Array, sig: number[]) => head.length >= sig.length && sig.every((b, i) => head[i] === b);

/** Do the first bytes look like the type? PDF "%PDF-", .docx a ZIP ("PK\x03\x04"), images as media.ts checks them. */
export function hasFileSignature(type: LessonFileType, head: Uint8Array): boolean {
  if (type === "application/pdf") return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
  return hasImageSignature(type as ImageType, head);
}

/** The name the student sees: the file's own, without a folder, on one line, at most 120 characters (extension kept); "fail.<ext>" when nothing is left. */
export function cleanFileName(raw: string, ext: string): string {
  const base = raw
    .slice(Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\")) + 1)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let name = base;
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const tail = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    let head = name.slice(0, NAME_MAX - tail.length);
    // a cut between the two halves of a surrogate pair (an emoji) leaves a lone high surrogate, which is not storable
    const lastUnit = head.charCodeAt(head.length - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) head = head.slice(0, -1);
    name = head + tail;
  }
  return name && storable(name) ? name : `fail.${ext}`;
}

/** Content-Disposition of a download with the file's own name: an ASCII fallback and the UTF-8 name (RFC 6266). */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export type StoredLessonFile = { id: number; name: string; size: number; contentType: LessonFileType };

/**
 * Checks one file and stores it for the lesson, last in its list. Throws UploadError ("type" | "size" | "empty" | "content") for a
 * refused file; "notFound" when there is no such lesson (nothing stored). The store keeps the type and the download's
 * Content-Disposition with the object.
 */
export async function addLessonFile(db: Db, store: FileStore, lessonId: number, file: File): Promise<StoredLessonFile | "notFound"> {
  const type = lessonFileType(file);
  if (!type) throw new UploadError("type");
  if (file.size === 0) throw new UploadError("empty");
  if (file.size > MAX_IMAGE_BYTES) throw new UploadError("size");
  const [lesson] = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) return "notFound";
  const bytes = await file.arrayBuffer();
  if (!hasFileSignature(type, new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)))) throw new UploadError("content");
  const ext = LESSON_FILE_TYPES[type];
  const name = cleanFileName(file.name, ext);
  const key = `lessons/${crypto.randomUUID()}.${ext}`;
  await store.put(key, bytes, type, attachmentHeader(name));
  // The object is stored. When its row cannot be made, it must not stay in the private bucket with nothing pointing at it: it is
  // removed again, and whatever the removal does, the error that comes out is the database's.
  try {
    // (a removed file waiting for its UndoBar to run out does not count: its place is free)
    const [{ last }] = await db.select({ last: sql<number | null>`max(${lessonFiles.position})` }).from(lessonFiles).where(and(eq(lessonFiles.lessonId, lessonId), isNull(lessonFiles.removedAt)));
    const [row] = await db.insert(lessonFiles).values({ lessonId, position: (last ?? 0) + 1, name, r2Key: key, size: file.size, contentType: type }).returning();
    return { id: row.id, name: row.name, size: row.size, contentType: type };
  } catch (e) {
    try {
      await store.delete(key);
    } catch (cleanup) {
      logFailure("[lesson-files] a stored file could not be removed after its row failed", cleanup); // never the key
    }
    throw e;
  }
}
