// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PHOTO_LIMITS } from "@/domain/completion";
import { fitWithin, MAX_SOURCE_BYTES, preparePhoto, ShrinkError, shrinkImage, type ShrinkOptions } from "@/lib/shrink-image";

// lib/shrink-image.ts (e-course completion, spec §4.3, D7, R6) in a browser-like document. The decoder (createImageBitmap, or an <img>
// where it is missing) and the canvas are stand-ins that record what is asked of them, so the size maths, the quality steps and the
// fallbacks are seen exactly. What the pixels carry (no EXIF, no GPS) is the end-to-end run's (Task 14, Review Focus 1).

const MB = 1024 * 1024;

/** One encode asked of a canvas: its size when toBlob was called, the type wanted and the quality. */
type Encode = { width: number; height: number; type: string; quality: number };
let encodes: Encode[];
/** The size in bytes of the blob an encode gives (each test sets it). */
let bytesOf: (e: Encode) => number;
/** The type the browser really writes for a wanted one (one without WebP writes PNG). */
let writes: (wanted: string) => string;
/** What the <img> stand-in decodes to: its size, or null for a file it cannot open. */
let imgDecodes: { width: number; height: number } | null;
let bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[];

const realCreate = document.createElement.bind(document);

/** A canvas that records each encode and answers it, a moment later, with a blob of bytesOf(…) bytes of the written type. */
function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ imageSmoothingQuality: "low", drawImage: () => {} }),
    toBlob(done: (blob: Blob | null) => void, type: string, quality: number) {
      const e = { width: canvas.width, height: canvas.height, type, quality };
      encodes.push(e);
      setTimeout(() => done(new Blob([new Uint8Array(bytesOf(e))], { type: writes(type) })), 0);
    },
  };
  return canvas;
}

/** An <img> that loads (as imgDecodes) or fails a moment after its address is set. */
function fakeImg() {
  const img = {
    naturalWidth: 0,
    naturalHeight: 0,
    onload: null as null | (() => void),
    onerror: null as null | (() => void),
    set src(_url: string) {
      setTimeout(() => {
        if (!imgDecodes) return img.onerror?.();
        img.naturalWidth = imgDecodes.width;
        img.naturalHeight = imgDecodes.height;
        img.onload?.();
      }, 0);
    },
  };
  return img;
}

