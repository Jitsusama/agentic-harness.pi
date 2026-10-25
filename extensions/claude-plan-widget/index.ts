/**
 * Claude Plan Widget: where a Claude plan's five-hour and weekly
 * allowances stand, on the footer, while the session talks to Claude
 * through Claude Code on that plan (earendil-works/pi-claude-code).
 *
 * Joel's plan is Pro, whose windows are small for agent work, and he
 * asked to see them so he can spend them knowingly. The provider puts
 * Anthropic's answer on each assistant message; this reads the last one
 * said, so a reloaded or resumed session shows it before its next turn.
 * Under any other provider the footer says nothing of it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type PlanUse,
	planUseFrom,
	planUseLine,
} from "../../lib/internal/claude-plan.ts";
import { footerMark } from "../../lib/ui/footer-mark.ts";

/** The provider the plan is reached through. */
const PROVIDER = "claude-code";
const STATUS_KEY = "claude-plan";

export default function claudePlanWidget(pi: ExtensionAPI) {
	let last: PlanUse | undefined;

	pi.on("session_start", async (_event, ctx) => {
		last = lastSaid(ctx);
		show(ctx, ctx.model?.provider === PROVIDER ? last : undefined);
	});

	pi.on("message_end", async (event, ctx) => {
		const said = planUseOf(event.message);
		if (!said) return;
		last = said;
		show(ctx, said);
	});

	pi.on("model_select", async (event, ctx) => {
		show(ctx, event.model.provider === PROVIDER ? last : undefined);
	});
}

/** The plan's standing from a message, when Claude Code said one. */
function planUseOf(message: unknown): PlanUse | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message) || message.role !== "assistant") return undefined;
	if (!("provider" in message) || message.provider !== PROVIDER) {
		return undefined;
	}
	const diagnostics = "diagnostics" in message ? message.diagnostics : [];
	return Array.isArray(diagnostics) ? planUseFrom(diagnostics) : undefined;
}

/** The newest standing the session's branch holds. */
function lastSaid(ctx: ExtensionContext): PlanUse | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry?.type !== "message") continue;
		const said = planUseOf(entry.message);
		if (said) return said;
	}
	return undefined;
}

/** The mark in its tone, then the windows quietly; nothing for none. */
function show(ctx: ExtensionContext, use: PlanUse | undefined): void {
	if (!ctx.hasUI) return;
	if (!use) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const { tone, text } = planUseLine(use, hourMinute);
	ctx.ui.setStatus(
		STATUS_KEY,
		`${footerMark("plan", tone, theme)} ${theme.fg("dim", text)}`,
	);
}

function hourMinute(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}
