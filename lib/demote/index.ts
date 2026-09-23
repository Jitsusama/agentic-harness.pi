/**
 * Demote rather than delete: cutting resident content only when a batch
 * of it pays for the cache rewrite it causes, in a way that always names
 * how to get it back, and counts how often getting it back actually
 * happens.
 */

export {
	type BatchDecision,
	type BatchInput,
	planBatch,
	type SizedMessage,
} from "./batch.js";
export { BoundedTextCache } from "./cache.js";
export {
	accumulateReexpansion,
	INITIAL_REEXPANSION,
	type ReexpansionTotals,
	reexpansionRate,
} from "./reexpansion.js";
export { type Demotion, type DemotionInput, planDemotions } from "./stub.js";
