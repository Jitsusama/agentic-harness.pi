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
import { blockIfUnsupported } from "./enforce.js";
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
	/**
	 * Run the guardian even without a UI. Content-gating guardians
	 * (prose, sections) set this so subagents and headless runs are
	 * still blocked at authoring time; the guardian's own review
	 * skips the human panel when there is no UI and relies on the
	 * gate. Guardians that only present a human panel leave this
	 * off and stay skipped without a UI.
	 */
	enforceWithoutUI?: boolean;
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

			if (!ctx.hasUI && !options?.enforceWithoutUI) {
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

			// Fail closed: a detected guardable command in a shape the
			// model cannot fully parse is blocked rather than passed
			// through unreviewed.
			const unsupported = blockIfUnsupported(command);
			if (unsupported) {
				if (trackedName && "block" in unsupported)
					record(trackedName, { kind: "blocked", reason: unsupported.reason });
				return unsupported;
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

			// No guardian emits a rewrite today (review blocks or
			// allows; rewriting lives in the attribution splice and the
			// interceptors). This stays as the one sanctioned place a
			// guardian rewrite would be applied, so a future opt-in does
			// not reintroduce a second mutation site.
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
