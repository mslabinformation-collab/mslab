import { cache } from "react";
import { getDb } from "@/db/client";
import { adminCounts } from "@/db/queries/admin";

/** The menu badges' numbers, read once per request (the shell, Päringud and Uudiskiri share them). */
export const getAdminCounts = cache(() => adminCounts(getDb(), new Date()));
