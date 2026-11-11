import { withAdmin } from "@/server/auth";
import { logFailure, logNote } from "@/server/log";
import { isUploadKind } from "@/lib/media";
import { putImage, UPLOAD_RULES, UploadError, type UploadReason } from "@/server/media";
import { mediaStore } from "@/server/media-store";

export const dynamic = "force-dynamic";
// R2 is given 10 s to answer (server/r2.ts); whatever else holds a request up ends after 30 s, not after the default 300 s
export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const STATUS: Record<UploadReason, number> = { type: 415, size: 413, empty: 400, content: 415 };
/** Room for the multipart boundaries and headers around the file. */
const ENVELOPE = 64 * 1024;

/**
 * POST /api/admin/upload — one image as multipart field `file` (signed-in admins only; a cross-site POST is 403); `?for=certificate-background`:
 * a certificate design's background photo, a JPEG of at most 1.5 MB (server/media.ts UPLOAD_RULES; without it, any picture up to 4 MB).
 * 201 `{ ok: true, key }` with the image's key (img/<uuid>.<ext>); 400/413/415 `{ ok: false, error }` with error
 * missing | type | size | empty | content, or kind (a `for` it does not know); 503 `{ ok: false, error: "storage" }` when there is no image store
 * (production without the R2 variables); 500 `{ ok: false, error: "server" }` when the store fails.
 */
export const POST = withAdmin(async (request) => {
  const kind = new URL(request.url).searchParams.get("for") ?? "image";
  if (!isUploadKind(kind)) return json({ ok: false, error: "kind" }, 400);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > UPLOAD_RULES[kind].maxBytes + ENVELOPE) return json({ ok: false, error: "size" }, 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return json({ ok: false, error: "missing" }, 400);
  try {
    const store = mediaStore();
    if (!store) {
      logNote("[admin] image upload refused: no image store (production needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET)");
      return json({ ok: false, error: "storage" }, 503);
    }
    const { key } = await putImage(store, file, kind);
    return json({ ok: true, key }, 201);
  } catch (e) {
    if (e instanceof UploadError) return json({ ok: false, error: e.reason }, STATUS[e.reason]);
    logFailure("[admin] image upload failed", e);
    return json({ ok: false, error: "server" }, 500);
  }
});
