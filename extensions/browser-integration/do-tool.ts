/**
 * browser_do as pi sees it: its name, its words and its parameters.
 * What it does is in do.ts, loaded on its first call (see sessions.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadOnce } from "../../lib/internal/single-flight.ts";
import { BROWSER_EXPOSURE } from "./exposure.ts";
import { renderBrowserCall, renderBrowserResult } from "./render.ts";
import type { Sessions } from "./sessions.ts";

const doModule = loadOnce(() => import("./do.ts"));

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("act"),
				Type.Literal("press"),
				Type.Literal("input"),
				Type.Literal("wait"),
				Type.Literal("eval"),
			],
			{
				description:
					"act: operate an element named by role and accessible " +
					"name, the default. press: send a chord or a sequence of " +
					"them, like 'Ctrl+Shift+K' or 'Tab Tab Enter', wherever " +
					"focus is. input: raw pointer and touch gestures at " +
					"coordinates, for what semantics cannot reach. wait: hold " +
					"until the page reaches a state, saying what it saw if it " +
					"never does. eval: run an expression in the page and " +
					"describe what came back, exceptions included.",
			},
		),
	),
	session: Type.Optional(
		Type.String({
			description: "Which browser, by name. Defaults to 'default'.",
		}),
	),
	expression: Type.Optional(
		Type.String({
			description:
				"For eval: the JavaScript to run, as an expression rather " +
				"than statements. A promise is awaited. DOM nodes, " +
				"functions and circular structures are described rather " +
				"than serialized.",
		}),
	),
	for: Type.Optional(
		Type.Union(
			[
				Type.Literal("selector"),
				Type.Literal("gone"),
				Type.Literal("text"),
				Type.Literal("attribute"),
				Type.Literal("count"),
				Type.Literal("idle"),
				Type.Literal("request"),
				Type.Literal("animations"),
				Type.Literal("duration"),
			],
			{
				description:
					"For wait: selector or gone for an element appearing or " +
					"leaving, text for words on the page, idle for the " +
					"network going quiet, request for one matching a pattern " +
					"finishing, attribute for an element's attribute reaching " +
					"a value (aria-busy going false, aria-expanded going " +
					"true), count for a number of matching elements being " +
					"there, animations for motion settling, duration to " +
					"simply pass time.",
			},
		),
	),
	selector: Type.Optional(
		Type.String({
			description:
				"For wait selector, gone, attribute and count: the CSS selector.",
		}),
	),
	attribute: Type.Optional(
		Type.String({
			description:
				"For wait attribute: which attribute to watch, e.g. " +
				"'aria-busy'. Pair with 'value' for the value to wait for, " +
				"or omit it to wait for the attribute to be removed.",
		}),
	),
	value: Type.Optional(
		Type.String({
			description:
				"For wait attribute: the value that ends the wait. Omit to " +
				"wait for the attribute to go away entirely.",
		}),
	),
	count: Type.Optional(
		Type.Number({
			description:
				"For wait count: how many elements must match the " +
				"selector. Exact, not a minimum, so a list that overshoots " +
				"is a finding rather than a pass. For input click: 2 " +
				"double-clicks.",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description:
				"For wait request: a url pattern, e.g. '*/api/save'. The " +
				"answer reports the status it got.",
		}),
	),
	status: Type.Optional(
		Type.Number({
			description:
				"For wait request: the status that counts as arrival. " +
				"Without it a request answering 500 ends the wait as " +
				"happily as one answering 200, so a check that the save " +
				"worked passes on a save that failed.",
		}),
	),
	quietMs: Type.Optional(
		Type.Number({
			description: "For wait idle: how long counts as quiet.",
		}),
	),
	ms: Type.Optional(
		Type.Number({
			description: "For wait duration: how long to wait, at most 120000.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"For wait: how long before giving up. Defaults to 10s, at most 120000.",
		}),
	),
	keys: Type.Optional(
		Type.String({
			description:
				"For press: the chord or sequence, e.g. 'Ctrl+Shift+K', " +
				"'Tab Tab Enter', 'Shift+ArrowDown'. Space is written as " +
				"the word Space.",
		}),
	),
	gesture: Type.Optional(
		Type.Union(
			[
				Type.Literal("click"),
				Type.Literal("drag"),
				Type.Literal("move"),
				Type.Literal("wheel"),
				Type.Literal("tap"),
				Type.Literal("longPress"),
				Type.Literal("swipe"),
				Type.Literal("pinch"),
			],
			{
				description:
					"For input: which gesture. click, drag, move and wheel " +
					"use the mouse; tap, longPress, swipe and pinch use " +
					"touch. All take coordinates in x/y, and the travelling " +
					"ones take toX/toY.",
			},
		),
	),
	x: Type.Optional(Type.Number({ description: "For input: where it starts." })),
	y: Type.Optional(Type.Number({ description: "For input: where it starts." })),
	toX: Type.Optional(
		Type.Number({ description: "For drag, swipe and wheel: where it ends." }),
	),
	toY: Type.Optional(
		Type.Number({ description: "For drag, swipe and wheel: where it ends." }),
	),
	spread: Type.Optional(
		Type.Number({
			description: "For pinch: how far apart the fingers start, in pixels.",
		}),
	),
	toSpread: Type.Optional(
		Type.Number({
			description: "For pinch: how far apart they end. Larger zooms in.",
		}),
	),

	button: Type.Optional(
		Type.String({
			description: "For input click and drag: left, middle or right.",
		}),
	),
	steps: Type.Optional(
		Type.Number({
			description:
				"For travelling gestures: how many intermediate moves. More " +
				"steps give a handler more to react to.",
		}),
	),
	holdMs: Type.Optional(
		Type.Number({
			description: "For longPress: how long to hold, at most 120000.",
		}),
	),
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("click"),
				Type.Literal("type"),
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("clear"),
				Type.Literal("select"),
				Type.Literal("upload"),
				Type.Literal("scrollTo"),
			],
			{
				description:
					"For act: click or type into the element; hover or focus " +
					"it to reveal state-dependent behaviour; clear empties a " +
					"field; select chooses an option by its text; upload puts " +
					"files on a file input, named in 'files'; scrollTo brings " +
					"it into view.",
			},
		),
	),
	role: Type.Optional(
		Type.String({ description: "For act: the target element's role." }),
	),
	name: Type.Optional(
		Type.String({ description: "For act: the target's accessible name." }),
	),
	text: Type.Optional(
		Type.String({
			description:
				"For action 'type': the text to enter. For 'select': the " +
				"option to choose.",
		}),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For action 'upload': absolute paths to put on the file " +
				"input. Target the input itself, which is usually hidden " +
				"behind a styled label and reads as a button in the " +
				"outline; it does not have to be visible.",
		}),
	),
	container: Type.Optional(
		Type.String({
			description:
				"For act: restrict the search to a container with this " +
				"name, which is how you tell two identically named " +
				"controls apart by where they live.",
		}),
	),
	ordinal: Type.Optional(
		Type.Number({
			description:
				"For act: 1-based position among same-named matches, for " +
				"when no container distinguishes them either.",
		}),
	),
	trace: Type.Optional(
		Type.Union(
			[
				Type.Literal("async"),
				Type.Literal("frames"),
				Type.Array(Type.Union([Type.Literal("async"), Type.Literal("frames")])),
			],
			{
				description:
					"For every kind: record a trace of the browser's own work " +
					"while this runs, and report what caused what. 'async' " +
					"pairs each timer with the fire it caused and each request " +
					"with the response that settled it, so you can see what " +
					"was in flight at once and what answered out of order. " +
					"'frames' reports what the compositor did, for a page that " +
					"scrolls or animates badly. Pass both for both. Tracing " +
					"is browser-wide and only one can run at a time, so a " +
					"second browser asking is refused, and every page pays " +
					"while it runs.",
			},
		),
	),
});

