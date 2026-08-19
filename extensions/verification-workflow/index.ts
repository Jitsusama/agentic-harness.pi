/**
 * Verification Workflow extension.
 *
 * Closes the trust gap after an edit without stalling an
 * autonomous run. Two cadences:
 *
 *   Fast layer, at the turn boundary. When the agent is about
 *   to yield, it asks the resident LSP backend for diagnostics
 *   on the files touched this run. New error-severity problems
 *   are enqueued as a follow-up so the agent continues and
 *   self-corrects before handing the turn to the user. It
 *   defers entirely while a TDD loop is active, and caps its
 *   fix requests so it never thrashes.
 *
 *   Medium layer, on request. The no-command verify tool runs
 *   the project's resolved check command when the user asks
 *   whether the code still builds or passes.
 *
 * No slash command and nothing runs after every edit: the
 * loop acts at the turn boundary and when the agent is asked.
 */

import { isAbsolute, resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveLspBackend } from "@jitsusama/agentic-harness.core/lsp";
import { runVerify } from "@jitsusama/agentic-harness.core/verify";
import { Type } from "@sinclair/typebox";
import { getLastEntry } from "../../lib/internal/state.js";
import { setVerificationFailing } from "../../lib/internal/verification/signal.js";
import {
	type FileError,
	fastLayerVerdict,
} from "../../lib/verification/index.js";
import {
	createVerificationState,
	MAX_FIX_ATTEMPTS,
	type VerificationState,
} from "./state.js";

const STATUS_KEY = "verification-workflow";
/** Files the LSP fast layer can serve today. */
const SYNCABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export default function verificationWorkflow(pi: ExtensionAPI) {
	const state = createVerificationState();
	let ctxRef: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		refreshStatus(ctx, state);
	});

	// Collect the files pi changed this turn.
	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = event.input.path;
		if (typeof path !== "string") return;
		state.touched.add(isAbsolute(path) ? path : resolve(process.cwd(), path));
	});

	// Fast layer: when the agent is about to yield (a terminal
	// turn that ran no tools, so the loop is about to stop), run
	// the resident LSP over the files touched this run plus any
	// still-outstanding ones. On new error-severity problems,
	// enqueue the fix as a follow-up. pi.sendUserMessage with
	// deliverAs "followUp" feeds the loop's follow-up queue, which
	// it drains immediately after this event and before it ends
	// the run (turn_end is emitted just ahead of the follow-up
	// drain), so the agent continues and self-corrects before the
	// turn returns to the user.
	pi.on("turn_end", async (event, ctx) => {
		ctxRef = ctx;
		// A turn that executed tools loops again on its own; only
		// verify when the assistant is about to stop. An errored or
		// aborted turn is not a clean yield worth checking.
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (event.toolResults.length > 0) return;
		if (stopReason === "error" || stopReason === "aborted") return;

		const watched = new Set<string>(state.pending.map((e) => e.path));
		for (const p of state.touched) watched.add(p);
		state.touched.clear();
		const files = [...watched].filter((p) => SYNCABLE.test(p));

		const backend = resolveLspBackend();
		if (!backend || files.length === 0) {
			refreshStatus(ctx, state);
			return;
		}

		const { errors, failed } = await collectErrors(backend, files);
		const tddPhase =
			getLastEntry<{ phase?: string }>(ctx, "tdd-workflow")?.phase ?? "idle";
		const verdict = fastLayerVerdict({
			tddPhase,
			attempts: state.attempts,
			maxAttempts: MAX_FIX_ATTEMPTS,
			errors,
		});

		if (verdict.action === "inject") {
			state.attempts = verdict.attempt;
			state.pending = [...errors];
			state.outcome = "failing";
			refreshStatus(ctx, state);
			// Continue the run so the agent fixes this before yielding.
			pi.sendUserMessage(verdict.message, { deliverAs: "followUp" });
			return;
		}
		if (verdict.action === "giveUp") {
			// Stop nagging and let the run end so the user sees the
			// agent's last word; the status line still shows failing.
			state.attempts = 0;
			state.pending = [];
			state.outcome = "failing";
		} else if (verdict.reason.includes("TDD")) {
			state.outcome = "deferred";
		} else if (failed) {
			// The server errored for the touched files, so "no errors"
			// is not "checked clean": report deferred rather than lie
			// green and unblock a commit on unchecked code.
			state.attempts = 0;
			state.pending = [];
			state.outcome = "deferred";
		} else {
			state.attempts = 0;
			state.pending = [];
			state.outcome = "clean";
		}
		refreshStatus(ctx, state);
	});

	pi.registerTool({
		name: "verify",
		label: "Verify",
		description:
			"Run the project's verification check command (lint, typecheck, " +
			"test) and report whether the code still builds and passes. Use " +
			"this when asked whether something works, still builds, or is green.",
		promptSnippet:
			"When asked whether the code still builds or passes, run the verify " +
			"tool rather than guessing.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId,
			_params,
			signal,
		): Promise<AgentToolResult<VerifyDetails>> {
			const questVerify = ctxRef
				? (getLastEntry<{ verify?: string | null }>(ctxRef, "quest-workflow")
						?.verify ?? undefined)
				: undefined;
			const result = await runVerify({
				cwd: process.cwd(),
				...(questVerify ? { questVerify } : {}),
				...(signal ? { signal } : {}),
			});
			if (ctxRef) {
				state.outcome = result.ok ? "clean" : "failing";
				refreshStatus(ctxRef, state);
			}
			return {
				content: [{ type: "text", text: result.output }],
				details: {
					ok: result.ok,
					...(result.command ? { command: result.command } : {}),
				},
			};
		},
	});
}

interface VerifyDetails {
	readonly ok: boolean;
	readonly command?: string;
}

interface DiagnosticsResult {
	readonly errors: FileError[];
	/** True when a diagnostics call threw, so "no errors" is not "checked clean". */
	readonly failed: boolean;
}

async function collectErrors(
	backend: { diagnostics: (path: string) => Promise<readonly unknown[]> },
	files: readonly string[],
): Promise<DiagnosticsResult> {
	const errors: FileError[] = [];
	let failed = false;
	for (const path of files) {
		let diagnostics: readonly unknown[];
		try {
			diagnostics = await backend.diagnostics(path);
		} catch {
			// The server errored for a file it was expected to serve.
			// Remember that so the caller does not report "clean" for a
			// check that never actually ran.
			failed = true;
			continue;
		}
		for (const raw of diagnostics) {
			const d = raw as {
				severity?: string;
				message?: string;
				range?: { start?: { line?: number; character?: number } };
			};
			if (d.severity !== "error") continue;
			errors.push({
				path,
				line: d.range?.start?.line ?? 1,
				character: d.range?.start?.character ?? 0,
				message: d.message ?? "error",
			});
		}
	}
	return { errors, failed };
}

function refreshStatus(ctx: ExtensionContext, state: VerificationState): void {
	// Publish the outcome so the commit guardian can refuse a
	// commit while checks are red. Only a definite failing verdict
	// blocks; deferred and unknown leave the signal clear.
	setVerificationFailing(state.outcome === "failing");
	const theme = ctx.ui.theme;
	const label =
		state.outcome === "clean"
			? theme.fg("success", "verify \u2713")
			: state.outcome === "failing"
				? theme.fg(
						"error",
						`verify \u2717${state.attempts ? ` ${state.attempts}/${MAX_FIX_ATTEMPTS}` : ""}`,
					)
				: state.outcome === "deferred"
					? theme.fg("muted", "verify (tdd)")
					: undefined;
	ctx.ui.setStatus(STATUS_KEY, label);
}
