/**
 * Governance: the captured-rule store and its prompt rendering.
 *
 * Correction capture files behavioural rules here; the prompt
 * coordinator injects them every turn and the advisor reviews
 * turns against them. One store, two readers.
 */

export {
	condenseTranscript,
	distillSystemPrompt,
	distillUserPrompt,
	parseRules,
	type Turn,
} from "./distill.js";
export { renderRulesBlock } from "./render.js";
export { type NewRule, openRuleStore, type RuleStore } from "./store.js";
export type { GovernanceRule } from "./types.js";
