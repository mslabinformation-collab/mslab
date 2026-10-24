import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { E2E_BUNNY } from "./bunny-values";

// A stand-in for Bunny Stream in the e2e run: the app's server gets BUNNY_FAKE_URL = this address (tests/local-secrets.ts,
// server/bunny.ts). It speaks what the app uses, with the checks Bunny makes:
// - the API: POST/GET/DELETE /library/<id>/videos[/<guid>] with the AccessKey;
// - tus: POST /tusupload (AuthorizationSignature = sha256(library + key + expiry + video), not expired), HEAD and PATCH
//   /tusupload/<id>, with CORS for the admin page. A finished upload reads as status 3 (transcoding, `encodeProgress` 40) once, then 4 (ready, `encodeProgress` 100, 125 s,
//   1920 × 1080: the picture size `width` × `height` is in the answer only from status 4 on, 0 before, as Bunny's is not known
//   until the file is processed; `rotation` is null, as Bunny's is without rotation metadata);
// - the player: GET /embed/<library>/<video>?token&expires[&t] (token = sha256(token key + video + expiry), not expired), a page that
//   speaks Player.js: "ready" at once; "Mängi lõpuni" sends timeupdate up to the length in 2 s steps (to subscribed events only; the
//   page's seek lock takes back a jump of more than 3 s), then pause, ended; setCurrentTime moves the fake's time and is noted in
//   `window.__seeks`;
// - for the tests: GET /_fake/state (the videos and the deleted ids); POST /_fake/video {width, height, rotation?} (a video that is
//   finished already, e.g. an upright 1080 × 1920 one; answers its guid); POST /_fake/shape {videoId, width, height, rotation?} (the
//   picture size a video gets when it finishes, or at once when it has); and GET /health.
// Run: npx tsx tests/e2e/fake-bunny.ts (Playwright starts it: tests/e2e/server.ts). It listens on E2E_BUNNY.port: 3998, or
// E2E_BUNNY_PORT when 3998 is taken on this machine (bunny-values.ts; Playwright and the app's server then use the same one).
// It never redirects: the app's Bunny client refuses redirects (server/bunny.ts).

type Shape = { width: number; height: number; rotation: number | null };
type Video = { guid: string; status: number; length: number; encodeProgress: number } & Shape;
const videos = new Map<string, Video>();
/** What a video's size will be once it is finished (a test said so), else the usual 16:9. */
const planned = new Map<string, Shape>();
const LANDSCAPE: Shape = { width: 1920, height: 1080, rotation: null };
const deleted: string[] = [];
const uploads = new Map<string, { videoId: string; length: number; offset: number }>();
const LENGTH = 125;
/** The `encodeProgress` of a video that is transcoding (status 3): Bunny gives 0…100, 100 once it is finished (video_getvideo). */
const ENCODING_PROGRESS = 40;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// X-Forwarded-For: the e2e browser context adds it to every request (tests/e2e/test.ts, visitorIp), the tus requests too.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, HEAD, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, Content-Type, AuthorizationSignature, AuthorizationExpire, VideoId, LibraryId, X-Requested-With, X-HTTP-Method-Override, X-Forwarded-For",
  "access-control-expose-headers": "Location, Upload-Offset, Upload-Length, Tus-Resumable",
};

function send(res: ServerResponse, status: number, body: unknown = "", headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, "cache-control": "no-store", ...(typeof body === "string" ? {} : { "content-type": "application/json" }), ...headers });
  res.end(text);
}
const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

/** Bunny's tus check: the signature of library + key + expiry + video, and an expiry in the future. */
function tusAllowed(req: IncomingMessage, videoId: string): boolean {
  const expire = Number(req.headers["authorizationexpire"]);
  return (
    req.headers["libraryid"] === E2E_BUNNY.libraryId &&
    req.headers["videoid"] === videoId &&
    expire > Date.now() / 1000 &&
    req.headers["authorizationsignature"] === sha(`${E2E_BUNNY.libraryId}${E2E_BUNNY.apiKey}${expire}${videoId}`)
  );
}

/** A test's request body as an object ({} when it is no JSON object). */
function readJson(body: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body.toString());
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `width`, `height` (whole numbers) and `rotation` (a whole number, or null when left out) of a test's request, else null. */
function readShape({ width, height, rotation = null }: Record<string, unknown>): Shape | null {
  return Number.isInteger(width) && Number.isInteger(height) && (rotation === null || Number.isInteger(rotation))
    ? { width: width as number, height: height as number, rotation: rotation as number | null }
    : null;
}

