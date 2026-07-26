/**
 * What the page has kept: local storage, session storage,
 * cookies and the clipboard.
 *
 * These are where the state behind a bug usually hides. A page
 * that behaves differently on a second visit is nearly always
 * remembering something, and the fastest way to find out what
 * is to look rather than to reason about it.
 */

/** One cookie, as the protocol describes it. */
export interface CookieRecord {
	readonly name: string;
	readonly value: string;
	readonly domain?: string;
	readonly path?: string;
	readonly expires?: number;
	readonly httpOnly?: boolean;
	readonly secure?: boolean;
	readonly sameSite?: string;
}

/** Everything a session can see that the page has kept. */
export interface StorageSnapshot {
	readonly local?: readonly (readonly [string, string])[];
	readonly session?: readonly (readonly [string, string])[];
	readonly cookies?: readonly CookieRecord[];
	readonly clipboard?: string;
	/** Why a store could not be read, when one could not. */
	readonly unavailable?: Readonly<Record<string, string>>;
}

/** How much of a stored value reads before it stops helping. */
const MAX_VALUE = 200;

/** What the page is holding on to. */
export function renderStorage(snapshot: StorageSnapshot): string {
	const sections: string[] = [];

	for (const [label, entries] of [
		["local storage", snapshot.local],
		["session storage", snapshot.session],
	] as const) {
		if (!entries) continue;
		sections.push(
			entries.length === 0
				? `${label}: empty`
				: `${label}: ${entries.length} ${
						entries.length === 1 ? "entry" : "entries"
					}\n${entries
						.map(([key, value]) => `  ${key} = ${clip(value)}`)
						.join("\n")}`,
		);
	}

	if (snapshot.cookies) {
		sections.push(
			snapshot.cookies.length === 0
				? "cookies: none"
				: `cookies: ${snapshot.cookies.length}\n${snapshot.cookies
						.map(
							(cookie) =>
								`  ${cookie.name} = ${clip(cookie.value)}${flags(cookie)}`,
						)
						.join("\n")}`,
		);
	}

	if (snapshot.clipboard !== undefined) {
		sections.push(
			snapshot.clipboard === ""
				? "clipboard: empty"
				: `clipboard: ${clip(snapshot.clipboard)}`,
		);
	}

	for (const [store, why] of Object.entries(snapshot.unavailable ?? {})) {
		sections.push(`${store}: could not be read. ${why}`);
	}

	return sections.length === 0
		? "Nothing was asked for."
		: sections.join("\n\n");
}

/** The properties that change what a cookie is for. */
function flags(cookie: CookieRecord): string {
	const noted: string[] = [];
	if (cookie.httpOnly) noted.push("httpOnly");
	if (cookie.secure) noted.push("secure");
	if (cookie.sameSite) noted.push(`sameSite=${cookie.sameSite}`);
	// A session cookie has no expiry, which the protocol reports
	// as -1 rather than as an absent field.
	if (cookie.expires !== undefined && cookie.expires < 0) {
		noted.push("session");
	}
	return noted.length === 0 ? "" : `  [${noted.join(", ")}]`;
}

/** A value cut to length, with the cut declared. */
function clip(value: string): string {
	return value.length > MAX_VALUE
		? `${value.slice(0, MAX_VALUE)}... (${value.length} chars)`
		: value;
}
