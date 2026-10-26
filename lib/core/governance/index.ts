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
} from "./distill.ts";
export { renderRulesBlock } from "./render.ts";
export { type NewRule, openRuleStore, type RuleStore } from "./store.ts";
export type { GovernanceRule } from "./types.ts";
