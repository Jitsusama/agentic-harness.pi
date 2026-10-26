/**
 * Cookie module: Chrome cookie extraction, key management,
 * and puppeteer injection.
 */

export type { PuppeteerCookie } from "./extract.ts";
export { getCookiesForUrl } from "./extract.ts";
export { injectCookies } from "./inject.ts";
export {
	hasCachedKey,
	isSetUp,
	KeyringSetupNeeded,
	StaleKeyError,
	setupChromeKey,
} from "./setup.ts";
