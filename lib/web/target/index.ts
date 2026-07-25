/**
 * Semantic targeting: how an element is named, how that name
 * resolves to a real node, and what to offer the caller when
 * it does not.
 */

export {
	ambiguityRefusal,
	describeRefusal,
	notFoundRefusal,
	type TargetCandidate,
	type TargetRefusal,
} from "./refusals.js";
export {
	resolveTarget,
	type Target,
	type TargetResolution,
} from "./target.js";
