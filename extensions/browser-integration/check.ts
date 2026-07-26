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
import { Type } from "@sinclair/typebox";
import { analyseWalk, renderWalk } from "../../lib/web/a11y/index.js";
import {
	analyseStructure,
	analyseVisual,
	mergeFindings,
	renderAudit,
	SUPERSEDED_BY,
	tallyFindings,
} from "../../lib/web/audit/index.js";
import { renderInventory, takeInventory } from "../../lib/web/design/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("keyboard"),
				Type.Literal("accessibility"),
				Type.Literal("visual"),
				Type.Literal("design"),
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
					"to have been meant as one. Defaults to keyboard.",
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
			"enough to have been meant as one.",
		promptSnippet:
			"Judge a browser page with browser_check: kind 'keyboard' walks the " +
			"tab order, kind 'accessibility' runs the WCAG rule set.",
		parameters,
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			const kind = params.kind ?? "keyboard";
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					`No session '${name}'. Navigate somewhere with browser_go first.`,
				);
			}

			const session = await registry.acquire(name);

			if (kind === "accessibility") {
				// Two rule sets, one report. axe is the WCAG baseline and
				// ours are the structural questions it leaves alone or
				// files as opinion; a reader should not have to know
				// which came from where to act on either.
				const [fromAxe, structure] = await Promise.all([
					session.audit(),
					session.structure(),
				]);
				const findings = mergeFindings(
					fromAxe,
					analyseStructure(structure),
					SUPERSEDED_BY,
				);
				return answer(
					name,
					kind,
					renderAudit(findings, tallyFindings(findings), {
						...(params.rule === undefined ? {} : { rule: params.rule }),
					}),
				);
			}

			if (kind === "design") {
				const samples = await session.styleSamples();
				return answer(
					name,
					kind,
					renderInventory(takeInventory(samples), {
						...(params.rule === undefined ? {} : { property: params.rule }),
					}),
				);
			}

			if (kind === "visual") {
				const { nodes, viewport } = await session.layout();
				const findings = analyseVisual(nodes, viewport);
				return answer(
					name,
					kind,
					renderAudit(findings, tallyFindings(findings), {
						...(params.rule === undefined ? {} : { rule: params.rule }),
					}),
				);
			}

			const capture = await session.keyboardWalk(params.maxStops);
			if (capture.candidates.length === 0) {
				return answer(
					name,
					kind,
					"Nothing on this page can hold focus. A page with no " +
						"focusable controls cannot be used with a keyboard at all, " +
						"which is either the point or the bug.",
				);
			}

			return answer(name, kind, renderWalk(analyseWalk(capture)));
		},
	});
}
