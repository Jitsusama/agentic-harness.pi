/**
 * Budgets: the contract a provider implements to say what a budget's
 * name means, the environment a session drawing on it runs with, and
 * registers over the bus. Which budget a quest draws on is the quest
 * workflow's to decide; what the name means is a provider's.
 */

export {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetAnswer,
	type BudgetHostApi,
	type BudgetProvider,
	isBudgetName,
	isBudgetProvider,
	registerBudgetProvider,
} from "./provider.ts";
