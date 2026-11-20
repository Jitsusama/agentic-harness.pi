/**
 * A budget's variables laid over a session's environment and taken
 * off again exactly. Plain pi uses process.env; a shared host keeps
 * an environment for each conversation and passes it to commands and
 * provider requests. This module does not resolve model-provider keys.
 *
 * Taking a budget off puts back what was there: a value that was set
 * before is set again, and a variable that was not set is removed. A
 * value something else changed while the budget was on is left as it
 * now is, since that change is newer than either. What was there is
 * kept once per session rather than per module, so a reloaded
 * extension, which sees the budget's values as if they were the
 * person's, still knows what to put back.
 */

import {
	type SessionEnvironment,
	type SessionRef,
	sessionSlot,
} from "../core/session/index.ts";
import {
	BUDGET_KEYS_VARIABLE,
	BUDGET_OPTED_OUT_VARIABLE,
	BUDGET_VARIABLE,
	isBudgetKeyName,
} from "./record.ts";

/** One variable a budget set, and what it replaced. */
interface Laid {
	/** What the variable held before, or undefined when it was unset. */
	readonly before: string | undefined;
	/** What the budget set it to, or undefined where it took it off. */
	readonly value: string | undefined;
}

/** The budget laid over an environment, if any. */
export interface BudgetOverlay {
	/** The budget's name. */
	name: string | undefined;
	/** The label its provider gave it. */
	label: string | undefined;
	/** Each variable it set, by name. */
	readonly laid: Map<string, Laid>;
}

/** An overlay with nothing on it. */
export function emptyOverlay(): BudgetOverlay {
	return { name: undefined, label: undefined, laid: new Map() };
}

/** The conversation's overlay, or the legacy process overlay on plain pi. */
export function processOverlay(ref?: SessionRef): BudgetOverlay {
	return sessionSlot("agentic-harness.pi:budget-overlay", ref, emptyOverlay);
}

/** Adapt an ordinary environment without changing the existing budget API. */
function mutableEnvironment(
	env: NodeJS.ProcessEnv | SessionEnvironment,
): SessionEnvironment {
	if (isSessionEnvironment(env)) return env;
	return {
		get: (key) => env[key],
		set: (key, value) => {
			env[key] = value;
		},
		delete: (key) => {
			delete env[key];
		},
		snapshot: () => ({ ...env }),
	};
}

function isSessionEnvironment(
	env: NodeJS.ProcessEnv | SessionEnvironment,
): env is SessionEnvironment {
	return typeof env.get === "function" && typeof env.snapshot === "function";
}

/**
 * Lay a budget's variables over `env`, in place of whatever budget was
 * on before, with its name in `PI_BUDGET` so what the process starts
 * knows which budget it inherited, and the variables it laid in
 * `PI_BUDGET_KEYS` (empty when it laid none, so an inherited list is
 * hidden until the budget comes off) so whatever sends a request can
 * tell its key from one that only sits there. A variable the earlier
 * budget set and this one does not is put back first.
 */
export function layBudget(
	env: NodeJS.ProcessEnv | SessionEnvironment,
	budget: {
		readonly name: string;
		readonly label: string;
		readonly env: Readonly<Record<string, string>>;
	},
	overlay: BudgetOverlay = processOverlay(),
): void {
	const target = mutableEnvironment(env);
	// Every variable is laid as the provider gave it; the list names only
	// those it can carry, so a comma in a name can't add names to it.
	const laying: Record<string, string> = {
		...budget.env,
		[BUDGET_KEYS_VARIABLE]: Object.keys(budget.env)
			.filter(isBudgetKeyName)
			.sort()
			.join(","),
		[BUDGET_VARIABLE]: budget.name,
	};
	for (const key of [...overlay.laid.keys()]) {
		if (!(key in laying || isSetAside(overlay, key)))
			restore(target, overlay, key);
	}
	for (const [key, value] of Object.entries(laying)) {
		const earlier = overlay.laid.get(key);
		// A value changed under the budget is newer than what it replaced,
		// so it is what the next lift puts back.
		const before =
			earlier && target.get(key) === earlier.value
				? earlier.before
				: target.get(key);
		overlay.laid.set(key, { before, value });
		target.set(key, value);
	}
	overlay.name = budget.name;
	overlay.label = budget.label;
}