/** What browser_do is called with. */
export type DoParams = Static<typeof parameters>;

/** Register the acting half of the browser family. */
export function registerDo(pi: ExtensionAPI, sessions: Sessions): void {
	pi.registerTool({
		name: "browser_do",
		...BROWSER_EXPOSURE,
		label: "Browser Do",
		description:
			"Act on a browser page. kind 'act' clicks an element or types into " +
			"it, targeting the element the way it reads in the outline: by role " +
			"and accessible name, narrowed by container or by the 1-based " +
			"ordinal among same-named matches. kind 'press' sends a chord " +
			"wherever focus is. kind 'input' sends raw pointer and touch " +
			"gestures at coordinates, for drags, wheels and swipes that no " +
			"semantic action expresses. The page view that follows shows what " +
			"the action did.",
		promptSnippet:
			"browser_do changes a page: act on an element named by role " +
			"and accessible name (waiting for it to be actionable), " +
			"press key chords, send raw pointer and touch gestures, " +
			"wait for a condition, or evaluate an expression. Read the " +
			"browser-guide skill.",
		parameters,
		renderCall: (args, theme, context) =>
			renderBrowserCall("do", args, theme, context?.lastComponent),
		renderResult: (result, options, theme, context) =>
			renderBrowserResult(result, options, theme, context?.lastComponent),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { runDo } = await doModule();
			return runDo(ctx, await sessions(), params, signal);
		},
	});
}
