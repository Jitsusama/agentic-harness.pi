/**
 * Destructive command confirmation — gate for risky git operations.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { showGate, formatSteer } from "../shared/gate.js";
import type { Severity } from "./patterns.js";

const DESTRUCTIVE_OPTIONS = [
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
	const label = severity === "irrecoverable"
		? "Destructive Command"
		: "Risky Command";

	const result = await showGate(ctx, {
		content: (theme, _width) => [
			theme.fg("text", ` ${icon} ${label}`),
			"",
			` ${theme.fg("text", command)}`,
			` ${theme.fg("muted", description)}`,
		],
		options: DESTRUCTIVE_OPTIONS,
		steerContext: command,
	});

	if (!result || result.value === "block") {
		return { block: true, reason: `User blocked: ${command}` };
	}

	if (result.value === "steer") {
		return formatSteer(result.feedback!, `Blocked command: ${command}`);
	}

	return;
}
