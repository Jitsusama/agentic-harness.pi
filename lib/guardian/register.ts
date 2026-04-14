/**
 * Guardian registration: wires a CommandGuardian into Pi's
 * tool_call event system.
 *
 * This is the single place in the codebase where command
 * rewriting (event.input.command mutation) occurs. All
 * guardians route through here.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { stripHeredocBodies } from "../shell/parse.js";
import type { CommandGuardian } from "./types.js";

/**
 * Register a command guardian on Pi's tool_call event.
 *
 * Handles the full pipeline: detect → parse → review → apply.
 * If the review returns a rewrite, the command is mutated
 * before allowing execution. Blocks are returned directly.
 */
export function registerGuardian<T>(
	pi: ExtensionAPI,
	guardian: CommandGuardian<T>,
): void {
	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;
			if (!ctx.hasUI) return;

			const command = event.input.command;
			if (!guardian.detect(stripHeredocBodies(command))) return;

			const parsed = guardian.parse(command);
			if (!parsed) return;

			const result = await guardian.review(parsed, ctx);
			if (!result) return;

			if ("rewrite" in result) {
				(event.input as { command: string }).command = result.rewrite;
				return;
			}

			return result;
		},
	);
}
