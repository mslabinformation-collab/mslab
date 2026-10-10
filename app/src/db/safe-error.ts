/**
 * What a failed database call may say on a terminal or in a log, for the CLI tools (fill-ru, demo, seed, copy-kv).
 *
 * Drizzle wraps every query failure in a DrizzleQueryError whose message is the statement plus ALL its bound parameters
 * ("Failed query: <sql>\nparams: <values>"): rows of the copy tool carry the clients' comment text, the sample data carries
 * names and addresses. So no message of a database error is ever printed, not even a redacted one: only a fixed text and
 * the driver's own error code (a Postgres SQLSTATE such as 23505, or a Node / postgres.js code such as ECONNREFUSED), which
 * the wrapper keeps on its `cause`. (dbErrorCode also tells the daily payment check a lost connection: db/queries/payments.ts isConnectionError.)
 */

/** A code is an identifier (SQLSTATE, ECONNREFUSED, CONNECT_TIMEOUT), never free text: anything else is not printed. */
const CODE = /^[0-9A-Z_]{3,40}$/;

/** The driver's error code, found on the error or down its `cause` chain (Drizzle's wrapper), or null. */
export function dbErrorCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CODE.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** "database error [23505]", or "database error" when there is no code. Never any part of the error's message. */
export function safeDbError(err: unknown): string {
  const code = dbErrorCode(err);
  return code ? `database error [${code}]` : "database error";
}
