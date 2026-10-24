import { serverEnv, type ServerEnv } from "./env";
import { sha256 } from "./token";

// Bunny Stream, the lesson videos' host (spec 3a section 2): one video library. Maria's browser uploads straight to it with tus;
// students watch in its iframe player through a signed embed URL. Configuration, the two signatures and a small client of its REST
// API; no database. bunny.net/docs (checked 05.10.2026):
// - API: https://video.bunnycdn.com/library/{libraryId}/videos[/{videoId}], header AccessKey (reference/video_createvideo,
//   video_getvideo, video_deletevideo);
// - tus: https://video.bunnycdn.com/tusupload; AuthorizationSignature = sha256(libraryId + apiKey + expires + videoId), checked on
//   every request (reference/tus-resumable-uploads);
// - embed: https://player.mediadelivery.net/embed/{libraryId}/{videoId}?token=sha256(tokenKey + videoId + expires)&expires=…
//   (stream/token-authentication; iframe.mediadelivery.net is the deprecated player); autoplay defaults to on, `t` starts at a
//   second (stream/player).

export type BunnyConfig = {
  libraryId: string;
  apiKey: string;
  tokenKey: string;
  /** The webhook URL's query secret; null: the webhook is taken without one (it only triggers a status read from the API). */
  webhookSecret: string | null;
  apiBase: string;
  tusEndpoint: string;
  embedBase: string;
};

export type BunnyEnv = Partial<Pick<ServerEnv, "BUNNY_LIBRARY_ID" | "BUNNY_API_KEY" | "BUNNY_TOKEN_KEY" | "BUNNY_WEBHOOK_SECRET" | "BUNNY_FAKE_URL">>;

const API = "https://video.bunnycdn.com";
const PLAYER = "https://player.mediadelivery.net/embed";

/**
 * The library, or null when the three settings are not all there (the admin's video field says "Video seadistamata", students see
 * "Video lisandub peagi"). BUNNY_FAKE_URL points the API, tus and the player at the e2e run's fake (tests/e2e/fake-bunny.ts); never
 * on Vercel (VERCEL is set there, build and runtime), whatever the project's variables say.
 */
export function bunnyConfig(env: BunnyEnv = serverEnv(), onVercel: boolean = Boolean(process.env.VERCEL)): BunnyConfig | null {
  if (!env.BUNNY_LIBRARY_ID || !env.BUNNY_API_KEY || !env.BUNNY_TOKEN_KEY) return null;
  const fake = !onVercel && env.BUNNY_FAKE_URL ? env.BUNNY_FAKE_URL.replace(/\/+$/, "") : null;
  return {
    libraryId: env.BUNNY_LIBRARY_ID,
    apiKey: env.BUNNY_API_KEY,
    tokenKey: env.BUNNY_TOKEN_KEY,
    webhookSecret: env.BUNNY_WEBHOOK_SECRET ?? null,
    apiBase: fake ?? API,
    tusEndpoint: `${fake ?? API}/tusupload`,
    embedBase: fake ? `${fake}/embed` : PLAYER,
  };
}

/** How long a signed embed URL plays (spec 5: about 4 hours). */
export const EMBED_TTL_SEC = 4 * 3600;
/** How long one tus upload may go on (Bunny checks the expiry on every request and advises an hour at least). */
export const UPLOAD_TTL_SEC = 6 * 3600;

/** From here a unix timestamp is in milliseconds (Date.now() is about 1.8e12), not seconds: seconds stay below it until the year 5138. */
const MS_THRESHOLD = 1e11;

/** `expires` is unix seconds: a whole, safe integer, below 1e11. A fraction (Date.now() / 1000) or milliseconds would sign a value Bunny never accepts. */
function checkExpires(expires: number): void {
  if (!Number.isSafeInteger(expires) || expires >= MS_THRESHOLD) throw new TypeError("expires must be a whole number of unix seconds");
}

export async function tusSignature(libraryId: string, apiKey: string, expires: number, videoId: string): Promise<string> {
  checkExpires(expires);
  return sha256(`${libraryId}${apiKey}${expires}${videoId}`);
}

export async function embedToken(tokenKey: string, videoId: string, expires: number): Promise<string> {
  checkExpires(expires);
  return sha256(`${tokenKey}${videoId}${expires}`);
}

/** The player's address for one video, signed until `expires` (unix seconds); autoplay off; a `startSec` of 1 or more (finite) starts there, whole seconds. */
export async function signedEmbedUrl(config: BunnyConfig, videoId: string, expires: number, startSec = 0): Promise<string> {
  const query = new URLSearchParams({ token: await embedToken(config.tokenKey, videoId, expires), expires: String(expires), autoplay: "false" });
  if (Number.isFinite(startSec) && startSec >= 1) query.set("t", String(Math.floor(startSec)));
  return `${config.embedBase}/${encodeURIComponent(config.libraryId)}/${encodeURIComponent(videoId)}?${query}`;
}

/**
 * What the app reads of Bunny's video object: its status, its length (s), the picture size in pixels as it is SHOWN (`width` ×
 * `height`; 0 when Bunny gives none: an older video, or one still being processed) and its encode progress. A missing size or
 * progress never fails the read.
 *
 * `encodeProgress`: Bunny's `encodeProgress` ("Encoding progress as a percentage from 0 to 100; reaches 100 when transcoding
 * finishes", integer; video_getvideo, checked 24.10.2026), as a whole number held to 0…100; null when the field is absent or no number.
 */
export type BunnyVideo = { status: number; length: number; width: number; height: number; encodeProgress: number | null };