/** createImageBitmap decoding every file as width × height (upright: the orientation applied, as `from-image` asks). */
function decodesAs(width: number, height: number) {
  // the signature is typed (so `decoder.mock.calls[0][1]` is the options), the stand-in itself takes nothing
  const decoder = vi.fn<(source: Blob, options?: ImageBitmapOptions) => Promise<{ width: number; height: number; close: ReturnType<typeof vi.fn> }>>(async () => {
    const bitmap = { width, height, close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  });
  vi.stubGlobal("createImageBitmap", decoder);
  return decoder;
}

/** A picked file of `type` that says it is `size` bytes (its real bytes do not matter to the stand-ins). */
function picked(name: string, type: string, size = 3 * MB): File {
  const file = new File([new Uint8Array(16)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  encodes = [];
  bitmaps = [];
  imgDecodes = null;
  // a full photo of about 900 KB, a thumbnail of about 60 KB
  bytesOf = (e) => (Math.max(e.width, e.height) <= PHOTO_LIMITS.thumbEdge ? 60 * 1024 : 900 * 1024);
  writes = (wanted) => wanted;
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) =>
    tag === "canvas" ? fakeCanvas() : tag === "img" ? fakeImg() : realCreate(tag, options)) as typeof document.createElement);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the student's photo (preparePhoto)", () => {
  test("a 6000 × 4000 photo: a JPEG of 2048 × 1365 at 0.85 and a 480 × 320 thumbnail at 0.8; decoded once, upright, and freed", async () => {
    const decoder = decodesAs(6000, 4000);
    const p = await preparePhoto(picked("IMG_0001.jpg", "image/jpeg"));
    expect(encodes).toEqual([
      { width: 2048, height: 1365, type: "image/jpeg", quality: 0.85 },
      { width: 480, height: 320, type: "image/jpeg", quality: 0.8 },
    ]);
    expect([p.width, p.height, p.full.type, p.thumb.type, p.full.size, p.thumb.size]).toEqual([2048, 1365, "image/jpeg", "image/jpeg", 900 * 1024, 60 * 1024]);
    expect(decoder).toHaveBeenCalledTimes(1);
    expect(decoder.mock.calls[0][1]).toEqual({ imageOrientation: "from-image" });
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
  });

  test("a portrait photo stays portrait (3000 × 4000 → 1536 × 2048, thumbnail 360 × 480); a small one is never made larger", async () => {
    decodesAs(3000, 4000);
    const portrait = await preparePhoto(picked("a.jpg", "image/jpeg"));
    expect([portrait.width, portrait.height]).toEqual([1536, 2048]);
    expect(encodes[1]).toMatchObject({ width: 360, height: 480 });
    encodes = [];
    decodesAs(1000, 800);
    const small = await preparePhoto(picked("b.jpg", "image/jpeg"));
    expect([small.width, small.height]).toEqual([1000, 800]);
    expect(encodes.map((e) => [e.width, e.height])).toEqual([[1000, 800], [480, 384]]);
  });

  test("R6: still over 2 MB at 0.85, it is encoded again at 0.7; still over, at 1600 px and 0.7", async () => {
    decodesAs(6000, 4000);
    bytesOf = (e) => (e.width <= 480 ? 60 * 1024 : e.quality === 0.85 ? Math.round(2.5 * MB) : Math.round(1.9 * MB));
    const second = await preparePhoto(picked("a.jpg", "image/jpeg"));
    expect(encodes.map((e) => [e.width, e.quality])).toEqual([[2048, 0.85], [2048, 0.7], [480, 0.8]]);
    expect([second.width, second.height, second.full.size]).toEqual([2048, 1365, Math.round(1.9 * MB)]);

    encodes = [];
    bytesOf = (e) => (e.width <= 480 ? 60 * 1024 : e.width === 2048 ? Math.round(2.2 * MB) : Math.round(1.2 * MB));
    const third = await preparePhoto(picked("b.jpg", "image/jpeg"));
    expect(encodes.map((e) => [e.width, e.quality])).toEqual([[2048, 0.85], [2048, 0.7], [1600, 0.7], [480, 0.8]]);
    expect([third.width, third.height]).toEqual([1600, 1067]);
  });

  test("over 2 MB at every step, or a thumbnail over 200 KB: ShrinkError 'size'", async () => {
    decodesAs(6000, 4000);
    bytesOf = (e) => (e.width <= 480 ? 60 * 1024 : 3 * MB);
    await expect(preparePhoto(picked("a.jpg", "image/jpeg"))).rejects.toMatchObject({ problem: "size" });
    expect(encodes.map((e) => e.width)).toEqual([2048, 2048, 1600]); // the thumbnail is not even made
    bytesOf = (e) => (e.width <= 480 ? 250 * 1024 : 900 * 1024);
    const refused = await preparePhoto(picked("b.jpg", "image/jpeg")).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ShrinkError);
    expect((refused as ShrinkError).problem).toBe("size");
  });

  test("Review Focus 1: a file the browser cannot open (HEIC in Chrome): createImageBitmap fails and so does the <img>: ShrinkError 'decode'", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new DOMException("The source image could not be decoded.", "InvalidStateError"))));
    imgDecodes = null;
    await expect(preparePhoto(picked("IMG_0001.HEIC", "image/heic"))).rejects.toMatchObject({ problem: "decode" });
    expect(encodes).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo");
  });

  test("Safari before 15 (no createImageBitmap): an <img> decodes the photo, and its local address is freed", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    imgDecodes = { width: 4032, height: 3024 };
    const p = await preparePhoto(picked("IMG_0002.JPG", "image/jpeg"));
    expect([p.width, p.height]).toEqual([2048, 1536]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo");
  });

  test("a createImageBitmap that does not take the options (it throws): the <img> takes over", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new TypeError("options are not supported"))));
    imgDecodes = { width: 1200, height: 900 };
    const p = await preparePhoto(picked("a.jpg", "image/jpeg"));
    expect([p.width, p.height]).toEqual([1200, 900]);
  });

  test("any image is taken, and a file the picker gave no type; not a PDF; an original over 60 MB is not even opened", async () => {
    const decoder = decodesAs(1000, 800);
    await expect(preparePhoto(picked("a.png", "image/png"))).resolves.toMatchObject({ width: 1000, height: 800 });
    await expect(preparePhoto(picked("pilt", ""))).resolves.toMatchObject({ width: 1000 });
    await expect(preparePhoto(picked("a.pdf", "application/pdf"))).rejects.toMatchObject({ problem: "type" });
    await expect(preparePhoto(picked("suur.jpg", "image/jpeg", PHOTO_LIMITS.sourceBytes + 1))).rejects.toMatchObject({ problem: "size" });
    expect(decoder).toHaveBeenCalledTimes(2);
    expect(MAX_SOURCE_BYTES).toBe(PHOTO_LIMITS.sourceBytes);
  });
});

