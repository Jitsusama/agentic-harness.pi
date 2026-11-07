/**
 * How much of a Claude plan's allowances is spent, as the Claude Code
 * provider (earendil-works/pi-claude-code) reports it after each turn.
 *
 * A plan has two allowances, each over a window: five hours, and a
 * week. On Pro they are small for agent work, and a turn past one stops
 * until it resets, so the person spends them knowingly only when the
 * footer says where each stands. The provider puts Anthropic's answer
 * on each assistant message as a `claude-code.rate-limit` diagnostic;
 * this reads it.
 */

import { isRecord } from "./record.ts";

/** The diagnostic the provider writes, by its type. */
export const RATE_LIMIT = "claude-code.rate-limit";

/** How full one window is, and when it starts again. */
export interface PlanWindow {
	/** Spent, from 0 to 1. */
	readonly used: number;
	/** When it resets, in milliseconds since the epoch, if said. */
	readonly resets?: number;
}

/** Where the plan stands after a turn. */
export interface PlanUse {
	readonly fiveHour?: PlanWindow;
	readonly week?: PlanWindow;
	/** Anthropic refused the turn: a window is spent. */
	readonly stopped: boolean;
}

/** Enough of a diagnostic to read. */
export interface Diagnostic {
	readonly type: string;
	readonly details?: unknown;
}

/** The plan's standing from a message's diagnostics, the last said winning. */
export function planUseFrom(
	diagnostics: readonly Diagnostic[] | undefined,
): PlanUse | undefined {
	const said = [...(diagnostics ?? [])]
		.reverse()
		.find((one) => one.type === RATE_LIMIT)?.details;
	if (!isRecord(said)) return undefined;
	const windows = isRecord(said.unifiedWindows) ? said.unifiedWindows : {};
	const fiveHour = windowFrom(windows.five_hour);
	const week = windowFrom(windows.seven_day);
	if (!fiveHour && !week) return undefined;
	return {
		...(fiveHour ? { fiveHour } : {}),
		...(week ? { week } : {}),
		stopped: said.status !== undefined && said.status !== "allowed",
	};
}

/** The provider a Claude plan is reached through. */
export const PLAN_PROVIDER = "claude-code";

/** The plan's standing from a message, when Claude Code said one. */
export function planUseOf(message: unknown): PlanUse | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (message.provider !== PLAN_PROVIDER) return undefined;
	const { diagnostics } = message;
	if (!Array.isArray(diagnostics)) return undefined;
	return planUseFrom(
		diagnostics.flatMap((one: unknown) =>
			isRecord(one) && typeof one.type === "string"
				? [{ type: one.type, details: one.details }]
				: [],
		),
	);
}

/**
 * The newest standing a session's branch holds, so a reloaded or
 * resumed session knows where the plan stood before its next turn.
 */
export function lastPlanUse(
	branch: readonly { readonly type: string; readonly message?: unknown }[],
): PlanUse | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry?.type !== "message") continue;
		const said = planUseOf(entry.message);
		if (said) return said;
	}
	return undefined;
}

function windowFrom(raw: unknown): PlanWindow | undefined {
	if (!isRecord(raw) || typeof raw.utilization !== "number") return undefined;
	const resets =
		typeof raw.resetsAt === "number" ? raw.resetsAt * 1000 : undefined;
	return {
		used: raw.utilization,
		...(resets !== undefined ? { resets } : {}),
	};
}
