import { sql, type SQL } from "drizzle-orm";

// A student's name as the admin sees it (the Õpilased list, Hindamine): the name in the account (Minu andmed), or else the name on her latest
// registration, or else `fallback`. A leaf of the db layer: it imports nothing from src/server, so db/queries/admin.ts, db/queries/assessment.ts
// and server/admin-clients.ts can all use it without a module cycle.

/**
 * A student's name as SQL over an unaliased `clients`, with `fallback` when she has no name anywhere (the Õpilased list gives `''`, Hindamine's
 * queries her address). Written out with the table's name: in a single-table query Drizzle prints a column without its table, which inside the
 * subquery would be the subquery's own column (registrations.id, not the client's).
 */
export function clientNameSql(fallback: SQL): SQL<string> {
  return sql<string>`coalesce(nullif(clients.name, ''), (select r.name from registrations r where r.client_id = clients.id order by r.created_at desc, r.id desc limit 1), ${fallback})`;
}
