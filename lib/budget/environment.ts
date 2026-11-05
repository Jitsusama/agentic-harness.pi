/**
 * A budget's variables laid over a process's own environment, and
 * taken off again exactly.
 *
 * Model providers read their keys from the process's environment as
 * each request is made, so a session switches budget by changing its
 * own `process.env`. What it starts afterwards (commands, subagents)
 * inherits the change, which is what makes their calls draw on the
 * quest's budget too.
 *
 * Taking a budget off puts back what was there: a value that was set
 * before is set again, and a variable that was not set is removed. A
 * value something else changed while the budget was on is left as it
 * now is, since that change is newer than either. What was there is
 * kept once per process rather than per module, so a reloaded
 * extension, which sees the budget's values as if they were the
 * person's, still knows what to put back.
 */

import { processGlobal } from "../internal/process-global.ts";

/** One variable a budget set, and what it replaced. */
interface Laid {
	/** What the variable held before, or undefined when it was unset. */
	readonly before: string | undefined;
	/** What the budget set it to. */
	readonly value: string;
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

/** The one overlay on this process's environment, shared by every module. */
export function processOverlay(): BudgetOverlay {
	return processGlobal("agentic-harness.pi:budget-overlay", emptyOverlay);
}

/**
 * Lay a budget's variables over `env`, in place of whatever budget was
 * on before. A variable the earlier budget set and this one does not is
 * put back first.
 */
export function layBudget(
	env: NodeJS.ProcessEnv,
	budget: {
		readonly name: string;
		readonly label: string;
		readonly env: Readonly<Record<string, string>>;
	},
	overlay: BudgetOverlay = processOverlay(),
): void {
	for (const key of [...overlay.laid.keys()]) {
		if (!(key in budget.env)) restore(env, overlay, key);
	}
	for (const [key, value] of Object.entries(budget.env)) {
		const earlier = overlay.laid.get(key);
		// A value changed under the budget is newer than what it replaced,
		// so it is what the next lift puts back.
		const before =
			earlier && env[key] === earlier.value ? earlier.before : env[key];
		overlay.laid.set(key, { before, value });
		env[key] = value;
	}
	overlay.name = budget.name;
	overlay.label = budget.label;
}

/** Take the budget off `env`, putting back what it replaced. */
export function liftBudget(
	env: NodeJS.ProcessEnv,
	overlay: BudgetOverlay = processOverlay(),
): void {
	for (const key of [...overlay.laid.keys()]) restore(env, overlay, key);
	overlay.name = undefined;
	overlay.label = undefined;
}

/**
 * A copy of `env` as it would be with no budget on: for a session
 * started for another quest, which draws on its own budget rather
 * than inheriting this one's.
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
	return out;
}

function restore(
	env: NodeJS.ProcessEnv,
	overlay: BudgetOverlay,
	key: string,
): void {
	const laid = overlay.laid.get(key);
	overlay.laid.delete(key);
	if (!laid || env[key] !== laid.value) return;
	if (laid.before === undefined) delete env[key];
	else env[key] = laid.before;
}
