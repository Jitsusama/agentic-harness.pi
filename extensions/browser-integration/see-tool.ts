/**
 * browser_see as pi sees it: its name, its words and its parameters.
 * What it does is in see.ts, loaded on its first call (see sessions.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import {
	MAX_OUTLINE_BUDGET_BYTES,
	OUTLINE_BUDGET_BYTES,
} from "../../lib/core/web/a11y/budget.ts";
import { loadOnce } from "../../lib/internal/single-flight.ts";
import { BROWSER_EXPOSURE } from "./exposure.ts";
import { renderBrowserCall, renderBrowserResult } from "./render.ts";
import type { Sessions } from "./sessions.ts";

const seeModule = loadOnce(() => import("./see.ts"));

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("page"),
				Type.Literal("reading"),
				Type.Literal("announcements"),
				Type.Literal("logs"),
				Type.Literal("requests"),
				Type.Literal("status"),
				Type.Literal("downloads"),
				Type.Literal("query"),
				Type.Literal("vitals"),
				Type.Literal("element"),
				Type.Literal("measure"),
				Type.Literal("sockets"),
				Type.Literal("heap"),
				Type.Literal("profile"),
				Type.Literal("layers"),
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("shot"),
			],
			{
				description:
					"page: the accessibility outline of what is on screen, " +
					"the default. reading: the same page narrated the way a " +
					"screen reader would say it. logs: what the page said, " +
					"threw, or had refused for it. requests: what the page " +
					"asked the network for. vitals: what the page cost to " +
					"show, from the browser's own performance observers. " +
					"query: search the whole page, " +
					"frames and shadow content included, for nodes matching " +
					"a tag, attribute, class or text. downloads: files the " +
					"page handed " +
					"back. status: where this browser stands, " +
					"including what it is pretending to be. announcements: " +
					"what the page " +
					"said out loud through its live regions. focus: which " +
					"element holds focus right now, which is how to check " +
					"where a click, a key or a navigation left it, and it " +
					"moves nothing. element: " +
					"everything about one element, named with 'within'. " +
					"measure: the space between two elements, named with " +
					"'within' and 'and': the gap, what lines up, and " +
					"whether they are the same size. sockets: every " +
					"websocket the page opened and both sides of what was " +
					"said over it. heap: how much memory the page is " +
					"holding, compared against the last reading, which is " +
					"how a leak is found. profile: record the page's " +
					"JavaScript for a while and report which functions spent " +
					"the time, which is what a long task cannot tell you. " +
					"layers: what the page asked the compositor to keep, how " +
					"much texture memory that costs, and the reason Chrome " +
					"gives for each one, which is how a layer explosion is " +
					"found. hover: what the page does on hover across every " +
					"element that has a hover rule, and whether focus does the " +
					"same, which is how a cue only a mouse can reach is found. " +
					"shot: a picture, written to disk and reported by path, " +
					"of the viewport, or of the whole page with 'fullPage', " +
					"or of one element with 'within'.",
			},
		),
	),
	session: Type.Optional(
		Type.String({
			description: "Which browser, by name. Defaults to 'default'.",
		}),
	),
	within: Type.Optional(
		Type.String({
			description:
				"Read only the branch under this element, named as " +
				"'role name', e.g. 'navigation Main' or 'form Checkout'. " +
				"For kind 'element', the element to inspect. For kind " +
				"'shot', the element to photograph, cropped to its box " +
				"rather than the whole page. For kind 'measure', the first " +
				"of the two elements to measure between.",
		}),
	),
	collect: Type.Optional(
		Type.Boolean({
			description:
				"For heap: force a garbage collection before measuring. " +
				"Defaults to true, and you almost never want false: " +
				"without it, garbage nobody has swept yet counts the same " +
				"as memory nobody can free, so growth proves nothing.",
		}),
	),
	and: Type.Optional(
		Type.String({
			description:
				"For measure: the second element, named as 'role name'. " +
				"The gap is measured between border boxes, which is the " +
				"edge you see.",
		}),
	),
	styles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For element: report exactly these CSS properties instead " +
				"of the curated set. For query: report them for every " +
				"match, which is how to sweep a whole page for a computed " +
				"value rather than reading one element at a time.",
		}),
	),
	why: Type.Optional(
		Type.String({
			description:
				"For element: trace why this one CSS property has the " +
				"value it has, through every rule that had a say.",
		}),
	),
	fullPage: Type.Optional(
		Type.Boolean({
			description:
				"For shot: capture the whole scrollable page rather than " +
				"what is on screen. Long pages come back as several " +
				"tiles. Ignored when 'within' names one element, since " +
				"that crops to the element instead.",
		}),
	),
	state: Type.Optional(
		Type.Union(
			[
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("active"),
				Type.Literal("focus-visible"),
			],
			{
				description:
					"For shot: hold this state on the element while " +
					"capturing, so a hover or focus style can be seen.",
			},
		),
	),
	behaviour: Type.Optional(
		Type.Boolean({
			description:
				"For element: also report what is listening on it, what " +
				"is listening further up that its events still reach, and " +
				"what is animating, which answers why a click did nothing.",
		}),
	),
	states: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("active"),
				Type.Literal("focus-visible"),
			]),
			{
				description:
					"For element: hold each of these states and report what " +
					"changes, which is how to check a focus ring exists.",
			},
		),
	),
	depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"For page and reading: keep this many levels of the " +
				"outline. Omit for all of it.",
		}),
	),
	har: Type.Optional(
		Type.Boolean({
			description:
				"For requests: also write the listing to disk as an HTTP " +
				"Archive, which any network tool can open.",
		}),
	),
	filter: Type.Optional(
		Type.String({
			description:
				"For requests: keep only those matching, by resource type " +
				"(script, image, fetch), by state (failed, pending), by " +
				"status, by the word 'errors', or by part of the url.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"For requests: also fetch the body of one request, named " +
				"by the number shown against it (#3, or just 3). Bodies " +
				"are not held as they stream past, so this asks now.",
		}),
	),
	level: Type.Optional(
		Type.String({
			description:
				"For logs: keep only this level, in the browser's own " +
				"vocabulary (error, warning, info, log, debug).",
		}),
	),
	since: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"For logs and announcements: read only what arrived after " +
				"this " +
				"cursor, which the previous read returned.",
		}),
	),
	only: Type.Optional(
		Type.Union(
			[
				Type.Literal("landmarks"),
				Type.Literal("headings"),
				Type.Literal("interactive"),
			],
			{
				description:
					"For page and reading: reduce the page to one kind of " +
					"thing: 'landmarks' for " +
					"how it is laid out, 'headings' for its outline, " +
					"'interactive' for what you can operate.",
			},
		),
	),
	tag: Type.Optional(
		Type.String({ description: "For query: the tag name to look for." }),
	),
	attribute: Type.Optional(
		Type.String({
			description:
				"For query: an attribute that must be present, e.g. " +
				"'data-testid'. Pair with value to require a value too.",
		}),
	),
	value: Type.Optional(
		Type.String({ description: "For query: the attribute's value." }),
	),
	className: Type.Optional(
		Type.String({ description: "For query: a class the node carries." }),
	),
	text: Type.Optional(
		Type.String({
			description: "For query: text the node must contain.",
		}),
	),
	rendered: Type.Optional(
		Type.Boolean({
			description:
				"For query: true for only what the browser drew, false for " +
				"only what it did not, which is how you find out why " +
				"something is missing.",
		}),
	),
	inShadow: Type.Optional(
		Type.Boolean({
			description: "For query: restrict to content inside shadow roots.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"For query: how many matches to list. The total is always " +
				"reported, however many are shown. For hover: how many " +
				"elements to hold and read, since each costs a round trip. " +
				"Defaults to 60, which is about half a second.",
		}),
	),
	ms: Type.Optional(
		Type.Number({
			description:
				"For profile: how long to record, in milliseconds. " +
				"Defaults to 3000, at most 60000. Do the slow thing while it runs, or " +
				"the profile catches an idle page.",
		}),
	),
	budget: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_OUTLINE_BUDGET_BYTES,
			description:
				"For page and reading: how many bytes of outline to return " +
				`before storing the rest. Defaults to ${OUTLINE_BUDGET_BYTES}, ` +
				`and will not go above ${MAX_OUTLINE_BUDGET_BYTES}. Whatever ` +
				"is cut stays queryable by handle, so narrowing with 'only', " +
				"'depth' or 'within' is the way to see more, not raising this.",
		}),
	),
});

/** What browser_see is called with. */
export type SeeParams = Static<typeof parameters>;

