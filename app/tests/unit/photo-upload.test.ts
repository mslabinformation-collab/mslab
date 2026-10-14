import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UPLOAD_TIMEOUT_MS, uploadPhoto } from "@/components/account/photo-upload";

// One practical photo's upload (components/account/photo-upload.ts, spec §4.3): XMLHttpRequest, for the share of the body sent so far.
// A stand-in XMLHttpRequest records the request and lets each test answer it: the form and the session cookie go to the path, the
// progress is reported as a share, the JSON answer comes back, and nothing ever throws (status 0: no answer, a timeout, an abort).

type ProgressEvent = { lengthComputable: boolean; loaded: number; total: number };

class FakeXhr {
  static made: FakeXhr[] = [];
  static refuseSend = false;
  method = "";
  url = "";
  withCredentials = false;
  timeout = 0;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  body: unknown = undefined;
  aborted = false;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.made.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    if (FakeXhr.refuseSend) throw new Error("the browser refused to send");
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  /** The server's answer arrives. */
  answer(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

const PATH = "/api/konto/kursus/veebikursus/praktiline/foto";

beforeEach(() => {
  FakeXhr.made = [];
  FakeXhr.refuseSend = false;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

test("posts the form to the path with the session cookie; the progress is the share sent (never past the whole); the JSON answer comes back", async () => {
  const form = new FormData();
  form.set("stage", "0");
  const progress: number[] = [];
  const done = uploadPhoto(PATH, form, (f) => progress.push(f));
  const xhr = FakeXhr.made[0];
  expect([xhr.method, xhr.url, xhr.withCredentials, xhr.headers.accept, xhr.timeout]).toEqual(["POST", PATH, true, "application/json", UPLOAD_TIMEOUT_MS]);
  expect(xhr.body).toBe(form);
  xhr.upload.onprogress!({ lengthComputable: true, loaded: 250, total: 1000 });
  xhr.upload.onprogress!({ lengthComputable: false, loaded: 500, total: 0 }); // nothing to tell
  xhr.upload.onprogress!({ lengthComputable: true, loaded: 1100, total: 1000 });
  xhr.answer(200, JSON.stringify({ ok: true, photo: { id: 7, round: 1, width: 2048, height: 1365 } }));
  expect(await done).toEqual({ status: 200, data: { ok: true, photo: { id: 7, round: 1, width: 2048, height: 1365 } } });
  expect(progress).toEqual([0.25, 1, 1]); // and 1 once stored
});

test("a refusal keeps its status and its JSON; an answer that is not a JSON object is {}; a refusal does not report the whole sent", async () => {
  const progress: number[] = [];
  const refused = uploadPhoto(PATH, new FormData(), (f) => progress.push(f));
  FakeXhr.made[0].answer(409, JSON.stringify({ ok: false, error: "full" }));
  expect(await refused).toEqual({ status: 409, data: { ok: false, error: "full" } });
  const html = uploadPhoto(PATH, new FormData(), () => {});
  FakeXhr.made[1].answer(502, "<html>Bad gateway</html>");
  expect(await html).toEqual({ status: 502, data: {} });
  const list = uploadPhoto(PATH, new FormData(), () => {});
  FakeXhr.made[2].answer(200, "[1, 2]");
  expect(await list).toEqual({ status: 200, data: {} });
  expect(progress).toEqual([]);
});

test("no connection, a timeout, the page stopping it: status 0, never a throw", async () => {
  const offline = uploadPhoto(PATH, new FormData(), () => {});
  FakeXhr.made[0].onerror!();
  expect(await offline).toEqual({ status: 0, data: {} });
  const slow = uploadPhoto(PATH, new FormData(), () => {});
  FakeXhr.made[1].ontimeout!();
  expect(await slow).toEqual({ status: 0, data: {} });
  const stop = new AbortController();
  const stopped = uploadPhoto(PATH, new FormData(), () => {}, stop.signal);
  stop.abort();
  expect(await stopped).toEqual({ status: 0, data: {} });
  expect(FakeXhr.made[2].aborted).toBe(true);
});

test("a signal stopped before it starts sends nothing; a send the browser refuses is status 0", async () => {
  const stop = new AbortController();
  stop.abort();
  expect(await uploadPhoto(PATH, new FormData(), () => {}, stop.signal)).toEqual({ status: 0, data: {} });
  expect(FakeXhr.made).toHaveLength(0);
  FakeXhr.refuseSend = true;
  expect(await uploadPhoto(PATH, new FormData(), () => {})).toEqual({ status: 0, data: {} });
});
