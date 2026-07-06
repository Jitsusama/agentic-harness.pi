/**
 * Cross-PR context for a per-PR reviewer.
 *
 * A reviewer only sees the cursor PR's diff, but a PR that
 * sits in a stack is easier to judge with its neighbours in
 * view: the reviewer knows a change deferred to a child PR
 * is not missing, and that a base assumed by this PR lives
 * upstream. This renders a short, read-only summary of the
 * stack for the reviewer prompt. It says nothing when the
 * PR stands alone.
 */

import type { Stack } from "./stack.js";

/**
 * Render a stack summary for the reviewer prompt, or return
 * undefined when there is no stack or it holds a single PR.
 * The cursor is marked; siblings are listed for context
 * only, with an explicit instruction not to review them.
 */
export function formatReviewStackContext(
	stack: Stack | null | undefined,
): string | undefined {
	if (!stack || stack.entries.length <= 1) return undefined;
	const lines: string[] = [];
	lines.push("## Stack context");
	lines.push("");
	lines.push(
		`This PR sits in a ${stack.entries.length}-PR stack, ordered base to ` +
			"head below. You are reviewing only the cursor PR's diff. The " +
			"siblings are listed for context so you don't flag a change that " +
			"belongs to another PR in the stack; do not review their code.",
	);
	stack.entries.forEach((entry, index) => {
		const marker = index === stack.cursorIndex ? "▶" : " ";
		const here = index === stack.cursorIndex ? " (this PR)" : "";
		lines.push(`- ${marker} #${entry.reference.number}${here}: ${entry.title}`);
	});
	return lines.join("\n");
}