function player(start: number): string {
  return `<!doctype html><html lang="et"><meta charset="utf-8"><title>Fake player</title>
<body style="margin:0;background:#111;color:#fff;font:16px sans-serif">
<button type="button" data-fake-play style="min-height:44px;margin:12px">Mängi lõpuni</button>
<p data-fake-time>${start}</p>
<script>
const duration = ${LENGTH}; let current = ${start}; const listeners = {}; const seeks = []; window.__seeks = seeks;
const post = (m) => parent.postMessage(JSON.stringify({ context: "player.js", version: "0.0.11", ...m }), "*");
addEventListener("message", (e) => {
  let m; try { m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
  if (!m || m.context !== "player.js") return;
  if (m.method === "addEventListener") listeners[m.value] = m.listener ?? m.value;
  if (m.method === "setCurrentTime") { current = Number(m.value); seeks.push(current); document.querySelector("[data-fake-time]").textContent = String(current); }
});
const emit = (event, value) => { if (event in listeners) post({ event, value, listener: listeners[event] }); };
document.querySelector("[data-fake-play]").onclick = async () => {
  emit("play");
  while (current < duration) {
    current = Math.min(duration, current + 2);
    emit("timeupdate", { seconds: current, duration });
    document.querySelector("[data-fake-time]").textContent = String(current);
    await new Promise((r) => setTimeout(r, 20));
  }
  emit("pause");
  emit("ended");
};
post({ event: "ready", value: { src: location.href, events: ["ready", "play", "pause", "ended", "timeupdate"], methods: ["play", "pause", "setCurrentTime", "getCurrentTime", "addEventListener"] } });
</script></body></html>`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", E2E_BUNNY.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204);
  if (path === "/health") return send(res, 200, "ok");
  if (path === "/_fake/state") return send(res, 200, { videos: [...videos.values()], deleted });
  if (path === "/_fake/video" && req.method === "POST") {
    const shape = readShape(readJson(await read(req)));
    if (!shape) return send(res, 400, "width and height");
    const guid = randomUUID();
    videos.set(guid, { guid, status: 4, length: LENGTH, encodeProgress: 100, ...shape });
    return send(res, 200, { guid });
  }
  if (path === "/_fake/shape" && req.method === "POST") {
    const body = readJson(await read(req));
    const shape = readShape(body);
    const video = videos.get(String(body.videoId));
    if (!shape || !video) return send(res, 400, "videoId, width and height");
    planned.set(video.guid, shape);
    if (video.status === 4) Object.assign(video, shape);
    return send(res, 200, { ok: true });
  }

  const api = /^\/library\/([^/]+)\/videos(?:\/([^/]+))?$/.exec(path);
  if (api) {
    if (api[1] !== E2E_BUNNY.libraryId) return send(res, 404, { message: "library" });
    if (req.headers["accesskey"] !== E2E_BUNNY.apiKey) return send(res, 401, { message: "key" });
    if (req.method === "POST" && !api[2]) {
      const guid = randomUUID();
      videos.set(guid, { guid, status: 0, length: 0, encodeProgress: 0, width: 0, height: 0, rotation: null });
      return send(res, 200, { guid, videoLibraryId: Number(E2E_BUNNY.libraryId), status: 0, length: 0, encodeProgress: 0, width: 0, height: 0 });
    }
    const video = api[2] ? videos.get(api[2]) : undefined;
    if (!video) return send(res, 404, { message: "video" });
    if (req.method === "DELETE") {
      videos.delete(video.guid);
      deleted.push(video.guid);
      return send(res, 200, { success: true });
    }
    if (req.method === "GET") {
      if (video.status === 1) Object.assign(video, { status: 3, encodeProgress: ENCODING_PROGRESS }); // uploaded → transcoding (one read, at 40 %)
      else if (video.status === 3) Object.assign(video, { status: 4, length: LENGTH, encodeProgress: 100 }, planned.get(video.guid) ?? LANDSCAPE); // → finished, with its size
      return send(res, 200, { guid: video.guid, status: video.status, length: video.length, encodeProgress: video.encodeProgress, width: video.width, height: video.height, rotation: video.rotation });
    }
  }

  if (path === "/tusupload" && req.method === "POST") {
    const videoId = String(req.headers["videoid"] ?? "");
    if (!videos.has(videoId) || !tusAllowed(req, videoId)) return send(res, 401, "unauthorized");
    const id = randomUUID();
    uploads.set(id, { videoId, length: Number(req.headers["upload-length"]), offset: 0 });
    return send(res, 201, "", { location: `${E2E_BUNNY.url}/tusupload/${id}`, "tus-resumable": "1.0.0" });
  }
  const tus = /^\/tusupload\/([^/]+)$/.exec(path);
  const upload = tus ? uploads.get(tus[1]) : undefined;
  if (tus && !upload) return send(res, 404, "upload");
  if (upload && !tusAllowed(req, upload.videoId)) return send(res, 401, "unauthorized");
  if (upload && req.method === "HEAD") return send(res, 200, "", { "upload-offset": String(upload.offset), "upload-length": String(upload.length), "tus-resumable": "1.0.0" });
  if (upload && req.method === "PATCH") {
    upload.offset += (await read(req)).length;
    if (upload.offset >= upload.length) videos.get(upload.videoId)!.status = 1;
    return send(res, 204, "", { "upload-offset": String(upload.offset), "tus-resumable": "1.0.0" });
  }

  const embed = /^\/embed\/([^/]+)\/([^/]+)$/.exec(path);
  if (embed && req.method === "GET") {
    const [, library, videoId] = embed;
    const expires = Number(url.searchParams.get("expires"));
    const fine = library === E2E_BUNNY.libraryId && expires > Date.now() / 1000 && url.searchParams.get("token") === sha(`${E2E_BUNNY.tokenKey}${videoId}${expires}`);
    if (!fine) return send(res, 403, "token");
    return send(res, 200, player(Number(url.searchParams.get("t") ?? 0)), { "content-type": "text/html; charset=utf-8" });
  }
  return send(res, 404, "not found");
}

/** Starts the fake on `port` (the e2e run's web server). */
export function startFakeBunny(port: number = E2E_BUNNY.port) {
  return createServer((req, res) => void handle(req, res).catch(() => send(res, 500, "error"))).listen(port);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/e2e/fake-bunny.ts")) startFakeBunny();
