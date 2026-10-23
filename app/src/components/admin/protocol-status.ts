import type { AutosaveStatus } from "@/domain/autosave";
import { adminEt } from "@/i18n/dict/admin";
import type { Conflict, SaveStatus } from "./protocol-autosave";

// The protocol screen's chip (admin UX pass, README A3: „the status chip is SaveStatus“). The screen keeps its own autosave (protocol-autosave.ts, the
// plan's ruling), so its engine's states are said in SaveStatus' kinds here. Pure; the browser runs it, on old iPads too (tests/unit/old-safari.test.ts).

/**
 * The engine's save status as SaveStatus shows it: "pending" is "dirty", "retrying" "retry", "tooLong" "invalid" with the labels of the boxes over
 * their limit in screen order (`titles`: the protocol's headings; the general notes are „Üldised märkused“), the others by name, and the time of a
 * save as a Date. An open notice (`conflict`, another device saved first) makes a settled protocol "conflict": the chip points at the notice until
 * „Selge“ or „Taasta minu tekst“; a save on its way, a retry and the states she has to act on (too long, signed out, gone) keep their own words.
 */
export function protocolSaveStatus(status: SaveStatus, conflict: Conflict | null, titles: readonly string[] = []): AutosaveStatus {
  switch (status.kind) {
    case "saved":
      return conflict ? { kind: "conflict" } : { kind: "saved", at: status.at === null ? null : new Date(status.at) };
    case "pending":
      return { kind: "dirty" };
    case "retrying":
      return { kind: "retry" };
    case "tooLong":
      return { kind: "invalid", fields: status.places.map((place) => (place === "general" ? adminEt.protocols.general : (titles[place] ?? ""))) };
    case "checking":
    case "saving":
    case "signedOut":
    case "gone":
      return { kind: status.kind };
  }
}
