/**
 * Cookie injection: sets Chrome session cookies on a puppeteer
 * page before navigation. Bridges the cookie extraction and
 * browser domains.
 */

import type { Page } from "puppeteer-core";
import { getCookiesForUrl } from "./extract.js";
import { StaleKeyError } from "./setup.js";

/**
 * Inject the user's Chrome session cookies for a URL into a
 * puppeteer page. Best-effort: if cookies can't be read (no
 * Chrome profile, Keychain denied, etc.) we silently continue
 * without them.
 */
export async function injectCookies(page: Page, url: string): Promise<void> {
	try {
		const cookies = await getCookiesForUrl(url);
		if (cookies.length) {
			await page.setCookie(...cookies);
		}
	} catch (err) {
		// Let stale key errors propagate so the user gets guidance
		if (err instanceof StaleKeyError) throw err;
		// Silent fallback for everything else: cookies are optional
	}
}
