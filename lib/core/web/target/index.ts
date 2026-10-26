/**
 * Semantic targeting: how an element is named, how that name
 * resolves to a real node, and what to offer the caller when
 * it does not.
 */

export {
	ambiguityRefusal,
	describeRefusal,
	describeTarget,
	notFoundRefusal,
	type TargetCandidate,
	type TargetRefusal,
} from "./refusals.ts";
export {
	foldEquals,
	parseTarget,
	resolveTarget,
	type Target,
	type TargetResolution,
} from "./target.ts";
