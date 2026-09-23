/**
 * Demote rather than delete: cutting resident content that a
 * shadow-mode measurement already found, in a way that always names
 * how to get it back, and counts how often getting it back actually
 * happens.
 */

export { BoundedTextCache } from "./cache.js";
export {
	accumulateReexpansion,
	INITIAL_REEXPANSION,
	type ReexpansionTotals,
	reexpansionRate,
} from "./reexpansion.js";
export { type Demotion, type DemotionInput, planDemotions } from "./stub.js";
