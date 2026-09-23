/**
 * Analysing what pi's `context` event carries, without ever rewriting
 * it. Wiring an analysis into an actual rewrite is a separate,
 * consequential step from measuring what there is to reclaim.
 */

export {
	type FindReclaimableOptions,
	findReclaimable,
	type ReclaimAnalysis,
	type ReclaimCandidate,
	type ToolResultLike,
} from "./reclaim.js";
