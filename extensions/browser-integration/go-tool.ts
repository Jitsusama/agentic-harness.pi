/**
 * browser_go as pi sees it: its name, its words and its parameters.
 * What it does is in go.ts, loaded on its first call (see sessions.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadOnce } from "../../lib/internal/single-flight.ts";
import { BROWSER_EXPOSURE } from "./exposure.ts";
import { renderBrowserCall, renderBrowserResult } from "./render.ts";
import type { Sessions } from "./sessions.ts";

const goModule = loadOnce(() => import("./go.ts"));

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
					"open: start a browser (optionally at a url). " +
					"navigate: go to a url, opening a browser when none is live. " +
					"close: dispose the browser. " +
					"reload: fetch the current page again. " +
					"back and forward: step through the browser's history. " +
					"dialogs: decide how alerts and confirms get answered, and " +
					"read back the ones already seen. " +
					"emulate: be a different visitor, by device, viewport, media " +
					"preference, sight, locale or clock. " +
					"tabs: list the tabs open, or switch to one. " +
					"storage: read, write or clear what the page has kept, or " +
					"save the signed-in state to a file and load it back in " +
					"another browser. " +
					"network: mock, block, throttle or go offline, and " +
					"clear to undo all of it. " +
					"Defaults to navigate with a url, open without one.",
			},
		),
	),
	session: Type.Optional(
		Type.String({
			description: "Which browser, by name. Defaults to 'default'.",
		}),
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
				"For storage: write everything keeping this browser signed " +
				"in, cookies and both DOM stores, to this file path. Sign " +
				"in once and every later browser can wear it.",
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
				"rules otherwise accumulate for the browser's life.",
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
				"Carry your own Chrome cookies into this browser, for sites " +
				"you are already signed in to. Applies when the browser is " +
				"first opened. Defaults to false: a browser is a clean user.",
		}),
	),
});

/** What browser_go is called with. */
export type GoParams = Static<typeof parameters>;

/** Register the navigation half of the browser family. */
export function registerGo(pi: ExtensionAPI, sessions: Sessions): void {
	pi.registerTool({
		name: "browser_go",
		...BROWSER_EXPOSURE,
		label: "Browser Go",
		description:
			"Put a browser somewhere. kind 'navigate' goes to a url and " +
			"opens a browser if none is live; kind 'open' starts one, with " +
			"a url if you have one; kind 'close' disposes it. Passing just a url " +
			"navigates. Navigating returns the page's accessibility outline, so " +
			"you see where you landed. Each browser gets its own cookies and " +
			"storage, so two named browsers are two independent users. " +
			"A javascript dialog stops the page until it is answered, so " +
			"browsers dismiss them by default; kind 'dialogs' changes that " +
			"and reports the ones already raised.",
		promptSnippet:
			"browser_go puts a browser somewhere and sets the " +
			"conditions it runs under: navigate, open, close, reload, " +
			"back, forward, emulate a device, shape the network, read " +
			"storage, reach a tab the page opened, answer dialogs. Read " +
			"the browser-guide skill.",
		parameters,
		renderCall: (args, theme, context) =>
			renderBrowserCall("go", args, theme, context?.lastComponent),
		renderResult: (result, options, theme, context) =>
			renderBrowserResult(result, options, theme, context?.lastComponent),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { runGo } = await goModule();
			return runGo(ctx, await sessions(), params, signal);
		},
	});
}
