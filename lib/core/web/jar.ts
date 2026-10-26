/**
 * The cookies one-off reads share with each other.
 *
 * Reads and searches used to share Chrome's default context, so a
 * cookie a site set during one read, a bot check's clearance say,
 * was sent on every later read for as long as the browser lived.
 * Each read now has a context of its own, so that one tab stuck
 * taking a screenshot cannot hold up every other read's screenshots
 * and close, which puppeteer serializes per context. This jar is how
 * the sharing survives the move: a context is seeded from it and
 * hands back what changed when it closes.
 *
 * The merge is three-way. A context writes back only the cookies it
 * set, changed or removed since it was seeded, so two reads running
 * at once do not undo each other's changes with stale copies.
 */

import type { Cookie, CookieData } from "puppeteer-core";

/** A cookie's identity: the same name can be set per domain, path and partition. */
function keyOf(cookie: CookieData): string {
	const partition =
		typeof cookie.partitionKey === "string"
			? cookie.partitionKey
			: (cookie.partitionKey?.sourceOrigin ?? "");
	return [cookie.name, cookie.domain, cookie.path ?? "/", partition].join(
		"\u0000",
	);
}

/**
 * What it takes to set a cookie again. A session cookie carries no
 * expiry, since the -1 Chrome reports for one would read as expired.
 */
export function cookieData(cookie: Cookie): CookieData {
	const data: CookieData = {
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		secure: cookie.secure,
		httpOnly: cookie.httpOnly ?? false,
	};
	if (!cookie.session) data.expires = cookie.expires;
	if (cookie.sameSite) data.sameSite = cookie.sameSite;
	if (cookie.priority) data.priority = cookie.priority;
	if (cookie.sourceScheme) data.sourceScheme = cookie.sourceScheme;
	if (cookie.partitionKey) data.partitionKey = cookie.partitionKey;
	return data;
}

/** Whether a cookie's expiry, in seconds since the epoch, has passed. */
function expired(cookie: CookieData, nowMs: number): boolean {
	return cookie.expires !== undefined && cookie.expires * 1000 <= nowMs;
}

/** Cookies carried from one reading context to the next. */
export class CookieJar {
	private readonly held = new Map<string, CookieData>();

	/** What a fresh context should start with. */
	contents(nowMs: number = Date.now()): CookieData[] {
		for (const [key, cookie] of this.held) {
			if (expired(cookie, nowMs)) this.held.delete(key);
		}
		return [...this.held.values()];
	}

	/**
	 * Take back what a context changed: every cookie it ended with
	 * that differs from what it was seeded with, and the removal of
	 * every seeded cookie it no longer has.
	 */
	absorb(seeded: readonly CookieData[], ended: readonly CookieData[]): void {
		const before = new Map(seeded.map((c) => [keyOf(c), c]));
		const after = new Map(ended.map((c) => [keyOf(c), c]));
		for (const [key, cookie] of after) {
			const was = before.get(key);
			if (!was || !same(was, cookie)) this.held.set(key, cookie);
		}
		for (const key of before.keys()) {
			if (!after.has(key)) this.held.delete(key);
		}
	}
}

/** Whether two readings of a cookie say the same thing. */
function same(a: CookieData, b: CookieData): boolean {
	return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

/** A cookie's fields in a fixed order, so equal cookies serialize equally. */
function ordered(cookie: CookieData): [string, unknown][] {
	return Object.entries(cookie)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
}
