/**
 * browser_check: verdicts rather than readings.
 *
 * The other three tools answer questions. This one forms a
 * judgment: it walks, audits or compares, and says whether what
 * it found is acceptable. Kinds grow with the phases of the
 * browser evolution plan; keyboard is the first, because a page
 * nobody can tab through is broken in a way no screenshot shows.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { analyseWalk, renderWalk } from "../../lib/web/a11y/index.js";
import {
	type A11yFinding,
	analyseStructure,
	analyseVisual,
	type Condition,
	conditionFrom,
	headlineOf,
	mergeFindings,
	type Part,
	renderAudit,
	renderHealth,
	renderSweep,
	renderVerdict,
	SUPERSEDED_BY,
	standingOf,
	tallyFindings,
	targetFindings,
	widthsToSweep,
} from "../../lib/web/audit/index.js";
import { renderComparison } from "../../lib/web/compare/index.js";
import { renderInventory, takeInventory } from "../../lib/web/design/index.js";
import { measure, renderVitals } from "../../lib/web/perf/index.js";
import type { BrowserSession } from "../../lib/web/session.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { renderBrowserCall, renderBrowserResult } from "./render.js";
import {
	answer,
	chooseSession,
	missingSession,
	refusal,
	sessionInPlay,
} from "./result.js";
import { listAnswer } from "./stored.js";

/**
 * A verdict, bounded, with every finding kept.
 *
 * A report naming a hundred elements is exactly the report worth
 * having and exactly the one that will not fit, and "name one rule
 * to see its elements" only helps a caller who already knows which
 * rule they care about. Storing the findings means the whole set
 * can be filtered by impact, rule or criterion without another
 * audit run.
 */
function auditAnswer(view: string, findings: readonly A11yFinding[]): string {
	return listAnswer({
		view,
		records: findings,
		unit: "findings",
		narrowing:
			"Name one rule in 'rule' to see the elements it hit, or query " +
			"the findings by impact, rule or criterion.",
	});
}

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("keyboard"),
				Type.Literal("accessibility"),
				Type.Literal("visual"),
				Type.Literal("design"),
				Type.Literal("compare"),
				Type.Literal("perf"),
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
					"to have been meant as one. compare: photograph the page " +
					"and diff it against a stored baseline of itself, " +
					"recording one on the first run. perf: what the page " +
					"cost to show, against the published web vitals " +
					"thresholds. health: run every check and report one " +
					"digest. Defaults to keyboard.",
			},
		),
	),
	rule: Type.Optional(
		Type.String({
			description:
				"For accessibility and visual: name one rule from the index " +
				"to see the elements it hit and how to fix them. For design: " +
				"name one property to see every value and where it is used.",
		}),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
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
				"Run the same check at each of these viewport widths and " +
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
				"After a sweep, name one condition from the table, e.g. " +
				"'375px', to see its report in full.",
		}),
	),
	update: Type.Optional(
		Type.Boolean({
			description:
				"For compare: replace the stored baseline with what the " +
				"page looks like now, accepting the change.",
		}),
	),
	maxStops: Type.Optional(
		Type.Number({
			description:
				"How many times to press Tab. Defaults to twice the number of " +
				"focusable things, which is enough to show a cycle.",
		}),
	),
});

