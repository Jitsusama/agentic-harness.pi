/**
 * The workflow's part of `/compaction-status`, and how the whole of it
 * is drawn.
 *
 * The workflow says what it would do now: whether the trigger is on,
 * which providers the chain would ask, what cache retention the prices
 * assume, whether a summary is being written ahead, and what became of
 * the last compaction this process saw. It also says what the branch
 * records about the compactions it carries, since those are what a
 * later reader has to go on.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	answerCompactionStatus,
	askCompactionStatus,
	COMPACTION_OUTCOME,
	type CompactionOutcome,
	compactionsOn,
	isCompactionOutcome,
	type StatusSection,
} from "../../lib/compaction/index.ts";
import { view } from "../../lib/ui/index.ts";
import type { AheadState } from "./host.ts";

/** The workflow's section sits first. */
export const WORKFLOW_ORDER = 10;

/** Show a context size in thousands of tokens. */
const TOKENS_PER_K = 1_000;

/** What the workflow knows about itself when asked. */
export interface WorkflowFacts {
	readonly enabled: boolean;
	readonly floorTokens: number;
	readonly retention: string | undefined;
	readonly chain: {
		readonly providers: readonly string[];
		readonly unknown: readonly string[];
	};
	readonly ahead: AheadState;
	readonly lastOutcome?: {
		readonly outcome: CompactionOutcome;
		readonly at: Date;
	};
}

function size(tokens: number): string {
	return `${Math.round(tokens / TOKENS_PER_K)}k`;
}

/** One outcome, in a line. */
export function describeOutcome(outcome: CompactionOutcome): string {
	switch (outcome.kind) {
		case "compacted": {
			const by = outcome.details.summariser;
			return `compacted at ${size(outcome.tokensBefore)} by ${
				typeof by === "string" ? by : "pi's own summariser"
			}`;
		}
		case "fallback":
			return `fell back to pi's summariser: ${outcome.reason}`;
		case "ahead-unused":
			return `a summary written ahead went unused: ${outcome.reason}`;
		case "failed":
			return `failed at ${size(outcome.failure.tokens)}: ${outcome.failure.error}`;
	}
}

/** What the branch's last compaction recorded, in lines. */
function lastCompactionLines(branch: readonly unknown[]): string[] {
	const compactions = compactionsOn(branch);
	const last = compactions.at(-1);
	if (!last) return ["compactions on this branch: none yet"];
	const { details } = last;
	const lines = [`compactions on this branch: ${compactions.length}`];
	const when = last.timestamp ? ` at ${last.timestamp}` : "";
	const before =
		last.tokensBefore !== undefined ? ` from ${size(last.tokensBefore)}` : "";
	lines.push(`last compaction:${when}${before}`);
	lines.push(
		`  written by: ${
			typeof details.summariser === "string"
				? `${details.summariser}${typeof details.written === "string" ? `, ${details.written}` : ""}`
				: "pi's own summariser (no record from this workflow)"
		}`,
	);
	const contributions =
		typeof details.contributions === "object" && details.contributions !== null
			? Object.keys(details.contributions)
			: [];
	lines.push(
		`  contributions recorded: ${contributions.length > 0 ? contributions.join(", ") : "none"}`,
	);
	return lines;
}

/** The workflow's section, from what it knows and the branch. */
export function workflowSection(
	facts: WorkflowFacts,
	branch: readonly unknown[],
): StatusSection {
	const lines = [
		`trigger: ${facts.enabled ? "on" : "off (PI_COMPACTION_POLICY=off)"}${
			facts.floorTokens > 0
				? `, never at or below ${size(facts.floorTokens)}`
				: ""
		}`,
		`provider chain: ${
			facts.chain.providers.length > 0
				? facts.chain.providers.join(", then ")
				: "none registered"
		}`,
	];
	if (facts.chain.unknown.length > 0) {
		lines.push(
			`  configured but not registered: ${facts.chain.unknown.join(", ")}`,
		);
	}
	lines.push(
		`cache retention: ${facts.retention ?? "default"}${
			facts.retention === "long" ? "" : " (idle compaction needs long)"
		}`,
		`summary written ahead: ${facts.ahead}`,
		`last outcome in this process: ${
			facts.lastOutcome
				? `${describeOutcome(facts.lastOutcome.outcome)} (${facts.lastOutcome.at.toISOString()})`
				: "none since load"
		}`,
		...lastCompactionLines(branch),
	);
	return {
		id: "compaction-workflow",
		title: "Compaction",
		order: WORKFLOW_ORDER,
		lines,
	};
}

/**
 * Answer status requests with the workflow's section, remembering the
 * last outcome said on the bus, and register `/compaction-status`,
 * which gathers every section and shows them.
 */
export function registerCompactionStatus(
	pi: ExtensionAPI,
	facts: () => Omit<WorkflowFacts, "lastOutcome">,
): void {
	let lastOutcome: WorkflowFacts["lastOutcome"];
	pi.events.on(COMPACTION_OUTCOME, (data: unknown) => {
		if (isCompactionOutcome(data))
			lastOutcome = { outcome: data, at: new Date() };
	});
	answerCompactionStatus(pi.events, (branch) =>
		workflowSection({ ...facts(), lastOutcome }, branch),
	);
	pi.registerCommand("compaction-status", {
		description:
			"Show how compaction stands now: the trigger, provider chain, excerpts, recall and this branch's compactions.",
		handler: async (_args, ctx) => {
			const sections = askCompactionStatus(
				pi.events,
				ctx.sessionManager.getBranch(),
			);
			await view(ctx, {
				title: "Compaction Status",
				content: (theme) => renderSections(sections, theme),
			});
		},
	});
}

/** Draw the gathered sections for a panel. */
export function renderSections(
	sections: readonly StatusSection[],
	theme: Theme,
): string[] {
	const lines: string[] = [""];
	for (const section of sections) {
		lines.push(`  ${theme.fg("accent", section.title)}`);
		for (const line of section.lines)
			lines.push(`    ${theme.fg("text", line)}`);
		lines.push("");
	}
	lines.push(
		theme.fg(
			"dim",
			"  A section appears only for an extension that is loaded and answered.",
		),
		"",
	);
	return lines;
}
