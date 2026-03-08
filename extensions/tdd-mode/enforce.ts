/**
 * TDD mode enforcement — RED phase file restriction.
 *
 * In RED phase, writes to implementation files require
 * confirmation (allow for minimal stubs, or block).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatSteer, showGate } from "../lib/ui/gate.js";
import { isTestFile } from "./patterns.js";
import type { TddState } from "./state.js";

/**
 * Check a write/edit tool call against RED phase restrictions.
 * Returns a block result, or undefined to allow.
 */
export async function enforceRedPhase(
	state: TddState,
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
	if (!state.enabled || state.phase !== "red") return;
	if (toolName !== "write" && toolName !== "edit") return;

	const filePath = String(input.path ?? "");
	if (isTestFile(filePath)) return;
	if (!ctx.hasUI) return;

	const result = await showGate(ctx, {
		content: (theme) => [
			theme.fg("warning", " Implementation file in RED phase"),
			"",
			` ${theme.fg("text", filePath)}`,
			` ${theme.fg("muted", "RED phase is for tests and minimal stubs only.")}`,
		],
		options: [
			{ label: "Allow — minimal stub", value: "allow" },
			{ label: "Block", value: "block" },
		],
		steerContext: `File: ${filePath}\nPhase: RED — should only modify test files and minimal stubs.`,
	});

	if (!result || result.value === "block") {
		return {
			block: true,
			reason: `RED phase: write to implementation file blocked. File: ${filePath}`,
		};
	}

	if (result.value === "steer") {
		return formatSteer(
			result.feedback ?? "",
			`Blocked write to ${filePath} during RED phase.`,
		);
	}
}
