import type { Contract } from "@/db/schema";
import type { AcceptedVia, ContractKind } from "@/domain/contract";

// One contract as Maria's screens get it (contracts Task 5): plain data the server pages hand to the client component ContractBlock and to the
// client drawer — dates as ISO text, no body (the PDF has it), nothing the screens do not show.

export type ContractView = {
  id: number;
  kind: ContractKind;
  title: string;
  locale: "et" | "ru";
  acceptedAt: string;
  acceptedVia: AcceptedVia;
  /** When a newer contract replaced this one, or null for the current one. */
  supersededAt: string | null;
  /** The last time the PDF was mailed to the student, or null. */
  sentAt: string | null;
  /** The registration it was accepted on, while that exists. */
  registrationId: number | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A contract row of server/contracts.ts (contractsOfRegistration, contractsOfClient) as the screens take it. */
export function contractView(c: Pick<Contract, "id" | "kind" | "title" | "locale" | "acceptedAt" | "acceptedVia" | "supersededAt" | "sentAt" | "registrationId">): ContractView {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    locale: c.locale,
    acceptedAt: c.acceptedAt.toISOString(),
    acceptedVia: c.acceptedVia,
    supersededAt: iso(c.supersededAt),
    sentAt: iso(c.sentAt),
    registrationId: c.registrationId,
  };
}
