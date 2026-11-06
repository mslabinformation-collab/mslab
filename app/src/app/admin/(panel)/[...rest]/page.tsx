import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth";

/**
 * Every admin address that is no page (06.11 polish board 7: /admin/kirjad showed the framework's English 404 with no menu). Signed out, it goes to
 * the login page first, as every admin page does; signed in, the panel's own not-found card, inside the menu. Any page of its own wins over it.
 */
export default async function UnknownAdminPage(): Promise<never> {
  await requireAdmin();
  notFound();
}
