import { expect, test } from "vitest";
import { VerdictTaps, type VerdictAnswer, type VerdictBody } from "@/components/admin/verdict-taps";

// The verdict taps of Maria's assessment screen (spec §5.3, R2): one request at a time and the last tap wins; a tap with no answer is kept
// ("Salvestamata") with the ones behind it and goes again first; a refusal drops the tap; a read's verdicts are taken for the points without a
// tap waiting. Each tap names the student's round the screen showed when it was tapped: the server answers "stale" for an older one. The server
// is answered by hand: each request waits for the test.

function server() {
  const calls: { body: VerdictBody; answer: (a: VerdictAnswer) => void }[] = [];
  const post = (body: VerdictBody) => new Promise<VerdictAnswer>((resolve) => calls.push({ body, answer: resolve }));
  return { calls, post };
}
const stored = (verdicts: ("ok" | "fix" | null)[]): VerdictAnswer => ({ status: 200, body: { ok: true, verdicts } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("one request at a time, each with the point's latest choice: the last tap wins on the server too", async () => {
  const s = server();
  const taps = new VerdictTaps(4, [null, null], 1, s.post);
  const first = taps.tap(9, 0, "ok");
  const second = taps.tap(9, 0, "fix"); // tapped again while the first is on its way
  expect(s.calls.map((c) => c.body)).toEqual([{ accessId: 4, protocolId: 9, round: 1, stage: 0, verdict: "ok" }]);
  expect(taps.shown(0)).toBe("fix");
  s.calls[0].answer(stored(["ok", null]));
  await settle();
  expect(s.calls.map((c) => c.body.verdict)).toEqual(["ok", "fix"]);
  expect(taps.shown(0)).toBe("fix"); // the latest choice, not the first answer's
  s.calls[1].answer(stored(["fix", null]));
  expect([await first, await second]).toEqual(["saved", "saved"]);
  expect([taps.shown(0), taps.unsaved(0), s.calls.length]).toEqual(["fix", false, 2]);
});

test("no answer keeps the tap and the ones behind it ('Salvestamata'); the next tap sends the kept one first; a refusal drops a tap and says so", async () => {
  const s = server();
  const taps = new VerdictTaps(4, [null, null, null], 1, s.post);
  const a = taps.tap(9, 0, "ok");
  s.calls[0].answer(null);
  expect(await a).toBe("unsaved");
  expect([taps.shown(0), taps.unsaved(0)]).toEqual(["ok", true]);
  const b = taps.tap(9, 1, "fix");
  await settle();
  expect(s.calls[1].body).toEqual({ accessId: 4, protocolId: 9, round: 1, stage: 0, verdict: "ok" });
  s.calls[1].answer(null); // still offline: both are kept
  expect(await b).toBe("unsaved");
  expect([0, 1].map((i) => [taps.shown(i), taps.unsaved(i)])).toEqual([["ok", true], ["fix", true]]);
  const c = taps.flush(9); // "Saada hinnang" tries them again
  await settle();
  s.calls[2].answer(stored(["ok", null, null]));
  await settle();
  expect(s.calls[3].body).toEqual({ accessId: 4, protocolId: 9, round: 1, stage: 1, verdict: "fix" });
  s.calls[3].answer({ status: 409, body: { ok: false, error: "closed" } });
  expect(await c).toBe("refused");
  expect([0, 1].map((i) => [taps.shown(i), taps.unsaved(i)])).toEqual([["ok", false], [null, false]]);
});

test("take: a read's verdicts for every point; a tap still waiting stays on top of its point; a flush with nothing waiting sends nothing", async () => {
  const s = server();
  const taps = new VerdictTaps(4, [null, null, null], 1, s.post);
  void taps.tap(9, 2, "ok"); // on its way
  taps.take(["fix", "ok", null], 1);
  expect([0, 1, 2].map((i) => taps.shown(i))).toEqual(["fix", "ok", "ok"]);
  s.calls[0].answer(stored(["fix", "ok", "ok"]));
  await settle();
  expect(await taps.flush(9)).toBe("saved");
  expect(s.calls).toHaveLength(1);
});

test("a tap names the round the screen showed when it was tapped, a read of the student's new round notwithstanding; the server's 'stale' drops it and says so, and the taps after it go on", async () => {
  const s = server();
  const taps = new VerdictTaps(4, [null, null], 1, s.post);
  const a = taps.tap(9, 0, "ok");
  s.calls[0].answer(null); // no answer: kept, "Salvestamata"
  expect(await a).toBe("unsaved");
  taps.take([null, null], 2); // a read: the student sent round 2 meanwhile
  expect(taps.round).toBe(2);
  const b = taps.tap(9, 1, "fix"); // a tap on the screen of round 2
  await settle();
  expect(s.calls[1].body).toEqual({ accessId: 4, protocolId: 9, round: 1, stage: 0, verdict: "ok" }); // the kept one, of the round it was tapped on
  s.calls[1].answer({ status: 409, body: { ok: false, error: "stale" } });
  await settle();
  expect(s.calls[2].body).toEqual({ accessId: 4, protocolId: 9, round: 2, stage: 1, verdict: "fix" });
  s.calls[2].answer(stored([null, "fix"]));
  expect(await b).toBe("stale");
  expect([0, 1].map((i) => [taps.shown(i), taps.unsaved(i)])).toEqual([[null, false], ["fix", false]]);
});