/** Register the judging member of the browser family. */
export function registerCheck(
	pi: ExtensionAPI,
	registry: SessionRegistry,
): void {
	pi.registerTool({
		name: "browser_check",
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
			"changed and what they sit on.",
		promptSnippet:
			"browser_check forms a verdict about a page: keyboard, " +
			"accessibility, visual, design, compare, perf, or health " +
			"for all of them at once. Every answer opens PASS, WARN or " +
			"FAIL, where WARN means undecided rather than nearly fine. " +
			"Read the browser-accessibility-guide skill before " +
			"reporting an accessibility result.",
		parameters,
		renderCall: (args, theme) => renderBrowserCall("check", args, theme),
		renderResult: (result, options, theme) =>
			renderBrowserResult(result, options, theme),
		async execute(_id, params) {
			const kind = params.kind ?? "keyboard";
			const chosen = sessionInPlay(
				params.session,
				DEFAULT_SESSION,
				registry.open(),
			);
			if ("candidates" in chosen) {
				return refusal(DEFAULT_SESSION, kind, chooseSession(chosen.candidates));
			}
			const name = chosen.name;
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					missingSession(
						name,
						registry.departureOf(name),
						"Navigate somewhere with browser_go first.",
					),
				);
			}

			const session = await registry.acquire(name);

			// A verdict about a page that is not there is worse than no
			// verdict: about:blank has no lang attribute, no landmark and
			// no heading, so a health check on it answers FAIL with four
			// accessibility rules and says nothing about the application
			// anybody meant to test. A session sits on about:blank before
			// its first navigation and after going back past it, so this
			// is easy to reach by accident.
			if (session.url === "about:blank") {
				return refusal(
					name,
					kind,
					`Session '${name}' has nothing loaded, so there is nothing ` +
						"to judge. A blank page fails rules about lang, " +
						"landmarks and headings, which would say nothing about " +
						"your page. Navigate with browser_go first.",
				);
			}

			if (params.widths && params.widths.length > 0) {
				// keyboard used to be refused here, on the grounds that a
				// walk cannot survive being resized underneath it. It is
				// not: the sweep resizes and then runs, never during, and
				// the walk now puts focus and scroll back where it found
				// them. The refusal was also a fiction, because health is
				// swept and runs the same walk at every width, so anyone
				// who hit the refusal could route around it by asking for
				// health and never learn what it was protecting.
				return answer(
					name,
					kind,
					await sweep(session, params.widths, params.at, (at) =>
						runOnce(session, kind, {
							...params,
							baseline: baselineAt(params, at),
						}),
					),
				);
			}

			return answer(name, kind, await runOnce(session, kind, params));
		},
	});
}

/** What check does under one set of conditions. */
type CheckParams = Static<typeof parameters>;

/**
 * Run one kind of check once and render it.
 *
 * Separate from the tool body so a sweep can call it repeatedly
 * under different conditions and collect the reports, rather
 * than each kind growing its own loop.
 */
async function runOnce(
	session: BrowserSession,
	kind: string,
	params: CheckParams,
): Promise<string> {
	if (kind === "health") {
		return digest(session, params);
	}

	if (kind === "perf") {
		const vitals = await session.vitals();
		return renderVitals(vitals, measure(vitals));
	}

	if (kind === "accessibility") {
		// Two rule sets, one report. axe is the WCAG baseline and
		// ours are the structural questions it leaves alone or
		// files as opinion; a reader should not have to know
		// which came from where to act on either.
		// Target size is ours to check. axe ships target-size
		// disabled by default and we do not turn it on, so WCAG 2.5.8
		// was measured by nothing at all while the arithmetic for it
		// sat exported, tested and unreachable from any tool.
		const [fromAxe, structure, targets] = await Promise.all([
			session.audit(),
			session.structure(),
			session.targets(),
		]);
		const findings = mergeFindings(
			fromAxe,
			[...analyseStructure(structure), ...targetFindings(targets)],
			SUPERSEDED_BY,
		);
		const measured =
			`Checked ${structure.length} elements against the axe rule ` +
			`set and our structural rules, and ${targets.length} pointer ` +
			`${targets.length === 1 ? "target" : "targets"} against WCAG 2.5.8.`;
		return auditAnswer(
			renderAudit(findings, tallyFindings(findings), {
				...(params.rule === undefined ? {} : { rule: params.rule }),
				measured,
			}),
			findings,
		);
	}

	if (kind === "compare") {
		const { comparison, recorded, artifacts } = await session.compareToBaseline(
			params.baseline ?? "default",
			{
				...(params.update === undefined ? {} : { update: params.update }),
			},
		);
		if (!comparison) {
			// Not a pass: nothing was judged. Recording a baseline
			// and reporting PASS would let a first run look like a
			// clean one forever after.
			return renderVerdict(
				{
					standing: "warn",
					headline: "No baseline existed, so this run became one.",
					measured: `Recorded at ${recorded}. Run this again after a change.`,
				},
				"",
			);
		}
		return renderComparison(comparison, artifacts);
	}

	if (kind === "design") {
		const samples = await session.styleSamples();
		const inventory = takeInventory(samples);
		return listAnswer({
			view: renderInventory(inventory, {
				...(params.rule === undefined ? {} : { property: params.rule }),
			}),
			// The samples rather than the inventory: a caller asking which
			// elements use a colour wants the elements, and the inventory
			// is the tally that hid them.
			records: samples,
			unit: "style samples",
			narrowing:
				"Name one property in 'rule' to see every value and where it " +
				"is used.",
		});
	}

	if (kind === "visual") {
		const { nodes, viewport } = await session.layout();
		const findings = analyseVisual(nodes, viewport);
		return auditAnswer(
			renderAudit(findings, tallyFindings(findings), {
				...(params.rule === undefined ? {} : { rule: params.rule }),
				measured:
					`Measured ${nodes.length} drawn elements in a ` +
					`${viewport.width} by ${viewport.height} viewport.`,
			}),
			findings,
		);
	}

	const capture = await session.keyboardWalk(params.maxStops);
	if (capture.candidates.length === 0) {
		return renderVerdict(
			{
				// A page of prose legitimately has no controls, and a
				// broken application looks identical from here.
				standing: "warn",
				headline: "Nothing on this page can hold focus.",
				measured:
					"A page with no focusable controls cannot be used " +
					"with a keyboard at all, which is either the point " +
					"or the bug.",
			},
			"",
		);
	}

	return renderWalk(analyseWalk(capture));
}

