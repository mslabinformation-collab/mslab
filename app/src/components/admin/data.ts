import { cache } from "react";
import { getDb } from "@/db/client";
import { adminCounts } from "@/db/queries/admin";

/** The menu badges' numbers for the signed-in admin `email`, read once per request (the shell, Päringud and Uudiskiri share them). */
export const getAdminCounts = cache((email: string) => adminCounts(getDb(), email, new Date()));
