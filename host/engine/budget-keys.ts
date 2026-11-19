/**
 * The keys a conversation's budget laid, which the host sends in place
 * of its own. The quest workflow lays a budget's key over the
 * conversation's environment and names each variable it laid in
 * PI_BUDGET_KEYS; any other key variable a conversation holds came with
 * its launch and may have gone stale, so the host's renewed key wins it.
 */
import { budgetDrawnOn, budgetKeysOf } from "../../lib/budget/record.ts";

/** The variables a conversation's budget laid, each with the value it laid, empty ones left out. */
export function laidKeys(
	env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	const laid: Record<string, string> = {};
	for (const name of budgetKeysOf(env)) {
		const value = env[name];
		if (value) laid[name] = value;
	}
	return laid;
}

/**
 * The key variables among `names` a conversation on a budget holds with
 * a value of its own that its budget didn't list, which the host's key
 * replaces: a budget laid before budgets named their keys, or a key that
 * came with the launch. Empty for a conversation on no budget.
 */
export function unlistedKeys(
	env: Readonly<Record<string, string | undefined>>,
	names: readonly string[],
): string[] {
	if (budgetDrawnOn(env) === null) return [];
	const laid = laidKeys(env);
	return names.filter((name) => env[name] && !(name in laid));
}
