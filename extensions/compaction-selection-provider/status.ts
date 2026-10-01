/**
 * The selection's part of `/compaction-status`.
 *
 * Whether excerpts will be quoted at the next compaction depends on
 * things nothing else shows: a classifier resolved or not, tags
 * recorded or not, a budget left at its default or set to zero. And
 * whether they were quoted before is in the summaries themselves. This
 * says both, so a compaction without excerpts can be explained before
 * the next one rather than after it.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	compactionsOn,
	type StatusSection,
} from "../../lib/compaction/index.ts";
import { EXCERPTS_HEADING } from "../../lib/compaction/selection/render.ts";
import { untagged } from "../../lib/compaction/selection/tags.ts";
import type { ClassifierState } from "./classifier.ts";
import { SELECTION_RECORD_ID } from "./contribution.ts";
import type { SelectionStore } from "./store.ts";

/** The selection's section sits after the workflow's. */
export const SELECTION_ORDER = 20;

/** What the selection knows about itself when asked. */
export interface SelectionFacts {
	readonly classifier: ClassifierState;
	readonly store: SelectionStore;
	readonly budget: number;
	readonly refs: boolean;
}

function describeClassifier(state: ClassifierState): string {
	if ("label" in state) return state.label;
	if ("unavailable" in state) return `none: ${state.unavailable}`;
	return "not resolved yet in this session";
}

/** What the last compaction's selection record says, in a line. */
function lastRecordLine(record: unknown): string {
	if (typeof record !== "object" || record === null) {
		return "last compaction's record: none (written before the selection recorded, or it did not run)";
	}
	const r = record as Record<string, unknown>;
	const by =
		typeof r.label === "string"
			? r.label
			: typeof r.unavailable === "string"
				? `no classifier (${r.unavailable})`
				: "classifier unresolved";
	if (r.nothingQuoted === "off") {
		return "last compaction's record: quoted nothing, excerpts were off";
	}
	const why =
		typeof r.nothingQuoted === "string"
			? ` (quoted nothing: ${r.nothingQuoted})`
			: "";
	const took =
		typeof r.taggingMs === "number"
			? `; tagging took ${seconds(r.taggingMs)}, checking ${seconds(
					typeof r.judgingMs === "number" ? r.judgingMs : 0,
				)} of model time, ${typeof r.tokens === "number" ? r.tokens : "?"} tokens`
			: "";
	return `last compaction's record: ${by}; chose ${r.chosen ?? "?"} of ${
		r.candidates ?? "?"
	} candidates${why}, ${r.untagged ?? "?"} dropped messages untagged${took}`;
}

const MS_PER_SECOND = 1000;

/** Milliseconds as seconds, to one decimal place. */
function seconds(ms: number): string {
	return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

/** The selection's section, from what it knows and the branch. */
export function selectionSection(
	facts: SelectionFacts,
	branch: readonly unknown[],
): StatusSection {
	const entries = branch as readonly SessionEntry[];
	const tags = facts.store.tags(entries);
	const compactions = compactionsOn(branch);
	const quoted = compactions.filter((c) =>
		c.summary.includes(EXCERPTS_HEADING),
	).length;
	const lines = [
		`classifier: ${describeClassifier(facts.classifier)}`,
		`excerpt budget: ${facts.budget > 0 ? `${facts.budget} tokens` : "0 (excerpts off)"}`,
		`tags kept: ${facts.store.kind === "memory" ? "in this process" : "on the session"}`,
		`quotes name their paragraph: ${facts.refs ? "yes" : "no (session_recall is not active)"}`,
		`paragraphs tagged on this branch: ${tags.kinds.size}`,
		`messages waiting to be tagged: ${untagged(entries, tags).length}`,
		`compactions that quoted excerpts: ${quoted} of ${compactions.length}`,
	];
	const last = compactions.at(-1);
	if (last) {
		const contributions = last.details.contributions as
			| Record<string, unknown>
			| undefined;
		lines.push(lastRecordLine(contributions?.[SELECTION_RECORD_ID]));
	}
	return {
		id: "compaction-selection-provider",
		title: "Excerpts",
		order: SELECTION_ORDER,
		lines,
	};
}
