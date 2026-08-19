/**
 * browser_go: be somewhere.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool opens a session, moves it to a URL and closes
 * it again. Navigating with no session open starts one, so the
 * common path costs a single call.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { count } from "@jitsusama/agentic-harness.core/web/audit/verdict";
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
} from "@jitsusama/agentic-harness.core/web/environment";
import {
	deviceEmulation,
	noSuchDevice,
} from "@jitsusama/agentic-harness.core/web/environment/devices";
import {
	type BrowserSession,
	CookieSetupNeeded,
} from "@jitsusama/agentic-harness.core/web/session";
import { renderDialogs } from "@jitsusama/agentic-harness.core/web/telemetry";
import { Type } from "@sinclair/typebox";
import { KnownDevices } from "puppeteer-core";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { renderBrowserCall, renderBrowserResult } from "./render.js";
import { answer, refusal } from "./result.js";
import { pageView } from "./see.js";
import { storageAnswer } from "./stored.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("open"),
				Type.Literal("navigate"),
				Type.Literal("close"),
				Type.Literal("reload"),
				Type.Literal("back"),
				Type.Literal("forward"),
				Type.Literal("dialogs"),
				Type.Literal("emulate"),
				Type.Literal("storage"),
				Type.Literal("tabs"),
				Type.Literal("network"),
			],
			{
				description:
					"open: start a session (optionally at a url). " +
					"navigate: go to a url, opening a session when none is live. " +
					"close: dispose the session. " +
					"reload: fetch the current page again. " +
					"back and forward: step through the session's history. " +
					"dialogs: decide how alerts and confirms get answered, and " +
					"read back the ones already seen. " +
					"emulate: be a different visitor, by device, viewport, media " +
					"preference, sight, locale or clock. " +
					"tabs: list the tabs open, or switch to one. " +
					"storage: read, write or clear what the page has kept, or " +
					"save the signed-in state to a file and load it back in " +
					"another session. " +
					"network: mock, block, throttle or go offline, and " +
					"clear to undo all of it. " +
					"Defaults to navigate with a url, open without one.",
			},
		),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	url: Type.Optional(Type.String({ description: "URL for open or navigate." })),
	mock: Type.Optional(
		Type.String({
			description:
				"For network: a url pattern to answer ourselves, e.g. " +
				"'*/api/*'. Give status, body and contentType to say what " +
				"it answers with.",
		}),
	),
	block: Type.Optional(
		Type.String({
			description:
				"For network: a url pattern to refuse, e.g. '*.png'. Use to " +
				"see what a page does without an asset it expects.",
		}),
	),
	status: Type.Optional(
		Type.Number({ description: "For network mock: the status to answer." }),
	),
	body: Type.Optional(
		Type.String({ description: "For network mock: the body to answer with." }),
	),
	contentType: Type.Optional(
		Type.String({ description: "For network mock: what the body is." }),
	),
	throttle: Type.Optional(
		Type.String({
			description:
				"For network: a speed to pretend. One of offline, slow-3g, " +
				"slow-4g, fast-4g, none. The numbers are Chrome's own.",
		}),
	),
	store: Type.Optional(
		Type.Union(
			[
				Type.Literal("local"),
				Type.Literal("session"),
				Type.Literal("cookies"),
				Type.Literal("clipboard"),
				Type.Literal("all"),
			],
			{
				description:
					"For storage: which store to work with. Defaults to all, " +
					"which reads everything but the clipboard.",
			},
		),
	),
	key: Type.Optional(
		Type.String({
			description: "For storage: the key to write, with value.",
		}),
	),
	value: Type.Optional(
		Type.String({
			description:
				"For storage: the value to write under key, or the text to " +
				"put on the clipboard.",
		}),
	),
	tab: Type.Optional(
		Type.Number({
			description:
				"For tabs: switch to this tab, numbered as the listing " +
				"shows. Omit to just list what is open. Every read and act " +
				"goes to the tab being driven, so a page that opened " +
				"another one is only reachable by switching to it.",
		}),
	),
	save: Type.Optional(
		Type.String({
			description:
				"For storage: write everything keeping this session signed " +
				"in, cookies and both DOM stores, to this file path. Sign " +
				"in once and every later session can wear it.",
		}),
	),
	load: Type.Optional(
		Type.String({
			description:
				"For storage: put back a state saved earlier, from this " +
				"file path. Navigate to the origin first, since the DOM " +
				"stores belong to one, then reload so the page reads them.",
		}),
	),
	clear: Type.Optional(
		Type.Boolean({
			description:
				"For storage: empty the named store instead of reading. " +
				"For network: drop every rule and the throttle, since " +
				"rules otherwise accumulate for the session's life.",
		}),
	),
	device: Type.Optional(
		Type.String({
			description:
				"For emulate: a device to imitate, by the names Chrome " +
				"itself ships (for example 'iPhone 15 Pro', 'Pixel 5', " +
				"'iPad landscape'). Sets viewport, scale and touch " +
				"together. Pass 'none' to stop imitating one.",
		}),
	),
	width: Type.Optional(
		Type.Number({ description: "For emulate: viewport width in pixels." }),
	),
	height: Type.Optional(
		Type.Number({ description: "For emulate: viewport height in pixels." }),
	),
	colorScheme: Type.Optional(
		Type.Union([Type.Literal("light"), Type.Literal("dark")], {
			description: "For emulate: what prefers-color-scheme should say.",
		}),
	),
	reducedMotion: Type.Optional(
		Type.Boolean({
			description: "For emulate: whether the visitor asks for reduced motion.",
		}),
	),
	contrast: Type.Optional(
		Type.Union(
			[
				Type.Literal("more"),
				Type.Literal("less"),
				Type.Literal("no-preference"),
			],
			{ description: "For emulate: what prefers-contrast should say." },
		),
	),
	forcedColors: Type.Optional(
		Type.Boolean({
			description:
				"For emulate: whether a forced colour mode is in effect, as " +
				"Windows high contrast does.",
		}),
	),
	vision: Type.Optional(
		Type.Union(
			[
				Type.Literal("none"),
				Type.Literal("achromatopsia"),
				Type.Literal("blurredVision"),
				Type.Literal("deuteranopia"),
				Type.Literal("protanopia"),
				Type.Literal("tritanopia"),
				Type.Literal("reducedContrast"),
			],
			{
				description:
					"For emulate: a sight condition to paint through. Changes " +
					"what a screenshot shows; invisible to the page's scripts.",
			},
		),
	),
	media: Type.Optional(
		Type.Union([Type.Literal("screen"), Type.Literal("print")], {
			description: "For emulate: which media the page is laid out for.",
		}),
	),
	touch: Type.Optional(
		Type.Boolean({ description: "For emulate: report a touch screen." }),
	),
	timezone: Type.Optional(
		Type.String({
			description: "For emulate: an IANA timezone, e.g. 'Asia/Tokyo'.",
		}),
	),
	locale: Type.Optional(
		Type.String({
			description:
				"For emulate: a locale for formatting, e.g. 'fr-CA'. Note " +
				"this does not reach navigator.language.",
		}),
	),
	cpuThrottle: Type.Optional(
		Type.Number({
			description:
				"For emulate: slow the processor by this factor, 1 being " +
				"full speed.",
		}),
	),
	accept: Type.Optional(
		Type.Boolean({
			description:
				"For dialogs: accept them from now on, rather than " +
				"dismissing. A dialog stops the page until it is answered, " +
				"so one of the two always happens; the default is to " +
				"dismiss, which changes least.",
		}),
	),
	promptText: Type.Optional(
		Type.String({
			description: "For dialogs: what to type into an accepted prompt.",
		}),
	),
	cookies: Type.Optional(
		Type.Boolean({
			description:
				"Carry your own Chrome cookies into this session, for sites " +
				"you are already signed in to. Applies when the session is " +
				"first opened. Defaults to false: a session is a clean user.",
		}),
	),
});

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

	return storageAnswer(await session.storage(wanted));
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
		`${state.origin} to ${path}. Load it in another session after ` +
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
			`this session is on ${landed.wrongOrigin}, so none were ` +
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

/** Register the navigation half of the browser family. */
export function registerGo(pi: ExtensionAPI, registry: SessionRegistry): void {
	pi.registerTool({
		name: "browser_go",
		label: "Browser Go",
		description:
			"Put a browser session somewhere. kind 'navigate' goes to a url and " +
			"opens a session if none is live; kind 'open' starts a session, with " +
			"a url if you have one; kind 'close' disposes it. Passing just a url " +
			"navigates. Navigating returns the page's accessibility outline, so " +
			"you see where you landed. Each session gets its own cookies and " +
			"storage, so two named sessions are two independent users. " +
			"A javascript dialog stops the page until it is answered, so " +
			"sessions dismiss them by default; kind 'dialogs' changes that " +
			"and reports the ones already raised.",
		promptSnippet:
			"browser_go puts a browser session somewhere and sets the " +
			"conditions it runs under: navigate, open, close, reload, " +
			"back, forward, emulate a device, shape the network, read " +
			"storage, reach a tab the page opened, answer dialogs. Read " +
			"the browser-guide skill.",
		parameters,
		renderCall: (args, theme, context) =>
			renderBrowserCall("go", args, theme, context?.lastComponent),
		renderResult: (result, options, theme, context) =>
			renderBrowserResult(result, options, theme, context?.lastComponent),
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			// A url is an intent to go there; without one there is
			// nowhere to go, so the only thing left is to open.
			const kind = params.kind ?? (params.url ? "navigate" : "open");

			if (kind === "close") {
				const closed = await registry.close(name);
				return answer(
					name,
					kind,
					closed ? `Closed session '${name}'.` : `No session '${name}'.`,
				);
			}

			if (kind === "navigate" && !params.url) {
				return refusal(name, kind, "navigate needs a url.");
			}

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
					`Reloaded ${session.url}.\n\n${await pageView(session)}`,
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
						? "This is the blank page the session started on, " +
							"before its first navigation."
						: await pageView(session);
				return answer(name, kind, `Went ${kind} to ${moved.url}.\n\n${landed}`);
			}

			if (kind === "network") {
				const shaped = shapingFrom(params);
				if ("error" in shaped) return refusal(name, kind, shaped.error);
				const { rules, throttle } = await session.shape(shaped.change);
				return answer(name, kind, renderShaping(rules, throttle));
			}

			if (kind === "storage") {
				return answer(name, kind, await runStorage(session, params));
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
				return answer(name, kind, `Opened session '${name}'.`);
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
			return answer(name, kind, `${arrival}${await pageView(session)}`);
		},
	});
}
