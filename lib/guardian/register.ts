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
} from "@earendil-works/pi-coding-agent";
import { record, register } from "../internal/guardian/registry.ts";
import { stripHeredocBodies, stripShellData } from "../shell/index.ts";
import { blockIfUnsupported } from "./enforce.ts";
import { declareGuard, type GuardDeclaration, guardMode } from "./policy.ts";
import { reportGuard } from "./report.ts";
import type { CommandGuardian } from "./types.ts";

/** Options for guardian registration. */
export interface RegisterGuardianOptions {
	/**
	 * The guard as the policy knows it. When given, it is declared and
	 * its resolved mode governs the pipeline: outside `block` an
	 * unreviewable shape goes through with a report, and the mode is
	 * handed to review, which reports rather than refuses under `off`.
	 * Without one the guardian behaves as it did before the policy,
	 * which is `block`.
	 */
	declaration?: GuardDeclaration;
	/**
	 * When provided, the guardian is skipped if this returns true.
	 * Checked before detect, so it short-circuits cheaply. Kept for
	 * guardians that predate the policy; a declared guard is switched
	 * off through the policy instead.
	 */
	bypass?: () => boolean;
	/**
	 * Display name for the guardian status registry. When set,
	 * the guardian's last-call outcome is tracked and surfaced
	 * in `/guards`. Optional so downstream packages
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
	const declaration = options?.declaration;
	if (declaration) declareGuard(declaration);
	const trackedName = options?.name ?? declaration?.name;
	if (trackedName) register(trackedName);
	const modeNow = () =>
		declaration ? guardMode(declaration.name) : ("block" as const);

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;

			if (!ctx.hasUI && !options?.enforceWithoutUI) {
				if (trackedName) record(trackedName, { kind: "skipped", why: "no-ui" });
				return;
			}
			// An off guard still runs, so the person sees what it saw; only a
			// bypass, which predates the policy, skips it outright.
			const mode = modeNow();
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

			// A detected guardable command in a shape the gate cannot fully
			// parse. A blocking guard fails closed, since passing it would
			// skip the review it promised. Any other promised only to show
			// what it saw, so it says it could not and lets it run.
			const unsupported = blockIfUnsupported(command);
			if (unsupported) {
				if (mode === "block") {
					if (trackedName)
						record(trackedName, {
							kind: "blocked",
							reason: unsupported.reason,
						});
					return unsupported;
				}
				if (trackedName) {
					reportGuard({
						guard: trackedName,
						kind: "waved",
						title: "Ran without review",
						body: `This command is in a shape the gate cannot read, so it ran unreviewed.\n\n\`\`\`bash\n${command}\n\`\`\``,
					});
					record(trackedName, { kind: "allowed" });
				}
				return;
			}

			const parsed = guardian.parse(command);
			if (!parsed) {
				if (trackedName)
					record(trackedName, { kind: "skipped", why: "parse-null" });
				return;
			}

			const result = await guardian.review(parsed, ctx, mode);
			if (!result) {
				if (trackedName) record(trackedName, { kind: "allowed" });
				return;
			}

			// The one sanctioned place a guardian rewrite is applied. The
			// history guardian uses it to turn a bare force push into a
			// leased one.
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