/**
 * Run a check at each width and report the table.
 *
 * The viewport is put back afterwards, because a check should
 * not leave the session somewhere the caller did not put it.
 */
async function sweep(
	session: BrowserSession,
	widths: readonly number[],
	only: string | undefined,
	run: (label: string) => Promise<string>,
): Promise<string> {
	// Restoring means the size the page was actually at, not the
	// absence of an override. Clearing the override hands the page
	// back to the real window, which is not where it started:
	// puppeteer sets its own default viewport, so a session that
	// had emulated nothing still came back 756 by 469 from 800 by
	// 600. So the measured size is captured and re-asserted.
	const before = session.emulated;
	const { viewport: was } = await session.layout();
	const height = before.viewport?.height ?? was.height;
	const conditions: Condition[] = [];
	try {
		for (const { label, setting } of widthsToSweep(widths)) {
			// The whole viewport object is replaced, not merged into,
			// so anything left out of this literal reverts to a
			// default. Passing only a width and height silently reset
			// the device pixel ratio to 1 and the mobile flag to false
			// for the length of the sweep, which changes how the page
			// renders and re-rasterizes every per-width baseline at a
			// different scale from a plain compare in the same session.
			await session.emulate({
				viewport: {
					...before.viewport,
					width: setting.width,
					height,
				},
			});
			conditions.push(conditionFrom(label, await run(label)));
		}
	} finally {
		await session.restoreEmulation({
			...before,
			viewport: before.viewport ?? { width: was.width, height: was.height },
		});
	}
	return renderSweep(conditions, {
		...(only === undefined ? {} : { only }),
	});
}

/** Every check the digest runs, in the order it reports them. */
const HEALTH_KINDS = [
	"accessibility",
	"keyboard",
	"visual",
	"perf",
	"design",
] as const;

/**
 * Run every check and report one digest.
 *
 * A check that throws becomes a part that says so rather than
 * ending the digest. One broken check should cost its own line,
 * not the other four, and a digest that quietly dropped it would
 * look like coverage it does not have.
 *
 * compare is left out on purpose: it needs a baseline and a
 * decision about what is being held still, which is not a
 * question a general health check can answer for somebody.
 */
async function digest(
	session: BrowserSession,
	params: CheckParams,
): Promise<string> {
	const parts: Part[] = [];
	for (const kind of HEALTH_KINDS) {
		try {
			const report = await runOnce(session, kind, {
				...params,
				rule: undefined,
			});
			parts.push({
				kind,
				standing: standingOf(report),
				headline: headlineOf(report),
			});
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			parts.push({
				kind,
				standing: "warn",
				headline: `Could not run: ${why}`,
				failedToRun: why,
			});
		}
	}
	return renderHealth(parts);
}

/**
 * Keep each width's baseline apart.
 *
 * One baseline across every width would compare a phone against
 * a desktop and refuse on size, every time.
 */
function baselineAt(params: CheckParams, at: string): string {
	return `${params.baseline ?? "default"}-${at}`;
}
