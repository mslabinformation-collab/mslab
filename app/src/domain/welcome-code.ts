// The newsletter's welcome code, as the sign-up's pages carry it (phase 2c, spec 5). The code itself is the `welcome` row of discount_codes since F1
// (domain/discount-codes.ts holds its shape, its percent and its days; Sooduskoodid edits it): Seaded's „Tervituskood“ and Hüpikaken's two numbers, which
// once lived in the `newsletter` setting and had their readers here, are gone. What is left is the fragment the confirmation link's redirect carries to
// the home page. Pure: no database, no React.

/**
 * The fragment the confirmation link's redirect carries to the home page: `kood=<CODE>`. A fragment, never the query: the home page is
 * cached for every visitor, and no server or cache ever sees a fragment (FlashNotice reads it in the browser and removes it).
 */
export const welcomeFragment = (code: string): string => `kood=${code}`;

/** The welcome code in a page's fragment (without "#"), read back only in its own shape. */
export const WELCOME_FRAGMENT = /^kood=([A-Z0-9-]{1,30})$/;
