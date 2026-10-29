// The review tools until launch: Maria's and Dim's comment bubble (public/feedback.js → /api/feedback), on every public page of the site and (Dim 22.10)
// on every page of the admin. NEXT_PUBLIC_REVIEW_TOOLS is set in next.config.ts ("1" for the review builds) and switched off ("0") at the mslab.ee
// launch (docs/launch-checklist.md); the build inlines it. Both root-level layouts (app/[locale]/(site) and app/admin) read it from here.

/** Are the review tools on in this build? */
export const REVIEW_TOOLS = process.env.NEXT_PUBLIC_REVIEW_TOOLS === "1";

/** The comment bubble's script, with the version that is bumped whenever public/feedback.js changes. */
export const FEEDBACK_SCRIPT = "/feedback.js?v=7";
