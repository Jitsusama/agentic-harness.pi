/**
 * The keys a conversation's budget laid, which the host sends in place
 * of its own. The quest workflow lays a budget's key over the
 * conversation's environment and names each variable it laid in
 * PI_BUDGET_KEYS; any other key variable a conversation holds came with
 * its launch and may have gone stale, so the host's renewed key wins it.
 */
import {
	BUDGET_KEYS_VARIABLE,
	budgetDrawnOn,
	budgetKeysOf,
} from "../../lib/budget/record.ts";

/** The variables the work provider reads its gateway key from, each holding the same key. */
export const KEY_VARIABLES = ["SHOPIFY_PROXY_KEY", "PI_PROXY_API_KEY"] as const;

/** The header the work provider sends its key in, when a budget laid one. */
export const AUTH_HEADER_VARIABLE = "PI_PROXY_AUTH_HEADER";

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
 * The gateway key a conversation's budget laid, under whichever of
 * KEY_VARIABLES it laid it, which goes under all of them: they name one
 * key, so a request never carries a budget's under one and the host's
 * under the other. None when its budget laid no key.
 */
export function budgetKey(
	env: Readonly<Record<string, string | undefined>>,
): string | undefined {
	const laid = laidKeys(env);
	return KEY_VARIABLES.map((name) => laid[name]).find(Boolean);
}

/**
 * The key variables a conversation on a budget holds with a value of its
 * own, laid before budgets listed their keys (no PI_BUDGET_KEYS at all),
 * which the host's key replaces until the budget is laid again. Empty off
 * a budget, and for a budget that listed its keys, even listing none.
 */
export function unlistedKeys(
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	if (budgetDrawnOn(env) === null) return [];
	if (env[BUDGET_KEYS_VARIABLE] !== undefined) return [];
	return KEY_VARIABLES.filter((name) => env[name]);
}
