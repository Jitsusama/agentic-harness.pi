/**
 * What a session's page keeps: its DOM stores, its cookies, its
 * clipboard, and the signed-in state they add up to.
 *
 * Kept apart from the session because what a page stores, and
 * how a saved state is worn again, change for reasons of their
 * own, and none of it needs more of the session than its wires.
 */

import {
	type CookieRecord,
	captureState,
	type SavedState,
	type StorageSnapshot,
} from "../environment/index.ts";
import { describeThrow } from "../evaluate/index.ts";
import type { SessionWires } from "./wires.ts";

/** The stores a call names, each read or cleared only when asked. */
interface StoresWanted {
	local?: boolean;
	session?: boolean;
	cookies?: boolean;
}

/** How much of a saved state landed, and where it could not. */
export interface StateLoaded {
	cookies: number;
	local: number;
	session: number;
	wrongOrigin?: string;
}

/** A session's stores, cookies and clipboard, read and written. */
export class SessionStorage {
	/** The live view of the browser this storage is read through. */
	private readonly wires: SessionWires;

	constructor(wires: SessionWires) {
		this.wires = wires;
	}

	/**
	 * Read what the page has kept.
	 *
	 * A store that cannot be read says why rather than coming
	 * back empty, since an empty store and an unreadable one lead
	 * to opposite conclusions.
	 */
	async storage(
		wanted: StoresWanted & { clipboard?: boolean },
	): Promise<StorageSnapshot> {
		await this.wires.ready();
		const snapshot: {
			local?: readonly (readonly [string, string])[];
			session?: readonly (readonly [string, string])[];
			cookies?: readonly CookieRecord[];
			clipboard?: string;
			unavailable: Record<string, string>;
		} = { unavailable: {} };

		if (wanted.local) {
			snapshot.local = await this.domStorage(true, snapshot.unavailable);
		}
		if (wanted.session) {
			snapshot.session = await this.domStorage(false, snapshot.unavailable);
		}
		if (wanted.cookies) {
			try {
				const { cookies } = await this.wires.cdp().send("Network.getCookies");
				snapshot.cookies = cookies as CookieRecord[];
			} catch (err) {
				snapshot.unavailable.cookies = String(err);
			}
		}
		if (wanted.clipboard) {
			const read = await this.clipboard();
			if (read.ok) snapshot.clipboard = read.text;
			else snapshot.unavailable.clipboard = read.why;
		}

		const { unavailable, ...rest } = snapshot;
		return Object.keys(unavailable).length > 0
			? { ...rest, unavailable }
			: rest;
	}

	/** One of the two DOM stores, keyed by this frame's origin. */
	private async domStorage(
		isLocalStorage: boolean,
		unavailable: Record<string, string>,
	): Promise<readonly (readonly [string, string])[] | undefined> {
		const label = isLocalStorage ? "local storage" : "session storage";
		try {
			await this.wires.cdp().send("DOMStorage.enable");
			const { entries } = await this.wires
				.cdp()
				.send("DOMStorage.getDOMStorageItems", {
					storageId: { securityOrigin: await this.origin(), isLocalStorage },
				});
			// The protocol types an entry as a loose string array; it
			// is always a key and a value, which is what the pair type
			// says and what the renderer reads.
			return entries.map((entry) => [entry[0] ?? "", entry[1] ?? ""] as const);
		} catch (err) {
			// A page on about:blank or a file url has no security
			// origin to key a store by, which is a fact about where we
			// are rather than a failure to report.
			unavailable[label] = String(err);
			return undefined;
		}
	}

	/** Put a value into one of the DOM stores. */
	async setStored(
		isLocalStorage: boolean,
		key: string,
		value: string,
	): Promise<void> {
		await this.wires.ready();
		await this.wires.cdp().send("DOMStorage.enable");
		await this.wires.cdp().send("DOMStorage.setDOMStorageItem", {
			storageId: { securityOrigin: await this.origin(), isLocalStorage },
			key,
			value,
		});
	}

	/**
	 * Keep everything that makes this session signed in.
	 *
	 * Cookies and the two DOM stores together, because being logged
	 * in is rarely all in one of them: a session cookie and a token
	 * in local storage is the ordinary arrangement, and saving half
	 * of it produces a state that restores without signing anyone
	 * in.
	 */
	async saveState(): Promise<SavedState> {
		await this.wires.ready();
		const snapshot = await this.storage({
			local: true,
			session: true,
			cookies: true,
		});
		return captureState(await this.origin(), snapshot);
	}

