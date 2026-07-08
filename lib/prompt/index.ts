/**
 * Public surface of the prompt library.
 *
 * The resident system-prompt coordinator: one deterministic
 * assembly point for the always-on prompt block, frozen per
 * session so its bytes never churn turn to turn. Extensions
 * register a PromptContributor; the coordinator extension owns
 * the single before_agent_start hook that appends the frozen
 * block.
 */

export {
	clearPromptContributors,
	createFrozenResidentPrompt,
	type FrozenResidentPrompt,
	type PromptContributor,
	registerPromptContributor,
	unregisterPromptContributor,
} from "./coordinator.js";
