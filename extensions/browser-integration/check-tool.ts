/**
 * browser_check as pi sees it: its name, its words and its parameters.
 * What it does is in check.ts, loaded on its first call (see sessions.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadOnce } from "../../lib/internal/single-flight.ts";
import { BROWSER_EXPOSURE } from "./exposure.ts";
import { renderBrowserCall, renderBrowserResult } from "./render.ts";
import type { Sessions } from "./sessions.ts";

const checkModule = loadOnce(() => import("./check.ts"));

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("keyboard"),
				Type.Literal("accessibility"),
				Type.Literal("visual"),
				Type.Literal("design"),
				Type.Literal("contrast"),
				Type.Literal("compare"),
				Type.Literal("perf"),
				Type.Literal("motion"),
				Type.Literal("typography"),
				Type.Literal("hydration"),
				Type.Literal("health"),
			],
			{
				description:
					"keyboard: tab through the page and report what a person " +
					"using only a keyboard can reach. accessibility: run the " +
					"axe WCAG rule set and report what failed, what is only " +
					"best practice, and what needs a person to look. visual: " +
					"report what the layout did wrong, from sideways scroll " +
					"and clipped text to images that did not load. design: " +
					"inventory what the page is built from, colours, type, " +
					"spacing and shadows, and point out values close enough " +
					"to have been meant as one. contrast: judge one element's " +
					"text against the background actually behind its glyphs, " +
					"for the gradients and photographs the accessibility " +
					"check hands back as needing a person. compare: " +
					"photograph the page " +
					"and diff it against a stored baseline of itself, " +
					"recording one on the first run. perf: what the page " +
					"cost to show, against the published web vitals " +
					"thresholds; pass samples to rate medians over several " +
					"loads instead of one. motion: emulate " +
					"prefers-reduced-motion, reload, and report what kept " +
					"moving anyway, which no axe rule sees. typography: read " +
					"real line boxes and report orphans and runts, one word " +
					"or a stub stranded on a last line. hydration: fetch the " +
					"server render and diff it against the hydrated page, " +
					"reading the console for the framework's own complaints. " +
					"motion and hydration reload the page, so run them after " +
					"reading any state a reload would lose. health: run every " +
					"check and report one " +
					"digest. Defaults to keyboard.",
			},
		),
	),
	level: Type.Optional(
		Type.Union([Type.Literal("A"), Type.Literal("AA"), Type.Literal("AAA")], {
			description:
				"For accessibility, health and contrast: which WCAG " +
				"conformance level " +
				"to hold the page to. Defaults to AAA, the enhanced level, " +
				"which switches on the three AAA rules axe ships disabled " +
				"and raises our own thresholds (pointer targets to 44px " +
				"under 2.5.5 rather than 24px under 2.5.8). Pass 'AA' or " +
				"'A' for a page that targets those instead. The report " +
				"always names the level it judged against, and says when " +
				"every failure was a AAA one so the page still meets AA. " +
				"contrast is the exception and defaults to AA, since it " +
				"reports one measured ratio beside the one required.",
		}),
	),
	rule: Type.Optional(
		Type.String({
			description:
				"For accessibility, visual and motion: name one rule from " +
				"the index " +
				"to see the elements it hit and how to fix them. For design: " +
				"name one property to see every value and where it is used.",
		}),
	),
	session: Type.Optional(
		Type.String({
			description: "Which browser, by name. Defaults to 'default'.",
		}),
	),
	baseline: Type.Optional(
		Type.String({
			description:
				"For compare: which baseline to measure against. Name it " +
				"after the state being held still, e.g. 'checkout-empty'. " +
				"Defaults to 'default'.",
		}),
	),
	widths: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"For every kind: run the same check at each of these " +
				"viewport widths and " +
				"report a table. Most layout and contrast faults are " +
				"conditional, so a single width can pass a page that is " +
				"unusable on a phone. Works with every kind. Note that " +
				"perf measures the load, which a resize does not repeat, " +
				"so its rows will be the same at every width.",
		}),
	),
	at: Type.Optional(
		Type.String({
			description:
				"For every kind, after a sweep: name one condition from " +
				"the table, e.g. " +
				"'375px', to see its report in full.",
		}),
	),
	within: Type.Optional(
		Type.String({
			description:
				"For contrast: the element whose text to judge, named as " +
				"'role name' the way the page outline reads it, e.g. " +
				"'heading Our Pricing'. Required for that kind, since the " +
				"measurement is of one element's glyphs and not the page.",
		}),
	),
	and: Type.Optional(
		Type.String({
			description:
				"For contrast: a second element, named the same way, which " +
				"changes the question to the boundary between the two. That " +
				"is how to judge an icon against its card or a border " +
				"against the page, which is criterion 1.4.11 and the one " +
				"axe does not answer. Without it, the check measures text " +
				"against the pixels behind its own glyphs.",
		}),
	),
	update: Type.Optional(
		Type.Boolean({
			description:
				"For compare: replace the stored baseline with what the " +
				"page looks like now, accepting the change.",
		}),
	),
	samples: Type.Optional(
		Type.Number({
			description:
				"For perf: how many loads to sample. The report answers " +
				"with the median per metric and the spread beside it, and " +
				"a rating that differed between loads is called out, since " +
				"a single headless load drifts. Defaults to 1, which " +
				"measures the load the browser already paid for; sampling " +
				"reloads the page between readings.",
		}),
	),
	maxStops: Type.Optional(
		Type.Number({
			description:
				"For keyboard: how many times to press Tab. Defaults to " +
				"twice the number of " +
				"focusable things, which is enough to show a cycle, or 400 " +
				"where that is fewer. A page with more controls than that " +
				"reports what it did not reach; pass a larger number, up " +
				"to 4000, to walk it to the end.",
		}),
	),
});

/** What check does under one set of conditions. */
export type CheckParams = Static<typeof parameters>;

