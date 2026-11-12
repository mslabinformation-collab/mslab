import type { MetadataRoute } from "next";
import { indexingOn } from "@/lib/indexing";

// SEO G2: /robots.txt, replacing public/robots.txt. It is one of the always-through root files (lib/root-files.ts): the gate
// and the routing serve it as they served the static file. The file is made at build, like next.config.ts's headers (a Vercel build has
// SITE_GATE and VERCEL_ENV; flipping the gate takes a redeploy anyway), so a bot's fetch costs no function run.

/** Link-preview bots: they may fetch pages while indexing is off, so a shared link shows a card. */
const PREVIEW_BOTS = [
  "facebookexternalhit", "Facebot", "Twitterbot", "LinkedInBot", "TelegramBot", "WhatsApp", "Slackbot-LinkExpanding", "Slackbot", "Discordbot",
  "SkypeUriPreview", "vkShare", "Pinterestbot", "redditbot",
];

/**
 * The areas crawlers are asked to stay out of once indexing is on. Not the client account, the cart and the payment result: they say noindex
 * (page metadata and header, always), and a crawler that is barred from them never reads it (final review M1).
 */
const PRIVATE = ["/admin", "/api/", "/maksa/", "/guide", "/p/"];

export default function robots(): MetadataRoute.Robots {
  // each setting named in full (process.env.NAME), as the middleware reads them
  if (!indexingOn({ SITE_GATE: process.env.SITE_GATE, VERCEL_ENV: process.env.VERCEL_ENV })) {
    return { rules: [...PREVIEW_BOTS.map((userAgent) => ({ userAgent, allow: "/" })), { userAgent: "*", disallow: "/" }] };
  }
  const site = (process.env.SITE_URL?.trim() || "https://mslab.ee").replace(/\/+$/, "");
  return { rules: [{ userAgent: "*", allow: "/", disallow: PRIVATE }], sitemap: `${site}/sitemap.xml` };
}
