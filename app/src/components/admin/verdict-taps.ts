import type { Verdict } from "@/db/schema";
import { SAVE_TIMEOUT_MS } from "./protocol-autosave";

// The verdict taps of Maria's assessment screen (phase e-course completion, spec §5.3, R2): "Kinnitatud" / "Paranda" are taps, each stored at
// once through POST /api/admin/hinnang into protocols.verdicts — outside the notes' autosave and its version check (a tap is discrete: nothing
// to wait for). One request at a time, each with the point's latest choice, so the last tap wins on the server too. Each tap names the student's
// round the screen showed when it was tapped (a resubmission never raises the notes' version, R3, so only the round tells a screen of an older
// submission): the server answers "stale" for an older round, and Maria never judges photos she has not seen. A tap that gets no answer
// (offline, a server error, signed out) keeps its look and says "Salvestamata", with the taps behind it; they go again with the next tap and
// before "Saada hinnang" (AssessmentSend.tsx). A refusal (the work changed meanwhile: approved on another device, nothing submitted, the row made
// again, or the student's new round) drops the tap: the screen reads the server again (AssessmentScreen.tsx). This file runs on old iPads: no
// lookbehind (tests/unit/old-safari.test.ts).

/** One tap as POST /api/admin/hinnang takes it (server/assessment.ts verdictBody): the round the screen showed; null clears the point's verdict. */
export type VerdictBody = { accessId: number; protocolId: number; round: number; stage: number; verdict: Verdict | null };
/** The route's answer; null when none came (no connection, the 10 s ran out). */
export type VerdictAnswer = { status: number; body: unknown } | null;
export type PostVerdict = (body: VerdictBody) => Promise<VerdictAnswer>;

/** POST /api/admin/hinnang with the admin's cookie, given up after 10 s. Never throws. */
export async function postVerdict(body: VerdictBody): Promise<VerdictAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SAVE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/admin/hinnang", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A list of verdicts as the server sends them ("ok", "fix" or null per point); the screen's reads are checked with it too (AssessmentScreen.tsx). */
export const isVerdicts = (v: unknown): v is (Verdict | null)[] => Array.isArray(v) && v.every((x) => x === "ok" || x === "fix" || x === null);

/**
 * How a flush ended: every tap stored; one got no answer (it and those behind it are kept); one was refused (dropped: read the server again); or
 * one named an older round than the server's (dropped: the student sent a new round, which the screen reads and shows). "stale" wins over
 * "refused" when a flush meets both: Maria's next step is to look at the new round.
 */
export type TapsResult = "saved" | "unsaved" | "refused" | "stale";

/** A tap not stored yet: its choice (null: cleared) and the round the screen showed when it was tapped. */
type Chosen = { verdict: Verdict | null; round: number };

/** The verdict taps of one access's screen (see the top of the file); `subscribe` / `snapshot` for useSyncExternalStore. */
export class VerdictTaps {
  /** The server's last word on the verdicts: a tap's answer, or a read of the screen. */
  private stored: (Verdict | null)[];
  /** The student's round the screen shows (AssessmentView.round): a tap names it. */
  private shownRound: number;
  /** The taps not stored yet, by point: each point's latest choice. */
  private readonly chosen = new Map<number, Chosen>();
  /** The points whose tap got no answer: "Salvestamata". */
  private readonly failed = new Set<number>();
  private running: Promise<TapsResult> | null = null;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly accessId: number;
  private readonly post: PostVerdict;

  constructor(accessId: number, stored: readonly (Verdict | null)[], round: number, post: PostVerdict = postVerdict) {
    this.accessId = accessId;
    this.stored = [...stored];
    this.shownRound = round;
    this.post = post;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly snapshot = (): number => this.revision;

  /** The student's round the screen shows now (the last read's, or the page's). */
  get round(): number {
    return this.shownRound;
  }

  /** The verdict a point shows: its tap still waiting, else the server's. */
  shown(stage: number): Verdict | null {
    const waiting = this.chosen.get(stage);
    return waiting ? waiting.verdict : (this.stored[stage] ?? null);
  }

  /** Did the point's tap get no answer (kept here: tried again with the next tap and before "Saada hinnang")? */
  unsaved(stage: number): boolean {
    return this.failed.has(stage);
  }

  /**
   * The server's verdicts read again, with the round they are of (a read of the screen, or what a send froze): a tap still waiting stays on top of
   * its point, naming the round it was tapped on.
   */
  take(stored: readonly (Verdict | null)[], round: number): void {
    this.stored = [...stored];
    this.shownRound = round;
    this.changed();
  }

  /** A tap: shown at once, then stored with the others waiting (flush). It names the round the screen shows now. */
  tap(protocolId: number, stage: number, verdict: Verdict | null): Promise<TapsResult> {
    this.chosen.set(stage, { verdict, round: this.shownRound });
    this.changed();
    return this.flush(protocolId);
  }

  /** Sends the taps waiting, after the round of requests on its way (never beside it). */
  flush(protocolId: number): Promise<TapsResult> {
    const before = this.running;
    if (before) return before.then(() => this.flush(protocolId));
    const run = this.send(protocolId);
    this.running = run;
    void run.then(() => {
      if (this.running === run) this.running = null;
    });
    return run;
  }

  /**
   * One request at a time, each with its point's latest choice (a point tapped again while its request was on its way goes again). No answer, or
   * one that is not the route's (a server error, signed out), stops the round: the waiting taps stay, "Salvestamata". A refusal (400, 404, 409)
   * drops that tap, and the round goes on with the others.
   */
  private async send(protocolId: number): Promise<TapsResult> {
    let result: TapsResult = "saved";
    for (;;) {
      const next = this.chosen.entries().next();
      if (next.done) return result;
      const [stage, choice] = next.value;
      const answer = await this.post({ accessId: this.accessId, protocolId, round: choice.round, stage, verdict: choice.verdict });
      const reply = (answer?.body ?? null) as { ok?: unknown; verdicts?: unknown; error?: unknown } | null;
      if (answer && answer.status === 200 && reply?.ok === true && isVerdicts(reply.verdicts)) {
        this.stored = reply.verdicts;
        this.failed.delete(stage);
        if (this.chosen.get(stage) === choice) this.chosen.delete(stage); // (tapped again meanwhile: that choice goes next)
        this.changed();
        continue;
      }
      if (answer && (answer.status === 400 || answer.status === 404 || answer.status === 409)) {
        if (this.chosen.get(stage) === choice) this.chosen.delete(stage);
        this.failed.delete(stage);
        result = answer.status === 409 && reply?.error === "stale" ? "stale" : result === "stale" ? "stale" : "refused";
        this.changed();
        continue;
      }
      for (const waiting of this.chosen.keys()) this.failed.add(waiting);
      this.changed();
      return result === "saved" ? "unsaved" : result;
    }
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
