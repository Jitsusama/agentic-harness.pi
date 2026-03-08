/**
 * Cookie module — Chrome cookie extraction, key management,
 * and puppeteer injection.
 */

export type { PuppeteerCookie } from "./extract.js";
export { getCookiesForUrl } from "./extract.js";
export { injectCookies } from "./inject.js";
export { isSetUp, StaleKeyError, setupChromeKey } from "./setup.js";