/**
 * Take any budget off `env` and set {@link BUDGET_OPTED_OUT_VARIABLE},
 * for work said to draw on none, so what the process starts keeps to
 * that. Laid as a budget's variables are, so the next lay or lift puts
 * back what it replaced.
 */
export function layOptedOut(
	env: NodeJS.ProcessEnv | SessionEnvironment,
	overlay: BudgetOverlay = processOverlay(),
): void {
	const target = mutableEnvironment(env);
	const key = BUDGET_OPTED_OUT_VARIABLE;
	for (const laid of [...overlay.laid.keys()]) {
		if (laid !== key) restore(target, overlay, laid);
	}
	const earlier = overlay.laid.get(key);
	const before =
		earlier && target.get(key) === earlier.value
			? earlier.before
			: target.get(key);
	overlay.laid.set(key, { before, value: OPTED_OUT });
	target.set(key, OPTED_OUT);
	overlay.name = undefined;
	overlay.label = undefined;
}

/** What {@link layOptedOut} sets its variable to. */
const OPTED_OUT = "1";

/**
 * Take an inherited {@link BUDGET_OPTED_OUT_VARIABLE} off `env`, for
 * work on a quest whose own word stands over the one it was started
 * under, so what it starts doesn't keep to that word. Laid as a
 * budget's variables are, so a lift puts it back as the session goes
 * back to its own word; a budget laid over it, such as a capped key's,
 * leaves it aside, since that doesn't change whose word stands.
 */
export function setAsideOptedOut(
	env: NodeJS.ProcessEnv | SessionEnvironment,
	overlay: BudgetOverlay = processOverlay(),
): void {
	const target = mutableEnvironment(env);
	const key = BUDGET_OPTED_OUT_VARIABLE;
	const before = target.get(key);
	if (before === undefined || overlay.laid.has(key)) return;
	overlay.laid.set(key, { before, value: undefined });
	target.delete(key);
}

/** Whether `key` is an inherited opt-out {@link setAsideOptedOut} took off. */
function isSetAside(overlay: BudgetOverlay, key: string): boolean {
	return (
		key === BUDGET_OPTED_OUT_VARIABLE &&
		overlay.laid.get(key)?.value === undefined
	);
}

/** Take the budget off `env`, putting back what it replaced. */
export function liftBudget(
	env: NodeJS.ProcessEnv | SessionEnvironment,
	overlay: BudgetOverlay = processOverlay(),
): void {
	const target = mutableEnvironment(env);
	for (const key of [...overlay.laid.keys()]) restore(target, overlay, key);
	overlay.name = undefined;
	overlay.label = undefined;
}

/**
 * A copy of `env` as it would be with no budget on: for a session
 * started for another quest, which draws on its own budget rather
 * than inheriting this one's, and keeps to its own word on none
 * rather than one this session laid or inherited.
 */
export function withoutBudget(
	env: Readonly<Record<string, string | undefined>>,
	overlay: BudgetOverlay = processOverlay(),
): Record<string, string | undefined> {
	const out = { ...env };
	for (const [key, laid] of overlay.laid) {
		if (out[key] !== laid.value) continue;
		if (laid.before === undefined) delete out[key];
		else out[key] = laid.before;
	}
	delete out[BUDGET_OPTED_OUT_VARIABLE];
	return out;
}

function restore(
	env: SessionEnvironment,
	overlay: BudgetOverlay,
	key: string,
): void {
	const laid = overlay.laid.get(key);
	overlay.laid.delete(key);
	if (!laid || env.get(key) !== laid.value) return;
	if (laid.before === undefined) env.delete(key);
	else env.set(key, laid.before);
}
