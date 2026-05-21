/** Session-global finding id allocation helpers. */

import type { Finding } from "./findings.js";
import type { PrWorkflowState } from "./state.js";

/** Allocate a contiguous block of finding ids for a parser. */
export function reserveFindingIds(
	state: PrWorkflowState,
	count: number,
): number {
	const startId = state.nextFindingId;
	state.nextFindingId += Math.max(0, count);
	return startId;
}

/** Advance the allocator past findings returned by a parser. */
export function rememberAllocatedFindings(
	state: PrWorkflowState,
	findings: readonly Finding[],
): void {
	let next = state.nextFindingId;
	for (const finding of findings) {
		next = Math.max(next, finding.id + 1);
	}
	state.nextFindingId = next;
}
