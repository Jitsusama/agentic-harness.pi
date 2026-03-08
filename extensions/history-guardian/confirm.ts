/**
 * Destructive command confirmation — delegates to the shared
 * review loop with allow/block actions and no editing.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { reviewLoop } from "../shared/review-loop.js";
import type { Severity } from "./patterns.js";

const DESTRUCTIVE_ACTIONS = [
	{ label: "Allow", value: "allow" },
	{ label: "Block", value: "block" },
];

export async function confirmDestructive(
	command: string,
	severity: Severity,
	description: string,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	const icon = severity === "irrecoverable" ? "⛔" : "⚠";
	const label =
		severity === "irrecoverable" ? "Destructive Command" : "Risky Command";

	return reviewLoop(ctx, {
		actions: DESTRUCTIVE_ACTIONS,
		content: (theme, _width) => [
			theme.fg("text", ` ${icon} ${label}`),
			"",
			` ${theme.fg("text", command)}`,
			` ${theme.fg("muted", description)}`,
		],
		entityName: "command",
		steerContext: command,
	});
}
