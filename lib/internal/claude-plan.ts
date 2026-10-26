/**
 * How much of a Claude plan's allowance is spent, as the Claude Code
 * provider (earendil-works/pi-claude-code) reports it after each turn.
 *
 * A plan's limits are windows: five hours, and a week. On Pro they are
 * small for agent work, and a turn past one stops until it resets, so
 * the person spends them knowingly only when the footer says where each
 * stands. The provider puts Anthropic's answer on each assistant
 * message as a `claude-code.rate-limit` diagnostic; this reads it.
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

/** Past this much of either window, the footer warns. */
export const WARN_AT = 0.8;

/** How a footer status is coloured, as the theme names it. */
export type PlanTone = "dim" | "warning" | "error";

/** The footer's words for the plan, and the tone its mark takes. */
export function planUseLine(
	use: PlanUse,
	clock: (at: number) => string,
): { tone: PlanTone; text: string } {
	const near = (window: PlanWindow | undefined) =>
		window !== undefined && (use.stopped || window.used >= WARN_AT);
	const part = (name: string, window: PlanWindow | undefined) => {
		if (!window) return undefined;
		const percent = `${name} ${Math.round(window.used * 100)}%`;
		return near(window) && window.resets !== undefined
			? `${percent} until ${clock(window.resets)}`
			: percent;
	};
	const text = [part("5h", use.fiveHour), part("wk", use.week)]
		.filter((one) => one !== undefined)
		.join(" ");
	const tone = use.stopped
		? "error"
		: near(use.fiveHour) || near(use.week)
			? "warning"
			: "dim";
	return { tone, text };
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
