import { pageInfo, type PageInfo } from "@/domain/paging";

// Paging for the admin's lists. It lives apart from admin.ts so that the queries admin.ts reads from (protocols.ts, payments.ts) can page without
// importing admin.ts back; admin.ts exports these names again for the callers that import them from there.

/** A slice of a list: `limit` rows from `offset` on. Without one the whole list is returned (the CSV export). */
export type Range = { limit: number; offset: number };
/** One page of an admin list: its rows and where it is (page, pages, total). */
export type Paged<T> = PageInfo & { rows: T[] };

/**
 * Page `requested` (clamped to 1…last) of a list. The count and the rows are read together; only when the requested
 * page lies beyond the end (an old link, a typed ?leht=) are the rows of the last page read once more.
 */
export async function paged<T>(requested: number, size: number, total: () => Promise<number>, rows: (range: Range) => Promise<T[]>): Promise<Paged<T>> {
  const guess = pageInfo(requested, Number.POSITIVE_INFINITY, size);
  const [n, first] = await Promise.all([total(), rows({ limit: size, offset: guess.offset })]);
  const info = pageInfo(requested, n, size);
  return { ...info, rows: info.offset === guess.offset ? first : await rows({ limit: size, offset: info.offset }) };
}
