// One practical photo's upload (e-course completion, spec §4.3, D7): XMLHttpRequest rather than fetch, because only it tells how much of
// the body has gone, and the student sees each photo's progress on a weak mobile signal. Same-origin with the session cookie, as
// lib/json-request.ts sendJson; a POST from the page keeps its Origin (the account API refuses a cross-site one).

/** How long one upload may take before it counts as failed ("Proovi uuesti"): 2.2 MB on a slow 3G link takes about a minute. */
export const UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

/** The body's JSON object, {} for anything else. */
function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Posts `form` to `path`, telling `onProgress` the share of the body sent so far (0…1, and 1 once the server has stored it). Never throws:
 * the answer's status (0 when there was none: no connection, a timeout, `signal` aborted) and its JSON object ({} when the body is not one).
 */
export function uploadPhoto(
  path: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ status: 0, data: {} });
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (status: number, data: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", stop);
      resolve({ status, data });
    };
    const stop = () => {
      xhr.abort();
      finish(0);
    };
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) onProgress(1);
      finish(xhr.status, jsonObject(xhr.responseText));
    };
    xhr.onerror = () => finish(0);
    xhr.ontimeout = () => finish(0);
    xhr.onabort = () => finish(0);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      xhr.open("POST", path);
      xhr.withCredentials = true;
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader("accept", "application/json");
      xhr.send(form);
    } catch {
      finish(0);
    }
  });
}
