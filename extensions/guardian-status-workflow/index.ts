/**
 * Guardian Status Workflow Extension
 *
 * Registers a `/guardian-status` command that shows the
 * last-call outcome of every registered guardian. Useful
 * when a user notices gates have stopped firing and wants
 * to confirm whether each guardian actually ran for the
 * most recent bash command.
 *
 * Reads from the registry populated by
 * `lib/guardian/register.ts` (which calls `record(...)` for
 * every short-circuit and review outcome). Read-only: the
 * command opens a scrollable panel and dismisses on Esc.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
	type GuardianOutcome,
	list,
} from "../../lib/internal/guardian/registry.js";
import { view } from "../../lib/ui/index.js";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * 60;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24;

/** Format a timestamp as "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago". */
function formatElapsed(when: Date): string {
	const seconds = Math.floor((Date.now() - when.getTime()) / 1000);
	if (seconds < SECONDS_PER_MINUTE) return `${seconds}s ago`;
	if (seconds < SECONDS_PER_HOUR) {
		return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ago`;
	}
	if (seconds < SECONDS_PER_DAY) {
		return `${Math.floor(seconds / SECONDS_PER_HOUR)}h ago`;
	}
	return `${Math.floor(seconds / SECONDS_PER_DAY)}d ago`;
}

/** Format an outcome as a coloured label. */
function formatOutcome(
	outcome: GuardianOutcome | undefined,
	theme: Theme,
): string {
	if (!outcome) return theme.fg("muted", "never called");
	switch (outcome.kind) {
		case "allowed":
			return theme.fg("success", "allowed");
		case "blocked":
			return theme.fg("warning", `blocked: ${outcome.reason}`);
		case "rewritten":
			return theme.fg("warning", "rewritten");
		case "skipped":
			return theme.fg("muted", `skipped (${outcome.why})`);
	}
}

/** Render the registry snapshot as a list of lines. */
function renderStatus(theme: Theme, _width: number): string[] {
	const statuses = list();
	if (statuses.length === 0) {
		return [
			"",
			theme.fg("muted", "  No guardians registered."),
			"",
			theme.fg("dim", "  Guardians register on package load. If this list is"),
			theme.fg(
				"dim",
				"  empty, no extension that uses registerGuardian has loaded.",
			),
			"",
		];
	}

	const nameWidth = Math.max(...statuses.map((entry) => entry.name.length));
	const lines: string[] = [""];

	for (const entry of statuses) {
		const name = theme.fg("text", entry.name.padEnd(nameWidth));
		const outcome = formatOutcome(entry.lastOutcome, theme);
		const elapsed = entry.lastCalledAt
			? `  ${theme.fg("dim", formatElapsed(entry.lastCalledAt))}`
			: "";
		lines.push(`  ${name}  ${outcome}${elapsed}`);
	}

	lines.push("");
	return lines;
}

export default function guardianStatusWorkflow(pi: ExtensionAPI) {
	pi.registerCommand("guardian-status", {
		description:
			"Show each registered guardian's last call outcome (allowed, blocked, rewritten, skipped).",
		handler: async (_args, ctx) => {
			await view(ctx, {
				title: "Guardian Status",
				content: renderStatus,
			});
		},
	});
}
