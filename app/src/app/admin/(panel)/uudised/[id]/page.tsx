import type { Metadata } from "next";
import Link from "next/link";
import { PostEditor } from "@/components/admin/PostEditor";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { tallinnFormParts } from "@/domain/calendar";
import { newPostDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { loadPost } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** "uus" → a new post; a number → that post; anything else → not found. */
function parseId(raw: string): number | "new" | null {
  if (raw === "uus") return "new";
  const n = Number(raw);
  return /^\d{1,10}$/.test(raw) && Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const id = parseId((await params).id);
  return { title: adminTitle(id === "new" ? adminEt.post.newTitle : adminEt.post.editCrumb) };
}

/** The post editor: /admin/uudised/uus (new) and /admin/uudised/<id> (Task 13B). */
export default async function PostEditPage({ params, searchParams }: Props) {
  await requireAdmin();
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = parseId(raw);
  const loaded = typeof id === "number" ? await loadPost(getDb(), id) : null;

  if (id === null || (id !== "new" && !loaded)) {
    return (
      <div className={ui.page}>
        <div className={ui.heading}>
          <h1 className={ui.h1}>{adminEt.nav.news}</h1>
        </div>
        <section className={ui.card}>
          <p className={ui.empty}>{adminEt.post.notFound}</p>
          <Link className={ui.link} href="/admin/uudised">
            {adminEt.post.back}
          </Link>
        </section>
      </div>
    );
  }

  // a new post is dated today (Estonian calendar day)
  const initial = loaded ?? { values: { post: newPostDraft(tallinnFormParts(new Date()).date) }, versions: { post: "" } };
  return <PostEditor key={id} initial={initial} created={sp.loodud === "1"} />;
}
