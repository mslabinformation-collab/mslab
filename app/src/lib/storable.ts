// Text Postgres can store: no NUL or other control character (a NUL in text is an error) and no lone surrogate (an error in a jsonb
// value). The account's input parser (server/account-input.ts) refuses anything else, and the browser leaves it out of what it sends
// (lib/favourites.ts, the favourites merge), so both sides agree on what a slug may be.
// It runs in the browser (lib/favourites.ts reaches every account page and the site's hearts), on iOS Safari before 16.4 too, so it has no
// regular expression with a lookbehind (tests/unit/old-safari.test.ts): a text is storable when toStorable leaves it as it is.

import { toStorable } from "./to-storable";

export const storable = (s: string): boolean => toStorable(s) === s;
