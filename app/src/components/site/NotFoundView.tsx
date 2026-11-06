"use client";

import { useParams } from "next/navigation";
import { Notice } from "./Notice";

export type NotFoundTexts = { title: string; text: string; links: { href: string; label: string }[] };

/**
 * not-found.tsx receives no props; the locale comes from the route params of the URL that was not found. `align`: the Notice's (centred on a
 * wide screen; the cart's 404, which says what the empty cart says, stays at the left edge as the empty cart does).
 */
export function NotFoundView({ texts, align }: { texts: { et: NotFoundTexts; ru: NotFoundTexts }; align?: "center" | "start" }) {
  const params = useParams<{ locale?: string }>();
  const t = params?.locale === "ru" ? texts.ru : texts.et;
  return <Notice title={t.title} text={t.text} links={t.links} align={align} />;
}
