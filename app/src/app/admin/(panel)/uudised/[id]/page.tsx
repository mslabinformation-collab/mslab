import type { Metadata } from "next";
import Link from "next/link";
import { PostEditor } from "@/components/admin/PostEditor";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { readPost } from "@/db/queries/admin-site";
import { parseSearch } from "@/domain/paging";
import { POST_PART } from "@/domain/site-entities";
import { adminEt } from "@/i18n/dict/admin";
import { parseRowId } from "@/lib/row-id";
import { requireAdmin } from "@/server/auth";
import { readSiteEditor } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.post.editCrumb) };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * A post's editor (admin UX pass piece 4b, Task 2; README §4 C3; rulings R-a, R-b, R-g): /admin/uudised/<id>, beside the list from 1180 px (the
 * uudised layout). The post's part as it is now — its draft over live while it is published, its row while it is not (server/site-drafts.ts
 * readSiteEditor) — with the read's stamp, handed to the editor as it came (SiteEditorPage's `parts` contract), and whether it is published (the bar,
 * the switch). „Lisa postitus +“ opens a new post here with `?loodud=1`; the list's search (`?otsi=`) goes back with „← Uudised“. An id that is no post
 * (also /admin/uudised/uus, the old new-post page: a post is made at once now) says so.
 */
export default async function PostEditPage({ params, searchParams }: Props) {
  await requireAdmin();
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const q = parseSearch(sp.otsi);
  const listHref = q ? `/admin/uudised?${new URLSearchParams({ otsi: q })}` : "/admin/uudised";
  const id = parseRowId(raw);
  const db = getDb();
  const post = id === null ? null : await readPost(db, id);
  const read = id !== null && post ? await readSiteEditor(db, { entity: "post", id }) : null;

  if (id === null || !post || !read?.parts[POST_PART]) {
    return (
      <div className={ui.page}>
        <div className={ui.heading}>
          <h1 className={ui.h1}>{adminEt.nav.news}</h1>
        </div>
        <section className={ui.card}>
          <p className={ui.empty}>{adminEt.post.notFound}</p>
          <Link className={ui.link} href={listHref}>
            {adminEt.post.back}
          </Link>
        </section>
      </div>
    );
  }

  // (a new mount for another post: its parts start from its own read)
  return <PostEditor key={id} id={id} published={post.published} parts={read.parts} stamp={read.stamp} created={sp.loodud === "1"} listHref={listHref} />;
}
