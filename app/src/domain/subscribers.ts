import { parseSearch } from "./paging";

// Uudiskiri → Tellijad (admin UX pass, piece 3b Task 7; README B5, piece3-texts P-13): what the page's address says about the list, read in one place so
// that the screen and „Laadi alla (CSV)“ (api/admin/subscribers.csv) show exactly the same rows. Pure and import-light, no database and no React.
//
//   ?otsi=<text>   the search: a part of an address (domain/paging.ts parseSearch; the query matches it with containsPattern, literally)
//   ?olek=kinnitatud | ootab   the state, the pills „Kinnitatud“ / „Ootab kinnitust“ (a word that is neither is no state)
//   ?kinnitatud=1  what the former „Lae alla kinnitatud (CSV)“ link carried: it means ?olek=kinnitatud, so that a page left open across the change
//                  never hands out the whole list as the confirmed one

/** A subscriber is `confirmed` (it has a confirmation time) or `pending` (a row of the old double opt-in that was never confirmed). */
export type SubscriberState = "confirmed" | "pending";

/** The words of the address for the two states (own keys only: "constructor" in the address is not one). */
export const STATE_OF_PARAM: Record<string, SubscriberState> = { kinnitatud: "confirmed", ootab: "pending" };
export const PARAM_OF_STATE: Record<SubscriberState, "kinnitatud" | "ootab"> = { confirmed: "kinnitatud", pending: "ootab" };

/** The filter of the subscribers' list: the text an address holds (as typed; the query reads it with parseSearch) and the state. */
export type SubscriberFilter = { search?: string; state?: SubscriberState };

type Params = Record<string, string | string[] | undefined>;

/** `?olek=` → a state, or undefined for nothing or a word that is none (a list of values, the parameter given twice, is none either). */
export function parseSubscriberState(value: string | string[] | undefined): SubscriberState | undefined {
  return typeof value === "string" && Object.hasOwn(STATE_OF_PARAM, value) ? STATE_OF_PARAM[value] : undefined;
}

/** The list's filter for an address's parameters (the page's `searchParams`, or the CSV route's). The search comes out as parseSearch reads it. */
export function subscriberFilterOf(sp: Params): { search: string; state: SubscriberState | undefined } {
  const olek = parseSubscriberState(sp.olek);
  return { search: parseSearch(sp.otsi), state: olek ?? (sp.kinnitatud === "1" && sp.olek === undefined ? "confirmed" : undefined) };
}