	/**
	 * Wear a state saved earlier, and report exactly what landed.
	 *
	 * Cookies go to the browser, so they apply whatever page is
	 * open. The DOM stores are scoped to an origin, so they can only
	 * be written while the session is on the origin they came from,
	 * and the answer says when they were not rather than counting
	 * them as restored. A caller who is told they are signed in and
	 * is not will blame the site.
	 */
	async loadState(state: SavedState): Promise<StateLoaded> {
		await this.wires.ready();
		if (state.cookies.length > 0) {
			await this.wires.cdp().send("Network.setCookies", {
				cookies: state.cookies.map(({ sameSite, ...rest }) => ({
					...rest,
					// A saved file can hold any string here, and the protocol
					// takes three. An unrecognised one is dropped rather than
					// passed on: without the attribute the browser applies its
					// own default, which is what a cookie with a nonsense
					// value would have got anyway, and sending it refuses the
					// whole batch and signs nobody in.
					...(sameSite === "Strict" || sameSite === "Lax" || sameSite === "None"
						? { sameSite }
						: {}),
				})),
			});
		}

		const here = await this.origin();
		if (here !== state.origin) {
			return {
				cookies: state.cookies.length,
				local: 0,
				session: 0,
				wrongOrigin: here,
			};
		}

		for (const [key, value] of state.local) {
			await this.setStored(true, key, value);
		}
		for (const [key, value] of state.session) {
			await this.setStored(false, key, value);
		}
		return {
			cookies: state.cookies.length,
			local: state.local.length,
			session: state.session.length,
		};
	}

	/** Empty the stores named, and only those. */
	async clearStorage(wanted: StoresWanted): Promise<void> {
		await this.wires.ready();
		if (wanted.local || wanted.session) {
			await this.wires.cdp().send("DOMStorage.enable");
			const securityOrigin = await this.origin();
			if (wanted.local) {
				await this.wires.cdp().send("DOMStorage.clear", {
					storageId: { securityOrigin, isLocalStorage: true },
				});
			}
			if (wanted.session) {
				await this.wires.cdp().send("DOMStorage.clear", {
					storageId: { securityOrigin, isLocalStorage: false },
				});
			}
		}
		if (wanted.cookies)
			await this.wires.cdp().send("Network.clearBrowserCookies");
	}

	/**
	 * Read the clipboard.
	 *
	 * Chrome refuses this unless the permission is granted against
	 * the browser context, not merely the origin, and unless the
	 * read is attributed to a user gesture. Both were measured;
	 * either alone still gets a refusal.
	 */
	private async clipboard(): Promise<
		{ ok: true; text: string } | { ok: false; why: string }
	> {
		try {
			await this.grantClipboard();
			const response = await this.wires.cdp().send("Runtime.evaluate", {
				expression: "navigator.clipboard.readText()",
				awaitPromise: true,
				userGesture: true,
				returnByValue: true,
			});
			// Runtime.evaluate resolves with exceptionDetails rather
			// than rejecting, so a refused permission arrived here as
			// an undefined value and was reported as an empty
			// clipboard. "Nothing is on the clipboard" and "the page
			// would not let us look" are different answers, and only
			// one of them is about the page.
			if (response.exceptionDetails) {
				return {
					ok: false,
					why: describeThrow(response.exceptionDetails).message,
				};
			}
			return { ok: true, text: String(response.result.value ?? "") };
		} catch (err) {
			return { ok: false, why: String(err) };
		}
	}

	/** Put text on the clipboard. */
	async writeClipboard(text: string): Promise<void> {
		await this.wires.ready();
		await this.grantClipboard();
		const response = await this.wires.cdp().send("Runtime.evaluate", {
			expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
			awaitPromise: true,
			userGesture: true,
		});
		// This inspected nothing at all, so a refused write was
		// reported to the caller as a success.
		if (response.exceptionDetails) {
			const threw = describeThrow(response.exceptionDetails);
			throw new Error(`Could not write the clipboard: ${threw.message}`);
		}
	}

	/** Ask for clipboard access against this context. */
	private async grantClipboard(): Promise<void> {
		await this.wires.cdp().send("Browser.grantPermissions", {
			origin: await this.origin(),
			browserContextId: this.wires.context().id,
			permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
		});
	}

	/** The origin the current page's stores are keyed by. */
	private async origin(): Promise<string> {
		return new URL(this.wires.page().url()).origin;
	}
}
