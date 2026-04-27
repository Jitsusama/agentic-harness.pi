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
import { record, register } from "../internal/guardian/registry.js";
import { stripHeredocBodies, stripShellData } from "../shell/parse.js";
import type { CommandGuardian } from "./types.js";

/** Options for guardian registration. */
export interface RegisterGuardianOptions {
	/**
	 * When provided, the guardian is skipped if this returns true.
	 * Checked before detect, so it short-circuits cheaply.
	 */
	bypass?: () => boolean;
	/**
	 * Display name for the guardian status registry. When set,
	 * the guardian's last-call outcome is tracked and surfaced
	 * in `/guardian-status`. Optional so downstream packages
	 * that haven't been updated keep working.
	 */
	name?: string;
}

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
	options?: RegisterGuardianOptions,
): void {
	const trackedName = options?.name;
	if (trackedName) register(trackedName);

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			if (!ctx.hasUI) {
				if (trackedName) record(trackedName, { kind: "skipped", why: "no-ui" });
				return;
			}
			if (options?.bypass?.()) {
				if (trackedName)
					record(trackedName, { kind: "skipped", why: "bypassed" });
				return;
			}

			const command = event.input.command;
			if (!guardian.detect(stripShellData(stripHeredocBodies(command)))) {
				if (trackedName)
					record(trackedName, { kind: "skipped", why: "detect-miss" });
				return;
			}

			const parsed = guardian.parse(command);
			if (!parsed) {
				if (trackedName)
					record(trackedName, { kind: "skipped", why: "parse-null" });
				return;
			}

			const result = await guardian.review(parsed, ctx);
			if (!result) {
				if (trackedName) record(trackedName, { kind: "allowed" });
				return;
			}

			if ("rewrite" in result) {
				(event.input as { command: string }).command = result.rewrite;
				if (trackedName) record(trackedName, { kind: "rewritten" });
				return;
			}

			if (trackedName)
				record(trackedName, { kind: "blocked", reason: result.reason });
			return result;
		},
	);
}
