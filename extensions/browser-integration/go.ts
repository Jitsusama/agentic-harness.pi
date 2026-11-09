/**
 * browser_go: be somewhere.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool opens a session, moves it to a URL and closes
 * it again. Navigating with no session open starts one, so the
 * common path costs a single call. Registered from go-tool.ts,
 * which loads this on the tool's first call.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// The catalogue's own module, rather than puppeteer's root, which
// would load all of puppeteer to read one table.
import { KnownDevices } from "puppeteer-core/internal/common/Device.js";
import { count } from "../../lib/core/web/audit/verdict.ts";
import {
	deviceEmulation,
	noSuchDevice,
} from "../../lib/core/web/environment/devices.ts";
import {
	type EmulationState,
	type NetworkRule,
	readState,
	renderEnvironment,
	renderShaping,
	renderTabs,
	type ThrottleConditions,
	throttleNames,
	throttleProfile,
} from "../../lib/core/web/environment/index.ts";
import {
	type BrowserSession,
	CookieSetupNeeded,
} from "../../lib/core/web/session.ts";
import { renderDialogs } from "../../lib/core/web/telemetry/index.ts";
import type { GoParams } from "./go-tool.ts";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.ts";
import { answer, refusal } from "./result.ts";
import { pageView } from "./see.ts";
import { storageAnswer } from "./stored.ts";

/**
 * Turn the tool's flat parameters into an emulation intent.
 *
 * A device name expands into viewport, scale and touch at once,
 * using the catalogue Chrome's own tooling ships rather than a
 * table of our own that would drift from real hardware.
 */
function emulationFrom(params: {
	device?: string;
	width?: number;
	height?: number;
	colorScheme?: "light" | "dark";
	reducedMotion?: boolean;
	contrast?: "more" | "less" | "no-preference";
	forcedColors?: boolean;
	vision?: string;
	media?: "screen" | "print";
	touch?: boolean;
	timezone?: string;
	locale?: string;
	cpuThrottle?: number;
}):
	| { state: EmulationState; clear: readonly (keyof EmulationState)[] }
	| { error: string } {
	const state: Record<string, unknown> = {};
	const clear: (keyof EmulationState)[] = [];

	if (params.device !== undefined && params.device !== "none") {
		// The library resolves a device name itself, so the name is
		// all that needs passing on. Refusing here anyway, rather than
		// letting it come back as a divergence, is worth the
		// duplication: a typo should stop the call before it changes
		// anything, and it can be answered with candidates.
		if (!deviceEmulation(params.device, KnownDevices)) {
			return { error: noSuchDevice(params.device, KnownDevices) };
		}
		state.device = params.device;
	} else if (params.device === "none") {
		// An explicit none has to take the override off, and naming
		// the fields is the only way to say so: a key set to nothing
		// is indistinguishable from a key left out, so this used to
		// leave the session pretending to be a phone for ever.
		clear.push("device", "viewport", "touch", "userAgent");
	}

	if (params.width !== undefined && params.height !== undefined) {
		state.viewport = { width: params.width, height: params.height };
	}
	for (const key of [
		"colorScheme",
		"reducedMotion",
		"contrast",
		"forcedColors",
		"vision",
		"media",
		"touch",
		"timezone",
		"locale",
		"cpuThrottle",
	] as const) {
		if (params[key] !== undefined) state[key] = params[key];
	}

	return { state: state as EmulationState, clear };
}

/**
 * What to say when the page never arrived.
 *
 * Being offline on purpose is a normal thing to be, so this reads
 * as a report rather than a scolding, and points at the log that
 * holds the detail.
 *
 * It used to promise the session had not moved. Measured against
 * a tab crashed on purpose: the navigation aborts in one
 * millisecond and Chrome announces the crash about a second and
 * a half later, so the promise was written before anything could
 * know, and by the time it was read the session had been moved
 * to a blank replacement tab. A failed navigation cannot speak
 * for where the session ends up, so it no longer tries; the page
 * read that follows says when a crash has stranded it.
 */
function arrivalFailed(failure: string): string {
	return (
		`The page did not arrive: ${failure}. Nothing was loaded. ` +
		"The attempt is in the request log: read requests with " +
		"filter failed."
	);
}

