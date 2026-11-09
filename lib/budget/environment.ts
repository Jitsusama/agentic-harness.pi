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
import { BUDGET_VARIABLE } from "./record.ts";

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
 * knows which budget it inherited. A variable the earlier budget set
 * and this one does not is put back first.
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
	const laying = { ...budget.env, [BUDGET_VARIABLE]: budget.name };
	for (const key of [...overlay.laid.keys()]) {
		if (!(key in laying)) restore(target, overlay, key);
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
