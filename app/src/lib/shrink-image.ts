import { PHOTO_LIMITS } from "@/domain/completion";

// Making an image smaller in the browser before it is uploaded (moved here from components/admin/ImageUpload.tsx in the e-course
// completion phase, spec §4.3, D7): decoded upright, drawn on a canvas at most `maxEdge` px on its longest side, and encoded again. A
// canvas holds pixels only, so the new file has no EXIF data (camera, GPS position) or other metadata. The admin's images and the
// student's practical photos use it with their own settings; the server checks type, size and content again. Browser only (document,
// canvas); no lookbehind anywhere (tests/unit/old-safari.test.ts: this runs on old iPhones too).

export type ShrinkProblem = "type" | "size" | "decode";

/** Why an image could not be made ready: not a type it takes, too big (the original, or the result at the lowest setting), or unreadable here. */
export class ShrinkError extends Error {
  constructor(readonly problem: ShrinkProblem) {
    super(problem);
    this.name = "ShrinkError";
  }
}

/**
 * `maxEdge`: the longest side in px; `quality`: the encoder's, 0…1; `maxBytes`: the largest result; `accept`: the types taken ("image/*":
 * any image, and a file the picker gave no type); `output`: "jpeg" always, or "keep" (JPEG stays JPEG, PNG and WebP become WebP with their
 * transparency; a browser that cannot write WebP gives PNG).
 */
export type ShrinkOptions = { maxEdge: number; quality: number; maxBytes: number; accept: readonly string[]; output: "jpeg" | "keep" };

/** Larger originals are not even opened (a phone photo is 3–12 MB): the student's limit (PHOTO_LIMITS.sourceBytes, 60 MB), the admin's too. */
export const MAX_SOURCE_BYTES = PHOTO_LIMITS.sourceBytes;

/** What "keep" may write: the browser's own type when it is one of these, else PNG. */
const KEPT = ["image/jpeg", "image/png", "image/webp"];

/** Is `type` among `accept`? "image/*" takes any image, and a file without a type (some phones' pickers give none for a HEIC). */
const accepts = (type: string, accept: readonly string[]): boolean =>
  accept.some((a) => (a === "image/*" ? type === "" || type.startsWith("image/") : a === type));

/** A decoded image, upright: what the canvas draws from, its size, and what to free afterwards. */
type Decoded = { source: CanvasImageSource; width: number; height: number; close(): void };

/**
 * Through an <img>: Safari before 15 has no createImageBitmap (and some browsers have one without its options). The image is drawn
 * upright there too: Safari 13.1 and later apply the photo's orientation to an image and to what a canvas draws from it.
 */
function decodeWithImg(file: Blob): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = document.createElement("img");
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new ShrinkError("decode"));
    };
    img.onload = () =>
      img.naturalWidth > 0 && img.naturalHeight > 0
        ? resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) })
        : fail();
    img.onerror = fail;
    img.src = url;
  });
}

/** The image upright (the EXIF orientation applied): createImageBitmap where it reads the file with its options, else an <img>. */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // the options not understood, or the file not readable by it: the <img> decides (a HEIC in Chrome fails there too)
    }
  }
  return decodeWithImg(file);
}

/** width × height at most `maxEdge` px on its longest side, never larger than it was, at least 1 px each. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The image drawn at `size` and encoded as `type` at `quality`: the blob the browser gives (its own type when it cannot write `type`). */
async function encode(image: Decoded, size: { width: number; height: number }, type: string, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ShrinkError("decode");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.source, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // the canvas's memory back at once: iOS Safari has a small budget for all canvases together
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new ShrinkError("decode");
  return blob;
}

/** One image made smaller with `opts` (the admin's: components/admin/ImageUpload.tsx). The file has a neutral name ("pilt.jpg"). */
export async function shrinkImage(file: File, opts: ShrinkOptions): Promise<File> {
  if (!accepts(file.type, opts.accept)) throw new ShrinkError("type");
  if (file.size > MAX_SOURCE_BYTES) throw new ShrinkError("size");
  const image = await decode(file);
  try {
    const wanted = opts.output === "jpeg" || file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const blob = await encode(image, fitWithin(image.width, image.height, opts.maxEdge), wanted, opts.quality);
    if (opts.output === "jpeg" && blob.type !== "image/jpeg") throw new ShrinkError("decode");
    const type = KEPT.includes(blob.type) ? blob.type : "image/png";
    if (blob.size > opts.maxBytes) throw new ShrinkError("size");
    const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
    // a neutral name: the visitor's file name (often a date, a person's name) is not sent
    return new File([blob], `pilt.${ext}`, { type });
  } finally {
    image.close();
  }
}

/** The student's practical photo, ready to send (spec §4.3): the full JPEG with its size, and its thumbnail. */
export type PreparedPhoto = { full: Blob; thumb: Blob; width: number; height: number };

/** The full photo's settings, tried in order while the result is over 2 MB (spec §4.3: 0.85, then 0.7; R6: then 1600 px at 0.7). */
const FULL_STEPS = [
  { maxEdge: PHOTO_LIMITS.maxEdge, quality: 0.85 },
  { maxEdge: PHOTO_LIMITS.maxEdge, quality: 0.7 },
  { maxEdge: 1600, quality: 0.7 },
] as const;
const THUMB_QUALITY = 0.8;

/**
 * The student's photo (e-course completion, spec §4.3): decoded once, upright; a JPEG of at most 2048 px at 0.85 (then 0.7, then 1600 px
 * at 0.7 while it is over 2 MB) and a 480 px thumbnail at 0.8 (at most 200 KB). Any image the browser can open is taken (a HEIC in
 * Safari); one it cannot is ShrinkError "decode" ("Vali JPG või PNG pilt"); still too big at the last step, "size".
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!accepts(file.type, ["image/*"])) throw new ShrinkError("type");
  if (file.size > PHOTO_LIMITS.sourceBytes) throw new ShrinkError("size");
  const image = await decode(file);
  try {
    let full: { blob: Blob; width: number; height: number } | null = null;
    for (const step of FULL_STEPS) {
      const size = fitWithin(image.width, image.height, step.maxEdge);
      const blob = await encode(image, size, "image/jpeg", step.quality);
      if (blob.type !== "image/jpeg") throw new ShrinkError("decode");
      if (blob.size <= PHOTO_LIMITS.fullBytes) {
        full = { blob, ...size };
        break;
      }
    }
    if (!full) throw new ShrinkError("size");
    const thumb = await encode(image, fitWithin(image.width, image.height, PHOTO_LIMITS.thumbEdge), "image/jpeg", THUMB_QUALITY);
    if (thumb.size > PHOTO_LIMITS.thumbBytes) throw new ShrinkError("size");
    return { full: full.blob, thumb, width: full.width, height: full.height };
  } finally {
    image.close();
  }
}