/** Register the judging member of the browser family. */
export function registerCheck(pi: ExtensionAPI, sessions: Sessions): void {
	pi.registerTool({
		name: "browser_check",
		...BROWSER_EXPOSURE,
		label: "Browser Check",
		description:
			"Form a verdict about a browser page. kind 'keyboard' tabs through " +
			"the page and reports focus traps, controls that cannot be reached, " +
			"focus that cannot be seen and a tab order that does not follow the " +
			"page; it moves focus to do this and puts it back afterwards. " +
			"kind 'accessibility' runs the axe WCAG rule set and reports what " +
			"failed, keeping standards apart from best practice and naming " +
			"what it could not decide. kind 'visual' reports what the layout " +
			"did wrong: sideways scroll, clipped text, escaped elements, " +
			"images that did not load or are drawn at the wrong shape. " +
			"kind 'design' inventories the colours, type, spacing and " +
			"shadows the page actually uses, and points out values close " +
			"enough to have been meant as one. kind 'compare' diffs the page " +
			"against a stored baseline of itself and says which regions " +
			"changed and what they sit on. kind 'motion' asks for reduced " +
			"motion and reports what kept moving; kind 'typography' reads " +
			"real line boxes for orphans and runts; kind 'hydration' diffs " +
			"the server render against the hydrated page.",
		promptSnippet:
			"browser_check forms a verdict about a page: keyboard, " +
			"accessibility, visual, design, compare, perf, motion, " +
			"typography, hydration, or health " +
			"for most of them at once. Every answer opens PASS, WARN or " +
			"FAIL, where WARN means undecided rather than nearly fine. " +
			"Read the browser-accessibility-guide skill before " +
			"reporting an accessibility result.",
		parameters,
		renderCall: (args, theme, context) =>
			renderBrowserCall("check", args, theme, context?.lastComponent),
		renderResult: (result, options, theme, context) =>
			renderBrowserResult(result, options, theme, context?.lastComponent),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { runCheck } = await checkModule();
			return runCheck(ctx, await sessions(), params, signal);
		},
	});
}