/** Register the reading half of the browser family. */
export function registerSee(pi: ExtensionAPI, sessions: Sessions): void {
	pi.registerTool({
		name: "browser_see",
		...BROWSER_EXPOSURE,
		label: "Browser See",
		description:
			"Read the current state of a browser without changing it. " +
			"kind 'page' (the default) returns the page's accessibility outline: " +
			"the roles and names of everything on screen, which is how you name " +
			"elements when you act on them. kind 'reading' narrates the same " +
			"page as a screen reader would, which is how you review what the " +
			"experience is like without sight. On a large page, narrow it: " +
			"'only' reduces to landmarks, headings or interactive elements, " +
			"'depth' keeps the top levels, and 'within' reads one branch.",
		promptSnippet:
			"browser_see reads a page and changes nothing: its " +
			"accessibility outline, reading order, one element in " +
			"depth, the space between two elements, a query across " +
			"frames and shadow roots, console, network and websocket " +
			"telemetry, screenshots, vitals, status. Read the " +
			"browser-guide skill.",
		parameters,
		renderCall: (args, theme, context) =>
			renderBrowserCall("see", args, theme, context?.lastComponent),
		renderResult: (result, options, theme, context) =>
			renderBrowserResult(result, options, theme, context?.lastComponent),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { runSee } = await seeModule();
			return runSee(ctx, await sessions(), params, signal);
		},
	});
}