/** Turn the tool's flat parameters into a shaping change. */
function shapingFrom(params: {
	mock?: string;
	block?: string;
	status?: number;
	body?: string;
	contentType?: string;
	throttle?: string;
	clear?: boolean;
}):
	| {
			change: {
				rules?: readonly NetworkRule[];
				throttle?: ThrottleConditions;
				clear?: boolean;
			};
	  }
	| { error: string } {
	if (params.clear) return { change: { clear: true } };

	const rules: NetworkRule[] = [];
	if (params.mock !== undefined) {
		rules.push({
			pattern: params.mock,
			action: "mock",
			...(params.status === undefined ? {} : { status: params.status }),
			...(params.body === undefined ? {} : { body: params.body }),
			...(params.contentType === undefined
				? {}
				: { contentType: params.contentType }),
		});
	}
	if (params.block !== undefined) {
		rules.push({ pattern: params.block, action: "block" });
	}

	let throttle: ThrottleConditions | undefined;
	if (params.throttle !== undefined) {
		throttle = throttleProfile(params.throttle);
		if (!throttle) {
			return {
				error:
					`No speed called '${params.throttle}'. Try one of ` +
					`${throttleNames().join(", ")}.`,
			};
		}
	}

	return {
		change: {
			...(rules.length === 0 ? {} : { rules }),
			...(throttle === undefined ? {} : { throttle }),
		},
	};
}

/**
 * Read, write or empty what the page has kept.
 *
 * The clipboard is left out of a bare read: it belongs to the
 * whole machine rather than to the page, and helping yourself
 * to it because someone asked what a site had stored would be
 * a surprise.
 */
async function runStorage(
	ctx: Pick<ExtensionContext, "sessionManager">,
	session: BrowserSession,
	params: {
		store?: "local" | "session" | "cookies" | "clipboard" | "all";
		key?: string;
		value?: string;
		clear?: boolean;
		save?: string;
		load?: string;
	},
): Promise<string> {
	if (params.save !== undefined)
		return await saveSignedIn(session, params.save);
	if (params.load !== undefined)
		return await loadSignedIn(session, params.load);

	const store = params.store ?? "all";
	const wanted = {
		local: store === "local" || store === "all",
		session: store === "session" || store === "all",
		cookies: store === "cookies" || store === "all",
		clipboard: store === "clipboard",
	};

	if (params.clear) {
		await session.clearStorage(wanted);
		return `Emptied ${store === "all" ? "local storage, session storage and cookies" : store}.`;
	}

	if (params.value !== undefined) {
		if (store === "clipboard") {
			await session.writeClipboard(params.value);
			return `Put ${JSON.stringify(params.value)} on the clipboard.`;
		}
		if (params.key === undefined) {
			return `Writing to ${store} needs a key as well as a value.`;
		}
		if (store !== "local" && store !== "session") {
			return "Only local and session storage can be written this way.";
		}
		await session.setStored(store === "local", params.key, params.value);
		return `Set ${params.key} in ${store} storage.`;
	}

	return storageAnswer(ctx, await session.storage(wanted));
}

/**
 * Keep everything that makes this session signed in, in a file.
 *
 * Written where the caller asked rather than into the session
 * bundle, because the whole point is to outlive this session, and
 * a path a caller chose is one they can find again.
 */
async function saveSignedIn(
	session: BrowserSession,
	path: string,
): Promise<string> {
	const state = await session.saveState();
	try {
		await writeFile(path, JSON.stringify(state, null, 1), "utf8");
	} catch (err) {
		return `Could not write the state to ${path}: ${String(err)}`;
	}
	return (
		`Saved ${count(state.cookies.length, "cookie")}, ` +
		`${count(state.local.length, "local entry")} and ` +
		`${count(state.session.length, "session entry")} for ` +
		`${state.origin} to ${path}. Load it in another browser after ` +
		"navigating to that origin, then reload so the page reads it."
	);
}

/** Wear a state saved earlier, saying exactly what landed. */
async function loadSignedIn(
	session: BrowserSession,
	path: string,
): Promise<string> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		return `Could not read a state from ${path}: ${String(err)}`;
	}
	const state = readState(text);
	if ("problem" in state) {
		return `${path} is not a saved state: ${state.problem}`;
	}

	const landed = await session.loadState(state);
	if (landed.wrongOrigin !== undefined) {
		return (
			`Restored ${count(landed.cookies, "cookie")}, which apply ` +
			`everywhere. The stored entries belong to ${state.origin} and ` +
			`this browser is on ${landed.wrongOrigin}, so none were ` +
			"written. Navigate to that origin and load it again."
		);
	}
	return (
		`Restored ${count(landed.cookies, "cookie")}, ` +
		`${count(landed.local, "local entry")} and ` +
		`${count(landed.session, "session entry")} for ${state.origin}. ` +
		"Reload for the page to read them."
	);
}

