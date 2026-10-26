/**
 * Cookie injection: sets Chrome session cookies on a puppeteer
 * page before navigation. Bridges the cookie extraction and
 * browser domains.
 */

import type { Page } from "puppeteer-core";
import { getCookiesForUrl } from "./extract.ts";
import { KeyringSetupNeeded, StaleKeyError } from "./setup.ts";

/**
 * Inject the user's Chrome session cookies for a URL into a
 * puppeteer page. Best-effort: if cookies can't be read (no
 * Chrome profile, Keychain denied, etc.) we silently continue
 * without them. A key that is stale or not yet read from the keyring
 * is reported instead, since setup fixes it.
 */
export async function injectCookies(page: Page, url: string): Promise<void> {
	try {
		const cookies = await getCookiesForUrl(url);
		if (cookies.length) {
			await page.setCookie(...cookies);
		}
	} catch (err) {
		// Key errors need to propagate so the user gets guidance
		if (err instanceof StaleKeyError) throw err;
		if (err instanceof KeyringSetupNeeded) throw err;
		// Everything else gets a silent fallback because cookies are optional.
	}
}
