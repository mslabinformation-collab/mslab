import { NewsScreen, type NewsRow } from "@/components/admin/news/NewsList";
import { getDb } from "@/db/client";
import { listAllPosts } from "@/db/queries/admin";
import { tallinnFormParts } from "@/domain/calendar";
import { pick } from "@/i18n/field";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Uudised (admin UX pass piece 4b, Task 2; ruling R-f): the list of every post, newest first, read here from the posts with the drafts lookup for the
 * status (listAllPosts' `changes`: a published post with a draft says „Avaldamata muudatused“), so it stays on the screen while a post is open — from
 * 1180 px at the left of the editor (`children`, /admin/uudised/<id>), below that as a screen of its own. A layout does not run again when the
 * visitor moves from post to post: the editor has the page read again (router.refresh) when what a row shows changes. Its search is the list's own
 * (`?otsi=`, filtered in the browser: a layout gets no searchParams).
 */
export default async function NewsLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const posts = await listAllPosts(getDb());
  const rows: NewsRow[] = posts.map((p) => ({
    id: p.id,
    title: pick(p.title, "et"),
    coverKey: p.coverKey,
    status: p.changes ? "changes" : p.published ? "published" : "draft",
    day: tallinnFormParts(p.publishedAt).date,
  }));
  return <NewsScreen rows={rows}>{children}</NewsScreen>;
}
