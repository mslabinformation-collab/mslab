import { NotFoundView, type NotFoundTexts } from "@/components/site/NotFoundView";
import { href } from "@/i18n/href";
import { getDict, type Locale } from "@/i18n/locales";

function texts(l: Locale): NotFoundTexts {
  const d = getDict(l);
  return { title: d.cart.emptyTitle, text: d.cart.emptyText, links: [{ href: href(l, "/koolitused?vorm=e"), label: d.formats.elearning.link }, { href: href(l, "/koolitused?vorm=k"), label: d.formats.contact.link }] };
}

// /ostukorv?kursus=<a course that does not exist or is not published>: a 404 (never a cached 200 page per made-up
// address) that says what the empty cart says, where the empty cart says it (at the left edge, as the cart's own page).
export default function CartNotFound() {
  return <NotFoundView texts={{ et: texts("et"), ru: texts("ru") }} align="start" />;
}