describe("the admin's images (shrinkImage with ImageUpload's settings: its behaviour unchanged)", () => {
  const ADMIN: ShrinkOptions = { maxEdge: 2400, quality: 0.86, maxBytes: 4 * MB, accept: ["image/jpeg", "image/png", "image/webp"], output: "keep" };

  test("a JPEG stays JPEG, at most 2400 px at 0.86, with a neutral name", async () => {
    decodesAs(4800, 3200);
    const out = await shrinkImage(picked("Mari Maasikas 2026.jpg", "image/jpeg"), ADMIN);
    expect(encodes).toEqual([{ width: 2400, height: 1600, type: "image/jpeg", quality: 0.86 }]);
    expect([out.name, out.type]).toEqual(["pilt.jpg", "image/jpeg"]);
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
  });

  test("PNG and WebP become WebP; a browser that cannot write WebP gives PNG", async () => {
    decodesAs(800, 600);
    const webp = await shrinkImage(picked("a.png", "image/png"), ADMIN);
    expect([encodes[0].type, webp.name, webp.type]).toEqual(["image/webp", "pilt.webp", "image/webp"]);
    writes = () => "image/png";
    const png = await shrinkImage(picked("b.webp", "image/webp"), ADMIN);
    expect([png.name, png.type]).toEqual(["pilt.png", "image/png"]);
  });

  test("refused: a type it does not take, an original over 60 MB, a result over 4 MB, an image it cannot read", async () => {
    decodesAs(800, 600);
    await expect(shrinkImage(picked("a.gif", "image/gif"), ADMIN)).rejects.toMatchObject({ problem: "type" });
    await expect(shrinkImage(picked("a.jpg", "image/jpeg", MAX_SOURCE_BYTES + 1), ADMIN)).rejects.toMatchObject({ problem: "size" });
    bytesOf = () => 4 * MB + 1;
    await expect(shrinkImage(picked("a.jpg", "image/jpeg"), ADMIN)).rejects.toMatchObject({ problem: "size" });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("broken"))));
    await expect(shrinkImage(picked("b.jpg", "image/jpeg"), ADMIN)).rejects.toMatchObject({ problem: "decode" });
  });

  test("output 'jpeg' writes a JPEG whatever came in", async () => {
    decodesAs(800, 600);
    const out = await shrinkImage(picked("a.png", "image/png"), { ...ADMIN, output: "jpeg" });
    expect([encodes[0].type, out.name, out.type]).toEqual(["image/jpeg", "pilt.jpg", "image/jpeg"]);
  });
});

test("fitWithin: the longest side at most maxEdge, never larger than it was, at least 1 px", () => {
  expect(fitWithin(6000, 4000, 2048)).toEqual({ width: 2048, height: 1365 });
  expect(fitWithin(4000, 6000, 1600)).toEqual({ width: 1067, height: 1600 });
  expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  expect(fitWithin(10000, 1, 480)).toEqual({ width: 480, height: 1 });
});
