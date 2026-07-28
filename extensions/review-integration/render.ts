/**
 * How the substrate talks to a person.
 *
 * Two rules hold this together. The first is that a glyph is a
 * noun: one per concept, always the same one, never two in a
 * row, so the eye learns the vocabulary instead of decoding a
 * new rebus each time. The second is that degradation is
 * narrated as a sentence rather than tabulated as a diagnostic,
 * because "three remarks will land on lines, one becomes prose
 * because its anchor moved" is something a person can act on.
 *
 * None of these glyphs reach a forge. What gets posted is
 * someone else's surface, and decorating it would be rude.
 */

import type {
	Anchor,
	ChecksRollup,
	Proposal,
	PublishOutcome,
	PublishPlan,
	Stack,
	Thread,
} from "../../lib/review/index.js";

/** The vocabulary. One glyph per concept, used everywhere. */
export const GLYPH = {
	target: "🌐",
	stack: "🪜",
	thread: "🧵",
	finding: "📌",
	verdict: "🎭",
	lands: "✨",
	degrades: "🌥",
	refused: "🚧",
	document: "📜",
	reaction: "🎉",
	checks: "🔬",
	resolved: "☑",
	unresolved: "☐",
} as const;

/** Where a remark points, in a form a person can scan. */
export function anchorLabel(anchor: Anchor): string {
	if (anchor.subject === "file") return anchor.path;
	const lines =
		anchor.startLine && anchor.startLine !== anchor.line
			? `${anchor.startLine}-${anchor.line}`
			: `${anchor.line}`;
	return `${anchor.path}:${lines}`;
}

/** Pluralize without the "1 items" tell. */
function count(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/** A change, in one line. */
export function proposalLine(proposal: Proposal): string {
	const draft = proposal.draft ? " (draft)" : "";
	return `${GLYPH.target} ${proposal.ref.label} ${proposal.title}${draft}\n   ${proposal.state} · ${proposal.author.id} · ${proposal.head} → ${proposal.base}`;
}

/** CI, with unreported kept apart from failed. */
export function checksLines(rollup: ChecksRollup): string {
	if (rollup.checks.length === 0) {
		return `${GLYPH.checks} nothing has reported yet`;
	}
	const byState = new Map<string, number>();
	for (const check of rollup.checks) {
		byState.set(check.state, (byState.get(check.state) ?? 0) + 1);
	}
	const parts = [...byState].map(([state, n]) => `${n} ${state}`);
	const notable = rollup.checks
		.filter((check) => check.state === "failing")
		.map((check) => `   ${check.name}`)
		.join("\n");
	const head = `${GLYPH.checks} ${rollup.state}: ${parts.join(", ")}`;
	return notable ? `${head}\n${notable}` : head;
}

/**
 * A stack as a lane graph. The cursor is marked because the
 * question people actually have is "where am I in this".
 */
export function stackLines(stack: Stack): string {
	const provenance =
		stack.provenance === "authoritative"
			? "recorded by the backend"
			: "derived from branch names, so it may be wrong at the edges";
	const header = `${GLYPH.stack} ${count(stack.nodes.length, "branch", "branches")}, ${provenance}`;
	const trunk = stack.trunk ? `\n   ╿ ${stack.trunk} (trunk)` : "";

	// Top of the stack first: that is how people draw them.
	const rows = [...stack.nodes.entries()].reverse().map(([index, node]) => {
		const here = index === stack.cursor ? "▶" : " ";
		const proposal = node.proposal;
		const label = proposal
			? `${node.ref} · ${proposal.title}`
			: `${node.ref} · not proposed anywhere`;
		const behind = node.behindParent ? "  (behind its parent)" : "";
		return `  ${here} ${index === 0 ? "╽" : "┃"} ${label}${behind}`;
	});
	return `${header}\n${rows.join("\n")}${trunk}`;
}

/** One thread, with its anchor and its state. */
export function threadLines(thread: Thread, index: number): string {
	const mark = thread.resolved ? GLYPH.resolved : GLYPH.unresolved;
	const where = thread.anchor ? anchorLabel(thread.anchor) : "on the change";
	const stale = thread.stale ? " · stale" : "";
	const first = thread.comments[0];
	const opener = first ? `${first.author.id}: ${first.body}` : "(empty)";
	const more =
		thread.comments.length > 1
			? `\n     …${count(thread.comments.length - 1, "more reply", "more replies")}`
			: "";
	return `${mark} [T${index + 1}] ${GLYPH.thread} ${where}${stale}\n     ${opener}${more}`;
}

/**
 * What publishing will do, narrated.
 *
 * The order is deliberate: what will happen, then what will
 * happen differently, then what will not happen. Someone who
 * reads only the first line still learns the important part.
 */
export function planNarration(plan: PublishPlan): string {
	const lines: string[] = [];

	if (plan.ops.length === 0 && plan.refused.length === 0) {
		return "Nothing to publish yet. Add a finding, a reply or a verdict.";
	}

	for (const op of plan.ops) {
		if (op.kind === "review") {
			const anchored = count(op.comments.length, "anchored remark");
			lines.push(
				`${GLYPH.lands} one review, ${op.verdict}, carrying ${anchored}`,
			);
		} else if (op.kind === "comment") {
			lines.push(`${GLYPH.lands} one top-level message`);
		} else if (op.kind === "reply") {
			lines.push(`${GLYPH.lands} a reply into ${GLYPH.thread} ${op.thread.id}`);
		} else if (op.kind === "resolve") {
			lines.push(`${GLYPH.lands} resolving ${GLYPH.thread} ${op.thread.id}`);
		} else {
			lines.push(`${GLYPH.reaction} ${op.reaction} on ${op.subject.id}`);
		}
	}

	for (const degraded of plan.degraded) {
		lines.push(
			`${GLYPH.degrades} #${degraded.itemId} was ${degraded.from}; it becomes ${degraded.to}, because ${degraded.reason}`,
		);
	}

	for (const refusal of plan.refused) {
		const which = refusal.itemId ? `#${refusal.itemId} ` : "";
		lines.push(
			`${GLYPH.refused} ${which}${refusal.subject} will not be sent: ${refusal.reason}`,
		);
	}

	return lines.join("\n");
}

/** What publishing actually did. */
export function outcomeNarration(outcome: PublishOutcome): string {
	if (outcome.outcomes.length === 0) return "Nothing was sent.";
	const landed = outcome.outcomes.filter((entry) => entry.ok);
	const failed = outcome.outcomes.filter((entry) => !entry.ok);
	const lines: string[] = [];

	if (landed.length > 0) {
		lines.push(`${GLYPH.lands} ${count(landed.length, "operation")} landed`);
		for (const entry of landed) {
			if (entry.posted?.url) lines.push(`   ${entry.posted.url}`);
		}
	}
	for (const entry of failed) {
		lines.push(
			`${GLYPH.refused} ${entry.op.kind} did not land: ${entry.error}`,
		);
	}
	if (failed.length > 0) {
		lines.push(
			"What failed is still in the draft, so publishing again sends only that.",
		);
	}
	return lines.join("\n");
}
