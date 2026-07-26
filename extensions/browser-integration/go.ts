/**
 * browser_go: be somewhere.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool opens a session, moves it to a URL and closes
 * it again. Navigating with no session open starts one, so the
 * common path costs a single call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { KnownDevices } from "puppeteer-core";
import {
	type EmulationState,
	renderEnvironment,
	renderStorage,
} from "../../lib/web/environment/index.js";
import {
	type BrowserSession,
	CookieSetupNeeded,
} from "../../lib/web/session.js";
import { renderDialogs } from "../../lib/web/telemetry/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";
import { pageView } from "./see.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("open"),
				Type.Literal("navigate"),
				Type.Literal("close"),
				Type.Literal("dialogs"),
				Type.Literal("emulate"),
				Type.Literal("storage"),
			],
			{
				description:
					"open: start a session (optionally at a url). " +
					"navigate: go to a url, opening a session when none is live. " +
					"close: dispose the session. " +
					"dialogs: decide how alerts and confirms get answered, and " +
					"read back the ones already seen. " +
					"emulate: be a different visitor, by device, viewport, media " +
					"preference, sight, locale or clock. " +
					"storage: read, write or clear what the page has kept. " +
					"Defaults to navigate with a url, open without one.",
			},
		),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	url: Type.Optional(Type.String({ description: "URL for open or navigate." })),
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
	clear: Type.Optional(
		Type.Boolean({
			description: "For storage: empty the named store instead of reading.",
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
}): { state: EmulationState } | { error: string } {
	const state: Record<string, unknown> = {};

	if (params.device !== undefined && params.device !== "none") {
		const known = KnownDevices[params.device as keyof typeof KnownDevices];
		if (!known) {
			// Fall back to the family name, since a wrong model number
			// is the likeliest way to miss and matching the whole string
			// would then offer nothing at all.
			const asked = params.device.toLowerCase();
			const family = asked.split(" ")[0] ?? asked;
			const names = Object.keys(KnownDevices);
			const near = (
				names.filter((candidate) => candidate.toLowerCase().includes(asked))
					.length > 0
					? names.filter((candidate) => candidate.toLowerCase().includes(asked))
					: names.filter((candidate) =>
							candidate.toLowerCase().includes(family),
						)
			).slice(0, MAX_DEVICE_SUGGESTIONS);
			return {
				error:
					`No device named '${params.device}'.` +
					(near.length > 0
						? ` Did you mean ${near.join(", ")}?`
						: " Chrome ships names like 'iPhone 15 Pro' and 'Pixel 5'."),
			};
		}
		state.device = params.device;
		state.viewport = {
			width: known.viewport.width,
			height: known.viewport.height,
			deviceScaleFactor: known.viewport.deviceScaleFactor,
			mobile: known.viewport.isMobile,
		};
		state.touch = known.viewport.hasTouch;
	} else if (params.device === "none") {
		// An explicit none has to clear the override, which an
		// absent viewport does and an absent key cannot.
		state.device = undefined;
		state.viewport = undefined;
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

	return { state: state as EmulationState };
}

/** How many near-miss device names are worth offering. */
const MAX_DEVICE_SUGGESTIONS = 5;

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
	},
): Promise<string> {
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

	return renderStorage(await session.storage(wanted));
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
			"Move a browser session with browser_go (navigate, open, " +
			"close, dialogs).",
		parameters,
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

			if (kind === "storage") {
				return answer(name, kind, await runStorage(session, params));
			}

			if (kind === "emulate") {
				const change = emulationFrom(params);
				if ("error" in change) return refusal(name, kind, change.error);
				const { asked, observed, gaps } = await session.emulate(change.state);
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
			await session.navigate(params.url);
			return answer(name, kind, await pageView(session));
		},
	});
}