export type BunnyApi = {
  /** A new, empty video titled `title`; its guid. */
  createVideo(title: string): Promise<string>;
  /** Its status, length (s), picture size and encode progress, or null when Bunny does not know it (404). */
  getVideo(videoId: string): Promise<BunnyVideo | null>;
  /** Deletes it; a video that is gone already (404) is fine. */
  deleteVideo(videoId: string): Promise<void>;
};

/** Bunny answered with a status the client does not take: the operation and the status only (never the URL, the key or the answer). */
export class BunnyError extends Error {
  constructor(
    readonly op: "create" | "get" | "delete",
    readonly status: number,
  ) {
    super(`Bunny ${op} answered ${status}`);
    this.name = "BunnyError";
  }
}

/** Bunny has 10 s to answer, headers and body together (the admin waits on create; the cron and the webhook on get and delete). */
const ANSWER_TIMEOUT_MS = 10_000;

const discard = (res: Response) => void res.body?.cancel().catch(() => {});

/** The REST client. `fetchImpl` is the platform's fetch (looked up at each call); tests pass a fake. Every call carries a signal (server/r2.ts explains why). */
export function bunnyApi(config: BunnyConfig, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): BunnyApi {
  const videos = `${config.apiBase}/library/${encodeURIComponent(config.libraryId)}/videos`;

  /**
   * One request, and `read` of its answer, within ANSWER_TIMEOUT_MS: the timer runs until `read` is done, so an answer whose body
   * stalls is cut off too. On time-out the signal is aborted (the platform's fetch drops the connection) and the call rejects
   * with a TimeoutError, whatever `fetchImpl` or `read` still do; the timer is cleared whichever way the call ends.
   * `redirect: "error"`: the API does not redirect, and a redirect must never carry the AccessKey on to another address.
   */
  async function call<T>(url: string, method: "GET" | "POST" | "DELETE", body: unknown, read: (res: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const reason = new DOMException("Bunny did not answer in time", "TimeoutError");
        controller.abort(reason);
        reject(reason);
      }, ANSWER_TIMEOUT_MS);
    });
    const answered = (async () =>
      read(
        await fetchImpl(url, {
          method,
          headers: { AccessKey: config.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        }),
      ))();
    try {
      // The race keeps listening to `answered` after the timer has won, so a late failure of the aborted call is handled, not an unhandled rejection.
      return await Promise.race([answered, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    createVideo: (title) =>
      call(videos, "POST", { title }, async (res) => {
        if (!res.ok) {
          discard(res);
          throw new BunnyError("create", res.status);
        }
        const json = (await res.json().catch(() => null)) as { guid?: unknown } | null;
        if (typeof json?.guid !== "string" || !json.guid) throw new BunnyError("create", res.status);
        return json.guid;
      }),
    getVideo: (videoId) =>
      call(`${videos}/${encodeURIComponent(videoId)}`, "GET", undefined, async (res) => {
        if (res.status === 404) {
          discard(res);
          return null;
        }
        if (!res.ok) {
          discard(res);
          throw new BunnyError("get", res.status);
        }
        const json = (await res.json().catch(() => null)) as { status?: unknown; length?: unknown; width?: unknown; height?: unknown; rotation?: unknown; encodeProgress?: unknown } | null;
        // An answer without a numeric status is not an answer: it must not pass for "still processing".
        if (typeof json?.status !== "number") throw new BunnyError("get", res.status);
        const size = shownSize(json.width, json.height, json.rotation);
        return { status: json.status, length: typeof json.length === "number" ? json.length : 0, ...size, encodeProgress: percentOrNull(json.encodeProgress) };
      }),
    deleteVideo: (videoId) =>
      call(`${videos}/${encodeURIComponent(videoId)}`, "DELETE", undefined, async (res) => {
        discard(res);
        if (!res.ok && res.status !== 404) throw new BunnyError("delete", res.status);
      }),
  };
}

/** A percent Bunny sent as a whole number from 0 to 100 (a fraction is rounded, a value outside is held to the range), or null (missing, not a number, not finite). */
function percentOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null;
}

/** A number Bunny sent, or 0 (missing, not a number, not finite). */
const numberOr0 = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The picture size a student sees. Bunny's `width` and `height` are those "of the original video file" (video_getvideo, checked
 * 06.10.2026), and `rotation` is the turn its container says to apply ("Rotation of the source file in degrees … e.g. 90, -90, 180,
 * 270; null when no rotation metadata is present"). A phone held upright often stores a 1920 × 1080 picture with a 90° turn: shown,
 * it is 1080 × 1920. So a quarter turn (90, -90, 270) swaps the sides; any other value, or none, leaves them. A side that is missing or
 * not a number is 0.
 */
function shownSize(width: unknown, height: unknown, rotation: unknown): { width: number; height: number } {
  const [w, h] = [numberOr0(width), numberOr0(height)];
  const quarterTurn = typeof rotation === "number" && Number.isFinite(rotation) && Math.abs(rotation) % 180 === 90;
  return quarterTurn ? { width: h, height: w } : { width: w, height: h };
}

export type BunnyVideoStatus = "uploading" | "processing" | "ready" | "failed";

/**
 * A lesson's video state from Bunny's video status (video_getvideo): 4 Finished → ready; 5 Error, 6 UploadFailed → failed;
 * 0 Created → still uploading; 1 Uploaded, 2 Processing, 3 Transcoding, 7–8 (JIT) and anything new → processing. Only 4 counts as
 * ready (3 may already play some resolutions; waiting for 4 is the safe side).
 */
export function lessonVideoStatus(bunnyStatus: number): BunnyVideoStatus {
  if (bunnyStatus === 4) return "ready";
  if (bunnyStatus === 5 || bunnyStatus === 6) return "failed";
  return bunnyStatus === 0 ? "uploading" : "processing";
}