/** What browser_go does with one call. */
export async function runGo(
	ctx: Pick<ExtensionContext, "sessionManager">,
	registry: SessionRegistry,
	params: GoParams,
	signal: AbortSignal | undefined,
) {
	const name = params.session ?? DEFAULT_SESSION;
	// A url is an intent to go there; without one there is
	// nowhere to go, so the only thing left is to open.
	const kind = params.kind ?? (params.url ? "navigate" : "open");

	// Close takes no turn: it is how a session whose call is stuck
	// gets put down, so it must not queue behind that call.
	if (kind === "close") {
		const closed = await registry.close(name);
		return answer(
			name,
			kind,
			closed ? `Closed browser '${name}'.` : `No browser '${name}'.`,
		);
	}

	if (kind === "navigate" && !params.url) {
		return refusal(name, kind, "navigate needs a url.");
	}

	return registry.use(name, signal, async () => {
		let session: BrowserSession;
		try {
			session = await registry.acquire(name, {
				...(params.cookies === undefined ? {} : { cookies: params.cookies }),
			});
		} catch (err) {
			// Asking for cookies that are not set up is a fixable
			// mistake, so say how to fix it rather than throwing.
			if (err instanceof CookieSetupNeeded) {
				return refusal(name, kind, err.message);
			}
			throw err;
		}

		// Reloading and stepping through history land on a page just
		// as navigating does, so they answer the same way. They used
		// to report only a URL, which meant confirming where you
		// actually ended up took a second call, and a reload that
		// changed the page said exactly as much as one that did not.
		if (kind === "reload") {
			const again = await session.reload();
			if (again.failure) {
				return refusal(name, kind, arrivalFailed(again.failure));
			}
			return answer(
				name,
				kind,
				`Reloaded ${session.url}.\n\n${await pageView(ctx, session)}`,
			);
		}

		if (kind === "back" || kind === "forward") {
			const moved = await session.step(kind);
			if (!moved.ok) return refusal(name, kind, moved.refusal);
			// Stepping back past the first navigation lands on the blank
			// page the session started on. That is the truth, but an
			// outline of nothing reads like a fault, so it is named.
			const landed =
				moved.url === "about:blank"
					? "This is the blank page the browser started on, " +
						"before its first navigation."
					: await pageView(ctx, session);
			return answer(name, kind, `Went ${kind} to ${moved.url}.\n\n${landed}`);
		}

		if (kind === "network") {
			const shaped = shapingFrom(params);
			if ("error" in shaped) return refusal(name, kind, shaped.error);
			const { rules, throttle } = await session.shape(shaped.change);
			return answer(name, kind, renderShaping(rules, throttle));
		}

		if (kind === "storage") {
			return answer(name, kind, await runStorage(ctx, session, params));
		}

		if (kind === "tabs") {
			if (params.tab === undefined) {
				return answer(name, kind, renderTabs(await session.tabs()));
			}
			const switched = await session.switchTab(params.tab);
			if ("refusal" in switched) return answer(name, kind, switched.refusal);
			return answer(
				name,
				kind,
				`Now driving tab ${switched.index}, ${switched.url}. The tab ` +
					"you left is still open and can be switched back to.",
			);
		}

		if (kind === "emulate") {
			const change = emulationFrom(params);
			if ("error" in change) return refusal(name, kind, change.error);
			const { asked, observed, gaps } = await session.emulate(
				change.state,
				change.clear,
			);
			return answer(name, kind, renderEnvironment(asked, observed, gaps));
		}

		if (kind === "dialogs") {
			if (params.accept !== undefined || params.promptText !== undefined) {
				session.setDialogPolicy({
					accept: params.accept ?? false,
					...(params.promptText === undefined
						? {}
						: { promptText: params.promptText }),
				});
			}
			const { policy, seen } = session.dialogs;
			const stance = policy.accept
				? `Dialogs are accepted${
						policy.promptText === undefined
							? ""
							: `, and prompts answered "${policy.promptText}"`
					}.`
				: "Dialogs are dismissed.";
			return answer(name, kind, `${stance}\n\n${renderDialogs(seen)}`);
		}

		if (!params.url) {
			return answer(name, kind, `Opened browser '${name}'.`);
		}
		const { status, failure } = await session.navigate(params.url);
		if (failure) return refusal(name, kind, arrivalFailed(failure));
		// An error page looks like a page. Saying the status up
		// front is the difference between checking the site and
		// checking its 404, which every later check would
		// otherwise judge without knowing.
		const arrival =
			status !== undefined && status >= 400
				? `The server answered ${status}. What follows is that ` +
					"response, not the page you asked for.\n\n"
				: "";
		return answer(name, kind, `${arrival}${await pageView(ctx, session)}`);
	});
}
